# Better Code Initiative 1

**Date:** March 31, 2026 — last updated April 1, 2026  
**Status:** In Progress - Phases 1, 2, and 3 materially complete; Phase 4 partially implemented  
**Scope:** Post-bugfix architectural cleanup  
**Intent:** Reduce responsibility sprawl, make workflow state transitions authoritative, and replace split output persistence with a canonical append-only timeline.

---

## Executive Summary

This plan addresses four connected problems that showed up clearly during the
interactive CLI early-exit bug fix:

1. `CliIntegration` currently owns too many concerns at once.
2. Workflow state ownership is spread across `WorkflowExecutor`, `PromptQueue`,
   and `WorkflowInstance`, which makes stop/fail/cancel edge cases fragile.
3. Output persistence is split across `cliOutputs`, `statusMessages`, and
   `outputTimeline`, then merged again in the webview.
4. Some ordering is still reconstructed later instead of being captured as
   canonical event order when the workflow runs.

The core recommendation is:

- Keep `CliIntegration` as a thin facade and move process/session/output logic
  into focused helper classes.
- Introduce a single authoritative workflow runtime state machine.
- Replace split history persistence with a required-timestamp, append-only
  event timeline.
- Stop inventing ordering in the UI. Persist it once and render it directly.

This is not one giant PR. It should be delivered in phases, with compatibility
shortcuts explicitly allowed because FlightPath is still pre-release and local
history can be wiped.

---

## Current Branch Status

### What Has Been Accomplished

Phases 1, 2, and 3 are now materially complete. Phase 4 is partially implemented.

**Phase 2 — Authoritative Runtime State Machine (complete with minor cleanup remaining):**
- `WorkflowStateMachine` is now the sole owner of runtime lifecycle state
  (`status`, `stopped`, `startTime`, `pausedTime`, `totalPausedDuration`). It
  provides named transitions for run-level (`startExecution`, `pause`, `resume`,
  `requestStop`, `confirmStopped`, `complete`, `fail`, `reset`) and attempt-level
  operations (`beginAttempt`, `completeAttempt`, `failAttempt`, `scheduleRetry`,
  `cancelAttempt`). Attempt-level transitions are no longer scattered.
- `WorkflowInstance` subscribes to `workflowRuntime.onDidTransition()` for
  state-driven side effects. `onQueueStateChanged()` no longer derives dashboard
  or auto-start behavior from `QueueState.status`; it buffers events for inactive
  workflows and syncs to the dashboard. Lifecycle authority comes from the runtime
  owner, not queue projection.
- `WorkflowExecutor` routes all transitions through the state machine rather than
  treating `PromptQueue` as lifecycle truth.
- `PromptQueue` lifecycle methods (`start`, `pause`, `resume`, `stop`,
  `confirmedStopped`, `markCompleted`, `markErrored`) have been removed. The
  queue now exposes `commitRuntimeTransition()`,
  `markInFlightPromptCancelled()`, `finalizeCancelledPromptAfterStop()`, and
  `finalizeFailedInFlightPrompt()` as queue-topology/persistence helpers only.

**Phase 1 — `CliIntegration` decomposition (materially complete):**
- `CliExecutionSession` owns per-attempt mutable state (prompt text, resolved
  properties, parsed output, temp files, session ID, result).
- `CliExecutionRunner` coordinates interactive and headless execution via
  `CliTransportCoordinator`, `CliInteractiveStartupCoordinator`,
  `CliResponseCollector`, and `CliPromptPreparer`. `CliIntegration` is no longer
  the execution path itself; it is a delegation facade.
- Old private-method tests were moved to the new seam.

**Phase 3 — Append-Only Timeline Recorder (complete):**
- `TimelineRecorder` manages `manifest.json` + `events.jsonl` under
  `.flightpath/.history/<workflow-id>/run-<timestamp>/`. Events are appended
  atomically with file locking. Schema version `2.0.0`.
- `OutputHistoryManager` now writes to the timeline format: `appendCliOutput()`,
  `appendStatusMessage()`, `appendRuntimeTransition()`,
  `saveSnapshotForTarget()`, and `saveUndoRecord()` all produce discrete events
  with `timestampMs` and monotonic `sequence`.
- `WorkflowTimelineTypes.ts` defines the full event discriminated union
  (`WorkflowTimelineEvent`) and run manifest type (`WorkflowRunManifest`).
