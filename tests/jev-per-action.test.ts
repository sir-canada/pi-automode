import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode, parseToolPattern } from "../extensions/auto-mode.ts";
import {
	DEFAULT_DECISION_MODEL_SETTINGS,
	DEFAULT_DECISION_MODEL_THRESHOLDS,
	JevError,
	assembleJevState,
	buildPerActionQuestions,
	decidePerAction,
	evaluateRiskAnswers,
	riskBand,
	type DecisionModelMode,
	type DecisionModelSettings,
	type JevClient,
} from "../extensions/auto-mode/decision-model.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const band = DEFAULT_DECISION_MODEL_THRESHOLDS.destructive;

function settings(mode: DecisionModelMode): DecisionModelSettings {
	return {
		...DEFAULT_DECISION_MODEL_SETTINGS,
		enabled: true,
		mode,
		endpoint: "http://localhost:30401/v1/systemone",
		model: "jev-1.13",
	};
}

function answers(d: number, s: number) {
	return {
		destructive: { type: "noul" as const, value: d },
		scope_creep: { type: "noul" as const, value: s },
	};
}

function client(
	decide: () => Promise<{ answers: ReturnType<typeof answers> }>,
	counter: { n: number },
): JevClient {
	return {
		async decide() {
			counter.n += 1;
			const r = await decide();
			return { model: "jev-1.13", reportedModel: "jev-1.13", answers: r.answers, durationMs: 1 };
		},
		async probe() {
			return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 };
		},
		reportedModel: undefined,
	};
}

