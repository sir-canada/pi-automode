import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_DECISION_MODEL_QUESTIONS,
	buildEffectiveConfigFromSources,
	createPiAutomode,
	loadEffectiveConfigWithDiagnostics,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";
import {
	JevError,
	createDecisionModelClient,
	decisionModelHealth,
	parseJevResponse,
	resetDecisionModelSession,
	type DecisionModelSettings,
	type JevFetch,
	type JevQuestionMap,
} from "../extensions/auto-mode/decision-model.ts";
import { createLogger, logJevCall } from "../extensions/auto-mode/log.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const ENDPOINT = "http://localhost:30401/v1/systemone";

function validBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		endpoint: ENDPOINT,
		model: "jev-1.13",
		apiKeyEnv: "JEV_API_KEY",
		...overrides,
	};
}

function testSettings(overrides: Partial<DecisionModelSettings> = {}): DecisionModelSettings {
	return {
		enabled: true,
		mode: "gate",
		endpoint: ENDPOINT,
		model: "jev-1.13",
		apiKeyEnv: "JEV_API_KEY",
		timeoutMs: 3000,
		thresholds: {
			destructive: { allow: 0.18, block: 0.82 },
			scope_creep: { allow: 0.18, block: 0.82 },
			covered_by_grant: { allow: 0.82 },
		},
		preflight: {
			thresholds: { dialog: 0.8, prompt: 0.4 },
			draftThreshold: 1.5,
			draftTimeoutMs: 10000,
		},
		questions: DEFAULT_DECISION_MODEL_QUESTIONS,
		...overrides,
	};
}

type RecordedCall = { url: string; init?: RequestInit };

function recordingFetch(
	handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetch: JevFetch } {
	const calls: RecordedCall[] = [];
	const doFetch: JevFetch = async (url, init) => {
		const call: RecordedCall = { url, init };
		calls.push(call);
		return handler(call, calls.length - 1);
	};
	return { calls, fetch: doFetch };
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const OK_PAYLOAD = {
	model: "jev-1.13",
	answers: { destructive: { type: "noul", value: 0.1 } },
};

const SAMPLE_STATE = "action: read README.md\ncwd: /tmp/project";
const SAMPLE_QUESTIONS: JevQuestionMap = {
	destructive: { type: "noul", text: "Is this destructive?" },
};

test("decisionModel block validates and applies plan defaults", () => {
	assert.deepEqual(
		validateSettingsFile({ autoMode: { decisionModel: validBlock() } }, "test-config"),
		[],
	);

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock() } }],
	});
	const decisionModel = config.decisionModel;
	assert.ok(decisionModel);
	assert.equal(decisionModel.enabled, true);
	assert.equal(decisionModel.mode, "gate");
	assert.equal(decisionModel.endpoint, ENDPOINT);
	assert.equal(decisionModel.model, "jev-1.13");
	assert.equal(decisionModel.apiKeyEnv, "JEV_API_KEY");
	assert.equal(decisionModel.timeoutMs, 3000);
	assert.deepEqual(decisionModel.thresholds, {
		destructive: { allow: 0.18, block: 0.82 },
		scope_creep: { allow: 0.18, block: 0.82 },
		covered_by_grant: { allow: 0.82 },
	});
	assert.deepEqual(decisionModel.preflight, {
		thresholds: { dialog: 0.8, prompt: 0.4 },
		draftThreshold: 1.5,
		draftTimeoutMs: 10000,
	});
	assert.deepEqual(
		Object.keys(decisionModel.questions).sort(),
		Object.keys(DEFAULT_DECISION_MODEL_QUESTIONS).sort(),
	);
});

test("decisionModel is absent by default so behaviour stays as today", () => {
	assert.equal(buildEffectiveConfigFromSources({}).decisionModel, undefined);
});