- `OutputHistoryTimelineAdapter` projects timeline events back into
  `WorkflowOutputHistory` shape for UI consumption, including the canonical
  `orderedEntries: OrderedHistoryEntry[]` array sorted by `(timestampMs,
  sequence)`.
- `OutputHistoryTypes.ts` was extended with `OutputExecutionTarget`,
  `OrderedHistoryEntry` (union of cli/status/runtime sub-types), and the optional
  `orderedEntries` and `outputTimeline` fields on `WorkflowOutputHistory`.

**Phase 4 — UI Projections (partially implemented):**
- `outputProjection.ts` is a new utility providing `mapOrderedHistoryEntriesToMessages`
  (canonical path using `orderedEntries`), `buildProjectedOutputMessages` (legacy
  fallback using per-step arrays with real timestamps instead of synthetic index
  math), and `buildHistoricalProjectionSteps` (interleaves queue/finalPrompt steps
  using `outputTimeline` ordering).
- `OutputSection.tsx` now delegates all output ordering to `outputProjection`.
  When `orderedEntries` are present (timeline-backed runs), it uses the canonical
  path; otherwise it falls back to projection from per-step arrays. No more manual
  merge of `cliOutputs + statusMessages` inside the component.
- `markdownExport.ts` uses `mapOrderedHistoryEntriesToMessages` when
  `orderedEntries` are available and sorts by `(timestamp, sequence)` otherwise.
  Markdown output now correctly labels `finalPrompt` sections as "Final Prompt
  Loop N" rather than "Prompt N".
- `workflowStore.ts` passes `orderedEntries` and `outputTimeline` through to
  `historyOutputs` so the webview can use them.

**Test coverage improvements:**
- Dedicated test files added: `OutputHistoryManager.test.ts`,
  `EndConditionHandler.test.ts`, `QueueOperations.test.ts`,
  `workflowStore.test.ts` (loadHistoryRun coverage),
  `outputProjection.test.ts`.
- `WorkflowInstance.test.ts` significantly expanded.

### What Is Still Incomplete

Phases 1–3 are in good shape. The remaining work is cleanup, full Phase 4
migration, and Phase 5 deletion.

**Remaining Phase 2 cleanup:**
- `QueueState` still carries `status`, `stopped`, and `totalPausedDuration`
  fields even though `WorkflowStateMachine` now owns these. They are kept for
  backward-compatible queue serialization via `syncToStateMachine()` /
  `syncFromStateMachine()`, creating a secondary source of truth. These redundant
  fields should be removed from `QueueState` once serialization is fully migrated
  to the timeline format.
- `PromptQueue.commitRuntimeTransition()` still acts as a persistence shim
  between the state machine and queue storage. A cleaner design would route
  persistence through `OutputHistoryManager` directly and remove this coupling.

**Remaining Phase 1 cleanup:**
- `CliIntegration` still owns prompt/session setup, runtime persistence handoff,
  and helper-factory wiring. It is a delegation facade but is still ~850 lines.
  The helper-factory glue could be extracted further if `CliIntegration` still
  feels dense after reading.

**Phase 0 (tests) still incomplete:**
- Ordering-specific regression coverage (history replay ordering across queue and
  finalPrompt) is still missing despite the new projection utilities.
- PTY exit during log discovery and interactive startup abort coverage is
  incomplete.

**Remaining Phase 4 work:**
- Live workflow output in `OutputSection.tsx` still builds messages from
  per-step `cliOutputs[i]` and `statusMessages[i]` arrays rather than consuming
  live timeline events. The canonical path (`mapOrderedHistoryEntriesToMessages`)
  is only used for history replay. The live path still relies on per-step array
  structure.
- History minimap is not yet fed from canonical event order.
- Run summary badges are not yet driven from timeline projections.

**Phase 5 not started:**
- Split `statusMessages[]` and `cliOutputs[]` per-step arrays still exist in
  `StepOutput` and are written during runs. These should be removed once the
  live output path also reads from the timeline.
- Legacy `.history/<workflow-id>/*.json` snapshot format is still supported
  alongside the new `run-*/manifest.json + events.jsonl` format. A one-time
  converter script or a clean schema bump should retire the old format.
- Render-time ordering math and compatibility replay fallbacks still exist in
  `buildProjectedOutputMessages` for legacy history files.

### Handoff Guidance For The Next Agent

