/**
 * Optional decision-model (Jev) support: config type/validation/merge, the
 * HTTP client, the fixed health probe, and the circuit breaker.
 *
 * The block is absent by default; without `autoMode.decisionModel` behaviour
 * is exactly today's. Validation failures produce a config diagnostic and the
 * block is ignored (fail back to current behaviour). Shared project
 * `.pi/automode.json` cannot set the block at all (see config.ts).
 */
import {
  DEFAULT_DECISION_MODEL_QUESTIONS,
  PROBE_QUESTIONS,
  PROBE_STATE,
} from "./constants.ts";
import { hasOwn, truncateMiddle } from "./utils.ts";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export type DecisionModelMode = "gate" | "gate+block" | "replace";

export type DecisionModelBand = { allow: number; block: number };

export type DecisionModelThresholds = {
  destructive: DecisionModelBand;
  scope_creep: DecisionModelBand;
  covered_by_grant: { allow: number };
};

export type DecisionModelPreflight = {
  thresholds: { dialog: number; prompt: number };
  draftThreshold: number;
  draftTimeoutMs: number;
};

export type JevQuestionType = "noul" | "choice" | "score";

/** One question asked of Jev. `instructions` is the numbered rubric. */
export type JevQuestion = {
  type: JevQuestionType;
  text: string;
  instructions?: string;
  criteria?: string;
};

export type JevQuestionMap = Record<string, JevQuestion>;

/** Resolved, validated `autoMode.decisionModel` settings with all defaults applied. */
export type DecisionModelSettings = {
  enabled: boolean;
  mode: DecisionModelMode;
  endpoint: string;
  model: string;
  /** Env var name holding the bearer token; empty means no auth header. */
  apiKeyEnv: string;
  timeoutMs: number;
  thresholds: DecisionModelThresholds;
  preflight: DecisionModelPreflight;
  questions: JevQuestionMap;
};

/** Raw `autoMode.decisionModel` block as written in a settings file. */
export type DecisionModelInput = {
  enabled?: boolean;
  mode?: DecisionModelMode;
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  thresholds?: {
    destructive?: Partial<DecisionModelBand>;
    scope_creep?: Partial<DecisionModelBand>;
    covered_by_grant?: { allow?: number };
  };
  preflight?: {
    thresholds?: Partial<DecisionModelPreflight["thresholds"]>;
    draftThreshold?: number;
    draftTimeoutMs?: number;
  };
  questions?: unknown;
};

export const DECISION_MODEL_MODES: readonly DecisionModelMode[] = [
  "gate",
  "gate+block",
  "replace",
];

export const DECISION_MODEL_TIMEOUT_MS_DEFAULT = 3000;
export const DECISION_MODEL_TIMEOUT_MS_MIN = 1000;
export const DECISION_MODEL_TIMEOUT_MS_MAX = 30_000;

export const DEFAULT_DECISION_MODEL_THRESHOLDS: DecisionModelThresholds = {
  destructive: { allow: 0.18, block: 0.82 },
  scope_creep: { allow: 0.18, block: 0.82 },
  covered_by_grant: { allow: 0.82 },
};

export const DEFAULT_DECISION_MODEL_PREFLIGHT: DecisionModelPreflight = {
  thresholds: { dialog: 0.8, prompt: 0.4 },
  draftThreshold: 1.5,
  draftTimeoutMs: 10_000,
};

export const DEFAULT_DECISION_MODEL_SETTINGS: DecisionModelSettings = {
  enabled: false,
  mode: "gate",
  endpoint: "",
  model: "",
  apiKeyEnv: "",
  timeoutMs: DECISION_MODEL_TIMEOUT_MS_DEFAULT,
  thresholds: {
    destructive: { ...DEFAULT_DECISION_MODEL_THRESHOLDS.destructive },
    scope_creep: { ...DEFAULT_DECISION_MODEL_THRESHOLDS.scope_creep },
    covered_by_grant: { ...DEFAULT_DECISION_MODEL_THRESHOLDS.covered_by_grant },
  },
  preflight: {
    thresholds: { ...DEFAULT_DECISION_MODEL_PREFLIGHT.thresholds },
    draftThreshold: DEFAULT_DECISION_MODEL_PREFLIGHT.draftThreshold,
    draftTimeoutMs: DEFAULT_DECISION_MODEL_PREFLIGHT.draftTimeoutMs,
  },
  questions: DEFAULT_DECISION_MODEL_QUESTIONS,
};

// ---------------------------------------------------------------------------
// Validation and merge
// ---------------------------------------------------------------------------