async function setup(opts: {
	mode: DecisionModelMode;
	decide: () => Promise<{ answers: ReturnType<typeof answers> }>;
	config?: Record<string, unknown>;
	logRoot?: string;
}) {
	const fake = createFakePi();
	const jev = { n: 0 };
	let llm = 0;
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: settings(opts.mode), ...(opts.config ?? {}) }),
		classifyAction: async () => {
			llm += 1;
			return { decision: "allow", tier: "none", reason: "llm allow" };
		},
		createDecisionModelClient: () => client(opts.decide, jev),
		logRoot: opts.logRoot,
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, opts.logRoot ? { sessionDir: opts.logRoot } : {});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const run = (command = "echo hi") =>
		fake.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } }, ctx) as Promise<
			{ block?: boolean; reason?: string } | undefined
		>;
	const runTool = (toolName: string, input: Record<string, unknown>) =>
		fake.emit("tool_call", { type: "tool_call", toolName, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	return { run, runTool, jev, get llm() { return llm; } };
}

test("riskBand boundaries", () => {
	assert.equal(riskBand(0.17, band), "allow");
	assert.equal(riskBand(0.18, band), "allow");
	assert.equal(riskBand(0.5, band), "middle");
	assert.equal(riskBand(0.82, band), "block");
	assert.equal(riskBand(0.83, band), "block");
});

test("evaluateRiskAnswers: riskier question decides; missing answer throws", () => {
	const e = evaluateRiskAnswers(answers(0.1, 0.9), DEFAULT_DECISION_MODEL_THRESHOLDS);
	assert.equal(e.band, "block");
	assert.equal(e.question, "scope_creep");
	assert.throws(
		() => evaluateRiskAnswers({ destructive: { type: "noul", value: 0 } }, DEFAULT_DECISION_MODEL_THRESHOLDS),
		JevError,
	);
});

test("decidePerAction mode matrix", () => {
	const t = DEFAULT_DECISION_MODEL_THRESHOLDS;
	const ev = (d: number) => evaluateRiskAnswers(answers(d, 0.1), t);
	const m = (mode: DecisionModelMode, d: number) => decidePerAction(mode, ev(d), false).result;
	assert.deepEqual([m("gate", 0.1), m("gate", 0.5), m("gate", 0.9)], ["allow", "llm", "llm"]);
	assert.deepEqual([m("gate+block", 0.1), m("gate+block", 0.5), m("gate+block", 0.9)], ["allow", "llm", "block"]);
	assert.deepEqual([m("replace", 0.1), m("replace", 0.5), m("replace", 0.9)], ["allow", "block", "block"]);
	assert.match(decidePerAction("gate+block", ev(0.91), false).reason, /destructive 0\.91, not covered by any grant/);
	assert.match(decidePerAction("replace", ev(0.5), false).reason, /replace-mode limits/);
	// truncated state never auto-allowed
	assert.equal(decidePerAction("gate", ev(0.1), true).result, "llm");
	assert.equal(decidePerAction("gate+block", ev(0.1), true).result, "llm");
	assert.equal(decidePerAction("replace", ev(0.1), true).result, "block");
});

test("buildPerActionQuestions uses numbered rubrics and keeps both risks", () => {
	const q = buildPerActionQuestions(settings("gate"));
	assert.deepEqual(Object.keys(q), ["destructive", "scope_creep"]);
	for (const v of Object.values(q)) {
		assert.equal(v.type, "noul");
		assert.match(v.instructions ?? "", /^1\. /);
		assert.match(v.instructions ?? "", /If unsure, answer yes/);
	}
});

test("assembleJevState: sections, truncation order, fixed sections intact", () => {
	const base = {
		userAsk: "ASK-MARKER",
		grants: [],
		action: { toolName: "bash", input: { command: "rm x" }, cwd: "/p", insideCwd: undefined },
		recentActions: ["a", "b", "c", "d"],
		transcript: "T".repeat(200),
		projectInstructions: "P".repeat(200),
		policy: { environment: ["env1"], allow: [], softDeny: ["sd"], hardDeny: ["hd"] },
		questions: buildPerActionQuestions(settings("gate")),
	};
	const small = assembleJevState(base);
	assert.equal(small.truncated, false);
	for (const s of ["role", "user_ask", "grants", "action", "recent_actions", "transcript", "project_instructions", "policy"]) {
		assert.match(small.text, new RegExp(`<${s}>`));
	}
	assert.doesNotMatch(small.text, /- a\n/);
	const big = assembleJevState({ ...base, transcript: "T".repeat(200_000), budgetTokens: 3000 });
	assert.equal(big.truncated, true);
	assert.match(big.text, /ASK-MARKER/);
	assert.match(big.text, /rm x/);
	assert.ok(big.text.includes("P".repeat(200)), "instructions kept while transcript is cut");
	const both = assembleJevState({ ...base, transcript: "T".repeat(200_000), projectInstructions: "P".repeat(200_000), budgetTokens: 3000 });
	assert.equal(both.truncated, true);
	assert.ok(both.approxTokens <= 3100);
});

for (const [mode, d, expectBlock, expectLlm] of [
	["gate", 0.1, false, 0], ["gate", 0.5, false, 1], ["gate", 0.9, false, 1],
	["gate+block", 0.1, false, 0], ["gate+block", 0.5, false, 1], ["gate+block", 0.9, true, 0],
	["replace", 0.1, false, 0], ["replace", 0.5, true, 0], ["replace", 0.9, true, 0],
] as const) {
	test(`hook: ${mode} destructive ${d}`, async () => {
		const h = await setup({ mode, decide: async () => ({ answers: answers(d, 0.1) }) });
		const r = await h.run();
		assert.equal(Boolean(r?.block), expectBlock);
		assert.equal(h.llm, expectLlm);
		assert.equal(h.jev.n, 1);
	});
}

for (const [mode, expectBlock, expectLlm] of [["gate", false, 1], ["gate+block", false, 1], ["replace", true, 0]] as const) {
	test(`hook: Jev failure in ${mode}`, async () => {
		const h = await setup({ mode, decide: async () => { throw new JevError("timeout", "timed out"); } });
		const r = await h.run();
		assert.equal(Boolean(r?.block), expectBlock);
		assert.equal(h.llm, expectLlm);
	});
}

test("hook: deny rule blocks with zero Jev calls", async () => {
	const h = await setup({
		mode: "gate",
		decide: async () => { throw new Error("Jev must not be called"); },
		config: { permissionDeny: [parseToolPattern("bash(rm *)")!] },
	});
	const r = await h.run("rm -rf foo");
	assert.equal(r?.block, true);
	assert.equal(h.jev.n, 0);
	assert.equal(h.llm, 0);
});

function collect(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? collect(p) : [p];
	});
}

test("hook: jev entry logged when log.enabled, including LLM verdict", async () => {
	const logRoot = mkdtempSync(join(os.tmpdir(), "pi-automode-jev-hook-"));
	try {
		for (const d of [0.1, 0.5]) {
			const h = await setup({
				mode: "gate",
				decide: async () => ({ answers: answers(d, 0.1) }),
				config: { log: { enabled: true, classifierIo: false } },
				logRoot,
			});
			await h.run();
		}
		const lines = collect(logRoot).flatMap((f) => readFileSync(f, "utf8").trim().split("\n")).map((l) => JSON.parse(l));
		const jev = lines.filter((l) => l.type === "jev");
		assert.deepEqual(jev.map((l) => l.decision).sort(), ["allow", "llm:allow"]);
		assert.ok(jev.every((l) => l.stage === "per_action" && /<action>/.test(l.state)));
	} finally {
		rmSync(logRoot, { recursive: true, force: true });
	}
});