The practical next steps in priority order:

1. **Remove redundant lifecycle fields from `QueueState`.** Now that
   `WorkflowStateMachine` is authoritative, `status`, `stopped`, and
   `totalPausedDuration` should not live in two places. This is the last
   meaningful Phase 2 cleanup item.
2. **Feed live output through the timeline.** `OutputSection.tsx` has two paths:
   canonical history and per-step-array live. Unifying them means emitting
   live `OrderedHistoryEntry` events to the webview during execution instead of
   separate `cliOutputs` / `statusMessages` arrays. This is the core Phase 4
   work.
3. **Remove `StepOutput.cliOutputs[]` and `StepOutput.statusMessages[]`** once
   the live path no longer needs them (Phase 5 start).
4. **Retire the legacy JSON history format** with a version bump and one-time
   migration script rather than keeping dual reader paths forever.
5. **Finish Phase 0 test gaps**: ordering regression coverage and interactive
   startup abort/log-discovery abort edge cases.

---

## Why This Is Worth Building

**Yes.** The recent bug was fixable, but it exposed structural weaknesses rather
than a single isolated defect.

The current architecture works, but it has three recurring failure modes:

- A single class accumulates more orchestration logic every time a new harness
  edge case appears.
- Execution state transitions are not owned in one place, so rare paths can
  miss a required follow-up transition.
- History replay correctness depends on reconstructing ordering from partially
  complete data structures rather than persisting a canonical event stream.

If left alone, future harness work will keep adding local patches to global
coordination code.

---

## Current Pain Points

### 1. `CliIntegration` is doing too much

Today `CliIntegration` is responsible for all of the following:

- Prompt preparation and temp file orchestration
- Headless vs interactive execution branching
- PTY process/session lifecycle
- Interactive startup waiting and SessionStart abort handling
- Session log discovery and monitoring coordination
- Failure classification and PTY tail capture
- Last-result / last-command / last-output bookkeeping
- Partial response / parsed response assembly

Even though some helper classes already exist, the top-level orchestration is
still too dense. Startup failures, process exits, log monitor behavior, and
output capture all meet in one class.

### 2. Runtime state ownership is split

The current behavior is spread across several classes:

- `PromptQueue` owns queue state and some execution status transitions
- `WorkflowExecutor` drives attempts and failure behavior
- `WorkflowInstance` coordinates stop/pause/resume and dashboard wiring

This split makes it easy for one path to call `stop()` and forget the matching
transition that another path performs somewhere else.

### 3. Output persistence is not canonical enough

The current persistence model stores:

- `cliOutputs[]`
- `statusMessages[]`
- `outputTimeline[]`

This already works better than older approaches, but it is still a projection,
not a canonical event stream. The live UI and history UI both have to rebuild a
single chronology from multiple structures.

### 4. Ordering is still reconstructed in multiple places

The long-term goal should be:

- every persisted event has a real `timestampMs`
- every event also has a monotonic per-run `sequence`
- the canonical sort is always `(timestampMs, sequence)`

If the system still needs `executionIndex * 10000 + index` style ordering math,
the persistence layer is not yet authoritative enough.

---

## Goals

### Primary Goals

- Make `CliIntegration` a facade instead of a giant orchestration class.
- Establish one authoritative owner for workflow runtime state transitions.
- Persist output as an append-only timeline instead of split arrays that must be
  merged later.
- Require timestamps for all persisted events.
- Eliminate synthetic fallback ordering from render-time logic.

### Secondary Goals

- Make interactive startup failures easier to reason about and test.
- Simplify history replay and markdown export.
- Reduce the amount of workflow logic embedded in UI selectors.

### Non-Goals

- Do not redesign the harness provider interfaces unless the refactor forces it.
- Do not solve parallel prompt execution as part of this initiative.
- Do not preserve backward compatibility for old local history if that slows the
  refactor down.

---

## Design Principles

### One owner per concern

- Process/session startup should have one orchestration owner.
- Workflow state transitions should have one owner.
- Persisted event ordering should have one owner.

### Persist facts, derive views

Persist timeline events as the source of truth. Derive `CliOutput`,
`StatusMessage`, retry summaries, minimap data, and markdown export views from
that canonical stream.

### Make invalid states hard to represent

If a workflow can be `cancelling`, there must be exactly one code path that can
move it to `stopped`, `error`, or `completed`.

