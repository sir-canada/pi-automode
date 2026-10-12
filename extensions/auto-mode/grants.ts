import {
  assembleJevState,
  buildPerActionQuestions,
  decidePerAction,
  decisionModelFailure,
  evaluateRiskAnswers,
  JevError,
  type DecisionModelSettings,
  type JevAnswerMap,
  type JevClient,
  type JevQuestionMap,
  type JevState,
  type JevStateInput,
  type PerActionDecision,
} from "./decision-model.ts";
import { DEFAULT_DECISION_MODEL_QUESTIONS } from "./constants.ts";

/**
 * Grants (plan §1.5). A grant is CONTEXT for the decision model, never a
 * bypass: nothing in this module is consulted before the deny, ask,
 * hard-deny, path-deny or protected-path checks, and none of those checks
 * reads grants.
 */
export type GrantScope = "session" | "task";
export type GrantSource = "dialog" | "template" | "draft";

export type Grant = {
  id: string;
  text: string;
  scope: GrantScope;
  source: GrantSource;
  createdAt?: number;
  risks: string[];
};

export function isGrant(value: unknown): value is Grant {
  const g = value as Partial<Grant> | null;
  return !!g && typeof g === "object" && typeof g.id === "string" &&
    typeof g.text === "string" && (g.scope === "session" || g.scope === "task") &&
    (g.source === "dialog" || g.source === "template" || g.source === "draft") &&
    Array.isArray(g.risks) && g.risks.every((r) => typeof r === "string");
}

/** Task-scoped grants expire when the next user prompt starts. */
export function clearTaskGrants(grants: readonly Grant[]): Grant[] {
  return grants.filter((g) => g.scope !== "task");
}

export function formatGrants(grants: readonly Grant[]): string {
  if (grants.length === 0) return "No active pi-automode grants.";
  return grants
    .map((g) =>
      `${g.id} [${g.scope}] ${g.text}\n  risks: ${g.risks.length > 0 ? g.risks.join(", ") : "(none)"}`
    )
    .join("\n\n");
}

/**
 * Conservative preflight skip helper: true only when a SESSION grant's risks
 * clearly cover every risk of the new prompt. Unknown/empty risks => false.
 */
export function grantsCoverPromptRisks(
  grants: readonly Grant[],
  promptRisks: readonly string[],
): boolean {
  const wanted = [...new Set(promptRisks.map((r) => r.trim()).filter(Boolean))];
  if (wanted.length === 0) return false;
  return grants.some((g) =>
    g.scope === "session" && wanted.every((r) => g.risks.includes(r))
  );
}

export function coveredByGrantQuestion(
  settings: DecisionModelSettings,
): JevQuestionMap[string] {
  const configured = settings.questions.covered_by_grant;
  return configured?.type === "noul"
    ? configured
    : DEFAULT_DECISION_MODEL_QUESTIONS.covered_by_grant!;
}

/**
 * Combine the risk decision with a covered_by_grant answer. Covered >=
 * threshold allows (overriding mid/high risk) unless the state was truncated.
 * Below threshold: gate/gate+block never auto-allow (LLM), gate+block still
 * blocks the block band, replace blocks.
 */
export function decideWithGrant(
  settings: DecisionModelSettings,
  answers: JevAnswerMap,
  truncated: boolean,
): PerActionDecision {
  const evaluation = evaluateRiskAnswers(answers, settings.thresholds);
  const covered = answers.covered_by_grant;
  if (!covered || covered.type !== "noul") {
    throw new JevError("shape", "decision model answer covered_by_grant is missing or not a noul");
  }
  const threshold = settings.thresholds.covered_by_grant.allow;
  if (covered.value >= threshold && !truncated) {
    return {
      result: "allow",
      reason: `Decision model: covered by grant (${covered.value.toFixed(2)})`,
    };
  }
  const base = decidePerAction(settings.mode, evaluation, truncated);
  if (base.result !== "allow") return base;
  const reason = `Decision model: grant coverage ${covered.value.toFixed(2)} below ${threshold}`;
  return settings.mode === "replace"
    ? { result: "block", reason: `${reason}; replace mode blocks a weak grant match` }
    : { result: "llm", reason: `${reason}; LLM review required` };
}

