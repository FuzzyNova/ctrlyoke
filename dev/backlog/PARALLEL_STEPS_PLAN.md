# Parallel Step Execution Within a Single Workflow

> **Last Updated:** September 3, 2026
>
> **Status:** Ready to implement in the staged order below. Audited against `main` on this
> date; every symbol named in "Current-Code Audit" was verified. Concurrent fan-out stays
> behind the gate in Decision 4 until Stages 1–5 are complete and verified. Recommended
> precursor: [`OUTPUT_STEP_FILTER_PLAN.md`](../implemented/OUTPUT_STEP_FILTER_PLAN.md),
> which has shipped and whose state and row primitives Stage 5 reuses.
>
> **Staging note:** this doc is written to be handed to the Spec-Driven Loop orchestrator as
> its `specFile`. Each stage's numbered items are the intended queue-step granularity;
> Stages 3 and 5 are large enough that the orchestrator should split them into two or three
> steps each along the numbered items. Every step must leave `npm run typecheck`,
> `npm run lint`, and `npm test` green and commit its own work. `npm run test:harness` is
> never part of this plan's verification.

## Outcome

Add a `parallel:` queue item that runs a flat group of normal prompt/script steps with a
join before the following step.

```yaml
harness: claude-cli
model: sonnet

steps:
  - name: setup
    prompt: Read the codebase and summarize the architecture.

  - parallel:
      - name: research-auth
        prompt: Research authentication in this codebase.
      - name: research-db
        prompt: Research the database schema.
      - name: research-perf
        prompt: Identify performance bottlenecks.
    failFast: true

  - name: synthesize
    priorContext: [2, 3, 4]
    prompt: Synthesize the parallel research.
```

The first release is a structured fork/join feature, not a general DAG:

- Queue items before the group finish first.
- Enabled members of the group may execute concurrently, subject to a global concurrency
  limit.
- The next queue item starts only after every started member has settled and the group
  join has committed.
- Nested parallel groups and parallel `finalStep` values are not supported.
- Flat integer step numbering remains authoritative. The example above still has steps
  1–5, and `priorContext: [2, 3, 4]` keeps its existing meaning.
- Members are prompt or script steps only. Step types proposed elsewhere
  (`WORKFLOW_STEP_PLAN.md`'s `subWorkflowStep`, `USER_INPUT_STEP_PLAN.md`'s `userInput`)
  must opt in explicitly if they ever want to be group members; the parser rejects them
  inside `parallel:` by default.

## Why Build It

This is different from running independent workflows at once. Parallel steps share one
workflow definition, one run timeline, variables, a join point, and downstream context.
The primary use case is parallel research or independent implementation tasks followed by
a synthesis/validation step.

Do not grow this first release into `dependsOn`/DAG scheduling. A DAG can be considered
later if real workflows need partial joins or multiple downstream branches.

## Naming

Two words this feature would naturally use already mean something else in the codebase:

- `barrier` is the worktree _landing barrier_ (`WorktreeManager`, `WorkflowInstance`,
  `HarnessIntegration`, `CliIntegration`).
- `parallel` in existing comments means _independent workflows running at once_.

Use the `ParallelGroup` prefix for every new identifier (`ParallelGroupDefinition`,
`ParallelGroupCoordinator`, `commitParallelGroupJoin`, `parallelGroupId`) and say "join"
rather than "barrier" in code. Prose in this doc uses "join" from here on.

## Current-Code Audit

All claims below were verified on 2026-09-03. Where the previous revision of this doc was
wrong, the correction is stated.

### Definition and run storage

- `WorkflowStep` is the `PromptStep | ScriptStep` union (`src/types/CtrlYokeTypes.ts`).
  `STEP_TYPES` lives in `src/types/DashboardConstants.ts`, not `CtrlYokeTypes.ts`;
  `PromptStep.type` is optional and defaults to prompt. `parallel` is a container in the
  authored syntax, not a third `STEP_TYPES` discriminant. (Do not confuse `STEP_TYPES` with
  `PREVIEW_STEP_TYPES`, a same-valued constant used only by dry-run preview types.)
- **No step has a stable id.** `PromptStep`, `ScriptStep`, and `PromptRuntimeMetadata`
  (`_runtime`) carry no `id`; step identity is the flat array index everywhere
  (`WorkflowAttemptTarget = { kind: "queue"; stepIndex } | { kind: "finalStep"; loopIndex }`,
  React keys in `WorkflowStepsPanel` are index-derived). `ParallelGroupDefinition.id` will
  be the first stable definition-level identity in the model. `crypto.randomUUID()` is used
  for `WorkflowInstance.id`; `WorkflowKey`/`RunRef` are sanitized-name-plus-timestamp
  strings, not UUIDs (the previous revision implied otherwise).
- `WorkingFile extends PromptFile` and is stored under the run lineage. Definition
  revisions are captured by `buildDefinitionSnapshot()` (`WorkflowStepSanitizer.ts`) into
  `WorkflowDefinitionSnapshot` (`WorkflowTimelineTypes.ts`) and persisted by exactly one
  timeline event, `DEFINITION_REVISION_COMMITTED`, via
  `TimelineRecorder.commitDefinitionRevisionIfNewer()`. Every other event carries only the
  revision number. `RunOutputResolver` reads the snapshot back. Revision 1 is not
  re-committed; the run's own `workflow.ctrlyoke.json` is its record.
- `PromptFileParser.normalizePromptFile()` (private; entry via `validateAndNormalize`)
  flattens authored root `parallel:` containers into `steps`, records their inclusive
  ranges in `parallelGroups`, and handles `finalStep` separately after the array.
  `validateWorkflowSteps()` still iterates the authoritative flat array, reports
  `Step N:` messages, and validates any supplied topology and sibling references.
- `schemas/workflow-schema.json` is the source; `schemas/workflow-schema.yaml` is
  generated by `scripts/generate-yaml-schema.mjs` in `precompile` and must be regenerated.
  `steps.items` is `$ref: #/definitions/workflowStep` (`oneOf` `promptStep` | `scriptStep`
  plus a `not: required: [worktree]` guard). A `{ parallel: [...] }` item is rejected today
  because it satisfies neither `required` set, not because of a root
  `additionalProperties: false` (the root has none; `scriptStep` does). The
  template-metadata `if/then` branch near the top of the schema restricts `harness` on
  `steps.items` and `finalStep` independently of `workflowStep`; a `parallel` item's
  members must get the same restriction there.
- `WorkflowSerializer.buildCleanWorkflow()` (`src/ui/WorkflowSerializer.ts`) is a flat
  field allow-list (`WORKFLOW_FIELDS`, `PROMPT_FIELDS`) over `workingFile.steps`. Any
  unknown top-level key is silently dropped on Save As / Save As Template, so group
  definitions vanish unless the serializer learns to reconstruct `parallel:` items.
- **Mutation entry points** (the previous revision named `WorkflowCommandHandler`, which is
  a three-method open-file helper and not a mutation path):
  - `PromptQueue`: `appendSteps`, `insertStepAfterIndex`, `replaceStep`, `updatePrompt`,
    `deletePrompt`, `reorderPendingPrompts`, `applyPendingRewind`, `syncStepsForUndoRedo`,
    plus the guards `assertPendingRewindSuffixIndex`, `assertNoPendingRewindWorkflowMutation`,
    `assertPendingRewindUndoRedoSuffix`, `assertEditableDuringExecution`.
  - `WorkingFileManager` static at-run mutators: `appendStepsToRun`, `insertStepAtRun`,
    `updateStepAtRun`, `updateFinalStepAtRun`, `deleteStepAtRun`, `reorderStepsAtRun`,
    `syncStepsForUndoRedoAtRun`, `beginPendingRewind` / `discardPendingRewind` /
    `commitPendingRewind`, `seedNewRun`, `promoteToNewRun`, `createWorkingFile`, and the
    index-paired merge/diff helpers plus `mergeDiskSteps`.
  - `RunContinuationService.appendStepsToRun` computes its splice point with
    `resolveQueueInsertIndex()` (`DashboardConstants.ts`) clamped by
    `immutablePrefixLength()`; the MCP `ctrlyoke_append_queue` handler in
    `src/mcp-server.ts` calls it, and the running executor picks the result up through
    `PromptQueue.mergeStepsFromDisk()`.
  - `WorkflowInstance`: `appendFromFile`, `executeEphemeralPrompt`,
    `insertWorkflowStepAfterIndex`, `updatePromptInQueue`, `updateFinalStepInQueue`,
    `deletePromptFromQueue`, `reorderPendingPrompts`, `beginPendingRewind`, and
    `reconcileExecutionStateAfterStepChange()` (required after any queue edit that can
    change whether work remains).
  - Dashboard side: `src/ui/WorkflowStepHandlers.ts` and `WorkflowMutationCoordinator.ts`,
    routed by `WebviewMessageRouter`; message types `EXECUTE_PROMPT`, `UPDATE_PROMPT`,
    `INSERT_WORKFLOW_STEP`, `DELETE_PROMPT`, `REORDER_PROMPTS`, `UNDO_REDO_SYNC`,
    `SET_START_POSITION`, `DISCARD_CONTINUATION`, `SEED_NEW_RUN`, `CONTINUE_RUN`,
    `APPEND_AND_CONTINUE_RUN`; echoes `STEPS_EXTENDED`, `PROMPT_DELETED`,
    `UPDATE_FINAL_PROMPT`, `REORDER_PROMPTS_CONFIRMED`.
  - `REORDER_PROMPTS` carries `newPendingOrder: number[]` — **slice-relative positions
    within the pending tail**, not absolute indices — and the webview keeps an optimistic
    local `sortableIds` list (`step-pending-<absoluteIndex>`). There is no store action for
    reorder. Drag between/into/out of groups cannot be expressed by that payload.