### Prefer append-only recording over array replacement

Replacing whole step arrays works, but it increases the amount of merging logic
and makes crash recovery harder. Appending discrete events is simpler and more
durable.

---

## Initiative A: Split `CliIntegration` by Responsibility

### Target Outcome

`CliIntegration` remains the public harness integration entry point, but most of
its internal logic moves into focused classes with narrow contracts.

### Proposed Responsibility Split

| Class                              | Responsibility                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `CliIntegration`                   | Thin facade that wires provider + runtime services and exposes `sendPrompt()`  |
| `CliPromptPreparer`                | Build prompt payloads, temp files, split prompt files, reference instructions  |
| `CliExecutionSession`              | Per-attempt runtime container for one prompt execution                         |
| `CliExecutionRunner`               | Coordinate one interactive/headless attempt using transport, startup, and logs |
| `CliTransportCoordinator`          | Start headless/interactive execution via `CliProcessManager` / PTY             |
| `CliInteractiveStartupCoordinator` | Wait for SessionStart, monitor startup aborts, coordinate log discovery        |
| `CliResponseCollector`             | Accumulate streaming text, structured output, session metadata, final response |
| `CliFailureTracker`                | Detect abnormal exits, store exit classification, capture PTY output tail      |
| `CliSessionResolverAdapter`        | Isolate session validation and resolution wiring from execution transport      |

### Notes on Existing Reuse

This should build on existing helpers, not replace them blindly:

- keep `CliProcessManager`
- keep `CliLogMonitor`
- keep provider-specific parser / mapper / log parser logic
- keep `CliOutputFormatter` and `CliProviderUtils`

The main change is moving orchestration seams out of `CliIntegration`, not
throwing away the current shared infrastructure.

### Suggested Extraction Order

#### Phase A1: Extract failure tracking

Move these concerns first because they are highly cohesive and recently changed:

- PTY exit code tracking
- process-exit termination reason
- sanitized PTY tail capture
- last failure output
- startup abort classification

#### Phase A2: Extract startup coordination

Move the interactive startup path into one dedicated coordinator:

- SessionStart wait loop
- startup cancellation checks
- process-exit short-circuiting
- log discovery bootstrap

#### Phase A3: Extract response collection

Create a collector that owns:

- structured output accumulation
- streamed text accumulation
- command / prompt / working directory metadata
- final `CliResult` shaping

#### Phase A4: Extract prompt preparation

Move prompt file materialization and temp file orchestration out of execution
transport.

### Success Criteria

- `CliIntegration` reads like a coordinator, not a kitchen sink.
- Startup abort tests can target one helper class directly.
- PTY failure capture no longer requires reading through unrelated prompt-file
  logic.

---

## Initiative B: Rework Workflow State Ownership

### Target Outcome

Introduce a single authoritative runtime state owner, and demote the current
classes to clearer roles.

### Recommended Ownership Model

| Component                                        | Future Role                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `WorkflowStateMachine` or `WorkflowRuntimeStore` | Sole owner of execution state transitions                                 |
| `PromptQueue`                                    | Queue topology and prompt ordering only                                   |
| `WorkflowExecutor`                               | Command-side runner that requests transitions from the state machine      |
| `WorkflowInstance`                               | Wiring layer for dashboard, persistence, subscriptions, and user commands |

### Core Problem to Fix

Today, execution state and queue navigation are too intertwined. The runtime
needs a single place that answers:

- what state are we in now?
- what transitions are allowed?
- what side effects should happen on transition?

### Recommended State Machine Surface

Example command-style API:

```typescript
runtime.beginRun(...)
runtime.beginAttempt(target, attemptIndex, timestampMs)
runtime.markAttemptStreaming(target, attemptIndex)
runtime.completeAttempt(target, attemptIndex, result)
runtime.failAttempt(target, attemptIndex, error)
runtime.requestStop(reason)
runtime.confirmStopped(reason)
runtime.pause(reason)
runtime.resume()
runtime.completeRun()
```

The important part is not the exact names. The important part is that every
transition is validated and recorded in one place.

### `PromptQueue` After the Refactor

`PromptQueue` should keep only queue-oriented concerns:

- ordered prompts
- current queue pointer
- finalPrompt loop metadata if it truly belongs to queue topology
- prompt insertion / deletion / reorder behavior

