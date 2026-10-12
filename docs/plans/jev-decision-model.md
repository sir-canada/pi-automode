# Plan: optional decision-model (Jev) support for pi-automode

Status: draft, decisions agreed 2026-10-12. No code yet.

This plan adds an optional, configurable decision model (Jev 1.13 via a local
`/v1/systemone` endpoint) to pi-automode's classifier path. The LLM classifier
stays. Jev is an optional accelerator and an optional second opinion, chosen by
configuration.

## 1. Decisions (agreed, do not relitigate without asking)

### 1.1 Authority

Jev's authority is configurable via `autoMode.decisionModel.mode`:

| Mode | Jev may do | LLM |
| --- | --- | --- |
| `gate` (default) | Allow only | Reviews everything Jev does not allow |
| `gate+block` | Allow and block | Reviews only the middle band |
| `replace` | Allow and block | Never called |

- Default is `gate`, and the block is absent by default: behaviour without the
  `decisionModel` block is exactly today's behaviour.
- Jev decides from day one (no shadow mode), but every call is logged (§1.9).

### 1.2 Config shape

A separate `autoMode.decisionModel` block. `classifierModel` is untouched: Jev
is not a pi-ai chat model and cannot go through the existing `completeFn` path.

```json
"autoMode": {
  "decisionModel": {
    "enabled": true,
    "mode": "gate",
    "endpoint": "http://localhost:30401/v1/systemone",
    "model": "jev-1.13",
    "apiKeyEnv": "JEV_API_KEY",
    "timeoutMs": 3000,
    "thresholds": {
      "destructive":  { "allow": 0.18, "block": 0.82 },
      "scope_creep":  { "allow": 0.18, "block": 0.82 },
      "covered_by_grant": { "allow": 0.82 }
    },
    "preflight": {
      "thresholds": { "dialog": 0.8, "prompt": 0.4 },
      "draftThreshold": 1.5,
      "draftTimeoutMs": 10000
    },
    "questions": {}
  }
}
```

Rules:

- Settable only from global, project-local, and inline config. Shared
  `.pi/automode.json` **cannot** set it — `replace` mode in a checked-in file
  would remove LLM review and break ADR-001.
- `apiKeyEnv` names an env var; the key is never inline in config.
- `timeoutMs` is separate from `classifierTimeoutMs` and defaults to 3000.
- Question texts and rubrics are built-in defaults overridable under
  `decisionModel.questions`, merged with `$defaults` like other rule lists.
- Validation failures produce a `/automode config` diagnostic and the block is
  ignored (fail back to current behaviour).

### 1.3 Per-action questions

Two `noul` questions, asked in one round trip:

- `destructive` — deletes, overwrites, or irreversibly changes data.
- `scope_creep` — goes beyond what the user asked for.

Plus, when a grant exists, `covered_by_grant`.

Decision rule in `gate`: allow only if both risk `noul`s are ≤ their allow
threshold **and** (if a grant exists) `covered_by_grant` ≥ its allow threshold.
Anything else falls through to the LLM. In `gate+block`/`replace`, a risk `noul`
≥ its block threshold with no covering grant blocks. A matching grant
overrides a mid/high risk score (§1.5).

### 1.4 Preflight on every prompt

Runs in `before_agent_start` on every user prompt, in one Jev call that also
carries `scope_clarity` (a `score` question).

| Result | Action |
| --- | --- |
| any risk ≥ 0.8 | approval dialog before the agent starts |
| any risk 0.4–0.8 | inject guidance telling the agent to confirm scope in chat first |
| < 0.4 | nothing |
| check fails/times out | start normally, no grant (never block startup) |

- `state` includes the agent's **last message** as well as the user's prompt,
  with a rubric line: if the user is answering a question, judge what they are
  agreeing to. An "ok" to "should I `rm -rf ~/projects/old`?" is flagged.
- Skipped when an existing session grant already covers the prompt, and when
  the prompt is a short reply the grant already covers. Jev does not get a
  separate `is_reply` question; context + rubric handles it.