test("hook: accepted permissions.ask is authoritative below destructive block threshold (replace mode, no LLM)", async () => {
	const h = await setup({
		mode: "replace",
		decide: async () => ({ answers: answers(0.3, 0.5) }),
		config: { permissionAsk: [parseToolPattern("bash(git push*)")!] },
	});
	const r = await h.run("git push --force origin main");
	assert.equal(r?.block, undefined);
	assert.equal(h.jev.n, 1);
	assert.equal(h.llm, 0);
});

test("hook: accepted permissions.ask still blocks at destructive >= block threshold", async () => {
	const h = await setup({
		mode: "gate",
		decide: async () => ({ answers: answers(0.82, 0.1) }),
		config: { permissionAsk: [parseToolPattern("bash(git push*)")!] },
	});
	const r = await h.run("git push --force origin main");
	assert.equal(r?.block, true);
	assert.equal(h.llm, 0);
});

for (const mode of ["gate", "gate+block", "replace"] as const) {
	test(`hook: accepted ask, ${mode}: destructive 0.81 runs`, async () => {
		const h = await setup({ mode, decide: async () => ({ answers: answers(0.81, 0.9) }), config: { permissionAsk: [parseToolPattern("bash(git push*)")!] } });
		const r = await h.run("git push origin x");
		assert.equal(r?.block, undefined);
		assert.equal(h.llm, 0);
	});
	test(`hook: accepted ask, ${mode}: Jev failure -> ${mode === "replace" ? "allow" : "LLM"}`, async () => {
		const h = await setup({ mode, decide: async () => { throw new Error("down"); }, config: { permissionAsk: [parseToolPattern("bash(git push*)")!] } });
		const r = await h.run("git push origin x");
		assert.equal(r?.block, undefined);
		assert.equal(h.llm, mode === "replace" ? 0 : 1);
	});
}

// No-bypass invariant: an accepted ask never skips deterministic denials, and Jev is never called.
const NO_BYPASS: Array<{ name: string; ask: string; config?: Record<string, unknown>; tool: string; input: Record<string, unknown> }> = [
	{ name: "permissions.deny", ask: "bash", config: { permissionDeny: [parseToolPattern("bash(rm *)")!] }, tool: "bash", input: { command: "rm -rf foo" } },
	{ name: "hard-deny shell profile", ask: "bash", tool: "bash", input: { command: "echo x >> ~/.bashrc" } },
	{ name: "protected safety-control file", ask: "write", tool: "write", input: { path: ".pi/automode.local.json", content: "{}" } },
];
for (const mode of ["gate", "gate+block", "replace"] as const) {
	for (const c of NO_BYPASS) {
		test(`hook no-bypass (${mode}): accepted ask + ${c.name} blocks with zero Jev/LLM calls`, async () => {
			const h = await setup({
				mode,
				decide: async () => { throw new Error("Jev must not be called"); },
				config: { permissionAsk: [parseToolPattern(c.ask)!], ...(c.config ?? {}) },
			});
			const fake = h as unknown as { run: (cmd?: string) => Promise<{ block?: boolean } | undefined> };
			const r = c.tool === "bash" ? await fake.run(c.input.command as string) : await (h as any).runTool?.(c.tool, c.input);
			assert.equal(r?.block, true);
			assert.equal(h.jev.n, 0);
			assert.equal(h.llm, 0);
		});
	}
}

test("hook: exactly the 3 prior actions reach the Jev state", async () => {
	const fake = createFakePi();
	const states: string[] = [];
	const c: JevClient = {
		async decide(s: string) { states.push(s); return { model: "jev-1.13", reportedModel: "jev-1.13", answers: answers(0.5, 0.5), durationMs: 1 }; },
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: settings("gate") }),
		classifyAction: async () => ({ decision: "allow", tier: "none", reason: "ok" }),
		createDecisionModelClient: () => c,
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	for (const n of [1, 2, 3, 4, 5]) {
		await fake.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command: `echo step${n}` } }, ctx);
	}
	const last = states.at(-1)!;
	assert.doesNotMatch(last, /echo step1/);
	for (const n of [2, 3, 4]) assert.match(last, new RegExp(`echo step${n}`));
});

for (const [mode, s, expectBlock, expectLlm] of [
	["gate", 0.9, false, 1], ["gate+block", 0.82, true, 0], ["replace", 0.5, true, 0], ["replace", 0.18, false, 0], ["gate", 0.19, false, 1],
] as const) {
	test(`hook: scope_creep drives decision (${mode}, scope ${s})`, async () => {
		const h = await setup({ mode, decide: async () => ({ answers: answers(0.1, s) }) });
		const r = await h.run("echo hi");
		assert.equal(r?.block === true, expectBlock);
		assert.equal(h.llm, expectLlm);
	});
}
