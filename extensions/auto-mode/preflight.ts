import { DEFAULT_DECISION_MODEL_QUESTIONS } from "./constants.ts";
import type {
  DecisionModelSettings,
  JevAnswerMap,
  JevClient,
  JevPolicy,
  JevQuestionMap,
} from "./decision-model.ts";
import { grantsCoverPromptRisks, type Grant, type GrantScope } from "./grants.ts";
import { truncateMiddle } from "./utils.ts";

/**
 * Preflight check on every user prompt (plan §1.4/§1.5). One Jev round trip
 * with four risk nouls plus scope_clarity. Failure or timeout passes through
 * (designated fail-open path, §1.11): the agent starts normally, no grant.
 */
export const PREFLIGHT_RISK_NAMES = [
  "destructive",
  "exfiltration",
  "security_weakening",
  "needs_scope_beyond_ask",
] as const;

/** Grant risk names use the per-action vocabulary (needs_scope_beyond_ask => scope_creep). */
export function grantRiskName(name: string): string {
  return name === "needs_scope_beyond_ask" ? "scope_creep" : name;
}

export const PREFLIGHT_ROLE = [
  "You are Jev, the decision model for pi-automode. The coding agent has NOT started yet.",
  "Judge the user's new prompt in <user_prompt> before any action is taken.",
  "If the user is answering a question the agent asked in <agent_last_message>, judge what they are agreeing to, not the literal reply (an 'ok' to 'should I rm -rf ~/projects/old?' is destructive).",
  "Use <grants>, the transcript, and the policy as context. Follow each question's numbered rubric exactly.",
].join("\n");

export const PREFLIGHT_CONFIRM_GUIDANCE = [
  "## pi-automode: confirm scope first",
  "The user's request may involve risky actions ({risks}).",
  "Before taking any action of that kind, restate the concrete targets and exclusions in chat and ask the user to confirm the scope. Do not perform those actions until the user confirms.",
].join("\n");

export const PREFLIGHT_CANCEL_GUIDANCE = [
  "## pi-automode: request cancelled",
  "The user cancelled this request in the pi-automode scope dialog. Do not call any tools. Reply briefly that the task was cancelled and wait for new instructions.",
].join("\n");

export const DIALOG_APPROVE_SESSION = "Approve for session";
export const DIALOG_APPROVE_TASK = "Approve this task only";
export const DIALOG_EDIT = "Edit scope";
export const DIALOG_CANCEL = "Cancel";
export const DIALOG_OPTIONS = [
  DIALOG_APPROVE_SESSION,
  DIALOG_APPROVE_TASK,
  DIALOG_EDIT,
  DIALOG_CANCEL,
];

const MAX_TRANSCRIPT_CHARS = 48_000;
const MAX_INSTRUCTIONS_CHARS = 24_000;

export function buildPreflightQuestions(settings: DecisionModelSettings): JevQuestionMap {
  const questions: JevQuestionMap = {};
  for (const name of PREFLIGHT_RISK_NAMES) {
    const configured = settings.questions[name];
    questions[name] = configured?.type === "noul"
      ? configured
      : DEFAULT_DECISION_MODEL_QUESTIONS[name]!;
  }
  const clarity = settings.questions.scope_clarity;
  questions.scope_clarity = clarity?.type === "score"
    ? clarity
    : DEFAULT_DECISION_MODEL_QUESTIONS.scope_clarity!;
  return questions;
}

export type PreflightStateInput = {
  prompt: string;
  agentLastMessage: string;
  transcript: string;
  projectInstructions: string;
  grants: readonly Grant[];
  policy: JevPolicy;
};

function section(name: string, body: string): string {
  return `<${name}>\n${body || "(none)"}\n</${name}>`;
}

function bullets(items: readonly string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "(none)";
}

export function buildPreflightState(input: PreflightStateInput): string {
  return [
    section("role", PREFLIGHT_ROLE),
    section("user_prompt", input.prompt),
    section("agent_last_message", input.agentLastMessage),
    section("grants", bullets(input.grants.map((g) => `[${g.scope}] ${g.text}`))),
    section("transcript", truncateMiddle(input.transcript, MAX_TRANSCRIPT_CHARS)),
    section(
      "project_instructions",
      truncateMiddle(input.projectInstructions, MAX_INSTRUCTIONS_CHARS),
    ),
    section("policy", [
      "environment:", bullets(input.policy.environment),
      "allow:", bullets(input.policy.allow),
      "soft_deny:", bullets(input.policy.softDeny),
      "hard_deny:", bullets(input.policy.hardDeny),
    ].join("\n")),
  ].join("\n\n");
}

