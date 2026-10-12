import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatJevReport,
  jevLean,
  percentile,
  readJevEntries,
  summarizeJevEntries,
} from "../extensions/auto-mode/jev-report.ts";
import type { JevLogEntry } from "../extensions/auto-mode/log.ts";

function entry(over: Partial<JevLogEntry>): JevLogEntry {
  return {
    type: "jev",
    ts: "2026-10-12T00:00:00Z",
    stage: "per_action",
    state: "",
    answers: {},
    decision: "allow",
    durationMs: 100,
    reportedModel: "jev-1.13",
    ok: true,
    ...over,
  } as JevLogEntry;
}

const noul = (value: number) => ({ type: "noul", value }) as never;

test("percentile uses nearest rank and handles empty input", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5], 95), 5);
});

test("jevLean blocks at >= 0.5 on either risk noul", () => {
  assert.equal(jevLean(entry({ answers: { destructive: noul(0.5) } })), "block");
  assert.equal(jevLean(entry({ answers: { destructive: noul(0.49), scope_creep: noul(0.1) } })), "allow");
  assert.equal(jevLean(entry({ answers: {} })), undefined);
});

test("summarize counts allow/block/fallthrough/failures/disagreements and skips probes", () => {
  const r = summarizeJevEntries([
    entry({ decision: "allow", durationMs: 100 }),
    entry({ decision: "block", durationMs: 200 }),
    entry({ decision: "llm", ok: false, durationMs: 300 }),
    entry({ decision: "llm:allow", answers: { destructive: noul(0.9) }, durationMs: 400 }),
    entry({ decision: "llm:block", answers: { destructive: noul(0.9) }, durationMs: 500 }),
    entry({ stage: "probe" as never, decision: "allow", durationMs: 9999 }),
  ]);
  assert.equal(r.total, 5);
  assert.equal(r.allow, 1);
  assert.equal(r.block, 1);
  assert.equal(r.fallthrough, 3);
  assert.equal(r.failures, 1);
  assert.equal(r.bothRan, 2);
  assert.equal(r.disagreements, 1);
  assert.equal(r.avgMs, 300);
  assert.equal(r.p50Ms, 300);
  assert.equal(r.p95Ms, 500);
});

test("readJevEntries skips missing files, malformed lines and other entry types", () => {
  assert.deepEqual(readJevEntries("/nonexistent/x.jsonl"), []);
  const dir = mkdtempSync(join(tmpdir(), "jev-report-"));
  const path = join(dir, "log.jsonl");
  writeFileSync(path, [
    JSON.stringify(entry({ decision: "block" })),
    "{not json",
    JSON.stringify({ type: "decision" }),
    "",
  ].join("\n"));
  const out = readJevEntries(path);
  assert.equal(out.length, 1);
  assert.equal(out[0].decision, "block");
});

test("formatJevReport renders all fields", () => {
  const text = formatJevReport(summarizeJevEntries([entry({})]), {
    breaker: "closed",
    breakerFailures: 0,
    allowTierFailures: 2,
  });
  assert.match(text, /jev calls: 1/);
  assert.match(text, /breaker: closed/);
  assert.match(text, /allow-tier failures \(failed open\): 2/);
  assert.match(text, /latency avg\/p50\/p95: 100\/100\/100 ms/);
});