`PromptQueue` should stop being a secondary owner of lifecycle transitions like
`running`, `cancelling`, or `stopped`.

### `WorkflowExecutor` After the Refactor

`WorkflowExecutor` should become a runner that:

- asks for the next unit of work
- invokes harnesses and end conditions
- emits events and transition requests
- does not own state truth itself

### Success Criteria

- No more paired transition logic split across multiple classes.
- Stop/fail/pause/resume behavior is traceable through one state machine.
- Edge-case tests assert transitions at one level, not through multiple indirect
  collaborators.

---

## Initiative C: Move to a Canonical Append-Only Timeline

### Target Outcome

Replace split history persistence with a single ordered event stream that drives
both live rendering and history replay.

### Current Model

Current persisted history is effectively a projection:

- `promptOutputs[stepIndex].cliOutputs[]`
- `promptOutputs[stepIndex].statusMessages[]`
- `finalPromptOutputs[loopIndex]...`
- `outputTimeline[]`

This is workable, but it is not the best canonical form.

### Proposed Canonical Model

Add a new persisted event type, for example:

```typescript
interface WorkflowTimelineEvent {
  id: string;
  runId: number;
  workflowId: string;
  timestampMs: number;
  sequence: number;
  target:
    | { kind: "queue"; stepIndex: number }
    | { kind: "finalPrompt"; loopIndex: number };
  attemptIndex?: number;
  eventType:
    | "promptStarted"
    | "cliCommandResolved"
    | "streamChunk"
    | "structuredEvents"
    | "statusMessage"
    | "attemptCompleted"
    | "attemptFailed"
    | "sessionResolved"
    | "workspaceSnapshotCaptured"
    | "undoApplied"
    | "redoApplied"
    | "stateTransition";
  payload: Record<string, unknown>;
}
```

### Important Ordering Rule

Every persisted event must have:

- required `timestampMs`
- required monotonic `sequence`

The canonical sort becomes:

1. `timestampMs`
2. `sequence`

`sequence` is not a synthetic render-time fallback. It is part of the canonical
recording contract, assigned when the event is emitted.

### Storage Recommendation

Use a manifest + JSONL event log model:

```text
.flightpath/.history/<workflow-id>/run-<timestamp>/
  manifest.json
  events.jsonl
```

`manifest.json` stores:

- run metadata
- final execution state
- schema version
- summary stats

`events.jsonl` stores one append-only `WorkflowTimelineEvent` per line.

### Why JSONL

- append-friendly
- crash-tolerant
- easier to inspect manually
- avoids full-file read/merge/write for every update

### Derived Views

The UI should derive these from the timeline, not persist them separately:

- prompt output cards
- status messages
- retry badges
- output minimap blocks
- markdown export order
- run summary badges

### Workspace Snapshots and Undo

Workspace snapshots and undo records can still exist as rich payloads, but they
should be timeline events rather than sidecar structures that must later be
matched back to UI elements.

---

## Initiative D: Eliminate Synthetic Ordering Logic

### Target Outcome

The UI should never need to invent order because the runtime already persisted it.

### Rules

- Every persisted event gets a timestamp at creation time.
- Every persisted event gets a monotonic sequence number at creation time.
- Output rendering sorts only on canonical persisted order.
- History replay uses the same ordering logic as live mode.
- Markdown export consumes the same projection layer as the output panel.

### What Should Disappear

Over time, remove logic shaped like this:

- `executionIndex * 10000 + index`
- infer ordering from array position alone
- merge `statusMessages` and `cliOutputs` in the component layer
- special-case replay ordering in the webview

### Migration Strategy

Because FlightPath is pre-release, prefer a clean cut:

- bump history schema version
- do not ship compatibility-only rendering hacks
- allow wiping old local history instead of carrying awkward migration code

If a migration is still desired later, build a one-time converter script rather
than polluting the runtime and webview paths forever.

---

## Recommended Implementation Phases

## Phase 0: Lock Down Behavior With Tests

**Status as of April 1, 2026:** Partial

Before deeper refactors, strengthen tests around the bug-prone seams.

### Add or expand coverage for

- interactive startup aborts
- PTY exit during SessionStart wait
- PTY exit during log discovery
- stop -> stopped transition behavior
- history replay ordering
- timeline ordering across queue and finalPrompt

### Deliverable

A behavior baseline that lets us refactor aggressively without reintroducing the
same bug class.