export type PreflightAction = "dialog" | "guidance" | "none";

export function mapPreflightAction(
  maxRisk: number,
  thresholds: { dialog: number; prompt: number },
): PreflightAction {
  if (maxRisk >= thresholds.dialog) return "dialog";
  if (maxRisk >= thresholds.prompt) return "guidance";
  return "none";
}

export function selectScopeSource(clarity: number, draftThreshold: number): "template" | "draft" {
  return clarity >= draftThreshold ? "draft" : "template";
}

export function buildTemplateScope(prompt: string, risks: readonly string[], note?: string): string {
  const line = `Approved for prompt "${prompt}": ${risks.join(", ") || "(no risks)"}`;
  return note ? `${line}\n(${note})` : line;
}

/** Both the scope text and the user's original words are always stored. */
export function buildGrantText(prompt: string, scope: string): string {
  return `User prompt: "${prompt}"\nScope: ${scope}`;
}

export function confirmGuidance(risks: readonly string[]): string {
  return PREFLIGHT_CONFIRM_GUIDANCE.replace("{risks}", risks.join(", ") || "unspecified");
}

export type DraftInput = { prompt: string; risks: string[]; transcript: string };
export type DraftFn = (input: DraftInput, signal: AbortSignal) => Promise<string>;

export const DRAFT_SYSTEM_PROMPT = [
  "You write the scope line for a user approval in a coding-agent guardrail.",
  "List the concrete targets (paths, commands, remotes) and explicit exclusions implied by the user's words.",
  "Never widen the scope beyond what the user said; when unclear, keep it narrower.",
  "Reply with the scope text only, at most 5 short lines.",
].join("\n");

export function buildDraftUserMessage(input: DraftInput): string {
  return [
    section("user_prompt", input.prompt),
    section("flagged_risks", input.risks.join(", ")),
    section("transcript", truncateMiddle(input.transcript, 16_000)),
  ].join("\n\n");
}

type UiLike = {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
};

export type PreflightCtx = { mode?: string; hasUI?: boolean; ui?: UiLike };

export function hasDialogUi(ctx: PreflightCtx): boolean {
  return ctx.mode === "tui" && ctx.hasUI !== false && typeof ctx.ui?.select === "function";
}

export type PreflightIssue = { kind: "preflight-failure" | "draft-failure"; error: string };
let issueRecorder: ((issue: PreflightIssue) => void) | undefined;

/** Step 6 wires this to the pi-automode:issue event. */
export function setPreflightIssueRecorder(fn: ((issue: PreflightIssue) => void) | undefined): void {
  issueRecorder = fn;
}

function recordIssue(issue: PreflightIssue): void {
  try {
    issueRecorder?.(issue);
  } catch {
    // A broken listener must not affect startup.
  }
}

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMEOUT);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type PreflightInput = PreflightStateInput & {
  client: JevClient;
  settings: DecisionModelSettings;
  ctx: PreflightCtx;
  draft?: DraftFn;
  newId?: () => string;
  now?: () => number;
};

export type PreflightResult = {
  outcome: "none" | "guidance" | "dialog" | "skipped" | "failed";
  /** Text to append to the system prompt, if any. */
  guidance?: string;
  grant?: Grant;
  cancelled?: boolean;
  scopeSource?: "template" | "draft";
  flagged: string[];
  maxRisk?: number;
  answers: JevAnswerMap;
  state: string;
  durationMs: number;
  reportedModel: string;
  error?: string;
};