export type GrantAwareOutcome = PerActionDecision & {
  state: JevState;
  answers: JevAnswerMap;
  durationMs: number;
  reportedModel: string;
  ok: boolean;
  error?: string;
};

async function ask(
  client: JevClient,
  stateInput: Omit<JevStateInput, "questions">,
  questions: JevQuestionMap,
  signal: AbortSignal | undefined,
) {
  const state = assembleJevState({ ...stateInput, questions });
  const startedAt = Date.now();
  try {
    const result = await client.decide(state.text, questions, signal ? { signal } : undefined);
    return { state, result, startedAt, error: undefined as unknown };
  } catch (error) {
    return { state, result: undefined, startedAt, error };
  }
}

/** Per-action round trip with the third covered_by_grant question (grants exist). */
export async function runGrantAwareDecision(
  client: JevClient,
  settings: DecisionModelSettings,
  stateInput: Omit<JevStateInput, "questions">,
  signal?: AbortSignal,
): Promise<GrantAwareOutcome> {
  const questions: JevQuestionMap = {
    ...buildPerActionQuestions(settings),
    covered_by_grant: coveredByGrantQuestion(settings),
  };
  const r = await ask(client, stateInput, questions, signal);
  try {
    if (!r.result) throw r.error;
    return {
      ...decideWithGrant(settings, r.result.answers, r.state.truncated),
      state: r.state,
      answers: r.result.answers,
      durationMs: r.result.durationMs,
      reportedModel: r.result.reportedModel,
      ok: true,
    };
  } catch (error) {
    return {
      ...decisionModelFailure(settings.mode, error),
      state: r.state,
      answers: {},
      durationMs: Date.now() - r.startedAt,
      reportedModel: client.reportedModel ?? "",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Allow-tier scope_creep check (plan §1.6). The ONLY fail-open path.
// ---------------------------------------------------------------------------

export type AllowTierIssue = { kind: "allow-tier-failure"; error: string };
let issueRecorder: ((issue: AllowTierIssue) => void) | undefined;
let allowTierFailures = 0;

/** Step 6 wires this to the pi-automode:issue event. */
export function setIssueRecorder(fn: ((issue: AllowTierIssue) => void) | undefined): void {
  issueRecorder = fn;
}

export function allowTierFailureCount(): number {
  return allowTierFailures;
}

export function resetAllowTierFailures(): void {
  allowTierFailures = 0;
}

export type AllowTierOutcome = {
  escalate: boolean;
  ok: boolean;
  score?: number;
  error?: string;
  state: JevState;
  answers: JevAnswerMap;
  durationMs: number;
  reportedModel: string;
};

export async function runAllowTierCheck(
  client: JevClient,
  settings: DecisionModelSettings,
  stateInput: Omit<JevStateInput, "questions">,
  signal?: AbortSignal,
): Promise<AllowTierOutcome> {
  const questions: JevQuestionMap = { scope_creep: buildPerActionQuestions(settings).scope_creep! };
  const r = await ask(client, stateInput, questions, signal);
  const answer = r.result?.answers.scope_creep;
  if (r.result && answer && answer.type === "noul") {
    return {
      escalate: answer.value >= settings.thresholds.scope_creep.block,
      ok: true,
      score: answer.value,
      state: r.state,
      answers: r.result.answers,
      durationMs: r.result.durationMs,
      reportedModel: r.result.reportedModel,
    };
  }
  const error = r.result
    ? "decision model answer scope_creep is missing or not a noul"
    : r.error instanceof Error ? r.error.message : String(r.error);
  allowTierFailures += 1;
  try {
    issueRecorder?.({ kind: "allow-tier-failure", error });
  } catch {
    // A broken listener must not change the decision.
  }
  return {
    escalate: false,
    ok: false,
    error,
    state: r.state,
    answers: r.result?.answers ?? {},
    durationMs: Date.now() - r.startedAt,
    reportedModel: client.reportedModel ?? "",
  };
}
