import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DECISION_MODEL_THRESHOLDS,
  JEV_STATE_TOKEN_BUDGET,
  assembleJevState,
  riskBand,
} from "../extensions/auto-mode/decision-model.ts";

const band = DEFAULT_DECISION_MODEL_THRESHOLDS.destructive;

test("riskBand 0.81 is middle, 0.19 is middle", () => {
  assert.equal(riskBand(0.81, band), "middle");
  assert.equal(riskBand(0.19, band), "middle");
});

test("state budget default is 24K and truncates large transcripts", () => {
  assert.equal(JEV_STATE_TOKEN_BUDGET, 24_000);
  const s = assembleJevState({
    userAsk: "x",
    grants: [],
    action: { toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
    recentActions: [],
    transcript: "word ".repeat(200_000),
    projectInstructions: "",
    policy: { environment: [], allow: [], softDeny: [], hardDeny: [] },
    questions: {},
  } as never);
  assert.equal(s.truncated, true);
  assert.ok(s.approxTokens <= 24_500, `approxTokens ${s.approxTokens}`);
});
