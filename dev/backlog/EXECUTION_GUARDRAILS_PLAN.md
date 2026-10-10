# Global Execution Guardrail Hardening Plan

> **Status:** Revised — reduced scope
>
> **Priority:** P2 — complete with or before unattended scheduling

> **2026-10-10 audit:** Partially done. The `queue.maxSteps` single-sourcing landed: every path
> resolves the limit through `src/utils/QueueLimitUtils.ts` (`resolveEffectiveMaxSteps`,
> `buildStepLimitError`) plus `exceedsLimit` from `LimitUtils` (append paths in `1661a4231`), and
> `WorkflowExecutor.checkStepLimit` already fails an oversized run at execution start before the first
> step and again after out-of-process appends. Still open: the timeout audits and Phase 2 (structured
> stop reason codes). Setting names corrected to `execution.maxPromptTimeoutSec` /
> `execution.scriptTimeoutSec`. Parallel steps shipped with `queue.maxParallelSteps`, and the related
> plans now live in `dev/implemented/`.

## Existing Product Contract

ctrlyoke already exposes and enforces execution guardrails through the settings
layer:

| Concern           | Existing setting                    | Current role                                             |
| ----------------- | ----------------------------------- | -------------------------------------------------------- |
| Prompt duration   | `execution.maxPromptTimeoutSec`     | Bounds one harness prompt; `-1` is unlimited             |
| Script duration   | `execution.scriptTimeoutSec`        | Default timeout for pre/end-condition scripts            |
| Workflow growth   | `queue.maxSteps`                    | Bounds the workflow step list, including dynamic appends |
| Workflow duration | `queue.maxWorkflowExecutionTimeSec` | Stops at safe execution boundaries; `-1` is unlimited    |
| Concurrency       | `queue.maxParallelSteps`            | Caps how many members of a parallel group run at once    |

Retry behavior already has focused controls:

- `errorBehavior.maxRetries` bounds harness/session-failure retries;
- `endCondition.maxRetries` bounds validation retries;
- condition-level `timeout` can override the global script timeout where a
  particular validation script genuinely needs a different budget.

These settings are the product's guardrail surface. They are configurable at
the settings scopes supported by `CtrlYokeConfigService`. The workflow root may
override `queue.maxSteps` for a run; no other queue override is supported.

## Product Decision

Do **not** add a workflow `limits` object or any queue override other than the
workflow-root `maxSteps` property. Do not add per-prompt overrides for queue size, workflow duration, prompt
duration, aggregate attempts, observed tokens, or concurrency.

Per-step limits would mainly buy exceptions such as “allow this unusually long
step while keeping the default tight.” That is occasionally useful, but it does
not justify another inheritance system and more authoring controls:

- a workflow could weaken a user's safety preference;
- copied workflows would carry machine-specific operational policy;
- mixed step limits make the effective run envelope harder to explain;
- the existing global prompt/workflow timeouts and focused retry settings cover
  the practical cases;
- script conditions already retain their existing timeout override because
  script runtimes vary substantially and that behavior is established.

If users later demonstrate a recurring need for prompt-specific AI timeouts,
design that narrow feature from evidence rather than introducing a generic
limits hierarchy now.

## Remaining Work

This plan is an enforcement and consistency audit, not a new schema feature.

### Phase 1 — Single-source existing enforcement

- ~~Create or identify one shared queue-limit check~~ — **done**: `QueueLimitUtils`
  (`resolveEffectiveMaxSteps`, `getEffectiveMaxStepsSource`, `buildStepLimitError`)
  with `LimitUtils.exceedsLimit`, used by `WorkflowInstance` (manual/topology
  append), `mcp-server.ts` (MCP append), `RunContinuationService`,
  `ExecutionPreviewService`, and `WorkflowExecutor.checkStepLimit`.
- ~~Reject an oversized initial workflow before its first step starts~~ —
  **done**: `WorkflowExecutor` calls `checkStepLimit` right after the run starts
  and before the first step, and again after merging out-of-process appends.
  Remaining gap: `PromptFileParser` validation only *warns*
  (`STEP_LIMIT_EXCEEDED`) and only against an authored workflow `maxSteps`, not
  the global setting, so the editor/dry-run cannot flag a run that will fail on
  `queue.maxSteps`.
- Count enabled and disabled queue entries consistently with the existing queue
  definition; do not create a second “billable step” count.
- ~~Audit `execution.maxPromptTimeoutSec` across interactive/headless transports
  and completion monitors so `-1` and finite values have the same meaning for
  every CLI harness~~ — **done**: all six harnesses use the shared headless
  spawn or interactive `CliLogMonitor` path (including PTY and inherited-stdio
  sessions). Headless process expiry now becomes a step-level `TIMEOUT`
  failure; Codex app-server timeouts are usage probes, and OpenCode server
  transport is MCP configuration rather than prompt execution. Added finite
  and unlimited coverage for both shared enforcement paths.
- Audit `queue.maxWorkflowExecutionTimeSec` across normal steps, script steps,
  retries, `finalStep`, pause/resume, and dynamically extended queues. Continue
  enforcing it only at safe boundaries; do not kill a harness while it may be
  writing files.