/** Validated pieces of one settings file's `decisionModel` block. */
export type DecisionModelPatch = {
  enabled?: boolean;
  mode?: DecisionModelMode;
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  thresholds?: {
    destructive?: Partial<DecisionModelBand>;
    scope_creep?: Partial<DecisionModelBand>;
    covered_by_grant?: { allow?: number };
  };
  preflight?: {
    thresholds?: Partial<DecisionModelPreflight["thresholds"]>;
    draftThreshold?: number;
    draftTimeoutMs?: number;
  };
  questions?: DecisionModelQuestionOverrides;
};

/**
 * Question overrides from one source. Mirrors the `$defaults` accumulator
 * semantics of the other rule lists: `entries` accumulate across sources and
 * the last source that sets `questions` decides whether the built-ins stay.
 */
export type DecisionModelQuestionOverrides = {
  includeDefaults: boolean;
  entries: JevQuestionMap;
};

export type DecisionModelParseResult = {
  /** Defined only when the block is valid. Invalid blocks are ignored. */
  patch?: DecisionModelPatch;
  diagnostics: string[];
};

const DECISION_MODEL_KEYS = new Set([
  "enabled",
  "mode",
  "endpoint",
  "model",
  "apiKeyEnv",
  "timeoutMs",
  "thresholds",
  "preflight",
  "questions",
]);
const THRESHOLD_CHECKS = ["destructive", "scope_creep", "covered_by_grant"] as const;
const BAND_KEYS: Record<(typeof THRESHOLD_CHECKS)[number], readonly string[]> = {
  destructive: ["allow", "block"],
  scope_creep: ["allow", "block"],
  covered_by_grant: ["allow"],
};
const PREFLIGHT_KEYS = new Set(["thresholds", "draftThreshold", "draftTimeoutMs"]);
const PREFLIGHT_THRESHOLD_KEYS = new Set(["dialog", "prompt"]);
const QUESTION_KEYS = new Set(["type", "text", "instructions", "criteria"]);
const QUESTION_TYPES = new Set<JevQuestionType>(["noul", "choice", "score"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseThresholdBand(
  value: unknown,
  base: string,
  check: (typeof THRESHOLD_CHECKS)[number],
  errors: string[],
): Partial<DecisionModelBand> | { allow?: number } | undefined {
  const path = `${base}.thresholds.${check}`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const before = errors.length;
  const band: Record<string, number> = {};
  const allowedKeys = BAND_KEYS[check];
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}: unknown key ${key}`);
      continue;
    }
    const entry = value[key];
    if (!isFiniteNumber(entry) || entry < 0 || entry > 1) {
      errors.push(`${path}.${key} must be a number from 0 through 1`);
      continue;
    }
    band[key] = entry;
  }
  if (errors.length !== before) return undefined;
  if (check !== "covered_by_grant") {
    const allow = band.allow ??
      DEFAULT_DECISION_MODEL_THRESHOLDS[check].allow;
    const block = band.block ??
      DEFAULT_DECISION_MODEL_THRESHOLDS[check].block;
    if (allow > block) {
      errors.push(`${path}.allow must not exceed ${path}.block`);
      return undefined;
    }
  }
  return band as Partial<DecisionModelBand>;
}

function parseQuestions(
  value: unknown,
  base: string,
  errors: string[],
  notes: string[],
): DecisionModelQuestionOverrides | undefined {
  const path = `${base}.questions`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const before = errors.length;
  const overrides: DecisionModelQuestionOverrides = {
    includeDefaults: false,
    entries: {},
  };
  for (const key of Object.keys(value)) {
    if (key === "$defaults") {
      if (value[key] !== true) {
        errors.push(`${path}.$defaults must be true`);
      } else {
        overrides.includeDefaults = true;
      }
      continue;
    }
    const entryPath = `${path}.${key}`;
    const entry = value[key];
    if (!isRecord(entry)) {
      errors.push(`${entryPath} must be an object`);
      continue;
    }
    const type = entry.type;
    if (typeof type !== "string" || !QUESTION_TYPES.has(type as JevQuestionType)) {
      errors.push(`${entryPath}.type must be one of noul, choice, score`);
      continue;
    }
    const text = entry.text;
    if (typeof text !== "string" || text.trim() === "") {
      errors.push(`${entryPath}.text must be a non-empty string`);
      continue;
    }
    let entryValid = true;
    if ("instructions" in entry && typeof entry.instructions !== "string") {
      errors.push(`${entryPath}.instructions must be a string`);
      entryValid = false;
    }
    if ("criteria" in entry && typeof entry.criteria !== "string") {
      errors.push(`${entryPath}.criteria must be a string`);
      entryValid = false;
    }
    for (const entryKey of Object.keys(entry)) {
      if (!QUESTION_KEYS.has(entryKey)) {
        errors.push(`${entryPath}: unknown key ${entryKey}`);
        entryValid = false;
      }
    }
    if (!entryValid) continue;
    const question: JevQuestion = { type: type as JevQuestionType, text };
    if (typeof entry.instructions === "string") {
      question.instructions = entry.instructions;
    }
    if (typeof entry.criteria === "string") question.criteria = entry.criteria;
    overrides.entries[key] = question;
  }
  if (
    errors.length === before &&
    Object.keys(overrides.entries).length > 0 &&
    !overrides.includeDefaults
  ) {
    notes.push(
      `${path} omits "$defaults" and replaces the built-in questions`,
    );
  }
  return overrides;
}

function parseDecisionModelPatch(
  value: unknown,
  base: string,
  errors: string[],
  notes: string[],
): DecisionModelPatch | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${base} must be an object`);
    return undefined;
  }
  const patch: DecisionModelPatch = {};
  for (const key of Object.keys(value)) {
    if (!DECISION_MODEL_KEYS.has(key)) {
      errors.push(`${base}: unknown key ${key}`);
    }
  }
  if (hasOwn(value, "enabled")) {
    if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
    else errors.push(`${base}.enabled must be a boolean`);
  }
  if (hasOwn(value, "mode")) {
    if (
      typeof value.mode === "string" &&
      (DECISION_MODEL_MODES as readonly string[]).includes(value.mode)
    ) {
      patch.mode = value.mode as DecisionModelMode;
    } else {
      errors.push(`${base}.mode must be one of gate, gate+block, replace`);
    }
  }
  if (hasOwn(value, "endpoint")) {
    if (isValidEndpoint(value.endpoint)) patch.endpoint = value.endpoint;
    else errors.push(`${base}.endpoint must be an http(s) URL`);
  }
  if (hasOwn(value, "model")) {
    if (typeof value.model === "string" && value.model.trim() !== "") {
      patch.model = value.model;
    } else {
      errors.push(`${base}.model must be a non-empty string`);
    }
  }
  if (hasOwn(value, "apiKeyEnv")) {
    if (
      typeof value.apiKeyEnv === "string" && value.apiKeyEnv.trim() !== ""
    ) {
      patch.apiKeyEnv = value.apiKeyEnv;
    } else {
      errors.push(`${base}.apiKeyEnv must be a non-empty string`);
    }
  }
  if (hasOwn(value, "timeoutMs")) {
    if (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs)) {
      errors.push(`${base}.timeoutMs must be an integer`);
    } else {
      patch.timeoutMs = clamp(
        value.timeoutMs,
        DECISION_MODEL_TIMEOUT_MS_MIN,
        DECISION_MODEL_TIMEOUT_MS_MAX,
      );
    }
  }
  if (hasOwn(value, "thresholds")) {
    const thresholds = value.thresholds;
    if (!isRecord(thresholds)) {
      errors.push(`${base}.thresholds must be an object`);
    } else {
      const parsed: NonNullable<DecisionModelPatch["thresholds"]> = {};
      let any = false;
      for (const key of Object.keys(thresholds)) {
        if (!(THRESHOLD_CHECKS as readonly string[]).includes(key)) {
          errors.push(`${base}.thresholds: unknown key ${key}`);
          continue;
        }
        const band = parseThresholdBand(
          thresholds[key],
          base,
          key as (typeof THRESHOLD_CHECKS)[number],
          errors,
        );
        if (!band) continue;
        any = true;
        if (key === "destructive") parsed.destructive = band as Partial<DecisionModelBand>;
        else if (key === "scope_creep") parsed.scope_creep = band as Partial<DecisionModelBand>;
        else parsed.covered_by_grant = band as { allow?: number };
      }
      if (any) patch.thresholds = parsed;
    }
  }
  if (hasOwn(value, "preflight")) {
    const preflight = value.preflight;
    if (!isRecord(preflight)) {
      errors.push(`${base}.preflight must be an object`);
    } else {
      const parsed: NonNullable<DecisionModelPatch["preflight"]> = {};
      let any = false;
      for (const key of Object.keys(preflight)) {
        if (!PREFLIGHT_KEYS.has(key)) {
          errors.push(`${base}.preflight: unknown key ${key}`);
          continue;
        }
        if (key === "thresholds") {
          const thresholds = preflight.thresholds;
          if (!isRecord(thresholds)) {
            errors.push(`${base}.preflight.thresholds must be an object`);
            continue;
          }
          const band: Partial<DecisionModelPreflight["thresholds"]> = {};
          let bandValid = true;
          for (const thresholdKey of Object.keys(thresholds)) {
            if (!PREFLIGHT_THRESHOLD_KEYS.has(thresholdKey)) {
              errors.push(`${base}.preflight.thresholds: unknown key ${thresholdKey}`);
              bandValid = false;
              continue;
            }
            const entry = thresholds[thresholdKey];
            if (!isFiniteNumber(entry) || entry < 0 || entry > 1) {
              errors.push(
                `${base}.preflight.thresholds.${thresholdKey} must be a number from 0 through 1`,
              );
              bandValid = false;
              continue;
            }
            if (thresholdKey === "dialog") band.dialog = entry;
            else band.prompt = entry;
          }
          if (bandValid) {
            parsed.thresholds = band;
            any = true;
          }
          continue;
        }
        if (key === "draftThreshold") {
          const entry = preflight.draftThreshold;
          if (!isFiniteNumber(entry) || entry < 0) {
            errors.push(`${base}.preflight.draftThreshold must be a non-negative number`);
            continue;
          }
          parsed.draftThreshold = entry;
          any = true;
          continue;
        }
        const entry = preflight.draftTimeoutMs;
        if (typeof entry !== "number" || !Number.isInteger(entry)) {
          errors.push(`${base}.preflight.draftTimeoutMs must be an integer`);
          continue;
        }
        parsed.draftTimeoutMs = clamp(
          entry,
          DECISION_MODEL_TIMEOUT_MS_MIN,
          DECISION_MODEL_TIMEOUT_MS_MAX,
        );
        any = true;
      }
      if (any) patch.preflight = parsed;
    }
  }
  if (hasOwn(value, "questions")) {
    const questions = parseQuestions(value.questions, base, errors, notes);
    if (questions) patch.questions = questions;
  }
  return patch;
}

