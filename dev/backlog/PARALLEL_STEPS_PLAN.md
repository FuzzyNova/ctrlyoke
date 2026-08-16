# Parallel Step Execution Within a Single Workflow

> **Last Updated:** August 10, 2026
>
> **Status:** Not implemented. The syntax, normalized storage model, execution barrier,
> output presentation, pause/stop semantics, and snapshot policy are decided below. Build
> the feature in the staged order in this document; do not enable concurrent fan-out until
> the target-keyed runtime and chronological output prerequisites are complete.

## Outcome

Add a `parallel:` queue item that runs a flat group of normal prompt/script steps with a
barrier before the following step.

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
  barrier has committed.
- Nested parallel groups and parallel `finalStep` values are not supported.
- Flat integer step numbering remains authoritative. The example above still has steps
  1–5, and `priorContext: [2, 3, 4]` keeps its existing meaning.

## Why Build It

This is different from running independent workflows at once. Parallel steps share one
workflow definition, one run timeline, variables, a join point, and downstream context.
The primary use case is parallel research or independent implementation tasks followed by
a synthesis/validation step.

Do not grow this first release into `dependsOn`/DAG scheduling. A DAG can be considered
later if real workflows need partial joins or multiple downstream branches.

## Current-Code Audit

The repository has changed substantially since the original plan. The current architecture
already provides useful pieces, but it is still sequential at several less-obvious seams.

### Definition and run storage

- `WorkflowStep` is the `PromptStep | ScriptStep` union. `parallel` is a container in the
  authored syntax, not a third `STEP_TYPES` discriminant.
- `WorkingFile` extends `PromptFile` and is stored under the run lineage. Definition
  revisions are also captured in `WorkflowDefinitionSnapshot` and timeline events.
- `PromptFileParser.normalizePromptFile()` currently maps each raw `steps` item directly to
  one `WorkflowStep`; it has no container normalization pass.
- `WorkflowSerializer` currently serializes a flat `workingFile.steps` array. It must learn
  to reconstruct authored `parallel:` containers when exporting/saving a definition.
- Every mutation path in `PromptQueue`, `WorkingFileManager`, `RunContinuationService`, and
  the dashboard currently assumes that inserting/reordering one step only changes the flat
  array. Group ranges must be updated in the same transaction.

### Execution state

- `WorkflowExecutor.execute()` is a queue → `finalStep` outer loop and executes the queue
  at `state.currentIndex` one target at a time.
- `executeSinglePrompt()` accepts an explicit target, but completion, skip, send, retry,
  failure, and progress still mutate current-index state.
- `PromptQueue.currentRetryCount` and several `EndConditionHandler` operations are singleton
  current-step state. Merely adding indexed completion methods is not enough.
- `WorkflowStateMachine` stores attempts in a target-keyed map, but it also has one
  `activeAttemptKey`; stop/cancel therefore sees only one active attempt.
- `WorkflowExecutor.isWaitingForResponse` is now only a boolean. The older plan's
  `pendingResponseResolver`/`pendingResponseText` parking fields no longer exist. Each
  response promise is already local to its integration; the remaining change is to make
  “awaiting any response” a target set or reference count.
- `EndConditionEvaluator` owns one `CliProcessManager`, and `CliProcessManager` owns one
  `currentProcess`. Concurrent pre-conditions, script steps, or end conditions would
  overwrite each other's cancellation/timeout bookkeeping.
- `WorkflowInstance.activeIntegration`, post-completion session-activity attribution, and
  user stop handling are singleton-oriented. `stop()` currently cancels one integration
  and one active attempt.
- `WorkflowInstance` caches normal execution integrations by harness. Same-harness parallel
  siblings require isolated integrations keyed by execution target.
- `OutputCaptureBuffer` is already keyed by step for live accumulation, but replay only
  replays the buffer at `state.currentIndex`. A parallel reconnect must replay every
  in-flight target.