- `-1` means unlimited for every setting whose schema accepts it
  (`execution.maxPromptTimeoutSec`, `queue.maxSteps`,
  `queue.maxWorkflowExecutionTimeSec`, retry caps), read through `LimitUtils`.
  `execution.scriptTimeoutSec` is **deliberately finite**: its schema has
  `exclusiveMinimum: 0` and `ConfigurationUtils.getScriptTimeoutMs()` falls back
  to the default for any non-positive value. Keep it that way (scripts run
  unattended and must stay bounded). Document it in the setting description;
  do not give `-1` a meaning there.

**Orchestrator findings (2026-10-10 planning pass)** — starting points for the
audits, verify before relying on them:

- Prompt timeout is read in exactly two places:
  `CliTransportCoordinator` (headless spawn `timeout`) and `CliLogMonitor`
  (log-monitor timer). Harness-specific transports that bypass both (e.g. the
  Codex app-server client, the opencode server, PTY/interactive completion
  paths) must be checked for whether they honour the setting at all. A timeout
  already maps to `FAILURE_KINDS.TIMEOUT` at the step level.
- Workflow time is checked by `WorkflowExecutor.checkExecutionTimeLimit` only
  before each queue step/parallel group and before each `finalStep` pass, using
  `context.dynamicQueueConfig` captured at run start. It is not checked between
  error/end-condition retries of a single step, and a mid-run settings change
  is not observed. Active time comes from
  `WorkflowStateMachine.getActiveExecutionTime()` (pauses excluded).

### Phase 2 — Observable outcomes

- Use stable structured reason codes for queue-size, prompt-timeout, and
  workflow-time stops across dashboard status/output, CLI results, MCP results,
  logs, and notifications.
- State the configured threshold and observed value in each stop message.
- Include the effective global guardrails in dry-run output
  (`dev/implemented/DRY_RUN_PREVIEW_PLAN.md` has shipped;
  `ExecutionPreviewService` already resolves the effective `maxSteps`).
- Today a step-limit stop **and** a workflow-time stop are each a
  `notifyUserFeedback` warning plus a generic runtime `fail()`
  (`WorkflowStateMachine.fail()` takes no reason), which is indistinguishable
  from a harness failure in run state — this is the gap the reason codes close.
  Attempt-level failures already carry a free-text `failureReason` and a
  step-level `FailureKind`; the run level has nothing.
- Design: one `const` code set in `DashboardConstants.ts` (queue-size limit,
  workflow-time limit, prompt timeout), one structured run-level stop reason
  `{ code, threshold, observed, message }` carried by the runtime state machine
  and persisted with the run, and one builder module for the messages (absorbing
  `buildStepLimitError` and the workflow-time message) so every surface renders
  the same text. A prompt timeout stays a step failure (`FailureKind.TIMEOUT`)
  but the run-level stop it causes carries the prompt-timeout code.

### Staging (queued by the orchestrator)

1. Prompt-timeout audit and fixes across transports/harnesses.
2. Workflow-time audit and fixes; `PromptFileParser`/editor validation against
   the effective global `queue.maxSteps`; queue counting consistency.
3. Structured stop-reason contract in core (constants, state machine,
   persistence, executor call sites, message builder).
4. CLI, MCP, and dry-run surfaces for stop reasons and effective guardrails.
5. Dashboard and notification surfaces; settings copy; close out the plan and
   release-checklist item.
- Keep configuration in the existing Execution and Queue settings sections; do
  not add workflow or prompt property controls.

## Explicitly Rejected Scope

- `limits` in `schemas/workflow-schema.json`.
- Step → workflow → settings limit resolution.
- Other workflow queue overrides; see `dev/implemented/WORKFLOW_MAX_STEPS_PLAN.md`.
- `maxDurationMs`; it duplicates the existing prompt/workflow/script timeout
  settings.
- `maxTotalAttempts`; focused retry caps plus workflow time already bound retry
  behavior, and an aggregate counter would add another surprising stop rule.
- `maxObservedTokens`; usage is incomplete for some harnesses and belongs in
  usage visibility, not a purported hard guardrail.
- `maxConcurrentSteps`; parallel-step execution owns its global concurrency
  setting, `queue.maxParallelSteps`.
- Administrator ceilings that workflow files may lower but not raise.
- Live remaining-budget widgets in workflow authoring.

## Relationship to Future Automation

Scheduling and standalone automation consume the same effective settings; they
must not invent workflow-authored limits. If scheduling later requires finite
values for a particular unattended mode, make that an explicit scheduler policy
and user choice.

Parallel steps inherit the existing queue and workflow-time settings. Their
concurrency cap (`queue.maxParallelSteps`) came from
`dev/implemented/PARALLEL_STEPS_PLAN.md`, and worktree isolation from
`dev/implemented/WORKTREE_SUPPORT_PLAN.md` (both shipped).

Observed token totals remain reporting data under
`dev/implemented/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`. They do not block execution.

## Acceptance Criteria

- No workflow or prompt schema gains a generic `limits` property.
- Every queue-entry path applies the same effective `queue.maxSteps` semantics.
- An oversized initial workflow is rejected before any step executes.
- Prompt and workflow timeouts behave consistently across supported execution
  modes and harnesses.
- Limit stops use stable reason codes and remain distinguishable from user
  cancellation and harness failure.
- Dashboard, CLI, MCP, settings copy, and dry-run output agree on unlimited
  values and configured thresholds.
- Scheduling and parallel-step plans reference these existing global controls
  without adding a second limits hierarchy.