- `WorkflowStepSanitizer.sanitizeClipboardWorkflowStep()` is a strict whitelist rebuilder;
  copy/paste of a group member yields a plain step, and there is no step "duplicate"
  action other than Copy Step → Paste Step (`INSERT_WORKFLOW_STEP`).
- Webview undo/redo is zundo `temporal` on `workflowStore`; `partialize` captures
  `steps`, `workflowName`, `finalStep`, `undoWorkflowProperties`, `runtimeUndoGeneration`,
  and `equality` is a length-first, per-index `isStepContentEqual` comparison. A group
  change that preserves step count and content would not register as undoable unless
  groups are added to both.
- Prior-context and session references are resolved in two places that both express
  "before me" as `< currentIndex`:
  - `RunOutputResolver.resolvePriorContextItems()` — `all` iterates `[0, currentIndex)`,
    `previous` is `currentIndex - 1`, numeric refs are silently dropped when
    `index >= currentIndex`, and attempts are read via `resolveLatestAttempts()` (latest,
    not pinned). `AddressedPriorContextResolver` only partitions cross-run addressed refs
    and never inspects numbers.
  - `SessionResolver.resolveNumericReference()` and `SessionResolver.validate()` for
    numeric `sessionId`, mirrored for dry run by `ExecutionPreviewService.resolveSessionId()`.
- The `ctrlyoke` dynamic-queue MCP server is enabled per step through the three-tier
  `mcpServers` resolution in `ExecutionPropertyResolver.resolveExecutionProperties()`
  (gated by `MCP_AVAILABILITY_MODES`), and the effective decision is
  `hasCtrlYokeServer` inside `CliProviderUtils.planMcpConfigBlock()`.

### Execution state

- `WorkflowExecutor.execute()` is an outer `while (true)` with an inner
  `while (promptQueue.hasNext())` that builds one target from `state.currentIndex` and
  awaits `executeWithSnapshot()` → `executeSinglePrompt()` (→ `executeScriptStep()` for
  scripts), then runs the `finalStep` leg and loops if the final step appended work.
- `executeSinglePrompt(target, …)` accepts a target but calls the current-index
  primitives `markCurrentAsSent`, `completeCurrentAndMoveNext`, `skipCurrentAndMoveNext`,
  `finalizeFailedInFlightPrompt`, `markInFlightPromptCancelled`,
  `finalizeCancelledPromptAfterStop`, and `getProgress()` (derived from `currentIndex`).
  `persistRuntimeMetadata`, `cacheRuntimeOutput`, `recordPreConditionSummary`,
  `recordEndConditionSummary`, and `getPreConditionSummary` are already index/target
  parameterized.
- `PromptQueue.currentRetryCount` is one counter (reset in `restart`,
  `completeCurrentAndMoveNext`, `skipCurrentAndMoveNext`); `EndConditionHandler` reads
  `getState().currentIndex` for status labels and `sendRetryPrompt`, though it already
  threads `retryContext.attemptTarget` for attempt bookkeeping. `core.instructions.md`
  records that pass/fail retries deliberately share this counter and it must reset only
  when the step terminates; the target-keyed version must keep that rule.
- `WorkflowStateMachine` keeps `attempts: Map<string, WorkflowAttemptState>` keyed
  `queue:<i>` / `final:<loop>` but one `activeAttemptKey` (last `beginAttempt` wins;
  `cancelActiveAttempt` cancels exactly one). `WorkflowInstance.stop()` is its only external
  `getActiveAttempt()` consumer.
- `WorkflowExecutor.isWaitingForResponse` is a plain boolean; the response promise is
  local to the send. No parking fields exist.
- Condition and headless script processes: `EndConditionEvaluator` owns one
  `ScriptProcessRunner`, which owns one `CliProcessManager`, which owns one
  `currentProcess`. Pre-conditions, headless script steps, and end conditions of one
  instance share that slot. Interactive script steps go through `spawnScriptPty` →
  `PtyProcessManager`, which is already multi-session, so only the headless path is the
  bottleneck. `CliTransportCoordinator` keeps one `currentPtySession` per integration,
  which is fine once integrations are per-target.
- `WorkflowInstance.activeIntegration` is one field; post-completion session-activity
  attribution is `lastCompletedActivityTarget` plus one `pendingSessionActivityEvents`
  buffer; `stop()` cancels one integration and one attempt with one 10 s settle timeout.
- Execution integrations are cached in `executionIntegrations: Map<HarnessId, …>` by
  `createIntegrationForMode()`, with `liveInjectIntegrations` carried across runs.
  `IntegrationFactory.createForExecution()` instances are per-run isolated, but two
  same-harness siblings would receive the same instance today.
- `OutputCaptureBuffer.replayTo()` replays every completed step but only the in-flight
  buffer at `state.currentIndex`; all three callers in `WorkflowInstance` pass
  `state.currentIndex`.
- `executeWithSnapshot()` captures `WorkspaceSnapshotService` state around one step and
  persists via `OutputHistoryManager.saveSnapshotForTarget()`, which is already
  target-keyed; `UndoRedoCoordinator` and `useOutputUndoActions` are already per-target.
  Only the capture _window_ is serial-per-step.
- Pause is honored only at step boundaries by `WorkflowExecutor.confirmPauseAndStop()`
  (five call sites: before the next prompt, after a queue step completes, after a script
  step completes, after the final step appends, after the final step completes).
  `PAUSED` has no in-flight step and `currentIndex` names the next `PENDING` step; the
  editable-tail rules in `core.instructions.md` depend on that.
- Crash/reload recovery: `PromptQueue.restoreFromWorkingFile()` rebuilds completed
  indices from per-step `_runtime.completedAt` (already supports a non-contiguous set),
  derives visual status from `_runtime.terminalStatus`, forces a persisted
  `RUNNING`/`PAUSING`/`CANCELLING` state to `STOPPED`, and resumes from
  `runtime.currentIndex`. `RunContinuationService` is the append path, not recovery.
- `hostCanProvidePty` is a boolean produced by `resolveCliExecutionMode()`
  (`src/cli/CliExecutionMode.ts`), threaded into `WorkflowInstance`, `PropertyResolver`,
  and `ExecutionPropertyResolver` as a clamp to headless. There is no host-capability
  interface; `PlatformAdapter.isVsCode?()` is the closest analogue. The interactive
  transport decision (VS Code PTY vs `stdio: "inherit"`) is made in
  `CliExecutionRunner.executeInTerminal()` via `isVsCodeContext()`, **not** in
  `CliExecutionMode.ts`.
- Settings: the `queue` namespace already exists (`maxSize`, `maxWorkflowExecutionTime`,
  `unlimitedMode`, `notifyOnExtension`) and is plumbed schema →
  `CtrlYokeGlobalSettings.queue` → `ConfigurationUtils.getDynamicQueueConfig()` →
  `context.dynamicQueueConfig`. `EXECUTION_GUARDRAILS_PLAN.md` explicitly leaves the
  concurrency cap to this plan and wants it in the queue section. There is no feature-flag
  or `experimental.*` mechanism anywhere in the codebase.
- Dry run: `ExecutionPreviewService` produces `WorkflowExecutionPreview` with one
  `StepExecutionPreview` per flat step (it already has an optional `stepId`, unused by the
  step model) and resolves sessions/MCP/harness per step. `DryRunModal.tsx` and the CLI's
  `CliTerminalFormatter.renderExecutionPreview()` render it. The previous revision did not
  mention preview at all; it must show groups and the preflight diagnostics.

### Output and history