**Progress note:** Dedicated test files were added for `OutputHistoryManager`,
`EndConditionHandler`, `QueueOperations`, `WorkflowInstance` (loadHistoryRun),
`outputProjection`, and `workflowStore`. Interactive-startup and log-discovery
abort coverage exists around `CliExecutionRunner`. Ordering-specific regression
coverage for history replay across queue and finalPrompt interleaving is still
incomplete.

---

## Phase 1: Decompose `CliIntegration`

**Status as of April 1, 2026:** Materially complete; minor cleanup remaining

### Deliverables

- `CliFailureTracker`
- `CliInteractiveStartupCoordinator`
- `CliResponseCollector`
- `CliPromptPreparer`
- slimmer `CliIntegration`

### Constraint

No history schema change yet. Keep behavior stable while splitting class
responsibilities.

**Progress note:** `CliExecutionSession`, `CliExecutionRunner`,
`CliTransportCoordinator`, `CliInteractiveStartupCoordinator`,
`CliResponseCollector`, and `CliPromptPreparer` are all in place. `CliIntegration`
is now a delegation facade (~850 lines) and no longer owns per-attempt mutable
state or the execution path itself. Remaining work is helper-factory wiring
cleanup within `CliIntegration` if it still feels dense after reading.

---

## Phase 2: Introduce Authoritative Runtime State Machine

**Status as of April 1, 2026:** Materially complete; minor cleanup remaining

### Deliverables

- new `WorkflowStateMachine` or equivalent runtime store
- `PromptQueue` reduced to queue topology concerns
- `WorkflowExecutor` transitions routed through the runtime owner
- removal of duplicated transition logic

### Constraint

Do this before the event-timeline rewrite so the new timeline records clean,
authoritative transitions rather than legacy mixed ownership.

**Progress note:** `WorkflowStateMachine` is now the sole authority for both
run-level and attempt-level transitions. `PromptQueue` lifecycle methods have
been removed; it now exposes only queue-topology and persistence helpers.
`WorkflowInstance` is event-driven via `onDidTransition` rather than deriving
behavior from `QueueState.status`. Remaining cleanup: remove the now-redundant
`status`, `stopped`, and `totalPausedDuration` fields from `QueueState` and
decouple `commitRuntimeTransition()` from queue persistence.

---

## Phase 3: Add Append-Only Timeline Recorder

**Status as of April 1, 2026:** Complete

### Deliverables

- new timeline event type definitions
- `TimelineRecorder` or equivalent append-only writer
- required `timestampMs` and `sequence` assignment at emit time
- manifest + `events.jsonl` run storage

### Constraint

Keep existing webview contracts alive through an adapter layer until the UI moves
to timeline-derived projections.

**Progress note:** `TimelineRecorder` manages `manifest.json` + `events.jsonl`
under `.flightpath/.history/<workflow-id>/run-<timestamp>/` with file-locked
atomic appends (schema version `2.0.0`). `OutputHistoryManager` writes all
output events — CLI outputs, status messages, runtime transitions, workspace
snapshots, undo records — as discrete timeline events with required `timestampMs`
and monotonic `sequence`. `OutputHistoryTimelineAdapter` projects the event log
back into `WorkflowOutputHistory` shape including a canonical `orderedEntries`
array sorted by `(timestampMs, sequence)`. Legacy `.json` snapshot files are
still read via the original path; new runs use the timeline format exclusively.

---

## Phase 4: Move UI and History Replay to Timeline Projections

**Status as of April 1, 2026:** Partially implemented

### Deliverables

- webview selector/projection helpers that consume timeline events
- markdown export driven from the same projections
- output minimap fed from canonical event order
- history reload path that matches live ordering exactly

### Constraint

Avoid duplicating live-vs-history projection logic. One projection layer should
serve both.

**Progress note:** `outputProjection.ts` provides `mapOrderedHistoryEntriesToMessages`
(canonical path for timeline-backed history), `buildProjectedOutputMessages` (legacy
fallback using real timestamps instead of synthetic index math), and
`buildHistoricalProjectionSteps` (interleaves queue/finalPrompt steps using
`outputTimeline` ordering). `OutputSection.tsx` uses the canonical path when
`orderedEntries` are present and falls back to projection for legacy snapshots.
`markdownExport.ts` uses canonical ordering when `orderedEntries` are available.
`workflowStore.ts` passes `orderedEntries` and `outputTimeline` through to
`historyOutputs`. Remaining: live workflow output still uses the per-step-array
path rather than live timeline events; minimap and run badges are not yet
timeline-driven.

