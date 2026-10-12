import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode, parseToolPattern } from "../extensions/auto-mode.ts";
import {
	DEFAULT_DECISION_MODEL_SETTINGS,
	type DecisionModelMode,
	type JevAnswerMap,
	type JevClient,
} from "../extensions/auto-mode/decision-model.ts";
import {
	addPending,
	deliverRetry,
	setPendingIssueRecorder,
	type PendingApproval,
} from "../extensions/auto-mode/pending.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const noul = (value: number) => ({ type: "noul" as const, value });

async function setup(mode: DecisionModelMode, config: Record<string, unknown> = {}) {
	const fake = createFakePi();
	const sent: Array<{ content: string; options?: unknown }> = [];
	fake.pi.sendUserMessage = (content: string, options?: unknown) => { sent.push({ content, options }); };
	const c: JevClient = {
		async decide(_s, q): Promise<any> {
			const answers: JevAnswerMap = { destructive: noul(0.95), scope_creep: noul(0.1) };
			if ("covered_by_grant" in q) answers.covered_by_grant = noul(0.95);
			return { model: "jev-1.13", reportedModel: "jev-1.13", answers, durationMs: 1 };
		},
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	createPiAutomode({
		loadConfig: () => baseConfig({
			log: { enabled: false, classifierIo: false },
			decisionModel: { ...DEFAULT_DECISION_MODEL_SETTINGS, enabled: true, mode, endpoint: "http://localhost:30401/v1/systemone", model: "jev-1.13" },
			...config,
		}),
		classifyAction: async () => ({ decision: "allow", tier: "none", reason: "llm allow" }),
		createDecisionModelClient: () => c,
	})(fake.pi);
	const selects: string[] = [];
	const ctx: any = createFakeCtx(fake.entries);
	ctx.ui.select = async (_t: string, opts: string[]) => selects.shift() === "first" ? opts[0] : selects.length >= 0 ? opts.find((o) => o === lastChoice) : undefined;
	let lastChoice = "";
	ctx.isIdle = () => true;
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const emit = (toolName: string, input: Record<string, unknown>, c2 = ctx) =>
		fake.emit("tool_call", { type: "tool_call", toolName, input }, c2) as Promise<{ block?: boolean; reason?: string } | undefined>;
	const approve = async (choice: string, c2 = ctx) => {
		lastChoice = choice;
		selects.push("first", "choice");
		await fake.commands.get("automode")!.handler("pending", c2);
	};
	return { fake, ctx, emit, approve, sent };
}

const item = (over: Partial<PendingApproval> = {}): PendingApproval => ({
	id: "p1", ts: 1, tool: "bash", inputSummary: "{}", actionSummary: "bash rm x", reason: "r",
	questionScores: { destructive: 0.9 }, sessionId: "s", ...over,
});

test("addPending queues and records a blocked issue", () => {
	const issues: string[] = [];
	setPendingIssueRecorder((i) => issues.push(i.kind));
	assert.equal(addPending([], item()).length, 1);
	assert.deepEqual(issues, ["blocked"]);
	setPendingIssueRecorder(undefined);
});

test("deliverRetry steers a running agent and prompts a settled one", () => {
	const sent: Array<{ c: string; o?: unknown }> = [];
	const pi = { sendUserMessage: (c: string, o?: unknown) => { sent.push({ c, o }); } };
	assert.equal(deliverRetry(pi, false, item()), "steer");
	assert.equal(deliverRetry(pi, true, item()), "prompt");
	assert.deepEqual(sent[0].o, { deliverAs: "steer" });
	assert.equal(sent[1].o, undefined);
	assert.match(sent[0].c, /User approved one pending pi-automode action \(pending id p1, tool bash\)[\s\S]*not a user instruction[\s\S]*tool input: "bash rm x"/);
});

test("Jev block queues pending with skip/continue/list reason, status shows count, restores on reload", async () => {
	const h = await setup("gate+block");
	const r = await h.emit("bash", { command: "rm -rf data" });
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /SKIP/);
	assert.match(r!.reason!, /CONTINUE/);
	assert.match(r!.reason!, /LIST/);
	await h.fake.commands.get("automode")!.handler("status", h.ctx);
	assert.match(h.ctx.notifications.at(-1).message, /pending approvals: 1/);
	const restored: any = createFakeCtx(h.fake.entries);
	await h.fake.emit("session_start", { type: "session_start" }, restored);
	await h.fake.commands.get("automode")!.handler("pending", Object.assign(restored, { hasUI: false }));
	assert.match(restored.notifications.at(-1).message, /1\. bash/);
	await h.fake.commands.get("automode")!.handler("reset", restored);
	await h.fake.commands.get("automode")!.handler("status", restored);
	assert.match(restored.notifications.at(-1).message, /pending approvals: 0/);
});

test("approve + retry creates a grant that allows the same action and sends follow-up when idle", async () => {
	const h = await setup("replace");
	assert.equal((await h.emit("bash", { command: "rm -rf data" }))?.block, true);
	await h.approve("Approve + retry now");
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].options, undefined);
	assert.equal((await h.emit("bash", { command: "rm -rf data" }))?.block, undefined);
});

test("approve + retry steers when agent is running", async () => {
	const h = await setup("replace");
	await h.emit("bash", { command: "rm -rf data" });
	h.ctx.isIdle = () => false;
	await h.approve("Approve + retry now");
	assert.deepEqual(h.sent[0].options, { deliverAs: "steer" });
});

test("approve only records grant without retry", async () => {
	const h = await setup("replace");
	await h.emit("bash", { command: "rm -rf data" });
	await h.approve("Approve only");
	assert.equal(h.sent.length, 0);
	await h.fake.commands.get("automode")!.handler("status", h.ctx);
	assert.match(h.ctx.notifications.at(-1).message, /active grants: 1[\s\S]*pending approvals: 0/);
});

test("deny-rule blocks keep plain reason and are not queued", async () => {
	const h = await setup("replace", { permissionDeny: [parseToolPattern("bash(rm *)")] });
	const r = await h.emit("bash", { command: "rm -rf data" });
	assert.equal(r?.block, true);
	assert.doesNotMatch(r!.reason!, /SKIP/);
	await h.fake.commands.get("automode")!.handler("status", h.ctx);
	assert.match(h.ctx.notifications.at(-1).message, /pending approvals: 0/);
});