- The webview still exposes one `currentStep`. Per-step statuses can represent several
  running members, but handlers such as live context-window updates currently discard any
  update whose `stepIndex !== currentStep`. Parallel activity needs an explicit active-target
  set (while `currentStep` may remain the group's compatibility/barrier index).
- The standalone CLI's interactive transport uses inherited process stdio, not the
  extension's independently multiplexed PTY sessions. Two interactive group members cannot
  safely share that one terminal.

### Output and history: what multiple writers would do today

`OutputPane.tsx` is not an output coordinator. It only virtualizes and renders the
`OutputRenderRow[]` supplied by `OutputSection`/`useOutputRowsModel`; writer attribution and
ordering must be solved before rows reach it.

The current path is:

```text
WorkflowExecutor streaming callbacks
  -> DashboardBroadcastHub / postMessage (each message has stepIndex)
  -> workflowStore
       liveOrderedEntries: one CLI aggregate per target/run/attempt/phase
       streamingChunks: text keyed by target + execution phase
  -> mapOrderedHistoryEntriesToMessages()
  -> buildOutputRows()
  -> OutputPane (virtualized renderer)
```

The durable run log is closer to a true timeline than the UI projection:

- `events.jsonl` records `cliOutputChunkAppended` and `cliOutputEventsAppended` events with
  a target, timestamp, and global run sequence.
- `StreamingHistoryBuffer` coalesces token traffic by target and flushes at semantic
  boundaries, size, or age.
- `OutputHistoryTimelineAdapter` then folds all streamed deltas for an attempt into one
  `OrderedCliHistoryEntry`.
- The live store does the same kind of folding in place: structured events are merged into
  the matching attempt and plain chunks accumulate in a target-keyed string.
- `buildOutputRows()` expands the entire attempt at the aggregate entry's position.

Therefore, if concurrency were enabled without output work, each writer would effectively
append to its own growing attempt block. The blocks would be ordered by their initial
placeholder/start timestamps, not by each later event. Output from step 3 could arrive
after output from step 4 but appear higher on screen inside step 3's existing block. This
has three UX problems:

1. It does not show the actual cross-step activity order.
2. A block near the top can grow while the user is following the bottom, causing
   virtualization measurements and scroll anchoring to move.
3. “Follow live output” cannot be implemented as “stay at the bottom,” because the most
   recently updated row may be anywhere in the list.

The transport is already step-attributed, so concurrent writers will not corrupt each
other merely because they use distinct flat step indices. The missing piece is a
cross-target activity projection; adding a group header to the current aggregate list does
not create one.

### Workspace snapshots and undo

`executeWithSnapshot()` currently captures around one step at a time. If sibling steps run
against the same workspace concurrently, each step's before/after window includes changes
made by its siblings. Per-step snapshot attribution and per-step undo would therefore be
incorrect even when output attribution is correct.

This is not only a display concern: two agents can edit the same file concurrently. The
first release does not attempt worktree isolation or automatic merge conflict resolution.
Parallel groups are intended for independent work, and the UI/docs must say so.

## Decisions

### 1. Authored syntax: nested `parallel` container

Use the YAML shape shown above. It is easier to read and validate than repeating a group
name/flag on each step. Reserve `dependsOn` for a possible future DAG design.

The group has one shared execution property in the first release:

```yaml
- parallel:
    - prompt: ...
    - prompt: ...
  failFast: true # default
```

All harness, model, agent, skills, permissions, conditions, hooks, and session properties
remain per-step or inherited from the workflow/settings. A group is a scheduling boundary,
not another property-inheritance layer.

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

Add `groups?: ParallelGroupDefinition[]` to `PromptFile`; `QueueState` exposes a non-null
array. `PromptFile.steps` remains `WorkflowStep[]`, and `WorkflowStep` remains unchanged.
Do not add `STEP_TYPES.PARALLEL`.

Group status is derived from member step/attempt state. Do not put mutable status in
`ParallelGroupDefinition`; definition topology and runtime state must not be mixed.

The group ID is generated during normalization with `randomUUID()`, matching the existing
ID convention in `WorkflowInstance` and `WorkflowLineageRepository`, then preserved in
working files and definition revisions. It is for stable UI keys, timeline correlation, and
mutation logic; users do not need to author it.

The following invariants are checked whenever a definition is loaded or mutated:

- ranges are bounded, non-overlapping, sorted, and contiguous;
- each group contains at least two steps (deleting down to one automatically unwraps it);
- `finalStep` is never grouped;
- all step mutations use one topology helper that updates `steps` and `groups` together.

The normalized representation must be carried through:

- draft and promoted `WorkingFile` values;
- `WorkflowDefinitionSnapshot` / definition revision events;
- run/draft webview messages and Zustand snapshots;
- history navigation, rewind, clone, append, delete, and reorder paths;
- `WorkflowSerializer`, which reconstructs nested `parallel:` items for authored YAML/JSON.

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
executeParallelGroup(...): Promise<GroupExecutionOutcome> // coordinator
```

The leaf path may emit target-scoped status/output and persist target-scoped runtime, but it
must not advance `currentIndex`, finalize the workflow, or cancel unrelated targets. The
coordinator owns fan-out, fail-fast policy, group snapshotting, the barrier commit, progress,
and workflow-level failure.

`PromptQueue` needs target/index-specific APIs:

- `markStepAsSent(stepIndex)`
- `completeStep(stepIndex, metadata?)`
- `skipStep(stepIndex, terminalStatus?)`
- `failStep(stepIndex, reason)`
- target-keyed retry get/increment/reset operations (or move retry counts fully into the
  attempt state machine)
- one `commitGroupBarrier(group, outcomes)` operation that persists member results and then
  advances `currentIndex` past `endIndex`

Keep sequential convenience wrappers around these primitives so there remains one source
of truth for step transitions.

While a group is running, `currentIndex` stays at the group's `startIndex`. Step status is
the source for member-level UI. Progress is completed/settled step count, not simply
`currentIndex`, and is broadcast after each member settles plus once at the barrier.

### 4. Concurrency limit: scheduler width, not group-size rejection

Add `queue.maxParallelSteps` to the config service/settings schema with a default of `6`.
It is the maximum number of active group members, not the maximum group length. A larger
group drains through a bounded worker pool and still has one join barrier.

This avoids making valid workflow files machine-dependent. With `failFast: true`, members
that have not entered the pool are cancelled without starting after the first terminal
failure.

### 5. Session and prior-context resolution uses a barrier snapshot

Before starting any member, capture an immutable view of completed steps and resolve every
member's effective properties against it. Do not let timing decide what a sibling sees.

Prior-context rules:

- A numeric `priorContext` reference into the same group is invalid.
- `previous` means the last completed step before the group, not the preceding flat sibling.
- `all` means the completed prefix before the group.
- All members therefore see the same pre-group context boundary.
- A step after the barrier can reference any completed group member normally.

Session rules:

- A numeric `sessionId` reference into the same group is invalid.
- Resolve inherited `resumeSession`, inherited/default `sessionId`, effective harness, and
  auto-resume against the same pre-group snapshot before fan-out.
- Two concurrently scheduled prompt steps may not resolve to the same concrete harness
  session. Report all conflicting step numbers/names before launching any member.
- Different-harness auto-resume may be valid because the resolved sessions differ; do not
  reject solely because two steps omit `sessionId`.
- Validation in the parser may catch explicit structural conflicts, but execution preflight
  is authoritative because global defaults and prior runtime session IDs are needed for
  effective resolution.
- Missing historical sessions keep the existing best-effort “warn and start fresh” behavior
  only after collision preflight has completed.

Resolve effective `mcpServers` in the same preflight. Any group member that effectively
enables the ctrlyoke dynamic-queue server is rejected because appending queue work from
inside an unsettled group has undefined topology/order semantics.

### 6. Runtime ownership is target-keyed

Before fan-out is enabled, make these resources concurrent-safe:

- Replace `WorkflowStateMachine.activeAttemptKey` with an active-target set/map. Stop and
  fail-fast cancellation operate on every applicable target.
- Replace the executor response-wait boolean with a target set/reference count. Response
  promises remain local to the target integration; no global response-text parking map is
  needed.
- Move retry counts and all `EndConditionHandler` current-index lookups to explicit targets.
- Give every parallel prompt an isolated execution integration keyed by
  `queue:<stepIndex>`, even when siblings use the same harness. Preserve the harness-keyed
  cache for ordinary sequential reuse.
- Replace `WorkflowInstance.activeIntegration` as the stop/cleanup source with a registry of
  active target resources. User stop cancels all of them and waits for all cancellation
  paths to settle (with the existing bounded shutdown behavior).
- Key post-completion/session activity attribution by integration/session/target instead of
  one `lastCompletedActivityTarget`.
- Make condition/script process ownership target-specific. Either instantiate an evaluator
  and `CliProcessManager` per active target or change the manager to a target-keyed process
  map; timeout and cancellation must never reference a shared `currentProcess`.
- Replay every `OutputCaptureBuffer.stepOutputBuffer` entry on reconnect, not only the one
  at `state.currentIndex`.
- Replace the coarse `hostCanProvidePty` assumption for this decision with an explicit host
  capability such as `supportsConcurrentInteractiveSessions`. The VS Code/hosted PTY path
  can return true; the standalone inherited-stdio path returns false.
- Thread active target indices through dashboard state and remove “must equal currentStep”
  guards from target-scoped telemetry such as context-window updates.

### 7. Failure, stop, and pause semantics

Use a group-scoped abort controller/resource registry. `Promise.allSettled` is useful for
draining cleanup, but it is not the cancellation mechanism by itself.

- `failFast: true`: the first terminal member failure prevents queued members from starting,
  cancels all running siblings, awaits their settlement, records cancelled outcomes, then
  fails the group/workflow.
- `failFast: false`: every member is allowed to settle; the group/workflow fails after the
  barrier if any member has a terminal failure.
- Per-step `onFail: continue`/error behavior is resolved inside the leaf result before the
  coordinator decides whether that outcome is terminal for the group.
- User **Stop** cancels every active group member and marks all not-yet-started members
  cancelled before committing stopped state.
- User **Pause** is barrier-based: already-started members finish their complete step
  contracts, no additional pool members start, and the workflow becomes paused after the
  partial group state is durably committed. Resume starts only unfinished members. This is
  safer and more predictable than trying to suspend arbitrary CLI processes mid-response.
- A crash/reload resumes only members without terminal `_runtime` state. Completed/skipped/
  failed/cancelled members are not silently rerun.

### 8. Workspace snapshot and undo policy: group-level

Capture one workspace snapshot before the group starts and one after every member settles.
Store the resulting artifact against the group ID and offer group-level undo/redo.

Do not present per-step prompt undo for members of a concurrently executed group. Their
filesystem windows overlap, so a per-step snapshot would make a false attribution claim.
Structured tool/file events may still show the step that reported an operation and its
diff, but the UI must distinguish event attribution from exclusive filesystem ownership.

Future precise per-step mutation isolation would require separate worktrees/sandboxes plus
an explicit merge phase. That is outside this plan.

## Output Design

### Decision: chronological semantic activity timeline with step focus

The default parallel-group output is one chronological activity stream. Every activity is
tagged with step number/name and has a stable group/target/attempt/phase identity. Do not
render three complete timelines stacked by step as the primary view.

To keep interleaving readable:

- Order **semantic activity starts**, not individual tokens. Text/thinking chunks from the
  same open block coalesce; tool start/result updates one stable activity item; status and
  script-output bursts are separate items.
- Consecutive activities from the same step share one visual run: show the full badge on the
  first row and a subtle continuation rail on subsequent rows.
- When another step becomes active, insert a compact step-switch marker/badge. Use both text
  and color/iconography so attribution is accessible.
- A group header shows `N running / N complete / N failed` and filter chips for **All** and
  each member. Selecting a step produces a coherent per-step view from the same underlying
  activity data; it is a filter, not a second stored history.
- Tool completion updates the original tool activity in place instead of adding a duplicate
  result at the bottom. The event's start sequence remains its location.
- Raw/plain response streams remain one target-owned response activity per attempt and grow
  in place. Exact token interleaving is neither useful nor reliably available.
- When live-follow is active, follow the most recently updated activity row rather than
  assuming the last list row is current. Suspend following as soon as the user scrolls away,
  matching existing behavior.
- After group completion, the same projection is used for history so live and replay do not
  reorder into different layouts.

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

This preserves the useful causal order without producing a token-by-token chat transcript.
The step filter answers the “show me one writer's complete story” need without duplicating
or re-storing output.

### Two projections, one durable source

Keep the existing attempt aggregate because it is useful for response reconstruction,
prior context, export, token totals, retries, and stats. Add an activity projection rather
than replacing it.

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

The exact shape may be refined during implementation, but the invariants are fixed:

- the durable timeline's `(timestampMs, sequence)` order is the cross-writer ordering source;
- every entry is target-attributed;
- coalescing boundaries are shared by live and replay paths;
- completed aggregate output updates metadata/content without duplicating streamed
  activities;
- stable activity keys allow tool-result and streaming-text updates in place.

`StreamingHistoryBuffer` already defines suitable semantic/size/age boundaries. Extend the
history path so the appended timeline events (including assigned sequence) can also drive
the live activity message, or create an equivalent run-scoped sequence at the same boundary.
Do not derive cross-writer order from React message arrival alone.

### UI ownership

Implement output changes at the projection/orchestration layer:

- `OutputHistoryManager` / `OutputHistoryTimelineAdapter`: preserve/expose activity entries
  in addition to aggregate attempt output.
- `workflowStore`: hold live/history activity entries and target-keyed streaming updates.
- `outputProjection.ts` / `useOutputRowsModel.ts` / `outputRows.ts`: merge, filter, coalesce,
  and build group/activity rows.
- `OutputSection.tsx`: own group filter state, live-follow navigation, minimap integration,
  and group header actions.
- `OutputRow` and small presentational components: render group headers, step-switch badges,
  and continuation rails.
- `OutputPane.tsx`: remain a generic virtualized row renderer. It may receive new rows/props,
  but it must not learn about writers, groups, ordering, or timeline mutation.

The minimap currently assumes a useful first row per target. Interleaved activity creates
multiple disjoint regions, so update its model to expose first/latest activity markers and
highlight the selected step filter. Do not represent one step as a single continuous span
when its rows are interleaved with siblings.

The per-step filter chip described above is not specific to parallel execution — ordinary
sequential multi-step workflows have the same "only show me step 3" need today, and every
output row is already step-attributed end-to-end (`OutputMessageTarget.index`,
`StepAnchorRow.stepIndex`). See
[`OUTPUT_STEP_FILTER_PLAN.md`](OUTPUT_STEP_FILTER_PLAN.md), a recommended precursor that
ships sequential-only step show/hide before this stage. Building it first validates the
filter-state and virtualization mechanics on the simpler single-writer case so Stage 5 can
reuse the same filter primitives instead of building a second mechanism.

## Terminal Design

Interactive parallel prompts are in scope. The PTY manager and terminal registry already
support multiple sessions, but webview reconciliation currently removes an existing AI
terminal when a new session has the same `harnessId`.

Add explicit execution identity to `TERMINAL_STARTED` and terminal session state:

- `stepIndex`
- `parallelGroupId` (preferred over only a boolean because it also helps diagnostics)

Rules:

1. The hard xterm identity remains `workflowId + sessionId`.
2. Replaying the same `sessionId` updates metadata in place.
3. Non-parallel same-harness sequential replacement keeps today's behavior.
4. Sessions with the same `parallelGroupId` are preserved as separate tabs even when their
   `harnessId` values match.
5. Tabs are labeled by sequential step number/name and can share the same harness icon.
6. Interactive script steps also need per-step PTY identity when scripts in one group run
   concurrently; the current single script-tab reuse rule is insufficient for that case.

The standalone CLI is different: its interactive harness processes inherit one stdin/stdout
TTY. If more than one enabled group member resolves to interactive mode and the host cannot
multiplex interactive sessions, fail preflight with a clear instruction to run the workflow
headless or set those members to `executionMode: headless`. Do not silently force a mode or
let several TUIs compete for input. Headless CLI output remains concurrent and prefixes each
displayed activity/burst with step number/name so interleaved text is attributable; JSON
results remain flat-step keyed.

## Validation Rules

### Structural validation

- `parallel` is accepted only as an item of the root `steps` array.
- `parallel` contains 2 or more prompt/script steps.
- Nested `parallel` containers are rejected.
- `finalStep` remains one `workflowStep` and cannot be parallel.
- Group ranges in normalized/working files satisfy the topology invariants above.
- Numeric `priorContext` and numeric `sessionId` references to a sibling in the same group
  are rejected.

### Effective execution preflight

Run before any group member launches:

- resolve inherited/default execution properties and variables;
- freeze the prior-context and session lookup boundary at group start;
- reject concrete session collisions;
- reject effective ctrlyoke dynamic-queue MCP access;
- verify required harnesses are ready and isolated integrations can be created;
- reject multiple interactive members when the active host cannot multiplex sessions;
- verify enabled member count and scheduler configuration;
- produce one aggregated diagnostic naming every invalid member rather than failing one at
  a time after partial launch.

A group whose members are all disabled (`enabled: false` or a failed `preCondition`) after
preflight has zero members to launch. Treat this the same as a normal `skipped` group: commit
the barrier immediately with no leaf executions, advance `currentIndex` past the group, and do
not treat it as a failure.

## Implementation Stages

### Stage 1 — Topology, schema, and round-trip persistence

1. Add `parallel` syntax to `schemas/workflow-schema.json` for root queue items only.
2. Add `ParallelGroupDefinition` and `groups` to shared definition/queue/message types.
3. Add a single topology helper for normalize/validate/insert/delete/reorder/group/ungroup.
4. Update `PromptFileParser` to flatten containers and populate group metadata.
5. Update working-file creation/update, run promotion, definition snapshots, revisions,
   rewind/clone, and addressed mutations to preserve groups.
6. Update `WorkflowSerializer` to reconstruct nested authored syntax.
7. Add parser, round-trip, mutation, revision, and invalid-range tests.

At the end of this stage, grouped steps may execute sequentially through the existing path,
but the UI must label this as sequential fallback. Do not imply concurrency yet.

### Stage 2 — Group editing and sequential UI

1. Store groups in `workflowStore` and its temporal snapshots.
2. Render a `ParallelGroupPanel` in `WorkflowStepsPanel` using existing step components.
3. Support group/ungroup plus drag into, out of, within, and between groups through the
   shared topology helper. Disable mutations while executing.
4. Show `failFast` in the group header and use existing message/property mutation patterns.
5. Add component/store tests for group rendering, status derivation, undo/redo, and drag
   topology.

### Stage 3 — Target-keyed runtime foundations

1. Add indexed queue result/completion APIs and group barrier commit.
2. Make retries and `EndConditionHandler` target-keyed.
3. Make `WorkflowStateMachine` support multiple active attempts.
4. Make response-wait state a target set/count.
5. Add isolated target-keyed integration acquisition and cleanup.
6. Make user stop cancel every active target.
7. Make condition/script processes target-owned and cancellable.
8. Make session-activity attribution and output replay multi-target.
9. Add active-target dashboard state and make live telemetry target-scoped.
10. Add `queue.maxParallelSteps` setting/config plumbing.

Keep real fan-out behind an internal feature gate until Stages 4–6 are complete.

### Stage 4 — Parallel coordinator and recovery

1. Implement barrier preflight and immutable context/session resolution.
2. Implement the bounded worker pool and `StepExecutionOutcome` leaf contract.
3. Implement fail-fast/fail-after-settle behavior and cancellation draining.
4. Implement barrier-based pause/resume and all-target stop.
5. Persist terminal member state as each member settles; commit group advancement once.
6. Recover interrupted groups by scheduling only non-terminal members.
7. Add group-level before/after workspace snapshots and undo/redo.

### Stage 5 — Chronological output projection

Recommended precursor: ship [`OUTPUT_STEP_FILTER_PLAN.md`](OUTPUT_STEP_FILTER_PLAN.md)
(sequential-only step show/hide) before or alongside this stage, and reuse its filter
state/UI primitives here rather than building a second filter mechanism.

1. Expose target-attributed activity entries from the append-only timeline without removing
   aggregate attempt output.
2. Thread sequence/timestamp/target through live activity messages.
3. Add live/history activity state and deduplication/reconciliation.
4. Build interleaved activity rows, group header, step-switch markers, and per-step filters.
5. Change live-follow to track the most recently updated row.
6. Update virtualization estimates/measurement invalidation and minimap semantics.
7. Verify history replay produces the same order and grouping as live output.

### Stage 6 — Terminal reconciliation and enablement

1. Add `stepIndex` and `parallelGroupId` to PTY session/start/replay messages.
2. Preserve same-harness parallel AI sessions and parallel script sessions as distinct tabs.
3. Exercise controller arbitration and reconnect replay with several simultaneous sessions.
4. Remove the concurrency feature gate only after end-to-end output, stop, pause, recovery,
   and terminal tests pass.

## File Map

| Area                      | Expected files                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/settings           | `schemas/workflow-schema.json`, `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`, `src/config/CtrlYokeConfigService.ts`, `src/utils/ConfigurationUtils.ts`                                                                                              |
| Shared topology/types     | `src/types/CtrlYokeTypes.ts`, `src/types/DashboardConstants.ts`, `src/types/WebviewMessageTypes.ts`, `src/types/WorkflowTimelineTypes.ts`, `src/types/OutputHistoryTypes.ts`                                                                                           |
| Parse/serialize/revisions | `src/core/PromptFileParser.ts`, `src/core/WorkflowStepSanitizer.ts`, `src/core/WorkingFileManager.ts`, `src/ui/WorkflowSerializer.ts`                                                                                                                                  |
| Queue/runtime             | `src/core/PromptQueue.ts`, `src/core/WorkflowStateMachine.ts`, `src/core/WorkflowExecutor.ts`, `src/core/EndConditionHandler.ts`, `src/core/EndConditionEvaluator.ts`, `src/utils/CliProcessManager.ts`                                 |
| Integration ownership     | `src/core/WorkflowInstance.ts`, `src/core/OutputCaptureBuffer.ts`, integration factories, shared CLI lifecycle code                                                                                                                                                    |
| Standalone CLI            | `src/cli.ts`, `src/cli/CliExecutionMode.ts`, CLI text/JSON result projection                                                                                                                                                                                           |
| Timeline/output backend   | `src/core/orchestration/StreamingHistoryBuffer.ts`, `src/core/orchestration/OutputHistoryManager.ts`, `src/core/orchestration/OutputHistoryTimelineAdapter.ts`, `src/core/orchestration/RunOutputResolver.ts`, dashboard sinks/hub                                     |
| Workflow UI               | `src/ui/webview-react/store/workflowStore.ts`, `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`, new `ParallelGroupPanel.tsx`                                                                                                                           |
| Output UI                 | `src/ui/webview-react/components/layout/OutputSection.tsx`, `OutputPane.tsx` (renderer only), `src/ui/webview-react/hooks/useOutputRowsModel.ts`, `useOutputMinimapModel.ts`, `src/ui/webview-react/utils/outputProjection.ts`, `outputRows.ts`, output row components |
| Terminal UI/backend       | `src/core/harness/PtyProcessManager.ts`, terminal transport messages, `src/ui/webview-react/hooks/terminalMessageHandlers.ts`, `terminalStore.ts`, terminal rail components                                                                                            |
| Tests                     | parser/schema, queue/state machine/executor/history tests in `src/test/**`; store/component/output/terminal tests in `src/ui/webview-react/test/**`                                                                                                                    |

The list is intentionally broader than the original plan. Definition revisions, output
timeline projection, retry/process ownership, reconnect replay, minimap behavior, and group
snapshot attribution are required correctness work, not optional polish.

## Test Strategy

Use controllable fake integrations/processes; never use paid harness integration tests for
this feature's normal verification.

Required cases:

- YAML/JSON parsing, flattening, authored round trip, and group topology mutations.
- Definition revision/history navigation retains the group that actually produced output.
- Same-harness siblings receive distinct integrations and sessions.
- Standalone inherited-stdio mode rejects multiple interactive members; standalone headless
  text prefixes concurrent activity with step identity.
- Different steps complete in reverse order without corrupting queue results/current index.
- Retry counters and retry status remain isolated per target.
- Concurrent pre/end/script processes time out and cancel independently.
- `failFast` both true and false, including members waiting for a scheduler slot.
- A group whose members are all disabled/preCondition-skipped commits the barrier
  immediately with no leaf executions and is not treated as a failure.
- Stop cancels all running targets; pause stops new launches and resumes unfinished members.
- Crash/reload with a partially settled group.
- Session collision detection after inherited/default property resolution.
- `previous`, `all`, and numeric prior context use the pre-group barrier snapshot.
- Live activity A1 → B1 → A2 replays in the same A1 → B1 → A2 order.
- Tool completion updates its original activity row without duplication.
- Per-step filter reconstructs one coherent target stream from the shared activity source.
- Multiple in-flight buffers and PTYs replay after workflow switch/reconnect.
- Virtualized output remains measured and navigable when an earlier activity row grows.
- Group undo restores the group-wide snapshot; per-step prompt undo is absent for concurrent
  group members.

## Decisions to Revisit Only After the First Release

- Arbitrary DAG dependencies and partial joins.
- Nested parallel groups.
- Per-group concurrency overrides; use the global scheduler width first.
- Isolated worktrees and automatic merge for precise per-step filesystem ownership.
- Per-step pause/resume controls inside a running group.
- A side-by-side lane/grid view. It is poorly suited to narrow output panes and should only
  be added if the chronological stream plus step filter proves insufficient.

## Readiness Checklist

The design questions that previously blocked implementation are resolved:

- **Output:** chronological semantic activity timeline, target tags, consecutive-run
  coalescing, per-step focus filter; attempt aggregates remain for non-visual consumers.
- **`OutputPane`:** stays generic; ordering/grouping belongs in the upstream output model.
- **Storage:** flat `WorkflowStep[]` plus persisted group definitions everywhere, including
  definition revisions.
- **Execution:** explicit target-scoped leaf plus fork/join coordinator.
- **Concurrency:** bounded worker pool, default width 6.
- **Pause/stop:** pause at a durable group barrier; stop cancels all targets.
- **Sessions/context:** resolve from one immutable pre-group snapshot and preflight
  collisions before launch.
- **Snapshots/undo:** one group-wide snapshot and group undo; no false per-step ownership.
- **Terminals:** session identity remains primary; same-harness parallel siblings stay as
  separate tabs using explicit group/step metadata; standalone inherited stdio rejects
  concurrent interactive members.

Implementation can begin with Stage 1. Concurrent execution must remain disabled until the
runtime, output, snapshot, recovery, and terminal prerequisites above are verified.