`OutputPane.tsx` (`components/layout/output-section/`) is a virtualized row renderer plus
the minimap host; row rendering never inspects `row.target`. Writer attribution and
ordering must be solved before rows reach it.

The current path is:

```text
WorkflowExecutor onStreamingChunk / onStreamingEvents
  -> IDashboardSink.updateCliStreamingChunk / updateCliStreamingEvents (stepIndex)
     and a *separate* final-step family (updateFinalStepStreamingChunk / Events, loopIndex)
  -> DashboardBroadcastHub / postMessage
  -> workflowStore
       liveOrderedEntries: one CLI aggregate per (target, runIndex, attemptIndex, phase)
       streamingChunks / finalStepStreamingChunks: text keyed `${targetIndex}:${phase}`
  -> mapOrderedHistoryEntriesToMessages()  (utils/outputProjection.ts)
  -> buildOutputRows()                      (utils/outputRows.ts)
  -> OutputPane
```

Two corrections to the previous revision: attribution travels on two parallel message
families (queue vs final step), and `streamingChunks` is keyed by
`getStreamingChunkKey(targetIndex, phase)` with no `kind` in the key, so a multi-writer
design cannot use that flat map as-is.

The durable run log is closer to a true timeline than the UI projection:

- `events.jsonl` records `CLI_OUTPUT_CHUNK_APPENDED` / `CLI_OUTPUT_EVENTS_APPENDED` with a
  target, `timestampMs`, and a global `sequence` assigned by `TimelineRecorder.appendEvents()`
  from `manifest.nextSequence` under a file lock.
- `StreamingHistoryBuffer` coalesces **per attempt** (key includes run/attempt/phase, finer
  than the previous revision claimed) and flushes on a non-text/thinking event, at 4096
  chars, at 1 s age, or on explicit flush; its flush callback already carries
  target/run/attempt/phase/timestamp.
- `OutputHistoryTimelineAdapter.project()` folds all deltas for an attempt into one
  `OrderedCliHistoryEntry` keyed by the identity tuple and keeps the _first_ snapshot's
  timestamp/sequence, so later deltas never move the entry.
- `workflowStore.appendLiveEntry` does the same in place (`findMatchingCliEntryIndex`, then
  "keep its persisted position").
- Rows are ordered by `timestampMs` (`sortOutputMessages`), not by arrival — see
  `webview-react-store.instructions.md`.
- `buildOutputRows()` expands the entire attempt at the aggregate entry's position.

Therefore, if concurrency were enabled without output work, each writer would append to
its own growing attempt block ordered by start time. Output from step 3 could arrive after
output from step 4 but appear higher on screen. Three UX problems follow: the actual
cross-step activity order is not shown; a block near the top grows while the user follows
the bottom, moving virtualization measurements; and "follow live output" cannot be "stay
at the bottom".

The transport is already step-attributed, so concurrent writers will not corrupt each
other merely because they use distinct flat step indices. The missing piece is a
cross-target activity projection.

Additional single-writer assumptions found in the audit:

- `workflowStore.currentStep` is one scalar consumed by `OutputSection`, `Header`,
  `WorkflowStepsPanel`, `PromptChipRail`, and `PromptEditor`. `WorkflowStepsPanel` and
  `PromptChipRail` slice steps into done/pending halves at `currentStep`.
- `useMessageHandler`'s `CONTEXT_WINDOW_UPDATE` handler drops any update whose
  `stepIndex !== currentStep`.
- `usePromptStatus` derives `RUNNING` for `index === currentStep` and `COMPLETED` for
  `index < currentStep` before consulting the recorded `prompt.status`.
- `PromptCounter` is already status-derived (compatible with out-of-order completion);
  `markdownExport` still writes `${currentStep} of ${totalSteps} completed`.
- The minimap (`useOutputMinimapModel`) emits one point per target from
  `firstRowIndexByTarget`; `useOutputNavigation.scrollToTarget` and the output context
  menu's "which step" heuristic use the same map. Interleaving breaks all three at once.
- Live-follow is a sticky-**bottom** latch (`outputAutoscroll.ts`, `useOutputScrollTarget`;
  `OUTPUT_SCROLL_TARGET_KINDS = { ROW, BOTTOM }`). "Follow the most recently updated row" is
  net-new: a new target kind plus a release rule that means something away from the bottom.
- The anchor lock in `useOutputScrollTarget` is the only permitted `scrollTop` writer;
  mid-list growth is corrected by `shouldSyncMeasurementCorrection()`, whose predicate is
  purely ordinal. Above-anchor growth from a sibling writer is handled there, not by a
  second corrector.

### Terminal and standalone CLI

- `PtyProcessManager.sessions` is a map keyed by `sessionId`; `PtySession` carries
  `workflowId`, `stepName`, `kind`, `promptNumber?`, `harnessId?`, `shellKind?`, status,
  `controllerClientId`, and a reconnect ring buffer — **no `stepIndex`, no group id**.
  `WorkflowExecutor` already passes `stepIndex` into `spawnScriptPty`, and
  `WorkflowInstance.spawnScriptPty` drops it.
- `TERMINAL_STARTED` has **no typed payload interface**; six hand-built producers
  (`CliTransportCoordinator` spawn and inject-refresh, `WorkflowInstance` script PTY,
  `WorkflowOrchestrator.replayTerminalSessionsTo`, `TerminalMessageHandlers.reconnectPanel`
  and shell restart) must all gain any new field.
- Webview reconciliation (`hooks/terminalMessageHandlers.ts`) removes an existing AI
  terminal with the same `harnessId`, and script PTYs (no `harnessId`, no `promptNumber`;
  `isScriptPtySession`) collapse onto one tab. A re-delivered same `sessionId` already
  updates in place. `terminalStore.clearAiCliSessions` also wipes all AI sessions of a
  workflow on run start.
- Controller arbitration (`pendingControllers`, `workflowRunControllers`, claim/auto-claim)
  is keyed by `workflowId` only; every session of a workflow inherits one controller
  client, and auto-claim conflicts resolve last-writer-wins.
- Standalone CLI interactive members inherit one TTY (`CliProcessManager.spawnInteractive`,
  `stdio: "inherit"`); there is no preflight rejecting several, only
  `warnAboutClampedInteractiveSteps`. Headless text output goes through
  `CliTerminalFormatter`, which prints `Step N/total` (no name; `PromptStartData` carries
  none), writes raw `onStreamingChunk` bytes unprefixed, and keeps a single module-level
  `_streaming` buffer. JSON results (`CliJsonResultBuilder`) are flat-step keyed.

### Workspace snapshots and undo

`executeWithSnapshot()` captures around one step at a time. If sibling steps run against
the same workspace concurrently, each step's before/after window includes changes made by
its siblings. Per-step snapshot attribution and per-step undo would therefore be incorrect
even when output attribution is correct.

Two agents can also edit the same file concurrently. The first release does not attempt
worktree isolation or merge resolution. A workflow-level managed/named worktree (already
supported, per run) is shared by all group members. Parallel groups are intended for
independent work, and the UI/docs must say so.

## Decisions

### 1. Authored syntax: nested `parallel` container

Use the YAML shape shown above. Reserve `dependsOn` for a possible future DAG design.

The group has one shared execution property in the first release:

```yaml
- parallel:
    - prompt: ...
    - prompt: ...
  failFast: true # default
```

All harness, model, agent, skills, permissions, conditions, hooks, and session properties
remain per-step or inherited from the workflow/settings. A group is a scheduling boundary,
not another property-inheritance layer. `enabled: false` is per member; there is no
group-level `enabled` (disable each member, or delete the group).

Schema changes (`schemas/workflow-schema.json`, then regenerate the YAML):

- New definition `parallelGroupItem`: `{ parallel: workflowStep[] (minItems 2),
failFast?: boolean }`, `additionalProperties: false`, and `workflowStep` members must
  not themselves be `parallelGroupItem` (no nesting).
- `steps.items` becomes `oneOf: [workflowStep, parallelGroupItem]` in the multi-step root
  branch. The template-metadata `if/then` branch's `steps.items` harness restriction must
  also apply to `parallel[].harness`.
- `finalStep` keeps `$ref: workflowStep` only.
- New root property `parallelGroups` (working-file form; see Decision 2). Add it to the
  `NOT_AUTHORABLE` map in
  `src/test/integration/schemaUiPropertyRoundTrip.integration.test.ts` with the reason
  "normalized working-file topology; authored as `parallel:` items". That test enumerates
  every authorable schema property and requires a sample value and a live UI control id,
  and its `KNOWN_*` allowance sets must stay empty. `failFast` lives only inside
  `parallelGroupItem`, which the test does not enumerate, so it needs no control id there;
  the group header's `failFast` control (Stage 2) is tested by its own component test.

