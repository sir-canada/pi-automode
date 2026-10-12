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