/**
 * Validate one `autoMode.decisionModel` block. Returns the validated patch
 * (to merge) plus diagnostics for `/automode config`. When the block is
 * invalid the patch is undefined so callers ignore the whole block and fall
 * back to today's behaviour.
 */
export function parseDecisionModelBlock(
  value: unknown,
  source: string,
): DecisionModelParseResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const base = source
    ? `${source}: autoMode.decisionModel`
    : "autoMode.decisionModel";
  const patch = parseDecisionModelPatch(value, base, errors, notes);
  return {
    patch: errors.length > 0 ? undefined : patch,
    diagnostics: [...errors, ...notes],
  };
}

/**
 * Apply one validated block on top of the accumulated settings. Fields the
 * block omits keep their previous value (or the plan defaults), so a
 * higher-precedence source can disable the feature without repeating the
 * endpoint.
 */
export function applyDecisionModelPatch(
  base: DecisionModelSettings | undefined,
  patch: DecisionModelPatch,
): DecisionModelSettings {
  const current = base ?? DEFAULT_DECISION_MODEL_SETTINGS;
  const thresholds = patch.thresholds;
  const preflight = patch.preflight;
  return {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    endpoint: patch.endpoint ?? current.endpoint,
    model: patch.model ?? current.model,
    apiKeyEnv: patch.apiKeyEnv ?? current.apiKeyEnv,
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
    thresholds: {
      destructive: { ...current.thresholds.destructive, ...thresholds?.destructive },
      scope_creep: { ...current.thresholds.scope_creep, ...thresholds?.scope_creep },
      covered_by_grant: {
        ...current.thresholds.covered_by_grant,
        ...thresholds?.covered_by_grant,
      },
    },
    preflight: {
      thresholds: { ...current.preflight.thresholds, ...preflight?.thresholds },
      draftThreshold: preflight?.draftThreshold ?? current.preflight.draftThreshold,
      draftTimeoutMs: preflight?.draftTimeoutMs ?? current.preflight.draftTimeoutMs,
    },
    questions: patch.questions
      ? {
        ...(patch.questions.includeDefaults ? DEFAULT_DECISION_MODEL_QUESTIONS : {}),
        ...patch.questions.entries,
      }
      : current.questions,
  };
}