test("invalid decisionModel blocks are diagnosed and the block is ignored", () => {
	const invalidBlocks: unknown[] = [
		"nope",
		["enabled"],
		{ enabled: "yes" },
		{ mode: "yes" },
		{ endpoint: "not a url" },
		{ endpoint: "ftp://internal/systemone" },
		{ model: "" },
		{ model: 42 },
		{ apiKeyEnv: "" },
		{ timeoutMs: "3000" },
		{ timeoutMs: 2500.5 },
		{ thresholds: "no" },
		{ thresholds: { unknown_check: { allow: 0.1 } } },
		{ thresholds: { destructive: { allow: 2 } } },
		{ thresholds: { destructive: { allow: -0.1 } } },
		{ thresholds: { destructive: { allow: 0.9 } } },
		{ thresholds: { covered_by_grant: { block: 0.5 } } },
		{ preflight: { thresholds: { dialog: 1.5 } } },
		{ preflight: { draftThreshold: -1 } },
		{ preflight: { draftTimeoutMs: "10000" } },
		{ questions: [] },
		{ questions: { "$defaults": "yes" } },
		{ questions: { destructive: { type: "maybe", text: "x" } } },
		{ questions: { destructive: { type: "noul" } } },
		{ questions: { destructive: { type: "noul", text: "x", typo: 1 } } },
		{ enabled: true, typo: 1 },
	];
	for (const block of invalidBlocks) {
		const label = JSON.stringify(block) ?? String(block);
		const diagnostics = validateSettingsFile(
			{ autoMode: { decisionModel: block } } as never,
			"test-config",
		);
		assert.ok(diagnostics.length > 0, `expected diagnostics for ${label}`);
		const config = buildEffectiveConfigFromSources({
			globalSettings: [{ autoMode: { decisionModel: block } } as never],
		});
		assert.equal(config.decisionModel, undefined, `expected block ignored for ${label}`);
	}
});

test("valid decisionModel variants are accepted", () => {
	assert.deepEqual(
		validateSettingsFile(
			{
				autoMode: {
					decisionModel: {
						mode: "gate+block",
						endpoint: "https://jev.example.com/v1/systemone",
						model: "jev-1.13",
						timeoutMs: 500,
						thresholds: {
							destructive: { allow: 0.3, block: 0.9 },
							scope_creep: { allow: 0.1, block: 0.7 },
							covered_by_grant: { allow: 0.95 },
						},
						preflight: {
							thresholds: { dialog: 0.9, prompt: 0.5 },
							draftThreshold: 2,
							draftTimeoutMs: 8000,
						},
						questions: { "$defaults": true },
					},
				},
			},
			"test-config",
		),
		[],
	);
});

test("shared project config cannot set decisionModel", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [{ autoMode: { decisionModel: validBlock() } }],
	});
	assert.equal(config.decisionModel, undefined);
});

test("shared project decisionModel is rejected with a diagnostic", () => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-shared-jev-"));
	try {
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(project, ".pi/automode.json"),
			JSON.stringify({ autoMode: { decisionModel: validBlock() } }),
		);

		// Isolate from the real global config, which may enable decisionModel.
		const { config, diagnostics } = loadEffectiveConfigWithDiagnostics(
			project,
			true,
			join(project, "no-global-config.json"),
		);

		assert.equal(config.decisionModel, undefined);
		assert.equal(
			diagnostics.some((line) =>
				line.includes(join(project, ".pi/automode.json")) &&
				line.includes("decisionModel") &&
				line.includes("ignored")
			),
			true,
			diagnostics.join("\n"),
		);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("decisionModel is settable from global, project-local, and inline config", () => {
	for (
		const source of ["globalSettings", "projectLocalSettings", "inlineSettings"] as const
	) {
		const config = buildEffectiveConfigFromSources({
			[source]: [{ autoMode: { decisionModel: validBlock() } }],
		});
		assert.ok(config.decisionModel, `expected decisionModel from ${source}`);
		assert.equal(config.decisionModel.enabled, true);
	}
});

test("decisionModel merges across sources and invalid higher-precedence blocks are ignored", () => {
	const merged = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock({ timeoutMs: 5000 }) } }],
		inlineSettings: [{ autoMode: { decisionModel: { mode: "replace" } } }],
	});
	assert.equal(merged.decisionModel?.mode, "replace");
	assert.equal(merged.decisionModel?.timeoutMs, 5000);

	const invalidHigher = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock() } }],
		inlineSettings: [{ autoMode: { decisionModel: { mode: "yes" } } }],
	});
	assert.equal(invalidHigher.decisionModel?.mode, "gate");
	assert.equal(invalidHigher.decisionModel?.enabled, true);

	const disabled = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock() } }],
		projectLocalSettings: [{ autoMode: { decisionModel: { enabled: false } } }],
	});
	assert.equal(disabled.decisionModel?.enabled, false);
	assert.equal(disabled.decisionModel?.endpoint, ENDPOINT);
});