### 2. Normalized storage: flat steps plus group definitions

Normalize authored containers immediately to one flat execution representation:

```typescript
interface ParallelGroupDefinition {
  /** Opaque identity persisted in the working file and definition revisions. */
  id: string;
  /** Inclusive indices in PromptFile.steps. */
  startIndex: number;
  endIndex: number;
  failFast: boolean;
}
```

Add `parallelGroups?: ParallelGroupDefinition[]` to `PromptFile`; `QueueState` exposes a
non-null array. `PromptFile.steps` remains `WorkflowStep[]`, and `WorkflowStep` remains
unchanged. Do not add `STEP_TYPES.PARALLEL`.

Group status is derived from member step/attempt state. Do not put mutable status in
`ParallelGroupDefinition`; definition topology and runtime state must not be mixed.

The group ID is generated during normalization with `crypto.randomUUID()` (the convention
used for `WorkflowInstance.id`) and then preserved in working files and definition
revisions. It is for stable UI keys, timeline correlation, and mutation logic; users do
not author it. A parsed file that contains both `parallel:` items and a root
`parallelGroups` array is rejected (the two forms are never mixed; the parser accepts
either).

Invariants checked whenever a definition is loaded or mutated:

- ranges are bounded, non-overlapping, sorted, and contiguous;
- each group contains at least two steps (deleting down to one automatically unwraps it);
- `finalStep` is never grouped;
- all step mutations go through one topology helper (`src/core/ParallelGroupTopology.ts`,
  pure functions over `{ steps, parallelGroups }`) that updates both together. Every
  entry point listed in the audit calls it; none re-derives ranges by hand.

The normalized representation must be carried through:

- draft and promoted `WorkingFile` values (`WorkingFileManager`, `PromptQueue`);
- `WorkflowDefinitionSnapshot` / `buildDefinitionSnapshot()` /
  `DEFINITION_REVISION_COMMITTED` / `RunOutputResolver`'s snapshot reader;
- `PromptFile` copies made by `WorkflowStepSanitizer` and `PromptFileLoader`;
- run/draft webview messages (`RUN_VIEW_LOADED`, `STEPS_EXTENDED`, `PROMPT_DELETED`,
  `REORDER_PROMPTS_CONFIRMED`, `UNDO_REDO_SYNC`) and `workflowStore` plus its zundo
  `partialize`/`equality`;
- history navigation, rewind, append, delete, and reorder paths;
- `WorkflowSerializer.buildCleanWorkflow()`, which reconstructs nested `parallel:` items
  (and never emits `parallelGroups`) for authored YAML/JSON;
- `ExecutionPreviewService` / `WorkflowExecutionPreview` (Decision 10).

Topology rules for the existing mutation semantics:

- **Insert** (`insertStepAfterIndex`, `insertStepAtRun`, `RunContinuationService`
  splice, `ACTION_TYPES.RUN_NEXT`/`QUEUE_NEXT`/`RUN_BEFORE_CURRENT`): an insert whose
  computed index falls strictly inside a group's range lands _after_ `endIndex` (or before
  `startIndex` for a "before" action). Inserts never silently join a group; joining is an
  explicit group/ungroup mutation.
- **Delete** inside a group shrinks the range; a group left with one member unwraps.
- **Reorder** within the pending tail may move whole groups and members; the message
  payload changes (Decision 11).
- **Rewind** (`beginPendingRewind`) to an index strictly inside a group snaps the
  boundary to `startIndex`. **Set start position** inside a group snaps to `startIndex`.
- **Clipboard**: copying a member yields a plain step; groups are not copyable in v1.
- **Undo/redo sync** (`syncStepsForUndoRedo*`) carries `parallelGroups` alongside `steps`.
- **MCP append** (`ctrlyoke_append_queue`) appends flat steps only; it cannot create
  groups in v1, and Decision 5 rejects it from inside a group.

### 3. Execution: explicit fork/join coordinator

Do not call the existing current-index-mutating `executeSinglePrompt()` concurrently.
Split the executor into:

```typescript
interface StepExecutionOutcome {
  target: WorkflowAttemptTarget;
  status: "completed" | "skipped" | "failed" | "cancelled";
  failureReason?: string;
}

executeTarget(...): Promise<StepExecutionOutcome> // leaf, target-scoped
executeParallelGroup(...): Promise<ParallelGroupOutcome> // coordinator
```

The leaf path may emit target-scoped status/output and persist target-scoped runtime, but it
must not advance `currentIndex`, finalize the workflow, or cancel unrelated targets. The
coordinator owns fan-out, fail-fast policy, group snapshotting, the join commit, progress,
and workflow-level failure. The existing sequential path becomes
`executeTarget` + a trivial "commit one" wrapper so there is one leaf implementation.

`PromptQueue` needs target/index-specific primitives:

- `markStepAsSent(stepIndex)`
- `completeStep(stepIndex, metadata?)`
- `skipStep(stepIndex, terminalStatus?)`
- `failStep(stepIndex, reason)`
- target-keyed retry get/increment/reset (or move retry counts fully into
  `WorkflowStateMachine`'s attempt state, which is the preferred home since attempts are
  already target-keyed)
- one `commitParallelGroupJoin(group, outcomes)` that persists member results and then
  advances `currentIndex` past `endIndex` in one transition

Keep the sequential wrappers (`markCurrentAsSent`, `completeCurrentAndMoveNext`, …) as
thin delegations so there remains one source of truth for step transitions.

While a group is running, `currentIndex` stays at the group's `startIndex`. Per-step status
is the source for member-level UI. Progress is settled step count, not `currentIndex`,
broadcast after each member settles plus once at the join.

Runtime persistence: each member's `_runtime` (`startedAt`, `completedAt`,
`terminalStatus`, session, elapsed, failure) is written as it settles, exactly as today,
so a partially settled group is visible on disk and recoverable.

### 4. Concurrency limit and the enablement gate

Add `queue.maxParallelSteps` (integer, minimum 1, default 6) to
`schemas/settings-schema.json`, `CtrlYokeGlobalSettings.queue`, the defaults block,
`ConfigurationUtils.getDynamicQueueConfig()` → `DynamicQueueConfig`, and
`docs/reference/settings.md`. It is the maximum number of _active_ group members, not the
maximum group length; a larger group drains through a bounded worker pool with one join.
`1` means "run groups sequentially" and is a supported configuration, not an error.
`settingsSchemaUiParity.integration.test.ts` requires a settings UI control for every
schema key; add it to the Queue settings section.

The gate: because the codebase has no feature-flag mechanism, add
`PARALLEL_GROUP_FAN_OUT_ENABLED = false` to `src/types/DashboardConstants.ts`. The
coordinator clamps effective width to `1` while it is `false`, regardless of the setting.
Stage 6 flips it to `true` and removes the sequential-fallback label. Until then the UI
labels grouped steps "runs sequentially in this build" so no one infers concurrency.

With `failFast: true`, members that have not entered the pool are cancelled without
starting after the first terminal failure.

### 5. Session and prior-context resolution uses a join-boundary snapshot

Before starting any member, capture an immutable view of completed steps and resolve every
member's effective properties against it. Do not let timing decide what a sibling sees.

Prior-context rules (enforced in `RunOutputResolver.resolvePriorContextItems()` by passing
the group's `startIndex` as the boundary instead of the member's own index, and validated
up front by the parser and preflight):

- A numeric `priorContext` reference into the same group is invalid.
- `previous` means the last completed step before the group, not the preceding sibling.
- `all` means the completed prefix before the group.
- All members therefore see the same pre-group context boundary.
- A step after the join can reference any completed group member normally.
- `finalStepPrevious`/`finalStepAll` are unaffected.

Session rules (`SessionResolver.resolveNumericReference()` / `validate()` and the preview
mirror `ExecutionPreviewService.resolveSessionId()` get the same boundary):

- A numeric `sessionId` reference into the same group is invalid.
- Resolve inherited `resumeSession`, inherited/default `sessionId`, effective harness, and
  auto-resume against the same pre-group snapshot before fan-out.
- Two concurrently scheduled prompt steps may not resolve to the same concrete harness
  session. Report all conflicting step numbers/names before launching any member.
- Different-harness auto-resume may be valid because the resolved sessions differ; do not
  reject solely because two steps omit `sessionId`.
- Parser validation catches explicit structural conflicts; execution preflight is
  authoritative because global defaults and prior runtime session IDs are needed for
  effective resolution.
- Missing historical sessions keep the existing best-effort "warn and start fresh"
  behavior only after collision preflight has completed.