// ---------------------------------------------------------------------------
// Jev responses
// ---------------------------------------------------------------------------

export type JevAnswer =
  | { type: "noul"; value: number }
  | { type: "choice"; value: string }
  | { type: "score"; value: number };

export type JevAnswerMap = Record<string, JevAnswer>;

export type JevResponse = { model: string; answers: JevAnswerMap };

/**
 * Validate the response shape `{model, answers: {name: {type, value}}}`.
 * Throws `JevError("shape")` on anything unexpected; extra keys are ignored.
 */
export function parseJevResponse(value: unknown): JevResponse {
  if (!isRecord(value)) {
    throw new JevError("shape", "decision model response must be a JSON object");
  }
  const model = value.model;
  if (typeof model !== "string" || model === "") {
    throw new JevError(
      "shape",
      "decision model response .model must be a non-empty string",
    );
  }
  const answers = value.answers;
  if (!isRecord(answers)) {
    throw new JevError(
      "shape",
      "decision model response .answers must be an object",
    );
  }
  const parsed: JevAnswerMap = {};
  for (const [name, raw] of Object.entries(answers)) {
    if (!isRecord(raw)) {
      throw new JevError("shape", `decision model answer ${name} must be an object`);
    }
    const type = raw.type;
    if (typeof type !== "string" || !QUESTION_TYPES.has(type as JevQuestionType)) {
      throw new JevError(
        "shape",
        `decision model answer ${name} .type must be one of noul, choice, score`,
      );
    }
    // Real Jev responses carry the value under the type name
    // ({type:"noul",noul:0.25}, {type:"choice",choice:"billing"},
    // {type:"score",score:0.84}); `.value` is accepted as a fallback.
    const answerValue = hasOwn(raw, type) ? raw[type] : raw.value;
    if (type === "choice") {
      if (typeof answerValue !== "string") {
        throw new JevError(
          "shape",
          `decision model answer ${name} .value must be a string`,
        );
      }
      parsed[name] = { type: "choice", value: answerValue };
      continue;
    }
    if (!isFiniteNumber(answerValue)) {
      throw new JevError(
        "shape",
        `decision model answer ${name} .value must be a finite number`,
      );
    }
    if (type === "noul" && (answerValue < 0 || answerValue > 1)) {
      throw new JevError(
        "shape",
        `decision model answer ${name} .value must be within [0, 1]`,
      );
    }
    if (type === "score" && answerValue < 0) {
      throw new JevError(
        "shape",
        `decision model answer ${name} .value must be non-negative`,
      );
    }
    parsed[name] = { type: type as "noul" | "score", value: answerValue };
  }
  return { model, answers: parsed };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed client failure. Callers map these onto the plan's per-path failure
 * policy: `timeout`/`http`/`parse`/`shape`/`network` are endpoint failures;
 * `unavailable` is the open circuit breaker short-circuiting with no I/O.
 */
export type JevErrorKind =
  | "timeout"
  | "http"
  | "parse"
  | "shape"
  | "network"
  | "unavailable";

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;

  constructor(
    kind: JevErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JevError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Session health (module-level, reset on session_start)
// ---------------------------------------------------------------------------

export type DecisionModelHealth = "healthy" | "unavailable" | "unknown";

type DecisionModelSession = {
  health: DecisionModelHealth;
  modelMismatchWarned: boolean;
};

const session: DecisionModelSession = {
  health: "unknown",
  modelMismatchWarned: false,
};

/** Module-level health for later status output. `unknown` until the first call. */
export function decisionModelHealth(): DecisionModelHealth {
  return session.health;
}

/** Fresh session: health is unknown again and the model-mismatch warning may fire once. */
export function resetDecisionModelSession(): void {
  session.health = "unknown";
  session.modelMismatchWarned = false;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export type JevFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type JevClientDeps = {
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetch?: JevFetch;
  /** Injectable clock for tests (breaker cooldown). Defaults to Date.now. */
  now?: () => number;
  /** Mismatch/health warning sink. Defaults to console.warn. */
  warn?: (message: string) => void;
};

export type JevRequestOptions = {
  /** Per-call timeout override in milliseconds. Defaults to settings.timeoutMs. */
  timeoutMs?: number;
  /** Caller cancellation (e.g. the turn's abort signal). Not an endpoint failure. */
  signal?: AbortSignal;
};

export type JevDecisionResult = {
  /** The configured model name. */
  model: string;
  /** The model string the endpoint reported in this response. */
  reportedModel: string;
  answers: JevAnswerMap;
  durationMs: number;
};

export type JevClient = {
  decide(
    state: string,
    questions: JevQuestionMap,
    opts?: JevRequestOptions,
  ): Promise<JevDecisionResult>;
  probe(opts?: JevRequestOptions): Promise<JevDecisionResult>;
  /** Last model string the endpoint reported, if any call succeeded. */
  readonly reportedModel: string | undefined;
  /** Circuit-breaker snapshot for status/report output. Optional for test fakes. */
  readonly breaker?: { state: "closed" | "open" | "half-open"; failures: number };
};

/** Consecutive failures that open the circuit. */
export const DECISION_MODEL_BREAKER_THRESHOLD = 3;
/** How long the circuit stays open before the half-open probe. */
export const DECISION_MODEL_BREAKER_COOLDOWN_MS = 60_000;

/**
 * Create the Jev HTTP client. The circuit breaker opens after
 * `DECISION_MODEL_BREAKER_THRESHOLD` consecutive failures for
 * `DECISION_MODEL_BREAKER_COOLDOWN_MS`, short-circuiting calls with an
 * `unavailable` error and no network I/O; the first call after expiry is a
 * half-open probe, and a success closes the breaker.
 */
export function createDecisionModelClient(
  settings: DecisionModelSettings,
  deps: JevClientDeps = {},
): JevClient {
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const warn = deps.warn ??
    ((message: string) => {
      console.warn(message);
    });

  const breaker = {
    failures: 0,
    state: "closed" as "closed" | "open" | "half-open",
    openUntil: 0,
  };
  let reportedModel: string | undefined;

  function openBreaker(): void {
    breaker.state = "open";
    breaker.failures = DECISION_MODEL_BREAKER_THRESHOLD;
    breaker.openUntil = now() + DECISION_MODEL_BREAKER_COOLDOWN_MS;
  }

  function gate(): void {
    if (breaker.state === "open") {
      if (now() < breaker.openUntil) {
        session.health = "unavailable";
        throw new JevError(
          "unavailable",
          `decision model circuit open after ${DECISION_MODEL_BREAKER_THRESHOLD} consecutive failures; retrying after ${
            Math.ceil((breaker.openUntil - now()) / 1000)
          }s`,
        );
      }
      breaker.state = "half-open";
    }
  }

  function recordSuccess(): void {
    breaker.failures = 0;
    breaker.state = "closed";
    breaker.openUntil = 0;
    session.health = "healthy";
  }

  function recordFailure(): void {
    session.health = "unavailable";
    breaker.failures += 1;
    if (breaker.failures >= DECISION_MODEL_BREAKER_THRESHOLD) openBreaker();
  }

  async function request(
    state: string,
    questions: JevQuestionMap,
    opts?: JevRequestOptions,
  ): Promise<JevDecisionResult> {
    gate();
    const timeoutMs = opts?.timeoutMs ?? settings.timeoutMs;
    const startedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new JevError("timeout", `decision model request timed out after ${timeoutMs} ms`),
      );
    }, timeoutMs);
    const parent = opts?.signal;
    const onParentAbort = () => controller.abort(parent?.reason);
    if (parent) {
      if (parent.aborted) onParentAbort();
      else parent.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const apiKey = settings.apiKeyEnv
        ? process.env[settings.apiKeyEnv]
        : undefined;
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let response: Response;
      try {
        response = await doFetch(settings.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: settings.model, state, questions }),
          signal: controller.signal,
        });
      } catch (error) {
        // Caller cancellation is not an endpoint failure.
        if (parent?.aborted && !timedOut) throw error;
        if (error instanceof JevError) throw error;
        if (timedOut) {
          throw new JevError(
            "timeout",
            `decision model request timed out after ${timeoutMs} ms`,
            { cause: error },
          );
        }
        throw new JevError(
          "network",
          `decision model request failed: ${messageOf(error)}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw new JevError(
          "http",
          `decision model request failed with HTTP ${response.status}`,
          { status: response.status },
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new JevError(
          "parse",
          "decision model response body is not valid JSON",
          { cause: error },
        );
      }
      const parsed = parseJevResponse(payload);

      recordSuccess();
      reportedModel = parsed.model;
      if (parsed.model !== settings.model && !session.modelMismatchWarned) {
        session.modelMismatchWarned = true;
        warn(
          `pi-automode: decision model mismatch: configured ${settings.model}, endpoint reports ${parsed.model}`,
        );
      }
      return {
        model: settings.model,
        reportedModel: parsed.model,
        answers: parsed.answers,
        durationMs: now() - startedAt,
      };
    } catch (error) {
      if (parent?.aborted && !timedOut) throw error;
      const jevError = error instanceof JevError
        ? error
        : new JevError(
          "network",
          `decision model request failed: ${messageOf(error)}`,
          { cause: error },
        );
      recordFailure();
      throw jevError;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }

  return {
    decide: (state, questions, opts) => request(state, questions, opts),
    probe: (opts) => request(PROBE_STATE, PROBE_QUESTIONS, opts),
    get reportedModel() {
      return reportedModel;
    },
    get breaker() {
      return { state: breaker.state, failures: breaker.failures };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-action questions, state assembly, threshold bands (plan §1.3/§1.7/§1.9)
// ---------------------------------------------------------------------------

export const RISK_QUESTION_NAMES = ["destructive", "scope_creep"] as const;
export type RiskQuestionName = (typeof RISK_QUESTION_NAMES)[number];

/**
 * The two per-action risk questions. A configured override wins; a missing
 * or non-`noul` override falls back to the built-in so neither risk check can
 * be dropped by configuration.
 */
export function buildPerActionQuestions(
  settings: DecisionModelSettings,
): JevQuestionMap {
  const questions: JevQuestionMap = {};
  for (const name of RISK_QUESTION_NAMES) {
    const configured = settings.questions[name];
    questions[name] = configured?.type === "noul"
      ? configured
      : DEFAULT_DECISION_MODEL_QUESTIONS[name]!;
  }
  return questions;
}

/** Approximate token budget for state + questions (of Jev's 32K window). */
export const JEV_STATE_TOKEN_BUDGET = 24_000;
const JEV_CHARS_PER_TOKEN = 4;

export const JEV_ROLE = [
  "You are Jev, the decision model for pi-automode, a guardrail that reviews one proposed coding-agent tool call before it runs.",
  "Answer each question about the proposed action in <action> only, using the user's request in <user_ask>, any grants in <grants>, the recent context, and the policy.",
  "Follow each question's numbered rubric exactly. When the context is insufficient, follow the rubric's 'if unsure' rule.",
].join("\n");

export type JevActionContext = {
  toolName: string;
  input: unknown;
  cwd: string;
  /** undefined when the action has no single target path (e.g. bash). */
  insideCwd: boolean | undefined;
};

export type JevPolicy = {
  environment: string[];
  allow: string[];
  softDeny: string[];
  hardDeny: string[];
};

export type JevStateInput = {
  userAsk: string;
  grants: string[];
  action: JevActionContext;
  recentActions: string[];
  transcript: string;
  projectInstructions: string;
  policy: JevPolicy;
  /** Questions sent alongside the state; counted against the budget, never truncated. */
  questions: JevQuestionMap;
  budgetTokens?: number;
};

export type JevState = {
  text: string;
  /** True when anything was cut or the fixed sections exceed the budget. Never auto-allowed. */
  truncated: boolean;
  approxTokens: number;
};

function approxTokens(text: string): number {
  return Math.ceil(text.length / JEV_CHARS_PER_TOKEN);
}

function stateSection(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

function bulletLines(items: readonly string[], empty = "(none)"): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function cutText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const marker = `[${label} truncated]`;
  if (maxChars <= marker.length + 40) return marker;
  return truncateMiddle(text, maxChars);
}

/**
 * Build Jev's labelled `state`. Truncation order: transcript middle first,
 * then project instructions. role, user_ask, grants, action, recent_actions,
 * policy and the question rubrics are never truncated.
 */
export function assembleJevState(input: JevStateInput): JevState {
  const budget = input.budgetTokens ?? JEV_STATE_TOKEN_BUDGET;
  const action = input.action;
  const inside = action.insideCwd === undefined
    ? "unknown"
    : action.insideCwd
    ? "yes"
    : "no";
  const outside = action.insideCwd === undefined
    ? "unknown"
    : action.insideCwd
    ? "no"
    : "yes";
  const actionBody = [
    `tool: ${action.toolName}`,
    `input: ${JSON.stringify(action.input)}`,
    `cwd: ${action.cwd}`,
    `inside_cwd: ${inside}`,
    `outside_cwd: ${outside}`,
  ].join("\n");
  const policyBody = [
    "environment:",
    bulletLines(input.policy.environment),
    "allow:",
    bulletLines(input.policy.allow),
    "soft_deny:",
    bulletLines(input.policy.softDeny),
    "hard_deny:",
    bulletLines(input.policy.hardDeny),
  ].join("\n");
  const head = [
    stateSection("role", JEV_ROLE),
    stateSection("user_ask", input.userAsk || "(none)"),
    stateSection("grants", bulletLines(input.grants)),
    stateSection("action", actionBody),
    stateSection(
      "recent_actions",
      bulletLines(input.recentActions.slice(-3).map((line) => line.replace(/\s+/g, " "))),
    ),
  ];
  const policy = stateSection("policy", policyBody);
  const fixedTokens = approxTokens(head.join("\n\n") + policy) +
    approxTokens(JSON.stringify(input.questions)) + 64;
  const available = Math.max(0, budget - fixedTokens) * JEV_CHARS_PER_TOKEN;
  let truncated = fixedTokens > budget;
  let transcript = input.transcript || "(none)";
  let instructions = input.projectInstructions || "(none)";
  if (transcript.length + instructions.length > available) {
    truncated = true;
    transcript = cutText(
      transcript,
      Math.max(0, available - instructions.length),
      "transcript",
    );
    if (transcript.length + instructions.length > available) {
      instructions = cutText(
        instructions,
        Math.max(0, available - transcript.length),
        "project instructions",
      );
    }
  }
  const text = [
    ...head,
    stateSection("transcript", transcript),
    stateSection("project_instructions", instructions),
    policy,
  ].join("\n\n");
  return { text, truncated, approxTokens: approxTokens(text) };
}

export type RiskBand = "allow" | "middle" | "block";

/** allow when score <= allow, block when score >= block (block wins on overlap). */
export function riskBand(score: number, band: DecisionModelBand): RiskBand {
  if (score >= band.block) return "block";
  if (score <= band.allow) return "allow";
  return "middle";
}

export type RiskEvaluation = {
  band: RiskBand;
  question: RiskQuestionName;
  score: number;
  scores: Record<RiskQuestionName, number>;
};

const BAND_RANK: Record<RiskBand, number> = { allow: 0, middle: 1, block: 2 };

/**
 * Evaluate both risk answers; the riskier one decides. A missing or
 * non-`noul` answer is a shape failure (handled by the mode failure policy).
 */
export function evaluateRiskAnswers(
  answers: JevAnswerMap,
  thresholds: DecisionModelThresholds,
): RiskEvaluation {
  const scores = {} as Record<RiskQuestionName, number>;
  let worst: RiskEvaluation | undefined;
  for (const name of RISK_QUESTION_NAMES) {
    const answer = answers[name];
    if (!answer || answer.type !== "noul") {
      throw new JevError(
        "shape",
        `decision model answer ${name} is missing or not a noul`,
      );
    }
    scores[name] = answer.value;
    const band = riskBand(answer.value, thresholds[name]);
    if (
      !worst || BAND_RANK[band] > BAND_RANK[worst.band] ||
      (BAND_RANK[band] === BAND_RANK[worst.band] && answer.value > worst.score)
    ) {
      worst = { band, question: name, score: answer.value, scores };
    }
  }
  return worst!;
}

export type PerActionResult = "allow" | "block" | "llm";
export type PerActionDecision = { result: PerActionResult; reason: string };

/** Map a risk evaluation onto the configured mode (plan §1.1, §1.7). */
export function decidePerAction(
  mode: DecisionModelMode,
  evaluation: RiskEvaluation,
  truncated: boolean,
): PerActionDecision {
  // Step 3 hook: a covered_by_grant answer >= its allow threshold will
  // override mid/high risk here (plan §1.5).
  const score = `${evaluation.question} ${evaluation.score.toFixed(2)}`;
  const autoAllow = evaluation.band === "allow" && !truncated;
  const allowReason =
    `Decision model: destructive ${evaluation.scores.destructive.toFixed(2)}, scope_creep ${
      evaluation.scores.scope_creep.toFixed(2)
    } within allow thresholds`;
  const llm = {
    result: "llm" as const,
    reason: truncated
      ? "Decision model state truncated; LLM review required"
      : `Decision model: ${score}; LLM review required`,
  };
  if (mode === "gate") {
    return autoAllow ? { result: "allow", reason: allowReason } : llm;
  }
  if (evaluation.band === "block") {
    return {
      result: "block",
      reason: `Decision model: ${score}, not covered by any grant`,
    };
  }
  if (mode === "gate+block") {
    return autoAllow ? { result: "allow", reason: allowReason } : llm;
  }
  if (evaluation.band === "middle") {
    return {
      result: "block",
      reason: `Decision model: ${score} exceeded the replace-mode limits, not covered by any grant`,
    };
  }
  if (truncated) {
    return {
      result: "block",
      reason: "Decision model: state was truncated; replace mode cannot allow it",
    };
  }
  return { result: "allow", reason: allowReason };
}

/** Per-action failure policy (plan §1.11): LLM in gate modes, block in replace. */
export function decisionModelFailure(
  mode: DecisionModelMode,
  error: unknown,
): PerActionDecision {
  if (mode === "replace") {
    return {
      result: "block",
      reason: `Decision model unavailable in replace mode: ${messageOf(error)}`,
    };
  }
  return {
    result: "llm",
    reason: `Decision model unavailable: ${messageOf(error)}`,
  };
}

export type PerActionOutcome = PerActionDecision & {
  state: JevState;
  answers: JevAnswerMap;
  durationMs: number;
  reportedModel: string;
  ok: boolean;
  error?: string;
};

/** One Jev round trip for an action that would otherwise reach the classifier. */
export async function runPerActionDecision(
  client: JevClient,
  settings: DecisionModelSettings,
  stateInput: Omit<JevStateInput, "questions">,
  signal?: AbortSignal,
): Promise<PerActionOutcome> {
  const questions = buildPerActionQuestions(settings);
  const state = assembleJevState({ ...stateInput, questions });
  const startedAt = Date.now();
  try {
    const result = await client.decide(
      state.text,
      questions,
      signal ? { signal } : undefined,
    );
    const evaluation = evaluateRiskAnswers(result.answers, settings.thresholds);
    return {
      ...decidePerAction(settings.mode, evaluation, state.truncated),
      state,
      answers: result.answers,
      durationMs: result.durationMs,
      reportedModel: result.reportedModel,
      ok: true,
    };
  } catch (error) {
    return {
      ...decisionModelFailure(settings.mode, error),
      state,
      answers: {},
      durationMs: Date.now() - startedAt,
      reportedModel: client.reportedModel ?? "",
      ok: false,
      error: messageOf(error),
    };
  }
}
