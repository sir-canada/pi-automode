import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode } from "../extensions/auto-mode.ts";
import {
	DEFAULT_DECISION_MODEL_SETTINGS,
	type DecisionModelSettings,
	type JevAnswerMap,
	type JevClient,
} from "../extensions/auto-mode/decision-model.ts";
import type { Grant } from "../extensions/auto-mode/grants.ts";
import {
	buildPreflightQuestions,
	DIALOG_APPROVE_SESSION,
	DIALOG_APPROVE_TASK,
	DIALOG_CANCEL,
	DIALOG_EDIT,
	mapPreflightAction,
	selectScopeSource,
	type DraftFn,
} from "../extensions/auto-mode/preflight.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const settings = (over: Partial<DecisionModelSettings> = {}): DecisionModelSettings => ({
	...DEFAULT_DECISION_MODEL_SETTINGS, enabled: true, endpoint: "http://localhost:30401/v1/systemone", model: "jev-1.13", timeoutMs: 1000, ...over,
});
const noul = (value: number) => ({ type: "noul" as const, value });
const answers = (risk: number, clarity = 0, which = "destructive"): JevAnswerMap => {
	const a: JevAnswerMap = { destructive: noul(0), exfiltration: noul(0), security_weakening: noul(0), needs_scope_beyond_ask: noul(0), scope_clarity: { type: "score", value: clarity } };
	a[which] = noul(risk);
	return a;
};

async function setup(opts: {
	decide: () => Promise<JevAnswerMap>;
	grants?: Grant[];
	choices?: string[];
	edits?: string[];
	draft?: DraftFn;
	noUi?: boolean;
	entries?: any[];
	pf?: Partial<DecisionModelSettings>;
}) {
	const fake = createFakePi();
	const jev = { states: [] as string[], questions: [] as string[][] };
	const c: JevClient = {
		async decide(s, q) {
			jev.states.push(s);
			jev.questions.push(Object.keys(q));
			return { model: "jev-1.13", reportedModel: "jev-1.13", answers: await opts.decide(), durationMs: 1 };
		},
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	const drafts: string[] = [];
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: settings(opts.pf) }),
		classifyAction: async () => ({ decision: "allow", tier: "none", reason: "ok" }),
		createDecisionModelClient: () => c,
		draftScope: opts.draft ?? (async (i) => { drafts.push(i.prompt); return "delete ./build only; exclude src/"; }),
	})(fake.pi);
	if (opts.grants) fake.entries.push({ type: "custom", customType: "pi-automode-state", data: { checkedActions: 0, blockedActions: 0, classifierAllowed: 0, classifierDenied: 0, recentDenials: [], grants: opts.grants } });
	for (const e of opts.entries ?? []) fake.entries.push(e);
	const ctx: any = createFakeCtx(fake.entries, opts.noUi ? { mode: "print", hasUI: false } : {});
	const choices = [...(opts.choices ?? [])];
	const edits = [...(opts.edits ?? [])];
	const dialogs: string[] = [];
	let aborted = 0;
	ctx.abort = () => { aborted += 1; };
	ctx.ui.select = async (title: string) => { dialogs.push(title); return choices.shift(); };
	ctx.ui.editor = async (_t: string, prefill?: string) => edits.shift() ?? prefill;
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const start = (prompt: string) => fake.emit("before_agent_start", { prompt, systemPrompt: "base", systemPromptOptions: { contextFiles: [] } }, ctx) as Promise<{ systemPrompt: string }>;
	const grants = async () => {
		await fake.commands.get("automode")!.handler("grants", ctx);
		return ctx.notifications.at(-1)!.message as string;
	};
	return { start, jev, dialogs, drafts, grants, get aborted() { return aborted; } };
}

test("mapPreflightAction boundaries 0.39/0.4/0.79/0.8", () => {
	const t = { dialog: 0.8, prompt: 0.4 };
	assert.equal(mapPreflightAction(0.39, t), "none");
	assert.equal(mapPreflightAction(0.4, t), "guidance");
	assert.equal(mapPreflightAction(0.79, t), "guidance");
	assert.equal(mapPreflightAction(0.8, t), "dialog");
});

test("selectScopeSource at 1.49/1.5 and five questions", () => {
	assert.equal(selectScopeSource(1.49, 1.5), "template");
	assert.equal(selectScopeSource(1.5, 1.5), "draft");
	const q = buildPreflightQuestions(settings());
	assert.deepEqual(Object.keys(q).sort(), ["destructive", "exfiltration", "needs_scope_beyond_ask", "scope_clarity", "security_weakening"]);
	assert.equal(q.scope_clarity!.type, "score");
	assert.ok(Array.isArray(q.scope_clarity!.criteria), "score criteria must be an array (strict endpoints reject a string)");
	assert.equal((q.scope_clarity!.criteria as string[]).length, 4);
	assert.match((q.scope_clarity!.criteria as string[])[0], /delete \.\/build/);
});