test("decisionModel timeoutMs defaults to 3000 and clamps to 1000..30000", () => {
	const low = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock({ timeoutMs: 500 }) } }],
	});
	assert.equal(low.decisionModel?.timeoutMs, 1000);
	const high = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { decisionModel: validBlock({ timeoutMs: 999999 }) } }],
	});
	assert.equal(high.decisionModel?.timeoutMs, 30000);
	assert.deepEqual(
		validateSettingsFile(
			{ autoMode: { decisionModel: validBlock({ timeoutMs: 500 }) } },
			"test-config",
		),
		[],
	);
});

test("decisionModel thresholds merge per check over the plan defaults", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{
			autoMode: {
				decisionModel: validBlock({
					thresholds: {
						destructive: { allow: 0.3, block: 0.9 },
						covered_by_grant: { allow: 0.95 },
					},
				}),
			},
		}],
	});
	assert.deepEqual(config.decisionModel?.thresholds, {
		destructive: { allow: 0.3, block: 0.9 },
		scope_creep: { allow: 0.18, block: 0.82 },
		covered_by_grant: { allow: 0.95 },
	});
});

test("decisionModel questions merge with $defaults like other rule lists", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{
			autoMode: {
				decisionModel: validBlock({
					questions: {
						"$defaults": true,
						destructive: { type: "noul", text: "custom destructive question" },
					},
				}),
			},
		}],
	});
	const questions = config.decisionModel?.questions ?? {};
	assert.equal("$defaults" in questions, false);
	assert.equal(questions.destructive?.text, "custom destructive question");
	assert.ok(questions.scope_creep, "built-in scope_creep question kept");
	assert.ok(questions.covered_by_grant, "built-in covered_by_grant question kept");
	assert.ok(questions.scope_clarity, "built-in scope_clarity question kept");
});

test("decisionModel questions without $defaults replace the built-ins", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{
			autoMode: {
				decisionModel: validBlock({
					questions: { destructive: { type: "noul", text: "only question" } },
				}),
			},
		}],
	});
	assert.deepEqual(Object.keys(config.decisionModel?.questions ?? {}), ["destructive"]);
	assert.equal(config.decisionModel?.questions.destructive.text, "only question");

	const diagnostics = validateSettingsFile(
		{
			autoMode: {
				decisionModel: validBlock({
					questions: { destructive: { type: "noul", text: "only question" } },
				}),
			},
		},
		"test-config",
	);
	assert.equal(
		diagnostics.some((line) => line.includes('omits "$defaults"')),
		true,
		diagnostics.join("\n"),
	);
});

test("decisionModel question $defaults follows rule-list precedence across sources", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{
			autoMode: {
				decisionModel: validBlock({
					questions: { "$defaults": true, destructive: { type: "noul", text: "global q" } },
				}),
			},
		}],
		inlineSettings: [{
			autoMode: {
				decisionModel: { questions: { scope_creep: { type: "noul", text: "inline q" } } },
			},
		}],
	});
	// Same as other rule lists: entries accumulate, the last source decides
	// whether the built-ins are kept.
	assert.deepEqual(
		Object.keys(config.decisionModel?.questions ?? {}).sort(),
		["destructive", "scope_creep"],
	);
	assert.equal(config.decisionModel?.questions.destructive.text, "global q");
	assert.equal(config.decisionModel?.questions.scope_creep.text, "inline q");
});