Resolve effective `mcpServers` in the same preflight (reuse `hasCtrlYokeServer` logic from
`CliProviderUtils.planMcpConfigBlock` by extracting it into a pure helper). Any group member
that effectively enables the ctrlyoke dynamic-queue server is rejected, because appending
queue work from inside an unsettled group has undefined topology/order semantics. The
`finalStep` may still use it and may append flat steps after the group.

Preflight is one shared module (`src/core/ParallelGroupPreflight.ts`) used by both the
executor and `ExecutionPreviewService`, so dry run and real execution agree.

### 6. Runtime ownership is target-keyed

Before fan-out is enabled, make these resources concurrent-safe:

- Replace `WorkflowStateMachine.activeAttemptKey` with an active-attempt set. Stop and
  fail-fast cancellation operate on every applicable target; `getActiveAttempt()` becomes
  `getActiveAttempts()`.
- Replace the executor response-wait boolean with a target set. Response promises remain
  local to the send; no global parking map is needed.
- Move retry counts into attempt state and make every `EndConditionHandler` current-index
  lookup explicit-target (`sendRetryPrompt` already receives the index; stop reading
  `getState().currentIndex`).
- Give every parallel prompt an isolated execution integration keyed by
  `queue:<stepIndex>` via `createIntegrationForMode(harness, target)`, even when siblings
  use the same harness. Preserve the harness-keyed cache for ordinary sequential reuse and
  close target-keyed integrations at the join.
- Replace `WorkflowInstance.activeIntegration` as the stop/cleanup source with a registry
  of active target resources (integration, attempt, process runner, PTY session). User stop
  cancels all of them and waits for all cancellation paths to settle with the existing
  bounded shutdown behavior.
- Key post-completion session-activity attribution by integration/session/target instead
  of one `lastCompletedActivityTarget` and one pending-events buffer.
- Give each active target its own `ScriptProcessRunner` (and therefore its own
  `CliProcessManager`) for pre-conditions, headless scripts, and end conditions. Timeout
  and cancellation must never reference a shared `currentProcess`.
- Replay every `OutputCaptureBuffer.stepOutputBuffer` entry on reconnect, not only the one
  at `state.currentIndex`; the replay signature takes the active target set.
- Add `supportsConcurrentInteractiveSessions` next to `hostCanProvidePty` in
  `CliExecutionModeResolution` and the `WorkflowInstance` constructor. The VS Code/hosted
  path passes `true`; the standalone CLI passes `false`.
- Thread the active-target set through dashboard state (`workflowStore.activeStepIndices`)
  and remove the `stepIndex !== currentStep` guard from `CONTEXT_WINDOW_UPDATE`; the
  webview keeps `currentStep` as the group's join index for compatibility.

### 7. Failure, stop, and pause semantics

Use a group-scoped abort controller plus the resource registry. `Promise.allSettled` drains
cleanup but is not the cancellation mechanism.

- `failFast: true`: the first terminal member failure prevents queued members from
  starting, cancels all running siblings, awaits their settlement, records cancelled
  outcomes, then fails the group/workflow.
- `failFast: false`: every member settles; the group/workflow fails after the join if any
  member has a terminal failure.
- Per-step `onFail: continue`/error behavior is resolved inside the leaf result before the
  coordinator decides whether that outcome is terminal for the group.
- User **Stop** cancels every active member and marks all not-yet-started members
  cancelled before committing stopped state.
- User **Pause** is join-based: already-started members finish their complete step
  contracts (pre-condition → prompt → end-condition, retries included), no additional
  pool members start, and the workflow becomes paused after the partial group state is
  durably committed. `confirmPauseAndStop()` gains a sixth call site inside the
  coordinator, after the last in-flight member settles. Resume starts only unfinished
  members. This is safer than suspending CLI processes mid-response.
- A crash/reload resumes only members without terminal `_runtime` state. Completed,
  skipped, failed, and cancelled members are not rerun. `restoreFromWorkingFile()` already
  tolerates a non-contiguous completed set; the coordinator, not the queue, decides which
  members to schedule.

**Editing a partially settled group.** `PAUSED` currently guarantees "no in-flight step,
`currentIndex` is the next pending step". With groups, `currentIndex = startIndex` while
some members may already be terminal. Rules:

- `PromptQueue.assertEditableDuringExecution()` and the webview's per-row lock treat a
  member with terminal `_runtime` as consumed (locked) even though its index is
  `>= currentIndex`.
- Members without terminal `_runtime` in a paused group remain editable (that is the whole
  point of pausing to edit).
- Group topology mutations (group/ungroup/move into/out of) are rejected for any group that
  has at least one settled or in-flight member. Adding a step to such a group is not
  possible; delete-then-unwrap still is.
- `reconcileExecutionStateAfterStepChange()` counts unsettled group members as remaining
  work.

### 8. Workspace snapshot and undo policy: group-level

Capture one workspace snapshot before the group starts and one after every member settles.
Persist it through the existing `saveSnapshotForTarget` against the target
`queue:<startIndex>` with a `parallelGroupId` marker in the snapshot metadata, so
`UndoRedoCoordinator` and `useOutputUndoActions` need no new target kind. The UI renders
that entry as "Undo parallel steps 2–4" on the group header (Stage 5) and on the minimap
entry of the first member (Stage 4, before the header exists).

Do not present per-step prompt undo for members of a concurrently executed group. Their
filesystem windows overlap, so a per-step snapshot would make a false attribution claim.
Structured tool/file events still show the step that reported an operation and its diff,
but the UI must distinguish event attribution from exclusive filesystem ownership. When the
effective width is 1 (gate closed or setting `1`), members run sequentially and keep
ordinary per-step snapshots.

Future precise per-step isolation would require separate worktrees plus a merge phase.
`WorktreeManager` is per run today; extending it per member is outside this plan.

### 9. Group header, status derivation, and the steps panel

- Group status derives from member statuses: `running` if any member is running or sent;
  `failed` if any member failed and the group has settled; `cancelled` if all settled
  members are cancelled; `completed` when all settled and none failed; `skipped` when every
  member was disabled or gate-skipped; otherwise `pending`.
- `usePromptStatus` consults the recorded `prompt.status` for indices inside the group at
  `currentStep` instead of assuming `index === currentStep → RUNNING`.
- `WorkflowStepsPanel` and `PromptChipRail` keep their done/pending split at `currentStep`;
  a group is always wholly inside one half because `currentIndex` stays at `startIndex`
  until the join.
- Dashboard "current step" affordances (editor default target, header banner) keep pointing
  at `currentStep`; the active-target set drives live badges.

### 10. Dry run / execution preview

- `WorkflowExecutionPreview` gains `parallelGroups: ParallelGroupDefinition[]`, and
  `StepExecutionPreview` gains `parallelGroupId?: string`.
- `ExecutionPreviewService` runs `ParallelGroupPreflight` for every group and emits its
  findings as `CompatibilityDiagnostic`s on the offending steps (session collision,
  in-group `priorContext`/`sessionId` reference, dynamic-queue MCP, interactive-multiplex
  on hosts that cannot, gate/width notice).
- `DryRunModal.tsx` renders members inside a bordered group block with the `failFast`
  value and "N of M will run concurrently (width W)" or "runs sequentially" text.
- `CliTerminalFormatter.renderExecutionPreview()` prints `Parallel steps 2–4 (failFast)`
  and indents members.
- `PreviewRedactor` passes the new fields through unchanged (no secrets in them).

### 11. Reorder and grouping messages

`REORDER_PROMPTS` becomes the single pending-tail topology message. Its payload is

```typescript
interface ReorderPromptsMessage {
  newPendingOrder: number[]; // slice-relative, as today
  pendingGroups: Array<{
    id?: string;
    start: number;
    end: number;
    failFast: boolean;
  }>;
  // ranges are slice-relative positions in newPendingOrder; id omitted = new group
}
```

Group/ungroup context-menu actions and drags into/out of/between groups all send it; the
extension validates through the topology helper and echoes `REORDER_PROMPTS_CONFIRMED` with
the resulting absolute `parallelGroups`. `useStepContextMenu.moveQueueStep` keeps using
`buildAdjacentSwapOrder` and passes the unchanged group list. This avoids a second message
family while keeping one validation path.

Drag UI uses dnd-kit's multi-container pattern: the outer `SortableContext` contains step
ids (`step-pending-<abs>`) and group container ids (`group-<id>`); each group renders a
nested `SortableContext` of its member ids; `onDragOver` moves ids between containers;
`onDragEnd` computes `newPendingOrder` + `pendingGroups` from the container model. The
number column stays outside `setNodeRef` as it does today.

## Output Design

### Decision: chronological semantic activity timeline with step focus

The default parallel-group output is one chronological activity stream. Every activity is
tagged with step number/name and has a stable group/target/attempt/phase identity. Do not
render three complete timelines stacked by step as the primary view.