- Issue type 2 (dialog) needs no desktop notification: `ui_prompt_start`
  already covers it.

### 1.5 Grants

- Created from the approval dialog; stored as **text**.
- Lifetime: **session by default**, with a "this task only" option that expires
  at the next user prompt.
- The dialog shows your original prompt plus a scope line. Three buttons:
  Approve for session / Approve this task only / Edit scope, plus Cancel.
- **Template vs LLM draft (C with D fallback):** `scope_clarity` decides.
  - score < 1.5 → editable template built from prompt + flagged risks
  - score ≥ 1.5 → `classifierModel` drafts a precise scope (10s timeout),
    shown above your original words, pre-filled and editable
  - draft failure → template with a note "draft unavailable"
  - both the draft and your words are stored.
- Enforcement: for each flagged action, Jev also answers `covered_by_grant`.
  ≥ 0.82 → allowed immediately. Otherwise → LLM (which sees the grant text).
  In `replace` mode, a weak match **blocks**.
- **Grants are context, never a bypass.** Deny, ask, hard-deny, path-deny and
  protected-path checks always run first and are unchanged.
- Session grants show in `/automode status` and are cleared by
  `/automode grants clear`.

### 1.6 Allow-tier coverage

Inside-cwd writes/edits and `permissions.allow` matches get one Jev
`scope_creep` check (read-only tools stay skipped).

- Block threshold reached → normal flow for the mode.
- Jev failure on this path **fails open** (§1.11), logged + notified.

### 1.7 Thresholds (loosened by 0.08 from the initial proposal)

| Check | Allow | Block (`gate+block`/`replace`) |
| --- | --- | --- |
| `destructive` | ≤ 0.18 | ≥ 0.82 |
| `scope_creep` | ≤ 0.18 | ≥ 0.82 |
| `covered_by_grant` | ≥ 0.82 | — |

Between the bands: LLM in `gate`/`gate+block`, block+pending in `replace`.
Each value is overridable per check.

### 1.8 Pending approvals

- Blocked actions in `gate+block`/`replace` are queued as pending approvals.
- **Session-only** state; restored across `/reload`, cleared on new session and
  `/automode reset`.
- Two buttons: **Approve + retry now** (steering message; follow-up prompt if
  the agent already settled) and **Approve only** (grant recorded).
- Block reason also tells the agent to skip the step, continue the task, and
  list skipped steps at the end.
- `/automode pending` lists them.

### 1.9 Context, rubrics, logging

- `state` is the **full** LLM context (rules, project instructions, transcript,
  action, cwd, grants, ask) plus Jev's role, as labelled sections. Jev is
  treated as needing explicit instructions: more context plus a written rubric,
  not less context.
