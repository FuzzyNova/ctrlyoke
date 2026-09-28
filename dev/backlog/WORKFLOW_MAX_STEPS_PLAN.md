# Workflow `maxSteps` Plan

**Status:** In progress (2026-09-27) — staged as five orchestrated steps; see [Implementation staging](#implementation-staging).

**Amends:** `dev/backlog/EXECUTION_GUARDRAILS_PLAN.md`. That plan's "Explicitly Rejected Scope"
lists "`maxSteps`; it duplicates `queue.maxSize`", and its Product Decision says a workflow should
not override the queue size. This plan reverses that one bullet, for the reasons in [Why](#why).
Its other rejections still stand: no generic `limits` object, no per-step limits, no
workflow-level time, concurrency, attempt, or token limits, and no admin ceilings. Editing that
plan is part of Phase 1.

**Related:** `dev/rejected/UNLIMITED_LIMIT_VALUES_PLAN.md` is the rejected alternative that
stored `"unlimited"` instead of `-1`. What survived from it is in
[Limit presentation](#limit-presentation).

## Goal

1. Add a workflow-root property, `maxSteps`, that overrides the global step cap for one workflow.
   A number sets a cap even when the global setting has none. `-1` removes the cap even when the
   global setting has one.
2. Rename the setting `queue.maxSize` to `queue.maxSteps`, so one concept has one name at both
   scopes. The setting and the workflow property take the same value shape: an integer ≥ 1, or
   `-1` for unlimited. `-1` is the notation every existing limit already uses.
3. **Remove `queue.unlimitedMode`** (decided 2026-09-27). It was meant as shorthand for "set the
   step cap and the time limit to unlimited", but the settings UI never reflected that. Checking
   it left both fields showing their old values, so the page displayed limits that were not being
   applied. Each limit can already be switched off directly: `queue.maxSteps: -1` and
   `queue.maxWorkflowExecutionTimeSec: -1`. Removing the toggle also removes the question of
   whether it or a workflow's `maxSteps` wins. It also gives "Set as default" a single setting
   to write (see [Set as default](#set-as-default)).
4. Add a **Max Steps** control to the Validation page of `WorkflowPropertiesPanel`, after Error
   Behavior. It is set at workflow level only, with no per-step override, like `worktree` and
   `trustedExternalRoots`.
5. Route every step-cap check through one resolver. The cap counts every step in the run,
   whether the author, an agent (`append_step`), the dashboard, or the CLI queued it. `maxSteps`
   means the maximum number of steps, whoever queued them.
6. Present every `-1` limit the same way in the UI, using one shared picker and one sentence in
   the schema descriptions (see [Limit presentation](#limit-presentation)).

## Why

**The use case.** Nathan runs with global limits off because most of his workflows are
conversations that grow to hundreds of turns. His orchestrator workflows are different.
`long-running-bug-fix`, for example, has a `finalStep` that files bugs and uses `append_step` to
queue fix steps. That loop can run forever; it had appended 22 steps when this plan was written.
Today the only way to cap that loop is to turn limits back on for _every_ workflow.

**Step count is part of a workflow's design; time and parallelism are properties of the
machine.** A "fix bugs until done" loop capped at 30 means the same thing on any machine.
`maxParallelSteps` (how many harness processes run at once) and `maxWorkflowExecutionTimeSec`
(a wall-clock budget) are hardware and budget policy, so they stay global.

**Answers to the guardrails plan's objections:**

| Objection                                                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| It duplicates `queue.maxSize`.                                    | It is the same concept at a narrower scope, like every other workflow property (`harness` ↔ `defaults.harness`). After the rename, both scopes share one name and one value shape.                                                                                                                                                                                                                                                                                                                                                                                       |
| A workflow could weaken a user's safety preference.               | The step cap guards against cost and runaway loops. It is **not a security boundary**: a step runs with the same permissions no matter how many came before it. Workflows already control far stronger policy (`toolPermissions.mode: dangerouslyAllowAll`, shell `hooks`, `mcpServers`) and other guardrails (`endCondition.maxRetries`, `errorBehavior.maxRetries`). The remaining risk is that a shared workflow sets a cap that is too loose (cost) or too tight (it stops early). Either is visible in the file and in the panel, like any other authored property. |
| Copied workflows would carry machine-specific operational policy. | That is true of time and concurrency, which is why those stay global. A step count is not machine-specific.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mixed limits make the effective envelope harder to explain.       | There is one number with two scopes. The panel shows the resolved value (`Inherit (100)`), and dry-run and `workflow_status` report the effective cap and where it came from.                                                                                                                                                                                                                                                                                                                                                                                            |
| Avoid building another inheritance system.                        | There is nothing new to build. This uses the workflow → settings inheritance that every execution property already has. It is not the step → workflow → settings `limits` hierarchy the guardrails plan rejected.                                                                                                                                                                                                                                                                                                                                                        |

## Naming decision

**`maxSteps`** at both scopes: workflow `maxSteps`, settings `queue.maxSteps`.

- The value is a number of steps. `checkQueueSizeLimit` compares it with `steps.length`, and
  `workflow_status` reports `totalSteps` next to it. "Queue" is internal vocabulary, and the
  workflow schema has no queue noun.
- Beside `maxParallelSteps`, `maxSteps` reads as the same unit: total steps versus concurrent
  steps.
- SCHEMA_UI_NAME_ALIGNMENT §1 rule 2: the same concept gets the same word on every surface.
- Churn: about 60 references to `maxSize` and about 30 to `unlimitedMode` outside tests, plus
  about 12 test files. We are pre-release, so there are no aliases and no migration shims.

**UI label: "Max Steps"** (rule 1: the humanized property name, matching "Max Retries"). The
Queue settings row changes from "Max queue size" to "Max steps".

## Semantics

### Values (the same shape at both scopes)

| Value       | Workflow `maxSteps`                                 | Settings `queue.maxSteps` |
| ----------- | --------------------------------------------------- | ------------------------- |
| omitted     | Inherits the settings value                         | Default `100`             |
| integer ≥ 1 | Caps the run at that number                         | Caps at that number       |
| `-1`        | No cap for this workflow, whatever the setting says | No global cap             |

Effective cap = the workflow value if the key is present, otherwise the setting. That is the
whole rule. There is no third input now that `unlimitedMode` is gone.

- The schema accepts exactly `-1` or an integer ≥ 1, as a `oneOf` of the shared `-1` definition
  (see [Limit presentation](#limit-presentation)) and `{ type: integer, minimum: 1 }`. It does
  **not** use `minimum: -1`, which would also admit `0`, a value with no meaning for a cap.
  Code today silently treats `<= 0` as unlimited in `WorkflowExecutor.checkQueueSizeLimit` and
  `ExecutionPreviewService.buildLimits`; that behaviour is removed.
- Define the value once, as `$defs.maxStepsValue` in `workflow-schema.json`, and have
  `settings-schema.json` `queue.maxSteps` `$ref` it (the §3b sibling-ref pattern), so the two
  schemas cannot drift.
- `null` is **not** accepted. In YAML, `maxSteps:` with nothing after it parses as `null`, and
  elsewhere in the workflow schema `null` means "disable what would be inherited". Both make
  `null` a bad spelling for "remove a restriction".

### What is counted

The count is the number of entries in the run's `steps` array: every step, however it got there,
including parallel-group members and disabled steps. `finalStep` iterations are **not** counted,
and neither are retries. A `finalStep` loop is still bounded, because every iteration that grows
the queue adds entries. Once the cap refuses further appends, the final step completes without
adding anything and the run ends. The schema description must say this, because "max steps"
could be read as "max step executions".

### Live edits

The working copy is live, so editing `maxSteps` in the panel during a run takes effect at the next
check. Every check reads `maxSteps` from the run's current workflow file:
`promptQueue.getWorkflowFile()` in-process, or the file read under lock in
`RunContinuationService`. The global value can keep coming from the
`context.dynamicQueueConfig` snapshot taken at the start of the run.

## UI

### New workflows and the default

- **New workflows omit `maxSteps`**, so they inherit `queue.maxSteps`. There is **no new
  `defaults.maxSteps` setting**. `queue.maxSteps` already _is_ the default for workflows that do
  not set one. A second "default for new workflows" setting would be the real duplicate the
  guardrails plan warned about, and it would split one meaning into two: one number for "what I
  get when I don't say" and another for "what gets written into new files".
- Templates can set `maxSteps` in their own definitions; orchestrator templates are the obvious
  candidates. Whether to do so is a per-template product call and is out of scope here.

### The control

`LimitSelect` (see [Limit presentation](#limit-presentation)) with an Inherit option, following
the three-mode pattern of `trustedExternalRoots` (`TRUSTED_ROOTS_SELECTION_OPTIONS_META`):

| Option                                      | Writes          | Shown when selected                                                                               |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| **Inherit (100)** / **Inherit (Unlimited)** | `omit maxSteps` | nothing else; the label shows the resolved setting                                                |
| **Unlimited**                               | `maxSteps: -1`  | nothing else                                                                                      |
| **Custom**                                  | `maxSteps: <n>` | a number input (min 1), prefilled with the resolved setting, or 100 when the setting is unlimited |

The UI never shows `-1`. Users pick **Unlimited**, and the file gets `-1`.

We considered a single number field, blank for Inherit and showing the global value as its
placeholder. It cannot express **Unlimited**, and Unlimited is exactly the override the reverse
case needs: a conversation workflow that should never be capped even when the global setting
has a cap.

The settings page uses the same component without an Inherit option. There, falling back to a
lower settings scope is already handled by the row's Reset button.

### Set as default

The button appears when the workflow's value is present and differs from `queue.maxSteps`. It
copies the workflow's value (a number, or `-1`) straight into `queue.maxSteps` through a
`ConfigurationUtils.setMaxSteps` branch in `WebviewSettingsSync.handleSetAsDefault`
(`WebviewSettingsSync.ts:675`). This follows the existing branches that write a reshaped target,
such as `model → defaults.models.<harness>`. The write is a plain copy because both scopes share
one value shape and `unlimitedMode` is gone. If `unlimitedMode` stayed, a default of 30 written
while it was on would silently do nothing, and an Unlimited default would have to flip a flag
that also disables the time limit.

`isDifferentFromGlobal` needs a `maxSteps` entry in `globalSettings` that holds the raw
`queue.maxSteps` value.

## Limit presentation

These are the parts of the rejected `"unlimited"` plan that do not depend on how the value is
stored. `-1` stays the stored value for every limit. What changes is how limits look in the UI and
how they are described. Everything here lands in the same change as `maxSteps`, so every
existing limit gets the Unlimited picker at the same time as the new one.

### Inventory of `-1` fields (verified 2026-09-27)

| Field                                                                            | `-1` means       | UI site                                                                   |
| -------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| workflow `maxSteps`, settings `queue.maxSteps` (new)                             | unlimited        | `WorkflowPropertiesPanel.tsx`, `QueueSection.tsx`                         |
| settings `execution.maxPromptTimeoutSec` (and CLI `--timeout`)                   | unlimited        | `ExecutionSection.tsx`                                                    |
| settings `queue.maxWorkflowExecutionTimeSec`                                     | unlimited        | `QueueSection.tsx` ("(seconds, -1 = unlimited)")                          |
| settings `runs.maxRuns`                                                          | keep all runs    | `GeneralSection.tsx`                                                      |
| workflow `endCondition.maxRetries` (also `defaults.endCondition` via its `$ref`) | unlimited        | `ScriptConditionEditor.tsx` (also rendered on the Workflow Defaults page) |
| settings `ui.outputVirtualizationRowThreshold`                                   | never virtualize | `GeneralSection.tsx`                                                      |

### Schema

- Add `$defs.unlimitedValue` to `workflow-schema.json`: `{ "const": -1, "description": "Unlimited." }`.
  Each unlimited-limit field becomes a `oneOf` of a `$ref` to it and the field's real integer
  range. Settings fields reach it through sibling `$ref`s. This gives `-1` its own hover text and
  removes the `0` that `minimum: -1` lets in for fields where `0` means nothing (the timeouts,
  `maxRuns`). `endCondition.maxRetries` keeps `0` because 0 retries is a real value.
- Every description uses one sentence form: "`-1` means unlimited." For the threshold, "`-1`
  means never."
- `schemas/archive/v1/` must be updated too. `scripts/publish-schemas-to-landing.mjs`
  (`assertArchiveMatchesCurrent`) requires it to match `schemas/` byte for byte while v1 is
  current, so copy the regenerated schemas into it.

### Code

- `DashboardConstants.ts`: `UNLIMITED_LIMIT = -1`.
- `src/utils/LimitUtils.ts`: `isUnlimited(limit)` and `exceedsLimit(count, limit)`. Types stay
  `number`. Every reader uses these helpers instead of writing `=== -1` inline:
  - `PromptQueue.ts:1362,1381`
  - `WorkflowExecutor.ts:3448,4708,5025`
  - `ExecutionPreviewService.ts:1258,1362`
  - `OutputHistoryManager.ts` and `RunSummaryCache.ts`
  - the `QueueLimitUtils` resolver below
- Delete the dead branch at `WorkflowExecutor.ts:391`. It checks `errorBehavior.maxRetries === -1`,
  but the schema requires `minimum: 1`.

### UI

- `components/shared/LimitSelect.tsx` is a picker plus a number input, built from option
  metadata. It has an **Unlimited / Custom** variant and a **Never / Custom** variant (for the
  threshold), and an optional `inheritLabel` that adds **Inherit (…)**. Unlimited or Never
  writes `-1`. The component uses every UI site in the inventory, and `ScriptConditionEditor`
  replaces its free number input for `maxRetries` with it.
- Labels keep their units ("seconds"). The "-1 = …" suffixes are dropped.

### Vocabulary

SCHEMA_UI_NAME_ALIGNMENT §1.1 reserves **None** for "none of this thing", and already assigns
**Never** to a different concept: a "when?" question answered with no time. A limit's "nothing"
is a third concept, _no bound_. "Max Steps: None" could just as easily be read as "a maximum of
zero steps", the opposite of what it means. Using a different word for a different concept is
rule 2, the same rule that produced **Never**:

| Word          | Means                                                            | Writes | Used for                               |
| ------------- | ---------------------------------------------------------------- | ------ | -------------------------------------- |
| **Unlimited** | A limit answered with no bound. It overrides anything inherited. | `-1`   | every "unlimited" row in the inventory |

- Add this row to the §1.1 table in `dev/implemented/SCHEMA_UI_NAME_ALIGNMENT_PLAN.md`, which is
  still where that policy is written down.
- `SchemaUiMetadata.test.ts` ("labels follow the nothing vocabulary…"): add a limit-path
  allowlist for the Unlimited option, alongside the existing `timingValues` allowlist for
  `never`, and add `ui.outputVirtualizationRowThreshold` to the Never allowlist.
- That test also requires one label per option value across all tables, so the Unlimited and
  Never options need their own value keys (`unlimited` / `never`, which the metadata maps to
  `-1`), not `none`.
- `workflow_status` keeps reporting `"unlimited"` in its output. That is a display surface, like
  the UI label.

## Current enforcement (verified 2026-09-28)

| Site                                                                                                       | What it does                                                                                      | Global source                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `WorkflowExecutor.checkStepLimit` (`WorkflowExecutor.ts:4754`)                                             | After a `finalStep` iteration grows the queue, fails the run if the effective cap is exceeded     | `ConfigurationUtils.getGlobalMaxSteps()`        |
| `WorkflowInstance.appendFromFile` (`WorkflowInstance.ts:2564`)                                             | Rejects appending a workflow file past the effective cap                                          | `ConfigurationUtils.getGlobalMaxSteps()`        |
| Dashboard editor (`WorkflowInstance.ts:3274`)                                                              | Rejects prompt and parallel-member appends past the effective cap                                 | `ConfigurationUtils.getGlobalMaxSteps()`        |
| `RunContinuationService.appendStepsToRun` / `…ToActiveParallelGroup` (`RunContinuationService.ts:280,451`) | Checks under the run-file lock against `source.maxSteps` and a required global limit              | caller                                          |
| CLI `append` (`cli.ts:1811`)                                                                               | Passes the in-process global limit into the locked append transaction                             | `ConfigurationUtils.getGlobalMaxSteps()`        |
| Lifecycle and orchestrator (`RunLifecycleService.ts:741`, `WorkflowOrchestrator.ts:4606`)                  | Pass the in-process limit through the shared append service                                       | `ConfigurationUtils.getGlobalMaxSteps()`        |
| `mcp-server.ts:1150` (`append_step`)                                                                       | Passes the global value from `CTRLYOKE_MAX_STEPS`                                                 | env set by `CliProviderUtils.ts:538` at spawn   |
| `mcp-server.ts:982` (`workflow_status`)                                                                    | Reports effective `maxSteps` / `remainingSteps` from `queueData.maxSteps` and the MCP environment | env                                             |
| `ExecutionPreviewService.buildLimits` (`:1352`)                                                            | Reports the effective cap, source, and any violation                                              | workflow value and `options.dynamicQueueConfig` |

The initial audit found unchecked CLI, dashboard, lifecycle, and orchestrator append paths. Step 2
now routes them through the same locked resolver; workflow `maxSteps` is read from the current run
file under the lock, so edits apply on the next append. MCP gets its global value from the
environment supplied to its subprocess, while in-process callers read `ConfigurationUtils`.

## Design

### Single resolver (`src/utils/QueueLimitUtils.ts`)

```ts
/**
 * Effective step cap for a run. An undefined workflow value means inherit.
 * A result of UNLIMITED_LIMIT (-1) means no cap.
 */
export function resolveEffectiveMaxSteps(
  workflowMaxSteps: number | undefined,
  globalMaxSteps: number
): number;
```

- `QueueLimitPolicy` is replaced by a plain `number`. The MCP server reads it from the env
  variable `CTRLYOKE_MAX_STEPS`, and in-process callers read it from `ConfigurationUtils`. The
  existing "in-process callers must not read the env" comment still applies.
- Every enforcement site calls `resolveEffectiveMaxSteps` and then `exceedsLimit`. No site
  compares against the raw setting.
- `RunContinuationService` makes the global limit a **required** parameter instead of
  `queueLimit?`, and resolves it against `source.maxSteps` under the lock. The optional
  parameter is how the CLI and dashboard gaps happened.
- The error text names the property and tells an agent what to do:
  `Step limit reached: this run has 30/30 steps (workflow maxSteps: 30). Do not retry; finish
without appending.` The source is named as either `workflow maxSteps` or
  `setting queue.maxSteps`.
- `WorkflowExecutor.checkQueueSizeLimit` becomes `checkStepLimit` and keeps its current stop
  behaviour. Reason codes belong to EXECUTION_GUARDRAILS_PLAN Phase 2.
- `checkExecutionTimeLimit` loses its `unlimitedMode ||` branch and uses `isUnlimited`.

### Renames and removals (one pass, no shims)

| From                                                                                                       | To                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| settings `queue.maxSize`                                                                                   | `queue.maxSteps` (`$ref` `maxStepsValue`)                                                                                                         |
| settings `queue.unlimitedMode`                                                                             | **removed**                                                                                                                                       |
| `CtrlYokeSettings.queue.maxSize` / `.unlimitedMode`                                                        | `queue.maxSteps` / removed                                                                                                                        |
| `DynamicQueueConfig.maxQueueSize` / `.unlimitedMode`                                                       | `maxSteps` / removed                                                                                                                              |
| `DEFAULT_MAX_QUEUE_SIZE`                                                                                   | `DEFAULT_MAX_STEPS`                                                                                                                               |
| env `CTRLYOKE_MAX_QUEUE_SIZE` + `CTRLYOKE_UNLIMITED_MODE`                                                  | `CTRLYOKE_MAX_STEPS`                                                                                                                              |
| `getMaxQueueSize()` / `isUnlimitedMode()`                                                                  | `getGlobalMaxSteps()`                                                                                                                             |
| MCP `workflow_status` `maxQueueSize` / `remainingSlots`                                                    | `maxSteps` / `remainingSteps`. These still report `"unlimited"` when there is no cap, and now give the _effective_ value, read from the run file. |
| webview "queue size limit reached" message (`CtrlYokeWebviewProvider.ts:917`, `useMessageHandler.ts:2867`) | step-limit wording and field names                                                                                                                |
| `QueueSection.tsx` "Unlimited mode" toggle                                                                 | removed; the Max steps row has its own Unlimited option                                                                                           |

## Phases

All phases land together, so the Unlimited picker reaches every limit at once.

### Phase 1: Schema, types, rename

1. `workflow-schema.json`:
   - Add `$defs.unlimitedValue` and `$defs.maxStepsValue`, and put `maxSteps` in
     `workflowOnlyProperties`. The description covers what is counted and how Inherit works.
   - `rootScriptStep` re-lists the workflow-only `$ref`s (`workflow-schema.json:490-497`), so add
     `maxSteps` there too.
   - Convert every inventoried `-1` field to the `oneOf` shape and the standard description.
   - Add a parser test proving that `maxSteps` on a step is rejected.
2. `settings-schema.json`: `queue.maxSteps` `$ref`s `maxStepsValue` with `default: 100`. Remove
   `unlimitedMode`. Convert the settings `-1` fields.
3. Types: `PromptFile.maxSteps?: number` (`CtrlYokeTypes.ts:343`), `PROMPT_PROPERTIES.MAX_STEPS`,
   and `WORKFLOW_PROPERTY_KEYS` (`DashboardConstants.ts:3166`, which gives undo/restore for free).
   Add `UNLIMITED_LIMIT`.
4. Apply the rename table. Regenerate with `npm run generate-schema-docs`,
   `npm run generate-schema`, and `npm run generate-schema-ui-descriptions` (the `SchemaDescriptions.ts` generator), then mirror the result
   into `schemas/archive/v1/`.
5. `WorkflowDefaultsSchemaCoverage.test.ts`: `RESHAPED_DEFAULTS.maxSteps = "queue.maxSteps"`.
6. Edit `EXECUTION_GUARDRAILS_PLAN.md`:
   - Update its settings table: drop the `unlimitedMode` row, rename `maxSize`, and correct the
     stale `maxWorkflowExecutionTime` to `…TimeSec`.
   - Replace the rejected `maxSteps` bullet with a pointer to this plan.
   - Narrow the Product Decision to "no other queue override".
   - Replace the "`unlimitedMode`, `maxSize <= 0`, and `-1`" consistency bullet with "`-1` means
     unlimited everywhere, read through `LimitUtils`".

### Phase 2: Single resolver and enforcement

1. Add `LimitUtils`, `resolveEffectiveMaxSteps`, and the global accessors. Route every step-cap
   site through them, reading `maxSteps` live from the run's workflow file. Convert the other
   `-1` readers to `LimitUtils`, and delete the dead `errorBehavior.maxRetries === -1` branch.
2. Make `RunContinuationService`'s limit parameter required, and update every caller: MCP, CLI
   `append`, the dashboard editor, `RunLifecycleService`, and `WorkingFileManager`.
3. `ExecutionPreviewService.buildLimits` reports the effective cap and its source.
4. MCP `workflow_status` reports the effective cap by combining `queueData.maxSteps` with the
   global value from the env.
5. Tests:
   - A resolver truth table: workflow value omitted, a number, or `-1`, against a global number
     or `-1`.
   - MCP: an append rejected by workflow `maxSteps` while the global is `-1`, and an append
     allowed by workflow `-1` while the global is 1.
   - CLI append and dashboard-editor append are rejected at the cap.
   - A `finalStep` loop stops at the workflow cap.
   - Editing `maxSteps` mid-run takes effect at the next append.
   - The time limit is still enforced once `unlimitedMode` is gone.
   - The schema rejects `0` and `-2` on `maxSteps` and on the converted timeout/`maxRuns`
     fields, and accepts `0` on `endCondition.maxRetries`.
   - `LimitUtils` unit tests.

### Phase 3: UI

1. `SchemaUiMetadata.ts`: add `MAX_STEPS_SELECTION_OPTIONS_META` (Inherit / Unlimited / Custom)
   and the shared Unlimited and Never option rows, each with the §1 rule 4 "writes …" tooltip.
2. `LimitSelect.tsx`, used at every UI site in the inventory.
3. `WorkflowPropertiesPanel.tsx`, Validation page, after Error Behavior: a
   `FormField label="Max Steps" schemaPath="maxSteps"` containing `LimitSelect` with an
   `inheritLabel`, plus `SetAsDefaultButton`. Validation is the right page because it already
   holds the controls for when a run stops or continues (conditions, error behaviour);
   Permissions is about what the harness may touch.
4. `WebviewSettingsSync.handleSetAsDefault`: add a `MAX_STEPS` → `queue.maxSteps` branch, and add
   `maxSteps` to `globalSettings` / `isDifferentFromGlobal`.
5. `QueueSection.tsx`:
   - The "Max steps" row (`path="queue.maxSteps"`) and the time row both use `LimitSelect`.
   - Delete the "Unlimited mode" toggle.
   - `notifyOnExtension`: the UI description says "…extended beyond the limit", but the schema
     says only "…when the queue is extended". Check which one the code does, then make both
     agree.
6. `ExecutionSection.tsx` (prompt timeout), `GeneralSection.tsx` (`maxRuns`, virtualization
   threshold), and `ScriptConditionEditor.tsx` (`maxRetries`) switch to `LimitSelect`.
7. Tests:
   - Add the control id to `UI_CONTROL_IDS` in `schemaUiPropertyRoundTrip.integration.test.ts`,
     and update `settingsSchemaUiParity` (path renamed, `unlimitedMode` removed).
   - Vitest for `LimitSelect`: Unlimited or Never writes `-1`, Custom writes the number, Inherit
     removes the key, and the Inherit label reflects a numeric or `-1` setting.
   - Set as default posts the raw value, including `-1`.
   - Update the existing `ExecutionSection` and `useOutputVirtualization` tests.

### Phase 4: Docs

Update:

- `docs/workflows/dynamic-queue.md:29`
- `docs/reference/mcp-tools.md:37,52`
- `docs/cli/ctrlyoke.md:80,175`
- `docs/workflows/end-conditions.md:72`
- `docs/troubleshooting/common-errors.md:96`
- every mention of `unlimitedMode`

Any worked example should use a `finalStep` orchestrator with `maxSteps: 30`.

## Implementation staging

"All phases land together" means the feature ships as a unit. It is still built as five
commits, and each one has to leave the tree compiling and `npm test` green. Removing
`unlimitedMode` from the schema forces the whole rename through in the first commit, so the
split is:

| Step | Scope                                                                                                                                                                                                                                                                                                                      | Status  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1    | Phase 1: schemas (`unlimitedValue`, `maxStepsValue`, `maxSteps`, `oneOf` conversions), types and constants, the full rename and `unlimitedMode` removal across backend and UI (the Queue toggle is simply deleted), regenerated artifacts, `schemas/archive/v1/` mirror, `EXECUTION_GUARDRAILS_PLAN.md` edit, schema tests | Done    |
| 2    | Phase 2: `LimitUtils`, `resolveEffectiveMaxSteps`, every enforcement site, required `RunContinuationService` limit, MCP `workflow_status`, dry-run, tests                                                                                                                                                                  | Done    |
| 3    | Phase 3 items 1–2, 5–6: `LimitSelect`, option metadata, vocabulary test, and every settings page and `ScriptConditionEditor` switched to it                                                                                                                                                                                | Pending |
| 4    | Phase 3 items 3–4: the Max Steps control on the Validation page, Set as default, round-trip tests                                                                                                                                                                                                                          | Pending |
| 5    | Phase 4 docs, the §1.1 vocabulary row, and the acceptance-criteria sweep                                                                                                                                                                                                                                                   | Pending |

Each step updates its row when it commits.

Step 1 note: the workflow-level Max Steps control and Set as default remain
deferred to Step 4 as planned. The current `schemaUiPropertyRoundTrip` gate
requires a live control for every workflow property, so it reports `maxSteps`
missing in this staging step. Adding the deferred control or a temporary test
opt-out would conflict with the staged scope and project test guidance.

Step 2 note: the dry-run preview includes `maxStepsSource`; it is optional in the
preview type so existing consumers and fixtures can omit it, while generated
previews always report the source. The legacy `maxQueueSteps` output field stays
for the existing preview contract and now contains the effective cap.

Verification note: the Step 2 focused extension tests and packaging suite pass.
The full `npm test` run also reported unrelated `HostedWorkspaceViewerService`,
`WorkingFileManager`, and CLI dry-run failures, plus the schema-to-UI gate
deferred from Step 1. Repository-wide `format:check` reports 36 format
violations outside the changed files; every changed file passes Prettier.

## Non-goals

- Per-step `maxSteps`. A step cannot own a whole-run limit.
- Workflow-level overrides for `maxWorkflowExecutionTimeSec` or `maxParallelSteps`. These are
  machine or budget policy.
- A `defaults.maxSteps` setting that gets written into new workflows (see [UI](#ui)).
- Storing `"unlimited"` instead of `-1` (rejected; see
  `dev/rejected/UNLIMITED_LIMIT_VALUES_PLAN.md`).
- Counting `finalStep` iterations or retries. If "max iterations" turns out to be what
  orchestrator users need, that would be a separate `finalStep` property.
- A limit that a workflow may only lower (an admin ceiling). The guardrails plan rejected this,
  and it stays rejected.

## Acceptance criteria

- With `queue.maxSteps: -1` and workflow `maxSteps: 30`, a `finalStep` loop cannot grow the run
  past 30 steps, and the `append_step` rejection names `maxSteps`.
- With `queue.maxSteps: 100` and workflow `maxSteps: -1`, a run grows past 100.
- Every append path (MCP, CLI, dashboard editor, file append, `finalStep`) enforces the same
  effective cap through `resolveEffectiveMaxSteps`, whoever queued the step.
- Dry-run, `workflow_status`, and the Inherit label all show the effective value that is enforced.
- Set as default copies the workflow value (a number or `-1`) into `queue.maxSteps`, and the new
  default takes effect.
- No UI surface shows a raw `-1`. Every inventoried field uses `LimitSelect`, and every
  inventoried reader goes through `LimitUtils`.
- `queue.maxSize`, `unlimitedMode`, `maxQueueSize`, `CTRLYOKE_MAX_QUEUE_SIZE`, and
  `CTRLYOKE_UNLIMITED_MODE` no longer appear anywhere outside `dev/implemented/` history.
  `schemas/archive/v1/` matches `schemas/`, and `npm run check:docs` passes.
