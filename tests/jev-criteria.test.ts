import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DECISION_MODEL_SETTINGS,
  JevError,
  createDecisionModelClient,
  parseDecisionModelBlock,
  resetDecisionModelSession,
} from "../extensions/auto-mode/decision-model.ts";

const base = { enabled: true, endpoint: "http://x.test/v1/systemone", model: "jev-1.13" };

test("score question criteria must be a non-empty string array", () => {
  const bad = parseDecisionModelBlock({ ...base, questions: { q: { type: "score", text: "t", criteria: "0 = a; 1 = b" } } }, "t");
  assert.equal(bad.patch, undefined);
  assert.ok(bad.diagnostics.some((d) => /criteria must be a non-empty array of strings for score/.test(d)));
  const good = parseDecisionModelBlock({ ...base, questions: { q: { type: "score", text: "t", criteria: ["a", "b"] } } }, "t");
  assert.deepEqual(good.diagnostics.filter((d) => /criteria/.test(d)), []);
  assert.ok(good.patch);
});

test("choice criteria accepts a label map", () => {
  const r = parseDecisionModelBlock({ ...base, questions: { q: { type: "choice", text: "t", criteria: { a: "x", b: "y" } } } }, "t");
  assert.ok(r.patch);
});

test("HTTP errors include a sanitized, truncated body excerpt", async () => {
  resetDecisionModelSession();
  const body = '{"error":{"code":"invalid_parameter"}}\u001b[31m' + "x".repeat(2000);
  const c = createDecisionModelClient(
    { ...DEFAULT_DECISION_MODEL_SETTINGS, ...base, timeoutMs: 1000 },
    { fetch: async () => new Response(body, { status: 400 }), warn: () => {} },
  );
  await assert.rejects(c.decide("s", { d: { type: "noul", text: "q" } }), (e) =>
    e instanceof JevError && e.kind === "http" && /HTTP 400: .*invalid_parameter/.test(e.message) &&
    !/\u001b/.test(e.message) && e.message.length < 400);
});