function defaultId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { client, settings, ctx } = input;
  const now = input.now ?? Date.now;
  const state = buildPreflightState(input);
  const questions = buildPreflightQuestions(settings);
  const startedAt = now();
  const base = { answers: {} as JevAnswerMap, state, flagged: [] as string[], reportedModel: client.reportedModel ?? "" };
  const fail = (error: string): PreflightResult => {
    recordIssue({ kind: "preflight-failure", error });
    return { ...base, outcome: "failed", durationMs: now() - startedAt, error };
  };

  let result;
  try {
    result = await withTimeout(
      (signal) => client.decide(state, questions, { signal, timeoutMs: settings.timeoutMs }),
      settings.timeoutMs,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (result === TIMEOUT) return fail(`preflight timed out after ${settings.timeoutMs}ms`);

  const answers = result.answers;
  const scores: Record<string, number> = {};
  for (const name of PREFLIGHT_RISK_NAMES) {
    const a = answers[name];
    if (!a || a.type !== "noul") return fail(`preflight answer ${name} is missing or not a noul`);
    scores[name] = a.value;
  }
  const clarityAnswer = answers.scope_clarity;
  const clarity = clarityAnswer && clarityAnswer.type === "score" ? clarityAnswer.value : 3;
  const maxRisk = Math.max(...Object.values(scores));
  const thresholds = settings.preflight.thresholds;
  const flagged = PREFLIGHT_RISK_NAMES.filter((n) => scores[n]! >= thresholds.prompt).map(grantRiskName);
  const common = {
    answers,
    state,
    flagged,
    maxRisk,
    reportedModel: result.reportedModel,
    durationMs: result.durationMs,
  };

  const action = mapPreflightAction(maxRisk, thresholds);
  if (action === "none") return { ...common, outcome: "none" };
  if (grantsCoverPromptRisks(input.grants, flagged)) return { ...common, outcome: "skipped" };
  if (action === "guidance" || !hasDialogUi(ctx)) {
    return { ...common, outcome: "guidance", guidance: confirmGuidance(flagged) };
  }

  // Dialog: template (clear scope) or LLM draft (vague scope) with template fallback.
  let scopeSource = selectScopeSource(clarity, settings.preflight.draftThreshold);
  let scope = buildTemplateScope(input.prompt, flagged);
  if (scopeSource === "draft") {
    let draftError: string | undefined;
    if (!input.draft) {
      draftError = "no draft model available";
    } else {
      try {
        const drafted = await withTimeout(
          (signal) => input.draft!({ prompt: input.prompt, risks: flagged, transcript: input.transcript }, signal),
          settings.preflight.draftTimeoutMs,
        );
        if (drafted === TIMEOUT) draftError = "draft timed out";
        else if (!drafted.trim()) draftError = "draft was empty";
        else scope = drafted.trim();
      } catch (error) {
        draftError = error instanceof Error ? error.message : String(error);
      }
    }
    if (draftError) {
      recordIssue({ kind: "draft-failure", error: draftError });
      scopeSource = "template";
      scope = buildTemplateScope(input.prompt, flagged, "draft unavailable");
    }
  }

  const ui = ctx.ui!;
  for (;;) {
    const title = [
      `pi-automode: approve risky request (${flagged.join(", ")})`,
      `Scope: ${scope}`,
      `Your prompt: "${input.prompt}"`,
    ].join("\n");
    const choice = await ui.select!(title, DIALOG_OPTIONS);
    if (choice === DIALOG_EDIT) {
      const edited = typeof ui.editor === "function"
        ? await ui.editor("Edit scope", scope)
        : await ui.input?.("Edit scope", scope);
      if (edited && edited.trim()) scope = edited.trim();
      continue;
    }
    if (choice === DIALOG_APPROVE_SESSION || choice === DIALOG_APPROVE_TASK) {
      const grantScope: GrantScope = choice === DIALOG_APPROVE_SESSION ? "session" : "task";
      const grant: Grant = {
        id: (input.newId ?? defaultId)(),
        text: buildGrantText(input.prompt, scope),
        scope: grantScope,
        source: scopeSource,
        createdAt: now(),
        risks: flagged,
      };
      return { ...common, outcome: "dialog", scopeSource, grant };
    }
    return { ...common, outcome: "dialog", scopeSource, cancelled: true, guidance: PREFLIGHT_CANCEL_GUIDANCE };
  }
}

/** Text of the most recent assistant message in the session branch. */
export function lastAssistantText(entries: readonly unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => (c as { type?: string })?.type === "text")
        .map((c) => String((c as { text?: unknown }).text ?? ""))
        .join("\n");
    }
    return "";
  }
  return "";
}