- Every question `instructions` is a numbered rubric with worked yes/no
  examples ("list what is deleted; git-tracked files inside cwd matching the
  user ask are not destructive; home/system paths, force-pushes and history
  rewrites are; if unsure, answer yes"). `criteria` for `choice`/`score`
  become concrete definitions.
- Budget: ~24K tokens of Jev's 32K. Truncation order: transcript middle, then
  project instructions; action, ask, grants and rubrics are never truncated.
  A truncated input cannot be auto-allowed in `gate` — it goes to the LLM.
- Logging: every Jev call logs `state`, answers, resulting decision and
  latency, gated on `log.enabled` only (not `classifierIo`). When the LLM also
  runs, its verdict lands in the same entry, so disagreements are visible.
- New command `/automode jev-report`: allow/block counts, fallthrough rate,
  LLM-vs-Jev disagreement rate, p50/p95 latency.

### 1.10 Health: probe + circuit breaker

- Background probe at `session_start`: one known-safe action with a single
  `noul`. Response shape validated. Probe failure → status "Jev unavailable" +
  issue-3 notification.
- Log the `model` the endpoint reports; warn once on mismatch with config
  (e.g. `jev-1.13` → `jev-1.13-free`).
- Circuit breaker: 3 consecutive failures → stop calling Jev for 60s, go
  straight to each mode's failure path, then probe again.
- Probe adds no startup latency (runs in background).

### 1.11 Failure behaviour summary

| Path | Failure result |
| --- | --- |
| Preflight | Start normally, no grant |
| `gate` per-action | LLM review |
| Allow-tier `scope_creep` (Q16) | **Allow** (as today) — logged, counted, notified |
| `replace` per-action | Block + pending |
| Draft of grant scope | Template fallback |
| Ask-rule approval (see §1.12) | n/a — click is authoritative |

### 1.12 Ask rules (Q21)

When the user accepts a `permissions.ask` dialog, **their click is the
approval**: Jev checks only `covered_by_grant` plus `destructive` against the
block threshold (0.82). Below that the action runs, in every mode. This keeps
`replace` from blocking something the user just approved.

### 1.13 Notifications

pi-automode emits `pi-automode:issue` on `pi.events`:

```ts
{ severity: "warning" | "error", kind: string, title: string, body: string }
```

`extensions/notify.ts` subscribes and owns all notification behaviour
(muting, styling, routing), so it changes in one place. pi-automode keeps its
existing `ctx.ui.notify` toast regardless, so a missing listener loses
nothing.

Notified issues:

1. Action blocked and added to pending
2. Preflight dialog — **skipped** (already covered by `ui_prompt_start`)
3. Classifier or Jev failure (timeout, auth, bad response, endpoint down) —
   `error`
4. Jev fallback to LLM in `gate` — **not notified**, log + status only
5. Config problem (invalid `decisionModel`, ignored files) — `error`
6. Agent finished with pending approvals outstanding

Dedup in `notify.ts`: at most one notification per kind per 60s, with a count
on repeats.

## 2. Code layout

New modules under `extensions/auto-mode/`:

| File | Contents |
| --- | --- |
| `decision-model.ts` | config type/validation, Jev HTTP client, questions/rubrics, threshold logic, probe + circuit breaker |
| `preflight.ts` | per-prompt check, risk→action mapping, dialog vs chat-confirm |
| `grants.ts` | grant store, template/draft generation, coverage plumbing |
| `pending.ts` | pending-approval store, approve/retry handling |

Touches existing files: `config.ts` (validation + merge), `types.ts`
(`DecisionModelSettings`, `Grant`, `PendingApproval`, `EffectiveConfig`), 
`extension.ts` (hook wiring, `/automode grants|pending|jev-report`), `log.ts`
(`jev` log entry kind), `constants.ts` (rubric defaults), `model-selector.ts`
(none), `state.ts` (grants/pending persistence).

**Fork, not the czottmann checkout.** Work happens on a `jev` branch in your
own fork with pi pointed at it. Jev code is isolated in the four modules above
and off by default so an upstream PR stays a small, self-contained diff.

`~/.pi/agent/extensions/notify.ts` is edited in place (your local file).

Tests (TDD per AGENTS.md, run `npm run check` and `npm test`):

- `tests/decision-model.test.ts` — config validation, threshold bands, probe
  and breaker, question assembly, truncation order.
- `tests/preflight.test.ts` — threshold mapping, reply-context rubric, skip
  rules, draft vs template selection.
- `tests/grants.test.ts` — lifetime (session/task), `covered_by_grant`
  handling, no-bypass invariant (deny/hard-deny still fire with a grant).
- `tests/pending.test.ts` — queue, approve + retry vs approve only, restore
  across reload, clear on reset.
- extend `tests/block-notification.test.ts` — issue emission and dedup.

## 3. Build order

1. Jev client, config validation, probe, circuit breaker, `jev` log kind
2. Per-action `destructive`/`scope_creep` checks + threshold bands
3. Grants + `covered_by_grant` + allow-tier `scope_creep`
4. Preflight + `scope_clarity` + dialog/template/draft
5. Pending approvals + `/automode pending`
6. `pi-automode:issue` + `notify.ts` listener + dedup
7. `/automode jev-report`, docs (`docs/configuration.md`,
   `docs/automode-classifier-flow.md`, README)

Each step lands with its tests green before the next begins.

## 4. Open questions

None. All decisions from the interview are recorded above.
