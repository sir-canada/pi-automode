import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode, parseToolPattern } from "../extensions/auto-mode.ts";
import {
	DEFAULT_DECISION_MODEL_SETTINGS,
	JevError,
	type DecisionModelMode,
	type DecisionModelSettings,
	type JevAnswerMap,
	type JevClient,
} from "../extensions/auto-mode/decision-model.ts";
import {
	allowTierFailureCount,
	clearTaskGrants,
	decideWithGrant,
	grantsCoverPromptRisks,
	resetAllowTierFailures,
	setIssueRecorder,
	type Grant,
} from "../extensions/auto-mode/grants.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

function settings(mode: DecisionModelMode): DecisionModelSettings {
	return { ...DEFAULT_DECISION_MODEL_SETTINGS, enabled: true, mode, endpoint: "http://localhost:30401/v1/systemone", model: "jev-1.13" };
}
const noul = (value: number) => ({ type: "noul" as const, value });
const ans = (d: number, s: number, c?: number): JevAnswerMap => ({
	destructive: noul(d), scope_creep: noul(s), ...(c === undefined ? {} : { covered_by_grant: noul(c) }),
});
const grant = (over: Partial<Grant> = {}): Grant => ({
	id: "g1", text: "delete build/ directory", scope: "session", source: "dialog", risks: ["destructive"], ...over,
});

async function setup(opts: {
	mode: DecisionModelMode;
	decide: (questions: Record<string, unknown>) => Promise<JevAnswerMap>;
	grants?: Grant[];
	config?: Record<string, unknown>;
}) {
	const fake = createFakePi();
	const jev = { n: 0, questions: [] as string[][] };
	let llm = 0;
	const c: JevClient = {
		async decide(_s, q) {
			jev.n += 1;
			jev.questions.push(Object.keys(q));
			return { model: "jev-1.13", reportedModel: "jev-1.13", answers: await opts.decide(q), durationMs: 1 };
		},
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: settings(opts.mode), ...(opts.config ?? {}) }),
		classifyAction: async () => { llm += 1; return { decision: "allow", tier: "none", reason: "llm allow" }; },
		createDecisionModelClient: () => c,
	})(fake.pi);
	if (opts.grants) {
		fake.entries.push({ type: "custom", customType: "pi-automode-state", data: { checkedActions: 0, blockedActions: 0, classifierAllowed: 0, classifierDenied: 0, recentDenials: [], grants: opts.grants } });
	}
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const emit = (toolName: string, input: Record<string, unknown>) =>
		fake.emit("tool_call", { type: "tool_call", toolName, input }, ctx) as Promise<{ block?: boolean } | undefined>;
	return { fake, ctx, emit, jev, get llm() { return llm; } };
}

test("decideWithGrant: covered_by_grant threshold boundaries", () => {
	const s = settings("gate");
	assert.equal(decideWithGrant(s, ans(0.5, 0.5, 0.82), false).result, "allow");
	assert.equal(decideWithGrant(s, ans(0.5, 0.5, 0.81), false).result, "llm");
	assert.equal(decideWithGrant(s, ans(0.1, 0.1, 0.5), false).result, "llm");
	assert.equal(decideWithGrant(s, ans(0.9, 0.1, 0.9), true).result, "llm", "truncated never auto-allowed");
	assert.equal(decideWithGrant(settings("replace"), ans(0.9, 0.9, 0.95), false).result, "allow");
	assert.equal(decideWithGrant(settings("replace"), ans(0.1, 0.1, 0.5), false).result, "block");
	assert.equal(decideWithGrant(settings("gate+block"), ans(0.9, 0.1, 0.5), false).result, "block");
	assert.throws(() => decideWithGrant(s, ans(0.1, 0.1), false), JevError);
});

test("hook: grant overrides high risk in gate (LLM not called)", async () => {
	const h = await setup({ mode: "gate", grants: [grant()], decide: async () => ans(0.9, 0.5, 0.95) });
	const r = await h.emit("bash", { command: "rm -rf build" });
	assert.equal(r?.block, undefined);
	assert.equal(h.llm, 0);
	assert.deepEqual(h.jev.questions[0], ["destructive", "scope_creep", "covered_by_grant"]);
});

test("hook: grant overrides in replace; weak match blocks", async () => {
	const ok = await setup({ mode: "replace", grants: [grant()], decide: async () => ans(0.5, 0.9, 0.9) });
	assert.equal((await ok.emit("bash", { command: "rm -rf build" }))?.block, undefined);
	const weak = await setup({ mode: "replace", grants: [grant()], decide: async () => ans(0.1, 0.1, 0.3) });
	assert.equal((await weak.emit("bash", { command: "rm -rf build" }))?.block, true);
	assert.equal(weak.llm, 0);
});