test("enabled decisionModel without endpoint or model is reported and ignored at load", () => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-jev-incomplete-"));
	const globalPath = join(project, "global.json");
	try {
		writeFileSync(
			globalPath,
			JSON.stringify({ autoMode: { decisionModel: { enabled: true, model: "jev-1.13" } } }),
		);
		const { config, diagnostics } = loadEffectiveConfigWithDiagnostics(
			join(project, "empty-cwd"),
			false,
			globalPath,
		);
		assert.equal(config.decisionModel, undefined);
		assert.equal(
			diagnostics.some((line) => line.includes("endpoint and model")),
			true,
			diagnostics.join("\n"),
		);

		// A disabled partial block is kept: it must stay possible to disable
		// the feature without repeating the endpoint.
		writeFileSync(
			globalPath,
			JSON.stringify({ autoMode: { decisionModel: { enabled: false } } }),
		);
		const kept = loadEffectiveConfigWithDiagnostics(
			join(project, "empty-cwd"),
			false,
			globalPath,
		);
		assert.equal(kept.config.decisionModel?.enabled, false);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("parseJevResponse accepts the documented shape", () => {
	const parsed = parseJevResponse({
		model: "jev-1.13",
		answers: {
			destructive: { type: "noul", value: 0.2 },
			scope_clarity: { type: "score", value: 2 },
			pick: { type: "choice", value: "yes" },
		},
	});
	assert.equal(parsed.model, "jev-1.13");
	assert.equal(parsed.answers.destructive.value, 0.2);
	assert.equal(parsed.answers.scope_clarity.value, 2);
	assert.equal(parsed.answers.pick.value, "yes");
});

test("parseJevResponse rejects malformed shapes with a shape error", () => {
	const malformed: unknown[] = [
		undefined,
		"string",
		[],
		{ answers: {} },
		{ model: "" },
		{ model: 5, answers: {} },
		{ model: "jev-1.13" },
		{ model: "jev-1.13", answers: [] },
		{ model: "jev-1.13", answers: { a: "nope" } },
		{ model: "jev-1.13", answers: { a: { type: "weird", value: 1 } } },
		{ model: "jev-1.13", answers: { a: { type: "noul", value: "high" } } },
		{ model: "jev-1.13", answers: { a: { type: "score", value: Number.NaN } } },
		{ model: "jev-1.13", answers: { a: { type: "choice", value: 3 } } },
	];
	for (const value of malformed) {
		assert.throws(
			() => parseJevResponse(value),
			(error: unknown) => error instanceof JevError && error.kind === "shape",
			`expected shape error for ${JSON.stringify(value)}`,
		);
	}
});

test("decide POSTs model, state, and questions to the configured endpoint", async () => {
	const { calls, fetch } = recordingFetch(() => jsonResponse(OK_PAYLOAD));
	const client = createDecisionModelClient(testSettings(), { fetch });
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, ENDPOINT);
	assert.equal(calls[0].init?.method, "POST");
	const body = JSON.parse(String(calls[0].init?.body));
	assert.equal(body.model, "jev-1.13");
	assert.equal(body.state, SAMPLE_STATE);
	// Wire shape: question text is folded into instructions (strict endpoints reject `text`).
	assert.deepEqual(body.questions, { destructive: { type: "noul", instructions: "Is this destructive?" } });
});

test("decide surfaces timeouts as a timeout error", async () => {
	const fetch: JevFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
		});
	const client = createDecisionModelClient(testSettings(), { fetch });
	await assert.rejects(
		client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS, { timeoutMs: 10 }),
		(error: unknown) => error instanceof JevError && error.kind === "timeout",
	);
});

test("decide surfaces HTTP, parse, shape, and network failures", async () => {
	const cases: Array<{ name: string; fetch: JevFetch; kind: string; status?: number }> = [
		{
			name: "http",
			fetch: async () => new Response("boom", { status: 503 }),
			kind: "http",
			status: 503,
		},
		{
			name: "parse",
			fetch: async () => new Response("{not json", { status: 200 }),
			kind: "parse",
		},
		{
			name: "shape",
			fetch: async () => jsonResponse({ model: "jev-1.13" }),
			kind: "shape",
		},
		{
			name: "network",
			fetch: async () => {
				throw new TypeError("connect ECONNREFUSED 127.0.0.1:30401");
			},
			kind: "network",
		},
	];
	for (const entry of cases) {
		resetDecisionModelSession();
		const client = createDecisionModelClient(testSettings(), { fetch: entry.fetch });
		await assert.rejects(
			client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
			(error: unknown) => {
				assert.ok(error instanceof JevError, `${entry.name}: expected JevError`);
				assert.equal(error.kind, entry.kind);
				if (entry.status !== undefined) assert.equal(error.status, entry.status);
				return true;
			},
			entry.name,
		);
	}
});

test("decide sends the bearer token only when apiKeyEnv resolves", async () => {
	const { calls, fetch } = recordingFetch(() => jsonResponse(OK_PAYLOAD));
	const client = createDecisionModelClient(testSettings(), { fetch });
	try {
		process.env.JEV_API_KEY = "sekret-token";
		await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
		const authHeaders = (calls[0].init?.headers as Record<string, string> | undefined) ?? {};
		assert.equal(authHeaders.Authorization, "Bearer sekret-token");

		delete process.env.JEV_API_KEY;
		await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
		const secondHeaders = (calls[1].init?.headers as Record<string, string> | undefined) ?? {};
		assert.equal(secondHeaders.Authorization, undefined);
	} finally {
		delete process.env.JEV_API_KEY;
	}
});

