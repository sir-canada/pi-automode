import { existsSync, readFileSync } from "node:fs";
import type { JevLogEntry } from "./log.ts";

/** Aggregate statistics over one session's `jev` log entries. */
export type JevReport = {
  total: number;
  allow: number;
  block: number;
  fallthrough: number;
  failures: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  /** Entries where the LLM also ran (decision `llm:<verdict>`). */
  bothRan: number;
  /** Of `bothRan`, entries where Jev's lean differed from the LLM verdict. */
  disagreements: number;
};

/** Nearest-rank percentile over a sorted array; 0 for an empty array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Jev's own lean for an entry that fell through to the LLM: `block` when any
 * risk noul (destructive/scope_creep) is >= 0.5, otherwise `allow`.
 */
export function jevLean(entry: JevLogEntry): "allow" | "block" | undefined {
  const risks = ["destructive", "scope_creep"]
    .map((name) => entry.answers?.[name])
    .filter((a): a is { type: "noul"; value: number } => a?.type === "noul");
  if (risks.length === 0) return undefined;
  return risks.some((a) => a.value >= 0.5) ? "block" : "allow";
}

/** Summarise decision entries (probe entries are excluded from counts). */
export function summarizeJevEntries(entries: JevLogEntry[]): JevReport {
  const calls = entries.filter((e) => e.type === "jev" && e.stage !== "probe");
  const report: JevReport = {
    total: calls.length,
    allow: 0,
    block: 0,
    fallthrough: 0,
    failures: 0,
    avgMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    bothRan: 0,
    disagreements: 0,
  };
  for (const e of calls) {
    if (!e.ok) report.failures += 1;
    if (e.decision === "allow") report.allow += 1;
    else if (e.decision === "block") report.block += 1;
    else if (e.decision === "llm" || e.decision.startsWith("llm:")) {
      report.fallthrough += 1;
    }
    if (e.decision.startsWith("llm:")) {
      report.bothRan += 1;
      const lean = jevLean(e);
      if (lean && lean !== e.decision.slice(4)) report.disagreements += 1;
    }
  }
  const latencies = calls.map((e) => e.durationMs).sort((a, b) => a - b);
  if (latencies.length > 0) {
    report.avgMs = Math.round(
      latencies.reduce((sum, v) => sum + v, 0) / latencies.length,
    );
    report.p50Ms = percentile(latencies, 50);
    report.p95Ms = percentile(latencies, 95);
  }
  return report;
}

/** Parse `jev` entries out of a JSONL session log; missing file or bad lines are skipped. */
export function readJevEntries(path: string): JevLogEntry[] {
  if (!existsSync(path)) return [];
  const out: JevLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string };
      if (parsed.type === "jev") out.push(parsed as JevLogEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

export type JevReportContext = {
  breaker: string;
  breakerFailures: number;
  allowTierFailures: number;
};

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

export function formatJevReport(r: JevReport, ctx: JevReportContext): string {
  return [
    `jev calls: ${r.total}`,
    `allow: ${r.allow}`,
    `block: ${r.block}`,
    `fallthrough: ${r.fallthrough} (${pct(r.fallthrough, r.total)})`,
    `failures: ${r.failures}`,
    `latency avg/p50/p95: ${r.avgMs}/${r.p50Ms}/${r.p95Ms} ms`,
    `llm-vs-jev disagreements: ${r.disagreements} of ${r.bothRan} (${pct(r.disagreements, r.bothRan)})`,
    `breaker: ${ctx.breaker} (consecutive failures: ${ctx.breakerFailures})`,
    `allow-tier failures (failed open): ${ctx.allowTierFailures}`,
  ].join("\n");
}