test("hook: no grants => no covered_by_grant question", async () => {
	const h = await setup({ mode: "gate", decide: async () => ans(0.1, 0.1) });
	await h.emit("bash", { command: "echo hi" });
	assert.deepEqual(h.jev.questions[0], ["destructive", "scope_creep"]);
});

test("bypass invariant: deny rule blocks despite a matching grant", async () => {
	const h = await setup({
		mode: "replace", grants: [grant({ text: "rm -rf anything" })],
		decide: async () => ans(0, 0, 1),
		config: { permissionDeny: [parseToolPattern("bash(rm *)")!] },
	});
	assert.equal((await h.emit("bash", { command: "rm -rf foo" }))?.block, true);
	assert.equal(h.jev.n, 0);
});

test("allow-tier scope_creep: low allows, high escalates, read-only skipped", async () => {
	const cfg = { allowInsideWorkingDirectory: true };
	const low = await setup({ mode: "replace", config: cfg, decide: async () => ({ scope_creep: noul(0.5) }) });
	assert.equal((await low.emit("write", { path: "/tmp/project/a.txt", content: "x" }))?.block, undefined);
	assert.deepEqual(low.jev.questions[0], ["scope_creep"]);
	await low.emit("read", { path: "/tmp/project/a.txt" });
	assert.equal(low.jev.n, 1);
	let n = 0;
	const high = await setup({ mode: "replace", config: cfg, decide: async () => (n++ === 0 ? { scope_creep: noul(0.9) } : ans(0.5, 0.5)) });
	assert.equal((await high.emit("write", { path: "/tmp/project/a.txt", content: "x" }))?.block, true);
	assert.equal(high.jev.n, 2);
});

test("allow-tier: Jev failure fails open, is counted and recorded", async () => {
	resetAllowTierFailures();
	const issues: unknown[] = [];
	try {
		const h = await setup({
			mode: "replace", config: { permissionAllow: [parseToolPattern("bash(echo *)")!] },
			decide: async () => { throw new JevError("timeout", "timed out"); },
		});
		// session_start installs the extension's issue recorder; override after it.
		setIssueRecorder((i) => issues.push(i));
		assert.equal((await h.emit("bash", { command: "echo hi" }))?.block, undefined);
		assert.equal(allowTierFailureCount(), 1);
		assert.equal(issues.length, 1);
	} finally {
		setIssueRecorder(undefined);
	}
});

test("clearTaskGrants keeps session grants; before_agent_start clears task grants", async () => {
	assert.deepEqual(clearTaskGrants([grant(), grant({ id: "g2", scope: "task" })]).map((g) => g.id), ["g1"]);
	const h = await setup({ mode: "gate", grants: [grant(), grant({ id: "g2", scope: "task" })], decide: async () => ans(0, 0, 1) });
	await h.fake.emit("before_agent_start", { prompt: "next", systemPrompt: "" }, h.ctx);
	await h.fake.commands.get("automode")!.handler("grants", h.ctx);
	const msg = h.ctx.notifications.at(-1)!.message;
	assert.match(msg, /g1 \[session\]/);
	assert.doesNotMatch(msg, /g2/);
});

test("/automode grants lists and clears; status shows grants", async () => {
	const h = await setup({ mode: "gate", grants: [grant()], decide: async () => ans(0, 0, 1) });
	const cmd = h.fake.commands.get("automode")!;
	await cmd.handler("grants", h.ctx);
	assert.match(h.ctx.notifications.at(-1)!.message, /g1 \[session\] delete build\/ directory\n  risks: destructive/);
	await cmd.handler("status", h.ctx);
	assert.match(h.ctx.notifications.at(-1)!.message, /active grants: 1/);
	await cmd.handler("grants clear", h.ctx);
	await cmd.handler("grants", h.ctx);
	assert.match(h.ctx.notifications.at(-1)!.message, /No active pi-automode grants/);
});

test("grantsCoverPromptRisks is conservative", () => {
	assert.equal(grantsCoverPromptRisks([grant()], ["destructive"]), true);
	assert.equal(grantsCoverPromptRisks([grant()], ["destructive", "scope_creep"]), false);
	assert.equal(grantsCoverPromptRisks([grant()], []), false);
	assert.equal(grantsCoverPromptRisks([grant({ scope: "task" })], ["destructive"]), false);
	assert.equal(grantsCoverPromptRisks([], ["destructive"]), false);
});