---

## Phase 5: Delete Legacy Structures

**Status as of April 1, 2026:** Not started

### Remove or demote

- split `statusMessages[]` persistence as canonical data
- split `cliOutputs[]` persistence as canonical data
- `outputTimeline[]` as a separate ordering structure
- render-time ordering math
- compatibility-only replay hacks

### Deliverable

One canonical model remains: append-only timeline events.

---

## Suggested File-Level Impact

### High-Impact Existing Files

- `src/flightpath/harness/CliIntegration.ts`
- `src/flightpath/HarnessIntegration.ts`
- `src/flightpath/WorkflowExecutor.ts`
- `src/flightpath/PromptQueue.ts`
- `src/flightpath/WorkflowInstance.ts`
- `src/flightpath/OutputCaptureBuffer.ts`
- `src/flightpath/orchestration/OutputHistoryManager.ts`
- `src/types/OutputHistoryTypes.ts`
- `src/types/CliOutputTypes.ts`
- `src/types/WebviewMessageTypes.ts`
- `src/ui/webview-react/components/layout/OutputSection.tsx`
- `src/ui/webview-react/utils/markdownExport.ts`

### New Files (now created)

- `src/flightpath/harness/shared/CliExecutionSession.ts` ✓
- `src/flightpath/harness/shared/CliExecutionRunner.ts` ✓
- `src/flightpath/harness/shared/CliInteractiveStartupCoordinator.ts` ✓
- `src/flightpath/harness/shared/CliResponseCollector.ts` ✓
- `src/flightpath/harness/shared/CliPromptPreparer.ts` ✓
- `src/flightpath/harness/shared/CliTransportCoordinator.ts` ✓
- `src/flightpath/WorkflowStateMachine.ts` ✓
- `src/flightpath/orchestration/TimelineRecorder.ts` ✓
- `src/flightpath/orchestration/OutputHistoryTimelineAdapter.ts` ✓
- `src/types/WorkflowTimelineTypes.ts` ✓
- `src/ui/webview-react/utils/outputProjection.ts` ✓

### Still Pending

- `src/flightpath/harness/shared/CliFailureTracker.ts` — PTY exit tracking and
  failure classification still live inside `CliIntegration`/`CliExecutionRunner`
  rather than a dedicated class.

---

## Risks

### Risk 1: Refactor scope creep

This can easily turn into a broad rewrite. Prevent that by keeping the phase
boundaries strict.

### Risk 2: UI migration churn

The webview has many derived behaviors. Move projections first, then switch the
renderers, rather than rewriting components and persistence at the same time.

### Risk 3: Over-designing the timeline schema

Start with the event kinds the product already needs. Do not build a generic
event-sourcing framework.

### Risk 4: Breaking tests through incidental renames

Prefer extraction and adapters before renaming public concepts.

---

## Success Metrics

- `CliIntegration` is materially smaller and easier to scan.
- Startup failure logic is isolated and directly unit-testable.
- Workflow lifecycle transitions are authored in one runtime owner.
- Persisted history has no optional ordering metadata gaps.
- The webview no longer merges separate canonical structures to reconstruct
  chronology.
- No compatibility-only replay fallback is needed.

---

## Recommendation

The initiative is in good shape. Phases 1–3 are done. Phase 4 is partial.
The remaining risk is in two areas: completing the live output path to use
timeline events (which would let us delete the per-step arrays), and retiring
the legacy JSON history format.

The practical continuation order from the current state:

1. Remove redundant lifecycle fields (`status`, `stopped`, `totalPausedDuration`)
   from `QueueState` — the last meaningful Phase 2 cleanup.
2. Feed live output through the timeline so `OutputSection.tsx` can use one path
   for both live and history — the core remaining Phase 4 work.
3. Once live output uses the timeline, remove `StepOutput.cliOutputs[]` and
   `StepOutput.statusMessages[]` (Phase 5 start).
4. Retire the legacy `.json` history format with a version bump and a one-time
   migration script.
5. Fill the Phase 0 test gaps: ordering regression coverage and
   interactive-startup/log-discovery abort edge cases.

That is the lowest-risk path from the code that exists now.