test("hook: < 0.4 nothing; 0.4-0.8 appends guidance without dialog", async () => {
	const low = await setup({ decide: async () => answers(0.39) });
	const r1 = await low.start("hi");
	assert.doesNotMatch(r1.systemPrompt, /confirm scope first/);
	assert.match(r1.systemPrompt, /^base\n\n## Auto Mode Active/);
	const mid = await setup({ decide: async () => answers(0.79, 0, "exfiltration") });
	const r2 = await mid.start("send it");
	assert.match(r2.systemPrompt, /confirm scope first/);
	assert.match(r2.systemPrompt, /exfiltration/);
	assert.equal(mid.dialogs.length, 0);
	assert.equal(mid.jev.questions[0]!.length, 5);
});

test("hook: reply context (agent last message) reaches the state", async () => {
	const h = await setup({
		decide: async () => answers(0),
		entries: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Should I rm -rf ~/projects/old?" }] } }],
	});
	await h.start("ok");
	assert.match(h.jev.states[0]!, /<agent_last_message>\nShould I rm -rf ~\/projects\/old\?/);
	assert.match(h.jev.states[0]!, /judge what they are agreeing to/);
});

test("hook: skip when session grant covers; no skip when not covering", async () => {
	const g: Grant = { id: "g1", text: "delete build", scope: "session", source: "dialog", risks: ["destructive"] };
	const covered = await setup({ grants: [g], decide: async () => answers(0.9) });
	const r = await covered.start("delete build again");
	assert.equal(covered.dialogs.length, 0);
	assert.doesNotMatch(r.systemPrompt, /confirm scope first/);
	const unsure = await setup({ grants: [g], decide: async () => answers(0.9, 0, "exfiltration"), choices: [DIALOG_CANCEL] });
	await unsure.start("upload");
	assert.equal(unsure.dialogs.length, 1);
});

test("hook: Jev failure and timeout start normally, no grant, no delay", async () => {
	const fail = await setup({ decide: async () => { throw new Error("down"); } });
	const r = await fail.start("rm everything");
	assert.match(r.systemPrompt, /Auto Mode Active/);
	assert.match(await fail.grants(), /No active/);
	const slow = await setup({ pf: { timeoutMs: 50, totalTimeoutMs: 50 }, decide: () => new Promise(() => {}) });
	const t0 = Date.now();
	await slow.start("x");
	assert.ok(Date.now() - t0 < 1000);
	assert.equal(slow.dialogs.length, 0);
	assert.match(await slow.grants(), /No active/);
});

test("hook: template below 1.5 stores original prompt; session grant", async () => {
	const h = await setup({ decide: async () => answers(0.9, 1.49), choices: [DIALOG_APPROVE_SESSION] });
	await h.start("delete ./build");
	assert.equal(h.drafts.length, 0);
	assert.match(h.dialogs[0]!, /Approved for prompt "delete \.\/build": destructive/);
	const msg = await h.grants();
	assert.match(msg, /\[session\]/);
	assert.match(msg, /User prompt: "delete \.\/build"/);
});

test("hook: draft at 1.5 stores draft and original; task grant", async () => {
	const h = await setup({ decide: async () => answers(0.9, 1.5), choices: [DIALOG_APPROVE_TASK] });
	await h.start("clean up old stuff");
	assert.equal(h.drafts.length, 1);
	const msg = await h.grants();
	assert.match(msg, /\[task\]/);
	assert.match(msg, /delete \.\/build only/);
	assert.match(msg, /User prompt: "clean up old stuff"/);
});

test("hook: draft timeout falls back to template with note", async () => {
	const h = await setup({
		pf: { preflight: { ...DEFAULT_DECISION_MODEL_SETTINGS.preflight, draftTimeoutMs: 30 } },
		decide: async () => answers(0.9, 3),
		draft: () => new Promise(() => {}),
		choices: [DIALOG_APPROVE_SESSION],
	});
	await h.start("clean up");
	assert.match(h.dialogs[0]!, /draft unavailable/);
	assert.match(await h.grants(), /Approved for prompt "clean up"/);
});

test("hook: edit scope then approve; cancel aborts", async () => {
	const h = await setup({ decide: async () => answers(0.9), choices: [DIALOG_EDIT, DIALOG_APPROVE_SESSION], edits: ["only ./dist"] });
	await h.start("delete stuff");
	assert.equal(h.dialogs.length, 2);
	assert.match(await h.grants(), /Scope: only \.\/dist/);
	const c = await setup({ decide: async () => answers(0.9), choices: [DIALOG_CANCEL] });
	const r = await c.start("delete stuff");
	assert.equal(c.aborted, 1);
	assert.match(r.systemPrompt, /request cancelled/);
	assert.match(await c.grants(), /No active/);
});

test("hook: no UI at >= 0.8 injects chat-confirm guidance", async () => {
	const h = await setup({ noUi: true, decide: async () => answers(0.95) });
	const r = await h.start("rm -rf ~");
	assert.equal(h.dialogs.length, 0);
	assert.match(r.systemPrompt, /confirm scope first/);
});

test("hook: cancel blocks every tool_call until the next prompt", async () => {
	const fake = createFakePi();
	let n = 0;
	const c: JevClient = {
		async decide() { n += 1; return { model: "jev-1.13", reportedModel: "jev-1.13", answers: n === 1 ? answers(0.9) : answers(0.0), durationMs: 1 }; },
		async probe() { return { model: "jev-1.13", reportedModel: "jev-1.13", answers: {}, durationMs: 1 }; },
		reportedModel: undefined,
	};
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: settings(), permissionAllow: [] }),
		classifyAction: async () => ({ decision: "allow", tier: "none", reason: "ok" }),
		createDecisionModelClient: () => c,
	})(fake.pi);
	const ctx: any = createFakeCtx(fake.entries);
	ctx.abort = () => {};
	ctx.ui.select = async () => DIALOG_CANCEL;
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const start = (prompt: string) => fake.emit("before_agent_start", { prompt, systemPrompt: "base", systemPromptOptions: { contextFiles: [] } }, ctx);
	const call = () => fake.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command: "echo hi" } }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	await start("delete stuff");
	const blocked = await call();
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /cancelled/);
	await start("what time is it");
	const after = await call();
	assert.notEqual(after?.reason ?? "", blocked?.reason);
});
