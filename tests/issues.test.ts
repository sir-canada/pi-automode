import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode } from "../extensions/auto-mode.ts";
import {
	DEFAULT_DECISION_MODEL_SETTINGS,
	type DecisionModelMode,
	type JevClient,
} from "../extensions/auto-mode/decision-model.ts";
import { emitIssue, ISSUE_CHANNEL } from "../extensions/auto-mode/issues.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const noul = (value: number) => ({ type: "noul" as const, value });

function fakeBus() {
	const events: Array<{ channel: string; data: any }> = [];
	return {
		events,
		bus: {
			emit(channel: string, data: unknown) { events.push({ channel, data }); },
			on() { return () => undefined; },
		},
	};
}

async function setup(opts: {
	mode?: DecisionModelMode;
	decide?: () => Promise<any>;
	diagnostics?: string[];
	noBus?: boolean;
} = {}) {
	const fake = createFakePi();
	const b = fakeBus();
	if (!opts.noBus) fake.pi.events = b.bus;
	const c: JevClient = {
		decide: opts.decide ?? (async () => ({
			model: "jev-1.13", reportedModel: "jev-1.13",
			answers: { destructive: noul(0.95), scope_creep: noul(0.1) }, durationMs: 1,
		})),
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	const cfg = baseConfig({
		log: { enabled: false, classifierIo: false },
		decisionModel: { ...DEFAULT_DECISION_MODEL_SETTINGS, enabled: true, mode: opts.mode ?? "gate+block", endpoint: "http://localhost:30401/v1/systemone", model: "jev-1.13" },
	});
	createPiAutomode({
		...(opts.diagnostics
			? { prepareGlobalConfig: () => ({ status: "current" as const, activePath: "/nonexistent", diagnostic: opts.diagnostics![0] }) }
			: {}),
		loadConfig: () => cfg,
		classifyAction: async () => ({ decision: "allow", tier: "none", reason: "llm allow" }),
		createDecisionModelClient: () => c,
	} as any)(fake.pi);
	const ctx: any = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const tool = (command: string) => fake.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } }, ctx) as Promise<any>;
	return { fake, ctx, events: b.events, tool };
}

test("emitIssue sends exactly one bus event with the contract shape", () => {
	const b = fakeBus();
	const issue = { severity: "warning" as const, kind: "blocked" as const, title: "t", body: "b" };
	emitIssue(b.bus, issue);
	assert.deepEqual(b.events, [{ channel: ISSUE_CHANNEL, data: issue }]);
	assert.equal(ISSUE_CHANNEL, "pi-automode:issue");
});

test("emitIssue is a silent no-op without a bus and swallows listener errors", () => {
	assert.doesNotThrow(() => emitIssue(undefined, { severity: "error", kind: "failure", title: "t", body: "b" }));
	assert.doesNotThrow(() => emitIssue({ emit() { throw new Error("boom"); } }, { severity: "error", kind: "failure", title: "t", body: "b" }));
});

test("decision-model block emits one blocked warning", async () => {
	const h = await setup();
	const r = await h.tool("rm -rf build");
	assert.equal(r?.block, true);
	const issues = h.events.filter((e) => e.channel === ISSUE_CHANNEL).map((e) => e.data);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].kind, "blocked");
	assert.equal(issues[0].severity, "warning");
	assert.match(issues[0].body, /rm -rf build/);
});

test("gate-mode Jev failure emits failure but never a fallback kind", async () => {
	const h = await setup({ mode: "gate", decide: async () => { throw new Error("endpoint down"); } });
	const r = await h.tool("rm -rf build");
	assert.equal(r, undefined);
	const kinds = h.events.map((e) => e.data.kind);
	assert.deepEqual(kinds, ["failure"]);
	assert.equal(h.events[0].data.severity, "error");
	assert.match(h.events[0].data.body, /endpoint down/);
	// The LLM fallback itself (kind 4) must add no event: exactly one, the failure.
});

test("config diagnostics emit a config error at load", async () => {
	const h = await setup({ diagnostics: ["global: autoMode.decisionModel.mode must be one of gate, gate+block, replace"] });
	const cfgIssues = h.events.filter((e) => e.data.kind === "config");
	assert.equal(cfgIssues.length, 1);
	assert.equal(cfgIssues[0].data.severity, "error");
	assert.match(cfgIssues[0].data.body, /decisionModel/);
});

test("agent_settled with open pending emits stale-pending; none when empty", async () => {
	const h = await setup();
	await h.fake.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.equal(h.events.length, 0);
	await h.tool("rm -rf build");
	h.events.length = 0;
	await h.fake.emit("agent_settled", { type: "agent_settled" }, h.ctx);
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0].data.kind, "stale-pending");
	assert.equal(h.events[0].data.severity, "warning");
});

test("no bus: blocking still works without emission errors", async () => {
	const h = await setup({ noBus: true });
	const r = await h.tool("rm -rf build");
	assert.equal(r?.block, true);
	await h.fake.emit("agent_settled", { type: "agent_settled" }, h.ctx);
});