To keep interleaving readable:

- Order **semantic activity starts**, not individual tokens. Text/thinking chunks from the
  same open block coalesce; tool start/result updates one stable activity item; status and
  script-output bursts are separate items.
- Consecutive activities from the same step share one visual run: full badge on the first
  row, a subtle continuation rail on subsequent rows.
- When another step becomes active, insert a compact step-switch marker/badge. Use both
  text and color/iconography so attribution is accessible.
- A group header shows `N running / N complete / N failed` and filter chips for **All** and
  each member. Chips write the `hiddenOutputTargets` set shipped by
  `OUTPUT_STEP_FILTER_PLAN.md`; selecting one member is `soloOutputTarget` over the group's
  member keys. Both live in `src/ui/webview-react/store/uiStore.ts` (**not**
  `workflowStore`), keyed by view address and pruned by `uiStore.pruneHiddenOutputTargets`;
  reuse that state as-is. It is a filter, not a second stored history.
- Tool completion updates the original tool activity in place instead of adding a duplicate
  result at the bottom. The event's start sequence remains its location.
- Raw/plain response streams remain one target-owned response activity per attempt and grow
  in place. Exact token interleaving is neither useful nor reliably available.
- When live-follow is active, follow the most recently updated activity row rather than the
  last list row. This is a new `OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY` target whose
  release rule is "the user scrolled away from the followed row", implemented inside
  `useOutputScrollTarget`/`outputAutoscroll.ts` without adding a second `scrollTop` writer.
  Outside a running group, `BOTTOM` behaves exactly as today.
- After group completion, the same projection is used for history so live and replay do
  not reorder into different layouts.

Example:

```text
▼ Parallel steps 2–4                  2 running · 1 complete
  [All] [2 auth] [3 database] [4 performance]

  2 · research-auth       Thinking about token validation…
  │                       Read src/auth/session.ts
  3 · research-db         Searched for migration definitions
  │                       Read src/db/schema.ts
  2 · research-auth       Edited src/auth/session.ts
  4 · research-perf       ✓ Completed · 38s
  3 · research-db         Running query analysis…
```

### Two projections, one durable source

Keep the existing attempt aggregate for response reconstruction, prior context, export,
token totals, retries, and stats. Add an activity projection rather than replacing it.

```typescript
interface OutputActivityEntry {
  timestampMs: number;
  sequence: number;
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
  kind: "text" | "structured" | "status" | "script";
  events?: CliEvent[];
  text?: string;
}
```

Invariants:

- the durable timeline's `(timestampMs, sequence)` order is the cross-writer ordering
  source; `timestampMs` is always the extension-host clock (see the `promptStartedAt` and
  status-message bullets in `core.instructions.md`);
- every entry is target-attributed;
- coalescing boundaries are shared by live and replay paths — reuse
  `StreamingHistoryBuffer`'s per-attempt flush as the activity boundary and carry the
  assigned `sequence` on the live message so the webview never derives order from arrival;
- completed aggregate output updates metadata/content without duplicating streamed
  activities;
- stable activity keys allow tool-result and streaming-text updates in place;
- the live store's identity matching goes through `matchesCliEntryIdentity` with the full
  `(target, runIndex, attemptIndex, phase)` tuple; `streamingChunks` becomes keyed by the
  full entry key (kind included) rather than `${targetIndex}:${phase}`.

### UI ownership

- `OutputHistoryManager` / `OutputHistoryTimelineAdapter`: expose activity entries in
  addition to aggregate attempt output.
- `workflowStore`: hold live/history activity entries, the active-target set, and
  full-key streaming updates. The step-filter state stays in `uiStore` where
  `OUTPUT_STEP_FILTER_PLAN.md` put it; do not migrate it.
- `outputProjection.ts` / `useOutputRowsModel.ts` / `outputRows.ts`: merge, filter,
  coalesce, and build group/activity rows; reuse `StepHiddenRow` and `hiddenTargetKeys`.
- `OutputSection.tsx`: own live-follow navigation, minimap integration, and group header
  actions; `outputStepFilterVersion` already flows into `rowRenderIdentity`.
- `OutputRow` and small presentational components: render group headers, step-switch
  badges, and continuation rails.
- `OutputPane.tsx`: remain a generic virtualized row renderer plus minimap host.

The minimap model must expose first/latest activity markers per target and highlight the
selected filter; do not represent one step as a single continuous span when its rows are
interleaved. `useOutputNavigation.scrollToTarget` and the output context menu's step
heuristic must use the anchor row (still emitted once per target) rather than assuming
contiguity.

## Terminal Design

Interactive parallel prompts are in scope in VS Code and the hosted dashboard.

- Add a typed `TerminalStartedMessage` in `WebviewMessageTypes.ts` with `stepIndex` and
  `parallelGroupId?`, and make all six producers use it. Put `stepIndex` and
  `parallelGroupId?` on `PtySession` and `SpawnPtyOptions`; `WorkflowInstance.spawnScriptPty`
  stops dropping the `stepIndex` it already receives.
- Reconciliation rules in `hooks/terminalMessageHandlers.ts`:
  1. The hard xterm identity remains `workflowId + sessionId`.
  2. Replaying the same `sessionId` updates metadata in place (already true).
  3. Non-parallel same-harness sequential replacement keeps today's behavior.
  4. Sessions with the same `parallelGroupId` are preserved as separate tabs even when
     their `harnessId` values match, and script PTYs with a `parallelGroupId` bypass the
     single-script-tab rule.
  5. Tabs are labeled by step number/name (`stepName` already; add the number) and share
     the harness icon.
  6. `clearAiCliSessions` on run start is unchanged (a new `RunRef` is a session boundary).
- Controller arbitration stays keyed by `workflowId`: every group session inherits the
  same controller client. That is acceptable for v1 and is documented; per-session
  controllers are out of scope.
- Reconnect replay (`replayTerminalSessionsTo`, `reconnectPanel`) already loops every
  session; only the payload gains fields.

Standalone CLI: if more than one enabled member resolves to interactive mode and
`supportsConcurrentInteractiveSessions` is false, preflight fails with an instruction to
run headless or set those members to `executionMode: headless`. Do not force a mode
silently. Headless CLI output stays concurrent: `PromptStartData` gains `stepName`,
`CliTerminalFormatter` keeps one streaming buffer per target and prefixes each rendered
burst with `[2 research-auth]`, and `renderPromptHeader` prints the name. JSON results stay
flat-step keyed and add `parallelGroupId` per step.

## Validation Rules

### Structural validation (parser)

- `parallel` is accepted only as an item of the root `steps` array.
- `parallel` contains 2 or more prompt/script steps.
- Nested `parallel` containers are rejected.
- `finalStep` remains one `workflowStep` and cannot be parallel.
- A file may not contain both `parallel:` items and root `parallelGroups`.
- Group ranges in normalized/working files satisfy the topology invariants.
- Numeric `priorContext` and numeric `sessionId` references to a sibling in the same group
  are rejected with the group's step numbers in the message.
- Error messages keep the existing `Step N:` numbering (flat, 1-based).

### Effective execution preflight (shared by executor and dry run)

Run before any group member launches:

- resolve inherited/default execution properties and variables;
- freeze the prior-context and session lookup boundary at group start;
- reject concrete session collisions;
- reject effective ctrlyoke dynamic-queue MCP access;
- verify required harnesses are ready and isolated integrations can be created;
- reject multiple interactive members when the host cannot multiplex sessions;
- compute effective width (`min(setting, gate ? ∞ : 1)`) and report it;
- produce one aggregated diagnostic naming every invalid member rather than failing one at
  a time after partial launch.

