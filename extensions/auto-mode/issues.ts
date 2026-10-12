/**
 * `pi-automode:issue` events (plan §1.13). The listener (notify.ts) owns
 * muting, styling, routing, and dedup; this side only emits.
 *
 * Emitted kinds: "blocked", "failure", "config", "stale-pending".
 * Never emitted: preflight dialog (ui_prompt_start covers it) and gate-mode
 * fallback to the LLM (log + status only).
 */
export const ISSUE_CHANNEL = "pi-automode:issue";

export type IssueKind = "blocked" | "failure" | "config" | "stale-pending";

export type AutomodeIssue = {
  severity: "warning" | "error";
  kind: IssueKind;
  title: string;
  body: string;
};

export type IssueBus = { emit(channel: string, data: unknown): void } | undefined;

/** Emit one issue on the bus. Silent no-op without a bus; never throws. */
export function emitIssue(events: IssueBus, issue: AutomodeIssue): void {
  try {
    events?.emit(ISSUE_CHANNEL, issue);
  } catch {
    // A broken listener must not change any decision.
  }
}
