---
description: "Fields ctrlyoke writes into a run's working copy while it executes, generated from schemas/workflow-schema.json."
editLink: false
---

<!-- AUTO-GENERATED from the JSON schemas — edit the schema descriptions or docs/reference/_partials/, then run `npm run generate-schema-docs` -->

# Run file reference

Each run keeps a working copy of its workflow at
`run-<timestamp>/workflow.ctrlyoke.json`. ctrlyoke adds the fields on this
page to that copy while the run executes. The dashboard uses them to restore
a run's state, and they help when you debug a run.

These fields are written by ctrlyoke. Do not author them in your own workflow
files. For the fields you write yourself, see the
[workflow schema reference](/reference/workflow-schema).

| Section | Purpose |
| --- | --- |
| [Run file root](#run-file-root) | Root fields present only in a run's working copy. |
| [Workflow runtime](#workflow-runtime) | Workflow-level runtime execution state for working files (optional, added automatically by ctrlyoke during execution) |
| [Step runtime](#step-runtime) | Per-prompt runtime execution metadata (optional, added automatically during execution) |
| [Parallel group topology](#parallel-group-topology) | Normalized working-file topology for one authored parallel group. |
| [Condition evaluation](#condition-evaluation) | Latest script-condition evaluation retained for the automation result projection (written automatically during execution). |
| [Token totals](#token-totals) | Run-scoped token aggregate projected from timeline history. |
| [Harness token totals](#harness-token-totals) | Per-harness token subtotal within a run aggregate. |

## Run file root {#run-file-root}

Root fields present only in a run's working copy.

### `parallelGroups` {#run-file-root-parallelgroups}

- **Type:** array of [Parallel group topology](#parallel-group-topology)

Normalized working-file topology for authored parallel groups.

### `originalFile` {#run-file-root-originalfile}

- **Type:** `string`

Path to original prompt file (working files only)

### `workflowName` {#run-file-root-workflowname}

- **Type:** `string`

Derived workflow name (working files only)

### `startedAt` {#run-file-root-startedat}

- **Type:** `number`

Timestamp when workflow started (working files only)

### `_runtime` {#run-file-root-runtime}

- **Type:** [Workflow runtime](#workflow-runtime)

## Workflow runtime {#workflow-runtime}

Workflow-level runtime execution state for working files (optional, added automatically by ctrlyoke during execution)

### `currentIndex` {#workflow-runtime-currentindex}

- **Type:** `number`
- **Required:** yes

Index of currently executing prompt (0-based)

### `executionState` {#workflow-runtime-executionstate}

- **Type:** `"idle" | "running" | "paused" | "stopped" | "cancelling" | "completed" | "error"`
- **Required:** yes

Current execution state

### `startTime` {#workflow-runtime-starttime}

- **Type:** `number`

Wall-clock timestamp when active workflow execution timing began

### `pausedTime` {#workflow-runtime-pausedtime}

- **Type:** `number`

Wall-clock timestamp when the current pause began

### `totalPausedDuration` {#workflow-runtime-totalpausedduration}

- **Type:** `number`

Accumulated time spent paused before the current pause, in milliseconds

### `executionEndTime` {#workflow-runtime-executionendtime}

- **Type:** `number`

Wall-clock timestamp when workflow execution reached a terminal state

### `activeParallelGroup` {#workflow-runtime-activeparallelgroup}

- **Type:** `{ groupId, admission }`

Durable admission state for the currently executing parallel group

Fields:

- `groupId` · `string` · required
- `admission` · `"accepting" | "closing"` · required

### `tokenTotals` {#workflow-runtime-tokentotals}

- **Type:** [Token totals](#token-totals)

Latest run-scoped token aggregate projected from timeline history (working files only, written automatically during execution)

### `pendingRewind` {#workflow-runtime-pendingrewind}

- **Type:** `{ fromStepIndex, baseDefinitionRevision }`

Durable marker for an in-place, nonzero rewind. The full pre-rewind file is kept beside the run until the continuation is committed or discarded.

### `pendingRewind.fromStepIndex` {#workflow-runtime-pendingrewind-fromstepindex}

- **Type:** `number`
- **Required:** yes

0-based index of the first rewound step

### `pendingRewind.baseDefinitionRevision` {#workflow-runtime-pendingrewind-basedefinitionrevision}

- **Type:** `number`
- **Required:** yes

Definition revision the rewind was taken from

### `finalStep` {#workflow-runtime-finalstep}

- **Type:** `{ phase, loopCount, status?, … }`

Runtime metadata for final step execution state (optional, added automatically during execution)

### `finalStep.phase` {#workflow-runtime-finalstep-phase}

- **Type:** `"queue" | "finalStep"`
- **Required:** yes

Current workflow execution phase

### `finalStep.loopCount` {#workflow-runtime-finalstep-loopcount}

- **Type:** `number`
- **Required:** yes

0-based final step execution loop count

### `finalStep.status` {#workflow-runtime-finalstep-status}

- **Type:** `"pending" | "sent" | "running" | "completed" | "failed" | "cancelled" | "skipped"`

Current final step status

### `finalStep.startedAt` {#workflow-runtime-finalstep-startedat}

- **Type:** `number`

Timestamp when final step execution started

### `finalStep.completedAt` {#workflow-runtime-finalstep-completedat}

- **Type:** `number`

Timestamp when final step execution completed

### `finalStep.preCondition` {#workflow-runtime-finalstep-precondition}

- **Type:** [Condition evaluation](#condition-evaluation)

Latest pre-condition evaluation retained for the final step's automation result projection

### `finalStep.endCondition` {#workflow-runtime-finalstep-endcondition}

- **Type:** [Condition evaluation](#condition-evaluation)

Latest end-condition evaluation retained for the final step's automation result projection

## Step runtime {#step-runtime}

Per-prompt runtime execution metadata (optional, added automatically during execution)

### `startedAt` {#step-runtime-startedat}

- **Type:** `number`

Timestamp when the executor claimed this step for dispatch

### `stepId` {#step-runtime-stepid}

- **Type:** `string`

Stable internal identity for this queue step within its run

### `completedAt` {#step-runtime-completedat}

- **Type:** `number`

Timestamp when this prompt completed execution (set for all terminal states, not just successful completion)

### `terminalStatus` {#step-runtime-terminalstatus}

- **Type:** `"completed" | "cancelled" | "failed" | "skipped"`

Terminal state of this prompt. Absent or 'completed' means successful completion. Used to restore the correct visual status after a working file reload.

### `retryCount` {#step-runtime-retrycount}

- **Type:** `number`

Number of retry attempts for this prompt

### `failureKind` {#step-runtime-failurekind}

- **Type:** `"userCancelled" | "processExit" | "harnessError" | "timeout" | "unknown"`

Structured classification of the last harness/session failure for this prompt.

### `failureMessage` {#step-runtime-failuremessage}

- **Type:** `string`

Human-readable message describing the last harness/session failure.

### `terminalFailure` {#step-runtime-terminalfailure}

- **Type:** `boolean`

Whether a failed member remains terminal for its parallel group. False when a per-step continue policy resolved the failure.

## Parallel group topology {#parallel-group-topology}

Normalized working-file topology for one authored parallel group.

### `id` {#parallel-group-topology-id}

- **Type:** `string`
- **Required:** yes
- **Constraints:** at least 1 character(s)

### `startIndex` {#parallel-group-topology-startindex}

- **Type:** `integer`
- **Required:** yes
- **Constraints:** minimum 0

### `endIndex` {#parallel-group-topology-endindex}

- **Type:** `integer`
- **Required:** yes
- **Constraints:** minimum 0

### `failFast` {#parallel-group-topology-failfast}

- **Type:** `boolean`
- **Required:** yes

## Condition evaluation {#condition-evaluation}

Latest script-condition evaluation retained for the automation result projection (written automatically during execution).

### `passed` {#condition-evaluation-passed}

- **Type:** `boolean`
- **Required:** yes

### `action` {#condition-evaluation-action}

- **Type:** `"continue" | "stopWorkflow" | "retry" | "skipPrompt"`

Populated for pre-conditions, where it explains the gate decision.

### `script` {#condition-evaluation-script}

- **Type:** `string`
- **Required:** yes

### `actual` {#condition-evaluation-actual}

- **Type:** `string`
- **Required:** yes

### `stdout` {#condition-evaluation-stdout}

- **Type:** `string`
- **Required:** yes

### `stderr` {#condition-evaluation-stderr}

- **Type:** `string`
- **Required:** yes

### `exitCode` {#condition-evaluation-exitcode}

- **Type:** `number`

### `durationMs` {#condition-evaluation-durationms}

- **Type:** `number`
- **Required:** yes

### `error` {#condition-evaluation-error}

- **Type:** `string`

### `operator` {#condition-evaluation-operator}

- **Type:** `"eq" | "ne" | "contains" | "notContains" | "gte" | "gt" | "lte" | "lt" | "matches" | "isEmpty" | "isNotEmpty"`

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. 'isEmpty'/'isNotEmpty' take no `expected`. Word tokens only: `operator: >=` is a YAML parse error and `operator: !=` silently parses as a YAML tag.

## Token totals {#token-totals}

Run-scoped token aggregate projected from timeline history. Written automatically during execution; not hand-authored.

### `total` {#token-totals-total}

- **Type:** `number`

Sum of every AI attempt's token total observed in this run

### `coverage` {#token-totals-coverage}

- **Type:** `"complete" | "partial"`

'complete' only when every executed AI attempt reported a usable total

### `reportedAttemptCount` {#token-totals-reportedattemptcount}

- **Type:** `number`

### `attemptCount` {#token-totals-attemptcount}

- **Type:** `number`

### `isFinal` {#token-totals-isfinal}

- **Type:** `boolean`

False while the run can still add usage

### `costUsd` {#token-totals-costusd}

- **Type:** `number`

### `costPartial` {#token-totals-costpartial}

- **Type:** `boolean`

### `costSources` {#token-totals-costsources}

- **Type:** array of `"harness-reported" | "price-table" | "user-override"`

### `byHarness` {#token-totals-byharness}

- **Type:** map of [Harness token totals](#harness-token-totals)

Same aggregate partitioned by the harness recorded on each immutable attempt output.

### `byLocalDay` {#token-totals-bylocalday}

- **Type:** map of map of [Harness token totals](#harness-token-totals)

Same per-harness subtotals partitioned by the attempt start's local day (YYYY-MM-DD).

## Harness token totals {#harness-token-totals}

Per-harness token subtotal within a run aggregate.

### `input` {#harness-token-totals-input}

- **Type:** `number`

### `output` {#harness-token-totals-output}

- **Type:** `number`

### `cachedInput` {#harness-token-totals-cachedinput}

- **Type:** `number`

### `cacheCreated` {#harness-token-totals-cachecreated}

- **Type:** `number`

### `reasoningOutput` {#harness-token-totals-reasoningoutput}

- **Type:** `number`

### `total` {#harness-token-totals-total}

- **Type:** `number`

### `coverage` {#harness-token-totals-coverage}

- **Type:** `"complete" | "partial"`

### `reportedAttemptCount` {#harness-token-totals-reportedattemptcount}

- **Type:** `number`

### `attemptCount` {#harness-token-totals-attemptcount}

- **Type:** `number`

### `costUsd` {#harness-token-totals-costusd}

- **Type:** `number`

### `costPartial` {#harness-token-totals-costpartial}

- **Type:** `boolean`

### `costSources` {#harness-token-totals-costsources}

- **Type:** array of `"harness-reported" | "price-table" | "user-override"`
