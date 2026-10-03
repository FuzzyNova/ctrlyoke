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

### Where run files live

By default, run history lives under
`~/.ctrlyoke/projects/<project>-<hash>/.runs/`. The
[`storage.runHistoryLocation`](/reference/settings#storage-runhistorylocation)
setting can move it to `.ctrlyoke/.runs/` inside the workspace instead. To keep
user-scope run history somewhere other than `~/.ctrlyoke`, set the
`CTRLYOKE_HOME` environment variable. Your user `settings.json` stays in
`~/.ctrlyoke` either way. Each workflow gets its own folder under `.runs/`:

| Path                                     | Contents                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workflow.json`                          | The workflow's history entry: name, favorite flag, latest run, and next run number.                                    |
| `runner.json`                            | Present only while a run executes. It names the run and the process that owns it.                                      |
| `draft/workflow.ctrlyoke.json`           | The workflow definition before its first run.                                                                          |
| `run-<timestamp>/workflow.ctrlyoke.json` | The run's working copy, described on this page.                                                                        |
| `run-<timestamp>/manifest.json`          | Run summary: state, timestamps, step count, and token totals.                                                          |
| `run-<timestamp>/events.jsonl`           | The run's event log, one JSON event per line. AI responses and script output are stored here, not in the working copy. |

ctrlyoke treats a `runner.json` lock as stale, and reclaims it, when its owning
process has exited or its heartbeat has been silent for 30 seconds. Deleting it
by hand is only needed when two synced machines share one run-history folder.

| Section | Purpose |
| --- | --- |
| [Run file root](#run-file-root) | Root fields present only in a run's working copy. |
| [Workflow runtime](#workflow-runtime) | Workflow-level runtime execution state for working files (optional, added automatically by ctrlyoke during execution). |
| [Step runtime](#step-runtime) | Per-prompt runtime execution metadata (optional, added automatically during execution). |
| [Parallel group topology](#parallel-group-topology) | Normalized working-file topology for one authored parallel group. |
| [Condition evaluation](#condition-evaluation) | Latest script-condition evaluation retained for the automation result projection (written automatically during execution). |
| [Token totals](#token-totals) | Run-scoped token aggregate projected from timeline history. |
| [Harness token totals](#harness-token-totals) | Per-harness token subtotal within a run aggregate. |

## Run file root {#run-file-root}

Root fields present only in a run's working copy.

### `parallelGroups` {#run-file-root-parallelgroups}

- **Type:** array of [Parallel group topology](#parallel-group-topology)

Normalized working-file topology for authored parallel groups.

### `startedAt` {#run-file-root-startedat}

- **Type:** `number`

Timestamp when workflow started (working files only)

### `definitionRevision` {#run-file-root-definitionrevision}

- **Type:** `integer`
- **Constraints:** minimum 1

Monotonic optimistic-concurrency counter, bumped on every definition-changing edit and not on runtime-only writes. Starts at 1; each promoted run restarts its own sequence at 1 (working files only).

### `_runtime` {#run-file-root-runtime}

- **Type:** [Workflow runtime](#workflow-runtime)

## Workflow runtime {#workflow-runtime}

Workflow-level runtime execution state for working files (optional, added automatically by ctrlyoke during execution). Its schemaVersion tracks run-file metadata independently of the root schemaVersion, which tracks the workflow-definition format.

### `schemaVersion` {#workflow-runtime-schemaversion}

- **Type:** `number`

Run-file format version for \_runtime metadata and run bookkeeping, stamped on every write. It is independent of the root schemaVersion, which versions the workflow definition format. A file written by a newer ctrlyoke is refused rather than overwritten.

### `lastActivityAt` {#workflow-runtime-lastactivityat}

- **Type:** `number`

Latest persisted activity for the run, including an appended step that has not started yet.

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

### `worktree` {#workflow-runtime-worktree}

- **Type:** `{ schemaVersion: 1, mode, origin, … }`

Disk-authoritative lifecycle metadata for a worktree-backed run. Distinct from the authored root `worktree` setting: this records the checkout the run actually used.

### `worktree.schemaVersion` {#workflow-runtime-worktree-schemaversion}

- **Type:** `1`
- **Required:** yes

### `worktree.mode` {#workflow-runtime-worktree-mode}

- **Type:** `"managed" | "named"`
- **Required:** yes

### `worktree.origin` {#workflow-runtime-worktree-origin}

- **Type:** `"created" | "discovered" | "recovered"`
- **Required:** yes

Whether ctrlyoke created the worktree, found it already present, or recovered it after an interrupted run

### `worktree.branchName` {#workflow-runtime-worktree-branchname}

- **Type:** `string`
- **Required:** yes

### `worktree.worktreePath` {#workflow-runtime-worktree-worktreepath}

- **Type:** `string`
- **Required:** yes

### `worktree.executionRoot` {#workflow-runtime-worktree-executionroot}

- **Type:** `string`
- **Required:** yes

### `worktree.executionCheckoutRoot` {#workflow-runtime-worktree-executioncheckoutroot}

- **Type:** `string`
- **Required:** yes

### `worktree.sourceCheckoutRoot` {#workflow-runtime-worktree-sourcecheckoutroot}

- **Type:** `string`
- **Required:** yes

### `worktree.namedWorkspaceRoots` {#workflow-runtime-worktree-namedworkspaceroots}

- **Type:** array of `{ name, fsPath }`
- **Required:** yes

Fields:

- `name` · `string` · required
- `fsPath` · `string` · required

### `worktree.baseCommit` {#workflow-runtime-worktree-basecommit}

- **Type:** `string`
- **Required:** yes

### `worktree.comparisonBaseLabel` {#workflow-runtime-worktree-comparisonbaselabel}

- **Type:** `string`

Recorded comparison base used for named-branch divergence, when known

### `worktree.comparisonBaseCommit` {#workflow-runtime-worktree-comparisonbasecommit}

- **Type:** `string`

### `worktree.changedFileCount` {#workflow-runtime-worktree-changedfilecount}

- **Type:** `number`

Number of files in the landed branch diff from baseCommit, when known

### `worktree.dirty` {#workflow-runtime-worktree-dirty}

- **Type:** `boolean`

Whether the named checkout had uncommitted changes at run start

### `worktree.sourceCheckoutDirty` {#workflow-runtime-worktree-sourcecheckoutdirty}

- **Type:** `boolean`

Whether source checkout changes existed when the managed worktree was created

### `worktree.targetBranch` {#workflow-runtime-worktree-targetbranch}

- **Type:** `string`

### `worktree.lifecycleOwner` {#workflow-runtime-worktree-lifecycleowner}

- **Type:** `"ctrlyoke" | "user"`
- **Required:** yes

### `worktree.lifecycleState` {#workflow-runtime-worktree-lifecyclestate}

- **Type:** `"provisioning" | "ready" | "finalizing" | "settled" | "blocked" | "orphaned"`
- **Required:** yes

### `worktree.setupOutcome` {#workflow-runtime-worktree-setupoutcome}

- **Type:** `"pending" | "running" | "succeeded" | "failed"`

### `worktree.landingOutcome` {#workflow-runtime-worktree-landingoutcome}

- **Type:** `"landed" | "no-changes" | "blocked"`

### `worktree.mergeOutcome` {#workflow-runtime-worktree-mergeoutcome}

- **Type:** `"fast-forward" | "merge-commit" | "conflict" | "blocked" | "abort-failed"`

### `worktree.directoryState` {#workflow-runtime-worktree-directorystate}

- **Type:** `"present" | "removed" | "missing" | "remove-failed"`
- **Required:** yes

### `worktree.branchState` {#workflow-runtime-worktree-branchstate}

- **Type:** `"present" | "deleted" | "missing"`
- **Required:** yes

### `worktree.finalBranchTip` {#workflow-runtime-worktree-finalbranchtip}

- **Type:** `string`

### `worktree.conflictFiles` {#workflow-runtime-worktree-conflictfiles}

- **Type:** `string[]`

### `worktree.message` {#workflow-runtime-worktree-message}

- **Type:** `string`

### `worktree.updatedAt` {#workflow-runtime-worktree-updatedat}

- **Type:** `number`
- **Required:** yes

### `worktreeNotice` {#workflow-runtime-worktreenotice}

- **Type:** `string`

Durable notice recorded when an inherited worktree default degraded to ordinary execution

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

0-based index of the current final-step pass (pass N is loopCount N-1)

### `finalStep.status` {#workflow-runtime-finalstep-status}

- **Type:** `"pending" | "sent" | "running" | "completed" | "failed" | "cancelled" | "skipped"`

Current final step status

### `finalStep.failureKind` {#workflow-runtime-finalstep-failurekind}

- **Type:** `"userCancelled" | "processExit" | "harnessError" | "harnessNotInstalled" | "timeout" | "unknown"`

Structured classification for the latest final-step failure

### `finalStep.failureMessage` {#workflow-runtime-finalstep-failuremessage}

- **Type:** `string`

Human-readable reason for the latest final-step failure

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

Per-prompt runtime execution metadata (optional, added automatically during execution). Execution-property fields record the values the step actually ran with after inheritance, including the session ID the harness reported; secrets are recorded by name only, never by value. The step's response text is not stored here — the run's events.jsonl is the only record of step output.

Also includes every field from [Execution properties](/reference/workflow-schema#execution-properties).

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

### `elapsed` {#step-runtime-elapsed}

- **Type:** `number`

Completed prompt duration in seconds

### `contextWindowUsed` {#step-runtime-contextwindowused}

- **Type:** `number`

Context window tokens in use, captured from the last completed output

### `contextWindowSize` {#step-runtime-contextwindowsize}

- **Type:** `number`

Context window size in tokens, captured from the last completed output

### `failureKind` {#step-runtime-failurekind}

- **Type:** `"userCancelled" | "processExit" | "harnessError" | "harnessNotInstalled" | "timeout" | "unknown"`

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

How the compare source is compared against `expected`. Default: 'eq' (whole-value literal match on trimmed text; numeric when compareSource is exitCode). 'contains'/'notContains' are substring tests. 'gte'/'gt'/'lte'/'lt' are numeric and fail when either side is not a number. 'matches' treats `expected` as an unanchored regular expression — add ^ and $ to require a full match. 'isEmpty'/'isNotEmpty' take no `expected`. Use word tokens such as `gte` and `ne`; `operator: >=` and `operator: !=` are YAML parse errors.

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