test("circuit breaker opens after three failures and recovers half-open", async () => {
	resetDecisionModelSession();
	let clock = 1_000_000;
	let failing = true;
	const { calls, fetch } = recordingFetch(() => {
		if (failing) throw new TypeError("connect ECONNREFUSED 127.0.0.1:30401");
		return jsonResponse(OK_PAYLOAD);
	});
	const client = createDecisionModelClient(testSettings(), { fetch, now: () => clock });

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await assert.rejects(
			client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
			(error: unknown) => error instanceof JevError && error.kind === "network",
		);
	}
	assert.equal(calls.length, 3);
	assert.equal(decisionModelHealth(), "unavailable");

	// Open: short-circuit with no network I/O.
	await assert.rejects(
		client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
		(error: unknown) => error instanceof JevError && error.kind === "unavailable",
	);
	assert.equal(calls.length, 3);

	// Still open before the 60s cooldown ends.
	clock += 59_000;
	await assert.rejects(
		client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
		(error: unknown) => error instanceof JevError && error.kind === "unavailable",
	);
	assert.equal(calls.length, 3);

	// Expiry: the next call is a half-open probe; success closes the breaker.
	clock += 1_000;
	failing = false;
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(calls.length, 4);
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(calls.length, 5);
	assert.equal(decisionModelHealth(), "healthy");
});

test("a failing half-open probe re-opens the circuit", async () => {
	resetDecisionModelSession();
	let clock = 5_000_000;
	const { calls, fetch } = recordingFetch(() => {
		throw new TypeError("connect ECONNREFUSED 127.0.0.1:30401");
	});
	const client = createDecisionModelClient(testSettings(), { fetch, now: () => clock });
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await assert.rejects(client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS));
	}
	clock += 60_000;
	await assert.rejects(
		client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
		(error: unknown) => error instanceof JevError && error.kind === "network",
	);
	assert.equal(calls.length, 4);
	await assert.rejects(
		client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS),
		(error: unknown) => error instanceof JevError && error.kind === "unavailable",
	);
	assert.equal(calls.length, 4, "open breaker must not reach the network");
});

test("model mismatch warns once per session and records the reported model", async () => {
	resetDecisionModelSession();
	const warnings: string[] = [];
	const { fetch } = recordingFetch(() =>
		jsonResponse({ model: "jev-1.13-free", answers: {} }));
	const client = createDecisionModelClient(testSettings(), {
		fetch,
		warn: (message) => warnings.push(message),
	});

	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /jev-1\.13/);
	assert.match(warnings[0], /jev-1\.13-free/);
	assert.equal(client.reportedModel, "jev-1.13-free");

	resetDecisionModelSession();
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(warnings.length, 2, "a new session warns again");
});

test("a matching reported model does not warn", async () => {
	resetDecisionModelSession();
	const warnings: string[] = [];
	const { fetch } = recordingFetch(() => jsonResponse(OK_PAYLOAD));
	const client = createDecisionModelClient(testSettings(), {
		fetch,
		warn: (message) => warnings.push(message),
	});
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.deepEqual(warnings, []);
	assert.equal(client.reportedModel, "jev-1.13");
});

test("health starts unknown, turns healthy on success, unavailable on failure", async () => {
	resetDecisionModelSession();
	assert.equal(decisionModelHealth(), "unknown");
	let failing = false;
	const { fetch } = recordingFetch(() => {
		if (failing) return new Response("down", { status: 502 });
		return jsonResponse(OK_PAYLOAD);
	});
	const client = createDecisionModelClient(testSettings(), { fetch });
	await client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS);
	assert.equal(decisionModelHealth(), "healthy");
	failing = true;
	await assert.rejects(client.decide(SAMPLE_STATE, SAMPLE_QUESTIONS));
	assert.equal(decisionModelHealth(), "unavailable");
});

test("probe sends one fixed known-safe noul question", async () => {
	resetDecisionModelSession();
	const { calls, fetch } = recordingFetch(() =>
		jsonResponse({
			model: "jev-1.13",
			answers: { probe_readme_read: { type: "noul", value: 0.05 } },
		}));
	const client = createDecisionModelClient(testSettings(), { fetch });
	const result = await client.probe();

	const body = JSON.parse(String(calls[0].init?.body));
	const names = Object.keys(body.questions);
	assert.equal(names.length, 1);
	const question = body.questions[names[0]];
	assert.equal(question.type, "noul");
	assert.equal(question.text, undefined);
	assert.match(question.instructions, /README/i);
	assert.match(question.instructions, /1\./);
	assert.equal(result.reportedModel, "jev-1.13");
	assert.equal(result.answers.probe_readme_read.value, 0.05);
	assert.equal(decisionModelHealth(), "healthy");
});

