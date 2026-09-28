# Global Execution Guardrail Hardening Plan

> **Status:** Revised — reduced scope
>
> **Priority:** P2 — complete with or before unattended scheduling

## Existing Product Contract

ctrlyoke already exposes and enforces execution guardrails through the settings
layer:

| Concern           | Existing setting                    | Current role                                             |
| ----------------- | ----------------------------------- | -------------------------------------------------------- |
| Prompt duration   | `execution.maxPromptTimeout`        | Bounds one harness prompt; `-1` is unlimited             |
| Script duration   | `execution.scriptTimeout`           | Default timeout for pre/end-condition scripts            |
| Workflow growth   | `queue.maxSteps`                    | Bounds the workflow step list, including dynamic appends |
| Workflow duration | `queue.maxWorkflowExecutionTimeSec` | Stops at safe execution boundaries; `-1` is unlimited    |

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

- Create or identify one shared queue-limit check used by initial workflow load,
  manual append, MCP/API append, working-file reload, and `finalStep` dynamic
  extension.
- Reject an initially loaded workflow whose executable step count exceeds
  `queue.maxSteps` before its first step starts. Current append paths enforce the
  limit, but initial loading relies on later execution checks.
- Count enabled and disabled queue entries consistently with the existing queue
  definition; do not create a second “billable step” count.
- Audit `execution.maxPromptTimeout` across interactive/headless transports and
  completion monitors so `-1` and finite values have the same meaning for every
  CLI harness.
- Audit `queue.maxWorkflowExecutionTimeSec` across normal steps, script steps,
  retries, `finalStep`, pause/resume, and dynamically extended queues. Continue
  enforcing it only at safe boundaries; do not kill a harness while it may be
  writing files.
- `-1` means unlimited everywhere, read through `LimitUtils`.

### Phase 2 — Observable outcomes

- Use stable structured reason codes for queue-size, prompt-timeout, and
  workflow-time stops across dashboard status/output, CLI results, MCP results,
  logs, and notifications.
- State the configured threshold and observed value in each stop message.
- Include the effective global guardrails in dry-run output once
  `DRY_RUN_PREVIEW_PLAN.md` is implemented.
- Keep configuration in the existing Execution and Queue settings sections; do
  not add workflow or prompt property controls.

## Explicitly Rejected Scope

- `limits` in `schemas/workflow-schema.json`.
- Step → workflow → settings limit resolution.
- Other workflow queue overrides; see `dev/backlog/WORKFLOW_MAX_STEPS_PLAN.md`.
- `maxDurationMs`; it duplicates the existing prompt/workflow/script timeout
  settings.
- `maxTotalAttempts`; focused retry caps plus workflow time already bound retry
  behavior, and an aggregate counter would add another surprising stop rule.
- `maxObservedTokens`; usage is incomplete for some harnesses and belongs in
  usage visibility, not a purported hard guardrail.
- `maxConcurrentSteps`; parallel-step execution must own its global concurrency
  setting when that feature is designed.
- Administrator ceilings that workflow files may lower but not raise.
- Live remaining-budget widgets in workflow authoring.

## Relationship to Future Automation

Scheduling and standalone automation consume the same effective settings; they
must not invent workflow-authored limits. If scheduling later requires finite
values for a particular unattended mode, make that an explicit scheduler policy
and user choice.

Parallel steps inherit the existing queue and workflow-time settings. Their
concurrency cap belongs to `PARALLEL_STEPS_PLAN.md`, while safe file isolation
belongs to `WORKTREE_SUPPORT_PLAN.md`.

Observed token totals remain reporting data under
`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`. They do not block execution.

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