A group whose members are all disabled (`enabled: false` or a failed `preCondition`)
after preflight has zero members to launch. Treat it as a `skipped` group: commit the join
immediately with no leaf executions, advance `currentIndex` past the group, and do not
treat it as a failure. `hasExecutableSteps()` is unaffected (a group's members are steps).

## Edge Cases

Each of these must have a test or an explicit "not supported" message.

- Group at index 0 (nothing before it): `previous`/`all` resolve to nothing; auto-resume
  starts fresh for every member.
- Group is the last queue item and the `finalStep` uses `finalStepPrevious`: the final
  step sees the last _settled_ member by index order, not by completion time.
- Two groups back to back: the second group's boundary is the first group's `endIndex + 1`.
- A member with `enabled: false` in the middle of a group: skipped, group still runs.
- A member whose pre-condition fails with `onFail: continue`: skipped outcome, not a
  failure; with `onFail: stop`, treated as a terminal failure under the group's
  `failFast` policy.
- A member retries via end-condition: retries are inside that member's leaf contract; the
  join waits for them; `maxRetries` is per member.
- Same harness, same explicit string `sessionId` on two members: preflight collision.
- Same harness, both `resumeSession: true` with no `sessionId`: auto-resume resolves both
  to the pre-group previous step's session — collision, reported with both step numbers.
- Different harnesses, both auto-resume: allowed.
- `ACTION_TYPES.RUN_NEXT` from the editor while a group is running: lands after
  `endIndex`.
- `ctrlyoke_append_queue` from a step _before_ the group appends after the group (append
  is always at the tail / clamped past any group containing the insert index).
- Stop during a group with one member still in its end-condition script: script process
  cancelled through its own runner; others cancelled through their integrations.
- Pause during a group: no new members start; the workflow becomes `PAUSED` only after all
  in-flight members settle; the steps panel shows settled members locked and unstarted
  members editable.
- Crash mid-group, then reopen: restored as `STOPPED` at `startIndex`; Resume schedules
  only unsettled members; settled members keep their output and status.
- Reconnect (hosted browser) mid-group: every in-flight buffer replays; every PTY replays.
- Group-level undo after the run: restores the pre-group snapshot; per-member prompt undo
  is absent when width > 1 and present when width was 1.
- `queue.maxParallelSteps: 1` with a 3-member group: sequential in index order; undo and
  output behave exactly like ungrouped steps except for the group header.
- Rewind to a member index: boundary snaps to `startIndex`; rewind to the step after a
  group leaves the group intact.
- Delete a member from a 2-member group in a draft: group unwraps; undo restores it.
- Save As of a working file with groups: authored file contains `parallel:` items and no
  `parallelGroups`; re-loading it reproduces identical ranges with new ids.
- Template with a `parallel:` item: `TemplateManager` strips `_templateMeta` then normalizes
  as usual. `WorkflowSchema.test.ts` validates only `template-starter` today; add a test
  that parses every bundled template so a parallel template cannot ship broken.
- History view of an older run whose definition had a group that no longer exists in the
  current draft: the run's own `DEFINITION_REVISION_COMMITTED` snapshot supplies the
  groups for that view.

## Implementation Stages

### Stage 1 — Topology, schema, and round-trip persistence

[x] 1. Schema: `parallelGroupItem`, root `parallelGroups`, template-branch harness
   restriction, YAML regeneration; `NOT_AUTHORABLE` entry in the round-trip test.
[x] 2. Types: `ParallelGroupDefinition`, `PromptFile.parallelGroups`, `QueueState`,
   and `WorkflowDefinitionSnapshot`.
[x] 3. `src/core/ParallelGroupTopology.ts`: normalize/validate/insert/delete/reorder/
   group/ungroup/unwrap/snap helpers with exhaustive unit tests.
[x] 4. `PromptFileParser`: flatten containers, populate groups, structural validation rules.
[x] 5. `WorkingFileManager`, `PromptQueue`, `RunContinuationService`, `WorkflowInstance`,
   `WorkflowStepSanitizer.buildDefinitionSnapshot`, `TimelineRecorder`,
   `RunOutputResolver`: carry and preserve groups through every mutation path listed in
   the audit, including the insert/rewind/start-position snapping rules.
6. `WorkflowSerializer.buildCleanWorkflow`: reconstruct nested `parallel:` items.
7. Tests: parser, schema, serializer round trip, queue mutation, revision snapshot,
   invalid-range, every-bundled-template parse.

Done when: grouped steps execute **sequentially** through the existing path with no
behavior change, and every mutation path preserves ranges. No UI yet.

### Stage 2 — Group editing and sequential UI

1. `workflowStore`: `parallelGroups` in state, `partialize`, and `equality`; message
   handlers for the extended `REORDER_PROMPTS_CONFIRMED`, `STEPS_EXTENDED`,
   `PROMPT_DELETED`, `RUN_VIEW_LOADED`.
2. `ParallelGroupPanel.tsx` inside `WorkflowStepsPanel` using `WorkflowStepRow` /
   `SortableWorkflowStepWrapper` (extract them from the panel file so the group panel can
   reuse them), group status derivation, `failFast` toggle, "runs sequentially in this
   build" label while the gate is closed.
3. Extended `REORDER_PROMPTS` payload, group/ungroup context-menu items, multi-container
   drag; extension-side validation through the topology helper.
4. `usePromptStatus` change (Decision 9); partially settled group edit locks (Decision 7).
5. Tests: store temporal (group edits are undoable), panel render/status/drag, context
   menu, `WorkflowStepsPanel.test.tsx` (currently keyboard-shortcuts only; add a drag
   suite), extension-side reorder validation.

Done when: a user can author, edit, save, and run grouped workflows (sequentially) from the
dashboard with undo/redo.

### Stage 3 — Target-keyed runtime foundations

1. Indexed `PromptQueue` primitives and `commitParallelGroupJoin`; sequential wrappers
   delegate to them.
2. Retry counts into attempt state; `EndConditionHandler` explicit-target.
3. `WorkflowStateMachine` active-attempt set; `stop()` cancels all.
4. Response-wait target set.
5. Target-keyed integration acquisition and cleanup; resource registry in
   `WorkflowInstance`.
6. Per-target `ScriptProcessRunner`; cancellation/timeout isolation tests.
7. Session-activity attribution keyed by target; `OutputCaptureBuffer.replayTo` replays
   every in-flight buffer.
8. `activeStepIndices` in dashboard state; `CONTEXT_WINDOW_UPDATE` guard removed.
9. `queue.maxParallelSteps` setting plumbing + settings UI control;
   `PARALLEL_GROUP_FAN_OUT_ENABLED = false`.
10. `supportsConcurrentInteractiveSessions` host flag.

Done when: all existing tests pass with the sequential path routed through the new
primitives, and a fake-integration test can drive two targets to completion in reverse
order without corrupting queue state.

### Stage 4 — Parallel coordinator, preflight, preview, and recovery

1. `ParallelGroupPreflight` (shared) and its use in `ExecutionPreviewService`; preview
   types, `DryRunModal`, CLI preview rendering.
2. Coordinator: bounded pool, `StepExecutionOutcome` leaf contract, join commit, progress.
3. Fail-fast / fail-after-settle and cancellation draining.
4. Join-based pause/resume; all-target stop.
5. Recovery: schedule only non-terminal members on resume.
6. Group-level before/after workspace snapshots with the `parallelGroupId` marker; hide
   per-member prompt undo when width > 1.
7. Standalone CLI: interactive-multiplex rejection; per-target streaming buffers and
   prefixes; JSON `parallelGroupId`.

Done when: with the gate temporarily forced open in tests, every case in "Edge Cases"
that concerns execution passes with fake integrations. The gate stays closed in the build.

### Stage 5 — Chronological output projection

Prerequisite: `OUTPUT_STEP_FILTER_PLAN.md` shipped (steps 1–7 complete).

1. Expose target-attributed activity entries from the append-only timeline without
   removing aggregate attempt output.
2. Thread `sequence`/`timestampMs`/target through live activity messages; full-key
   `streamingChunks`.
3. Live/history activity state and deduplication/reconciliation in `workflowStore`.
4. Interleaved activity rows, group header with chips (writing `hiddenOutputTargets`),
   step-switch markers, continuation rails.
5. `LATEST_ACTIVITY` live-follow target.
6. Virtualization measurement invalidation and minimap first/latest markers.
7. Verify history replay produces the same order and grouping as live output.

Done when: a fake two-writer run renders A1 → B1 → A2 live and identically on reload, and
the filter chips isolate one writer.

### Stage 6 — Terminal reconciliation and enablement

1. Typed `TerminalStartedMessage`; `stepIndex`/`parallelGroupId` on PTY sessions and
   all six producers.
2. Preserve same-harness parallel AI sessions and parallel script sessions as distinct
   tabs; label with step number/name.
3. Exercise controller arbitration and reconnect replay with several simultaneous
   sessions.
4. Docs: `docs/workflows/yaml-format.md` (new "Parallel steps" section),
   `docs/reference/workflow-schema.md` (also fix its stale `prompt-schema.json` reference),
   `docs/workflows/json-format.md`, `docs/workflows/session-management.md`,
   `docs/workflows/context-files.md`, `docs/workflows/dynamic-queue.md`,
   `docs/guide/concepts.md`, `docs/reference/settings.md`, `README.md` if it shows step
   syntax. Add a bundled "Parallel Research" template only if the every-template test from
   Stage 1 exists.
5. Flip `PARALLEL_GROUP_FAN_OUT_ENABLED` to `true`, remove the sequential-fallback label,
   and run the full manual checklist below.

## Manual Test Checklist (after Stage 6)

Run in the dev host with a three-member group of the same harness followed by a synthesis
step; repeat once with one member set to `enabled: false` and once with
`queue.maxParallelSteps: 1`.

1. Dry run shows the group block, width, and no diagnostics; add a numeric `sessionId`
   pointing at a sibling and confirm the diagnostic names both steps.
2. Run: three terminal tabs appear with distinct labels; output interleaves with step
   badges; chips isolate one member; live-follow tracks the most recent writer.
3. Pause mid-group: no new member starts; state becomes `PAUSED` only after in-flight
   members finish; settled members are locked, the unstarted one is editable.
4. Resume: only the unstarted member runs; synthesis sees all three.
5. Stop mid-group: all tabs end; every member shows `cancelled` or its terminal state.
6. Kill the extension host mid-group and reopen: run shows `STOPPED` at the group; Resume
   runs only the unsettled members.
7. Undo the group's changes from the header; confirm per-member prompt undo is absent.
8. Save As, reopen the saved file, and confirm the `parallel:` block round-tripped.
9. Standalone CLI: headless run prefixes each burst with the step; `--interactive` with
   two interactive members fails preflight with the documented message.

## File Map

| Area                      | Expected files                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/settings           | `schemas/workflow-schema.json` (+ generated YAML), `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`, `src/config/CtrlYokeConfigService.ts`, `src/utils/ConfigurationUtils.ts`, settings UI Queue section, `docs/reference/settings.md`                                                                                   |
| Shared topology/types     | `src/core/ParallelGroupTopology.ts` (new), `src/core/ParallelGroupPreflight.ts` (new), `src/types/CtrlYokeTypes.ts`, `src/types/DashboardConstants.ts`, `src/types/WebviewMessageTypes.ts`, `src/types/WorkflowTimelineTypes.ts`, `src/types/OutputHistoryTypes.ts`, `src/types/ExecutionPreviewTypes.ts`                               |
| Parse/serialize/revisions | `src/core/PromptFileParser.ts`, `src/core/WorkflowStepSanitizer.ts`, `src/core/WorkingFileManager.ts`, `src/core/orchestration/RunContinuationService.ts`, `src/core/orchestration/TimelineRecorder.ts`, `src/ui/WorkflowSerializer.ts`, `src/mcp-server.ts`                                                                            |
| Queue/runtime             | `src/core/PromptQueue.ts`, `src/core/WorkflowStateMachine.ts`, `src/core/WorkflowExecutor.ts`, `src/core/EndConditionHandler.ts`, `src/core/EndConditionEvaluator.ts`, `src/core/orchestration/ScriptProcessRunner.ts`, `src/utils/CliProcessManager.ts`, `src/utils/SessionResolver.ts`, `src/core/orchestration/RunOutputResolver.ts` |
| Integration ownership     | `src/core/WorkflowInstance.ts`, `src/core/OutputCaptureBuffer.ts`, `src/core/IntegrationFactory.ts`, `src/core/harness/shared/CliTransportCoordinator.ts`, `src/core/harness/shared/CliProviderUtils.ts`                                                                                                                                |
| Preview                   | `src/core/ExecutionPreviewService.ts`, `src/types/PreviewRedactor.ts`, `src/ui/webview-react/components/shared/DryRunModal.tsx`, `src/cli/CliTerminalFormatter.ts`                                                                                                                                                                      |
| Standalone CLI            | `src/cli.ts`, `src/cli/CliExecutionMode.ts`, `src/cli/CliTerminalFormatter.ts`, `src/cli/CliJsonResultBuilder.ts`                                                                                                                                                                                                                       |
| Timeline/output backend   | `src/core/orchestration/StreamingHistoryBuffer.ts`, `OutputHistoryManager.ts`, `OutputHistoryTimelineAdapter.ts`, `RunOutputResolver.ts`, `src/ui/DashboardBroadcastHub.ts`, `src/types/IDashboardSink.ts`                                                                                                                              |
| Workflow UI               | `src/ui/webview-react/store/workflowStore.ts`, `components/layout/WorkflowStepsPanel.tsx`, new `components/prompts/ParallelGroupPanel.tsx`, `hooks/usePromptStatus.ts`, `hooks/useStepContextMenu.tsx`, `utils/stepContextMenuItems.ts`, `hooks/useMessageHandler.ts`, `src/ui/WorkflowStepHandlers.ts`                                 |
| Output UI                 | `components/layout/OutputSection.tsx`, `output-section/OutputPane.tsx` (renderer + minimap host), `hooks/useOutputRowsModel.ts`, `useOutputMinimapModel.ts`, `useOutputScrollTarget.ts`, `utils/outputAutoscroll.ts`, `utils/outputProjection.ts`, `utils/outputRows.ts`, output row components                                         |
| Terminal UI/backend       | `src/core/harness/PtyProcessManager.ts`, `src/ui/TerminalMessageHandlers.ts`, `src/core/WorkflowOrchestrator.ts` (replay), `hooks/terminalMessageHandlers.ts`, `store/terminalStore.ts`, `components/output/TerminalView.tsx`                                                                                                           |
| Tests                     | parser/schema/serializer/queue/state machine/executor/history/preview tests in `src/test/**`; store/component/output/terminal tests in `src/ui/webview-react/test/**`                                                                                                                                                                   |

## Test Strategy

Use controllable fake integrations/processes; never use paid harness integration tests for
this feature's normal verification.

Required cases:

- YAML/JSON parsing, flattening, authored round trip, mixed-form rejection, and every
  topology mutation including snapping rules.
- Every bundled template parses and validates.
- Definition revision/history navigation retains the group that produced output.
- Same-harness siblings receive distinct integrations and sessions.
- Standalone inherited-stdio mode rejects multiple interactive members; standalone
  headless text prefixes concurrent activity with step identity.
- Different steps complete in reverse order without corrupting queue results or
  `currentIndex`.
- Retry counters and retry status remain isolated per target, and pass/fail retries still
  share one counter per target.
- Concurrent pre/end/script processes time out and cancel independently.
- `failFast` both true and false, including members waiting for a scheduler slot.
- All-disabled/pre-condition-skipped group commits the join immediately and is not a
  failure.
- Stop cancels all running targets; pause stops new launches and resumes unfinished
  members; edit locks on a partially settled paused group.
- Crash/reload with a partially settled group.
- Session collision detection after inherited/default property resolution, in both the
  executor preflight and the dry-run preview.
- `previous`, `all`, and numeric prior context use the pre-group boundary.
- Insert/append while a group is running lands after `endIndex`.
- Live activity A1 → B1 → A2 replays in the same A1 → B1 → A2 order.
- Tool completion updates its original activity row without duplication.
- Chips reconstruct one coherent target stream from the shared activity source.
- Multiple in-flight buffers and PTYs replay after workflow switch/reconnect.
- Virtualized output remains measured and navigable when an earlier activity row grows.
- Group undo restores the group-wide snapshot; per-step prompt undo is absent for
  concurrent members and present at width 1.
- `PARALLEL_GROUP_FAN_OUT_ENABLED = false` clamps width to 1 regardless of the setting.

## Decisions to Revisit Only After the First Release

- Arbitrary DAG dependencies and partial joins.
- Nested parallel groups.
- Per-group concurrency overrides; use the global scheduler width first.
- Isolated worktrees and automatic merge for precise per-step filesystem ownership.
- Per-step pause/resume controls inside a running group.
- Per-session terminal controller arbitration.
- Group creation through `ctrlyoke_append_queue`.
- A side-by-side lane/grid view; add only if the chronological stream plus chips proves
  insufficient.

## Readiness Checklist

- **Output:** chronological semantic activity timeline, target tags, consecutive-run
  coalescing, per-step chips over the shared hidden-target state; attempt aggregates
  remain for non-visual consumers.
- **`OutputPane`:** stays generic; ordering/grouping belongs in the upstream output model.
- **Storage:** flat `WorkflowStep[]` plus persisted `parallelGroups` everywhere, including
  definition revisions and dry-run preview; authored form is always `parallel:`.
- **Execution:** explicit target-scoped leaf plus fork/join coordinator; one shared
  preflight for executor and preview.
- **Concurrency:** bounded worker pool, `queue.maxParallelSteps` default 6, constant gate
  until Stage 6.
- **Pause/stop:** pause at a durable join; stop cancels all targets; partially settled
  groups have explicit edit locks.
- **Sessions/context:** resolve from one immutable pre-group snapshot and preflight
  collisions before launch.
- **Snapshots/undo:** one group-wide snapshot stored against the first member's target
  with a group marker; no false per-step ownership at width > 1.
- **Terminals:** session identity remains primary; same-group siblings stay as separate
  tabs using typed step/group metadata; standalone inherited stdio rejects concurrent
  interactive members.

Implementation can begin with Stage 1.
