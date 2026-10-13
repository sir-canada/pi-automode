import assert from "node:assert/strict";
import test from "node:test";
import { JevError, parseJevResponse } from "../extensions/auto-mode/decision-model.ts";

const resp = (type: string, value: unknown) => ({ model: "jev-1.13", answers: { x: { type, value } } });

test("noul values outside [0,1] are shape errors (fail closed)", () => {
  for (const v of [-1, -0.0001, 1.0001, 7]) {
    assert.throws(() => parseJevResponse(resp("noul", v)), (e) => e instanceof JevError && e.kind === "shape");
  }
  assert.equal(parseJevResponse(resp("noul", 0)).answers.x.value, 0);
  assert.equal(parseJevResponse(resp("noul", 1)).answers.x.value, 1);
});

test("negative score values are shape errors", () => {
  assert.throws(() => parseJevResponse(resp("score", -0.5)), (e) => e instanceof JevError && e.kind === "shape");
  assert.equal(parseJevResponse(resp("score", 2.4)).answers.x.value, 2.4);
});

test("real Jev wire shape: value keyed by type name", () => {
  const r = parseJevResponse({ model: "jev-1.13-free", answers: {
    a: { type: "noul", noul: 0.25 },
    b: { type: "choice", choice: "billing", confidence: 1, probabilities: { billing: 1 } },
    c: { type: "score", score: 0.84, confidence: 0.58 },
  } });
  assert.equal(r.answers.a.value, 0.25);
  assert.equal(r.answers.b.value, "billing");
  assert.equal(r.answers.c.value, 0.84);
  assert.throws(() => parseJevResponse({ model: "m", answers: { a: { type: "noul", noul: 1.5 } } }), (e) => e instanceof JevError && e.kind === "shape");
});

import { toWireQuestions } from "../extensions/auto-mode/decision-model.ts";
test("wire questions carry only type/instructions/criteria (text folded in)", () => {
  const w = toWireQuestions({ a: { type: "noul", text: "Q?", instructions: "1. rule" } } as never);
  assert.deepEqual(Object.keys(w.a).sort(), ["instructions", "type"]);
  assert.equal(w.a.instructions, "Q?\n1. rule");
});
