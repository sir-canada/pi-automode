import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DECISION_MODEL_SETTINGS,
  JevError,
  createFallbackDecisionModelClient,
  parseDecisionModelBlock,
  resetDecisionModelSession,
  resolveApiKey,
  type DecisionModelSettings,
} from "../extensions/auto-mode/decision-model.ts";

const PRIMARY = "http://primary.test/v1/systemone";
const BACKUP = "http://backup.test/v1/systemone";

function settings(over: Partial<DecisionModelSettings> = {}): DecisionModelSettings {
  return {
    ...DEFAULT_DECISION_MODEL_SETTINGS,
    enabled: true,
    endpoint: PRIMARY,
    model: "jev-1.13",
    timeoutMs: 1000,
    totalTimeoutMs: 5000,
    fallbacks: [{ endpoint: BACKUP, model: "jev-latest", apiKeyEnv: "", apiKeyFile: "", timeoutMs: 1000 }],
    ...over,
  };
}

const ok = (model: string) =>
  new Response(JSON.stringify({ model, answers: { destructive: { type: "noul", noul: 0.1 } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function fakeFetch(behaviour: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return behaviour[url]();
  };
  return { calls, fetch };
}

const QUESTIONS = { destructive: { type: "noul", text: "q" } } as never;

test("primary failure falls through to the backup; reportedModel reflects the answerer", async () => {
  resetDecisionModelSession();
  const { calls, fetch } = fakeFetch({
    [PRIMARY]: () => new Response("nope", { status: 500 }),
    [BACKUP]: () => ok("jev-latest"),
  });
  const c = createFallbackDecisionModelClient(settings(), { fetch, warn: () => {} });
  const r = await c.decide("s", QUESTIONS);
  assert.equal(r.reportedModel, "jev-latest");
  assert.deepEqual(calls, [PRIMARY, BACKUP]);
  assert.equal(c.reportedModel, "jev-latest");
});

test("primary success never touches the backup", async () => {
  resetDecisionModelSession();
  const { calls, fetch } = fakeFetch({ [PRIMARY]: () => ok("jev-1.13"), [BACKUP]: () => ok("jev-latest") });
  const c = createFallbackDecisionModelClient(settings(), { fetch, warn: () => {} });
  await c.decide("s", QUESTIONS);
  assert.deepEqual(calls, [PRIMARY]);
});

test("open primary breaker is skipped without I/O, then recovers after cooldown", async () => {
  resetDecisionModelSession();
  let t = 0;
  let primaryUp = false;
  const { calls, fetch } = fakeFetch({
    [PRIMARY]: () => (primaryUp ? ok("jev-1.13") : new Response("x", { status: 503 })),
    [BACKUP]: () => ok("jev-latest"),
  });
  const c = createFallbackDecisionModelClient(settings(), { fetch, now: () => t, warn: () => {} });
  for (let i = 0; i < 3; i += 1) await c.decide("s", QUESTIONS);
  assert.equal(c.breaker?.state, "open");
  calls.length = 0;
  await c.decide("s", QUESTIONS);
  assert.deepEqual(calls, [BACKUP], "open breaker must not hit the primary");
  primaryUp = true;
  t += 60_000;
  calls.length = 0;
  const r = await c.decide("s", QUESTIONS);
  assert.deepEqual(calls, [PRIMARY]);
  assert.equal(r.reportedModel, "jev-1.13");
  assert.equal(c.breaker?.state, "closed");
});

test("all endpoints failing surfaces the last JevError", async () => {
  resetDecisionModelSession();
  const { fetch } = fakeFetch({
    [PRIMARY]: () => new Response("x", { status: 500 }),
    [BACKUP]: () => new Response("y", { status: 502 }),
  });
  const c = createFallbackDecisionModelClient(settings(), { fetch, warn: () => {} });
  await assert.rejects(c.decide("s", QUESTIONS), (e) => e instanceof JevError && e.kind === "http" && /502/.test(e.message));
});

test("totalTimeoutMs bounds the whole chain", async () => {
  resetDecisionModelSession();
  let t = 0;
  const { calls, fetch } = fakeFetch({
    [PRIMARY]: () => { t += 6000; return new Response("x", { status: 500 }); },
    [BACKUP]: () => ok("jev-latest"),
  });
  const c = createFallbackDecisionModelClient(settings({ totalTimeoutMs: 5000 }), { fetch, now: () => t, warn: () => {} });
  await assert.rejects(c.decide("s", QUESTIONS), (e) => e instanceof JevError);
  assert.deepEqual(calls, [PRIMARY], "no budget left for the backup");
});

test("no fallbacks behaves as the single-endpoint client", async () => {
  resetDecisionModelSession();
  const { calls, fetch } = fakeFetch({ [PRIMARY]: () => new Response("x", { status: 500 }) });
  const c = createFallbackDecisionModelClient(settings({ fallbacks: [] }), { fetch, warn: () => {} });
  await assert.rejects(c.decide("s", QUESTIONS), (e) => e instanceof JevError && e.kind === "http");
  assert.deepEqual(calls, [PRIMARY]);
});

test("resolveApiKey: env wins, then mode-600 file; loose/missing/empty files are auth errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-key-"));
  const good = join(dir, "good.key");
  writeFileSync(good, "xpl_secret\nignored\n");
  chmodSync(good, 0o600);
  const loose = join(dir, "loose.key");
  writeFileSync(loose, "xpl_secret\n");
  chmodSync(loose, 0o644);
  const empty = join(dir, "empty.key");
  writeFileSync(empty, "\n");
  chmodSync(empty, 0o600);

  assert.equal(resolveApiKey({ apiKeyEnv: "K", apiKeyFile: good }, { K: "fromenv" }), "fromenv");
  assert.equal(resolveApiKey({ apiKeyEnv: "K", apiKeyFile: good }, {}), "xpl_secret");
  assert.equal(resolveApiKey({ apiKeyEnv: "", apiKeyFile: "" }, {}), undefined);
  for (const file of [loose, empty, join(dir, "missing.key")]) {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "", apiKeyFile: file }, {}),
      (e) => e instanceof JevError && e.kind === "auth" && !e.message.includes("xpl_secret"),
    );
  }
});

test("fallbacks config validates shape and rejects unknown keys / bad endpoints", () => {
  const good = parseDecisionModelBlock({
    enabled: true, endpoint: PRIMARY, model: "jev-1.13",
    fallbacks: [{ endpoint: BACKUP, model: "jev-latest", apiKeyFile: "~/.pi/agent/jev-backup.key", timeoutMs: 4000 }],
    totalTimeoutMs: 6000,
  }, "t");
  assert.deepEqual(good.diagnostics, []);
  assert.equal(good.patch?.fallbacks?.length, 1);
  assert.equal(good.patch?.fallbacks?.[0].timeoutMs, 4000);
  assert.equal(good.patch?.totalTimeoutMs, 6000);

  const bad = parseDecisionModelBlock({
    enabled: true, endpoint: PRIMARY, model: "m",
    fallbacks: [{ endpoint: "ftp://x", model: "m" }, { endpoint: BACKUP, model: "m", bogus: 1 }],
  }, "t");
  assert.equal(bad.patch, undefined);
  assert.ok(bad.diagnostics.some((d) => /fallbacks\[0\]\.endpoint/.test(d)));
  assert.ok(bad.diagnostics.some((d) => /fallbacks\[1\]: unknown key bogus/.test(d)));
});