test("probe failure marks health unavailable", async () => {
	resetDecisionModelSession();
	const { fetch } = recordingFetch(() => new Response("down", { status: 502 }));
	const client = createDecisionModelClient(testSettings(), { fetch });
	await assert.rejects(
		client.probe(),
		(error: unknown) => error instanceof JevError && error.kind === "http",
	);
	assert.equal(decisionModelHealth(), "unavailable");
});

test("session_start kicks off the decision-model probe in the background", async () => {
	resetDecisionModelSession();
	const fake = createFakePi();
	let probeStarted = false;
	let probeFinished = false;
	const created: DecisionModelSettings[] = [];
	createPiAutomode({
		loadConfig: () => baseConfig({ decisionModel: testSettings({ enabled: true }) }),
		createDecisionModelClient: (settings) => {
			created.push(settings);
			return {
				async decide() {
					throw new Error("not used in this test");
				},
				async probe() {
					probeStarted = true;
					await new Promise((resolve) => setTimeout(resolve, 30));
					probeFinished = true;
					return {
						model: "jev-1.13",
						reportedModel: "jev-1.13",
						answers: {},
						durationMs: 30,
					};
				},
				reportedModel: undefined,
			};
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);

	await fake.emit("session_start", { type: "session_start" }, ctx);

	assert.equal(created.length, 1);
	assert.equal(probeStarted, true);
	assert.equal(
		probeFinished,
		false,
		"session_start must not await the background probe",
	);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(probeFinished, true);
});

test("session_start does not probe without an enabled decisionModel", async () => {
	resetDecisionModelSession();
	for (
		const decisionModel of [
			undefined,
			testSettings({ enabled: false }),
		] as const
	) {
		const fake = createFakePi();
		let created = 0;
		createPiAutomode({
			loadConfig: () => baseConfig(decisionModel ? { decisionModel } : {}),
			createDecisionModelClient: () => {
				created += 1;
				throw new Error("client must not be created");
			},
		})(fake.pi);
		await fake.emit("session_start", { type: "session_start" }, createFakeCtx(fake.entries));
		assert.equal(created, 0);
	}
});

test("logJevCall appends a jev entry when logging is enabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-jev-log-"));
	try {
		const logger = createLogger({
			enabled: true,
			classifierIo: false,
			sessionDir: dir,
			sessionId: "abc",
		});
		logJevCall(logger, {
			stage: "probe",
			state: SAMPLE_STATE,
			answers: { q: { type: "noul", value: 0.1 } },
			decision: "probe",
			durationMs: 12,
			reportedModel: "jev-1.13",
			ok: true,
		});
		logJevCall(logger, {
			decisionId: "abc123",
			stage: "per_action",
			state: SAMPLE_STATE,
			answers: {},
			decision: "fallthrough",
			durationMs: 4,
			reportedModel: "jev-1.13",
			ok: false,
			error: "timeout",
		});

		const lines = readFileSync(join(dir, "abc-pi-automode.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(lines.length, 2);
		const probeEntry = lines[0];
		assert.equal(probeEntry.type, "jev");
		assert.equal(typeof probeEntry.ts, "string");
		assert.equal(probeEntry.stage, "probe");
		assert.equal(probeEntry.state, SAMPLE_STATE);
		assert.equal(probeEntry.decision, "probe");
		assert.equal(probeEntry.durationMs, 12);
		assert.equal(probeEntry.reportedModel, "jev-1.13");
		assert.equal(probeEntry.ok, true);
		assert.equal(probeEntry.error, undefined);
		const failureEntry = lines[1];
		assert.equal(failureEntry.decisionId, "abc123");
		assert.equal(failureEntry.ok, false);
		assert.equal(failureEntry.error, "timeout");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logJevCall is a no-op when logging is disabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-jev-log-off-"));
	try {
		const logger = createLogger({
			enabled: false,
			classifierIo: true,
			sessionDir: dir,
			sessionId: "abc",
		});
		logJevCall(logger, {
			stage: "probe",
			state: SAMPLE_STATE,
			answers: {},
			decision: "probe",
			durationMs: 1,
			reportedModel: "jev-1.13",
			ok: true,
		});
		assert.throws(() => readFileSync(join(dir, "abc-pi-automode.jsonl"), "utf8"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
