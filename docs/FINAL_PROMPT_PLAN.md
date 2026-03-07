# Final Prompt (Orchestrator Gate)

**Date**: March 6, 2026  
**Status**: Implemented  
**Related**: [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md), [prompt-schema.json](../schemas/prompt-schema.json), [WorkflowExecutor.ts](../src/flightpath/WorkflowExecutor.ts), [PromptQueue.ts](../src/flightpath/PromptQueue.ts), [PromptsPanel.tsx](../src/ui/webview-react/components/layout/PromptsPanel.tsx), [OutputSection.tsx](../src/ui/webview-react/components/layout/OutputSection.tsx)

## Implementation Status

Fully implemented. All design decisions described in this document were adopted as-is:

- `finalPrompt` field on `PromptFile` (`src/types/FlightPathTypes.ts`)
- `FinalPromptRuntimeState` interface and `FinalPromptPhase` type (`src/types/FlightPathTypes.ts`, `src/types/DashboardConstants.ts`)
- `StepExecutionTarget` / `StepExecutionKey` discriminated types in `WorkflowExecutor.ts`
- `executeSinglePrompt()` + outer queue→finalPrompt loop in `WorkflowExecutor.ts`
- `UPDATE_FINAL_PROMPT`, `FINAL_PROMPT_STATUS_CHANGED`, `FINAL_PROMPT_OUTPUT` message constants in `DashboardConstants.ts`
- `finalPrompt` in `schemas/prompt-schema.json` (multi-prompt schema and working-file runtime schema)
- `FinalPromptFooter.tsx` component in the prompts panel
- Message handling in `useMessageHandler.ts` (all finalPrompt store fields)
- `extension.ts` wires `finalPrompt` from the workflow file to the dashboard on load

---

## Problem Statement

FlightPath has no first-class way to run a "cleanup and gate" prompt that is structurally guaranteed to execute after all normal queue work is done.

Users currently have two weak options:

1. **Put the cleanup at the end of the static queue.** This breaks for dynamic workflows. If earlier prompts append more work, the cleanup prompt is no longer last.

2. **Make every prompt self-orchestrating with `allowDynamicExtension`.** This mixes task execution and orchestration in every prompt, which violates single responsibility, increases prompt size, and makes convergence harder to reason about.

The missing primitive is a prompt that is guaranteed to run after the queue drains, regardless of how many prompts were appended earlier.

---

## Background: The Ralph Loop Pattern

The "Ralph Loop" pattern is an outer gate around an agentic loop:

1. Hand the agent a goal and a durable progress reference.
2. Let the agent do work and declare completion.
3. Intercept that completion with a final gate.
4. If work remains, append new work and continue.

FlightPath maps cleanly onto this pattern if `finalPrompt` is the outer gate and queue prompts remain focused on inner tasks.

The key principle is separation of concerns:

- Normal prompts perform work.
- `finalPrompt` decides whether the workflow is actually done.

---

## Proposed Solution: `finalPrompt` Workflow Property

Add a workflow-level `finalPrompt` property. It is a full `PromptItem`, with the same execution properties as normal prompts:

- `harness`
- `model`
- `agent`
- `skills`
- `resumeSession`
- `sessionId`
- `endCondition`
- `allowDynamicExtension`

### Use Cases

| Pattern                       | `allowDynamicExtension` | Description                                                                                                     |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Ralph Loop / Orchestrator** | `true`                  | Reads a plan doc, checks completion, appends the next task if needed, and reruns after appended prompts finish  |
| **PR / Review Gate**          | `false`                 | Reviews changes, writes a PR description, stages files, commits, or performs other end-of-run work exactly once |
| **Cleanup & Commit**          | `false`                 | Ensures reusable templates always end with cleanup, formatting, test execution, or final bookkeeping            |
| **Notification / Reporting**  | `false`                 | Sends a summary, writes a report, or updates a tracking file after all other prompts are complete               |

---

## Core Design Decisions

### 1. `finalPrompt` Lives Outside the Queue

`finalPrompt` is not part of `promptQueue.prompts` and does not participate in `currentIndex`.

That keeps queue semantics stable:

- `hasNext()` still means "is there another normal queued prompt?"
- `currentIndex` still points only at normal prompts
- prompt append/extend logic remains queue-native

### 2. No Virtual Numeric Step Index

Do **not** represent `finalPrompt` as `prompts.length` or any other numeric queue index.

That would collide with newly appended prompts because a prompt appended after `finalPrompt` runs can later occupy that same numeric index. Current output, retry, status, anchor, and history paths are keyed by numeric step indices, so index reuse would misattribute data.

Instead, `finalPrompt` gets its own runtime identity model.

### 3. `finalPrompt` Needs a Distinct Runtime Identity

Use a separate execution identity for `finalPrompt` rather than overloading queue step indices.

Recommended shape:

```typescript
type StepExecutionTarget =
  | { kind: "queue"; stepIndex: number }
  | { kind: "finalPrompt"; loopIndex: number };
```

For places that only need a string key, use a stable derived key:

```typescript
type StepExecutionKey = `queue:${number}` | `final:${number}`;
```

Examples:

- `queue:0`
- `queue:1`
- `final:0`
- `final:1`

This avoids collisions in:

- live output storage
- retry state storage
- streaming buffers
- output anchors
- history snapshots
- CLI watch replay

### 4. `finalPrompt` Is a Real Execution Phase

The workflow has two logical phases:

- `queue`: draining normal prompts
- `finalPrompt`: running the orchestrator gate

This phase distinction must be reflected in runtime state so pause, stop, resume, and restore behave deterministically.

---

## Execution Model

### Loop Semantics

```text
outer loop (bounded by existing maxQueueSize / unlimitedMode / maxWorkflowExecutionTime guards):
  1. drain normal queue prompts while queue.hasNext()
  2. if execution is no longer RUNNING, stop
  3. if no finalPrompt, complete
  4. execute finalPrompt once
  5. if execution is no longer RUNNING, stop
  6. if finalPrompt appended queue prompts, continue outer loop
  7. otherwise complete
```

### Key Invariants

- `finalPrompt` runs only after the normal queue is empty.
- If `finalPrompt.allowDynamicExtension !== true`, the workflow ends after `finalPrompt` completes.
- If `finalPrompt.allowDynamicExtension === true` and it appends prompts, those prompts run before `finalPrompt` runs again.
- Existing queue growth guards remain authoritative:
  - `maxQueueSize`
  - `unlimitedMode`
  - `maxWorkflowExecutionTime`
- `finalPrompt` participates in the same harness resolution, end condition, retry, pause, and stop behavior as a normal prompt.

### Executor Refactor

The current queue loop in [WorkflowExecutor.ts](../../src/flightpath/WorkflowExecutor.ts) should be split into:

1. A reusable `executeSinglePrompt(...)` path used by both queue prompts and `finalPrompt`
2. An outer orchestration loop that alternates between:
   - draining queue prompts
   - optionally executing `finalPrompt`

Recommended sketch:

```typescript
async execute(defaultIntegration, context): Promise<void> {
  this.clearPendingState();
  this.stepStatusMessages.clear();
  await this.promptQueue.start();
  this.promptQueue.startExecutionTimer();

  const workflowFile = context.workflowFile ?? this.promptQueue.getWorkflowFile();
  const finalPrompt = workflowFile?.finalPrompt;

  while (true) {
    while (this.promptQueue.hasNext()) {
      const state = this.promptQueue.getState();
      const prompt = state.prompts[state.currentIndex];
      await this.executeSinglePrompt({
        target: { kind: "queue", stepIndex: state.currentIndex },
        prompt,
        defaultIntegration,
        context,
      });
    }

    const statusAfterQueue = this.promptQueue.getState().status;
    if (statusAfterQueue !== EXECUTION_STATES.RUNNING) {
      break;
    }

    if (!finalPrompt) {
      break;
    }

    const loopIndex = context.finalPromptRuntime?.loopCount ?? 0;
    const queueSizeBefore = this.promptQueue.getState().prompts.length;

    await this.executeSinglePrompt({
      target: { kind: "finalPrompt", loopIndex },
      prompt: finalPrompt,
      defaultIntegration,
      context,
    });

    const statusAfterFinal = this.promptQueue.getState().status;
    if (statusAfterFinal !== EXECUTION_STATES.RUNNING) {
      break;
    }

    const queueSizeAfter = this.promptQueue.getState().prompts.length;
    if (queueSizeAfter <= queueSizeBefore) {
      break;
    }

    context.finalPromptRuntime = {
      ...context.finalPromptRuntime,
      loopCount: loopIndex + 1,
      phase: "queue",
    };
  }
}
```

---

## Runtime State and Resume Semantics

### Working File Requirements

The current working file runtime only tracks queue position and execution state. That is not enough to restore a workflow paused or stopped during `finalPrompt`.

Add runtime metadata for final prompt execution.

Recommended shape:

```typescript
interface FinalPromptRuntimeState {
  phase: "queue" | "finalPrompt";
  loopCount: number;
  status?: StepStatus;
  startedAt?: number;
  completedAt?: number;
}

interface WorkingFileRuntime {
  currentIndex: number;
  executionState: ExecutionState;
  finalPrompt?: FinalPromptRuntimeState;
}
```

### Resume Rules

- If the workflow is paused or stopped during normal queue execution, resume from `currentIndex` as today.
- If the workflow is paused or stopped during `finalPrompt`, resume by re-running `finalPrompt` for the same `loopCount`.
- If VS Code restarts while the workflow was in `finalPrompt`, restore phase as `finalPrompt` and let resume continue through that phase.
- `loopCount` is not just informational. It is part of execution identity and must survive restart.

### Completion Rules

- If the workflow completes normally, persist final prompt runtime as completed.
- If `finalPrompt` fails its end condition after retries, the workflow ends in `error`.
- If the user stops during `finalPrompt`, the workflow ends in `stopped`, preserving final prompt phase for explicit resume.

---

## Schema Changes (`schemas/prompt-schema.json`)

Add `finalPrompt` to the multi-prompt schema using the existing `promptItem` definition:

```json
"finalPrompt": {
  "$ref": "#/definitions/promptItem",
  "description": "A prompt that always runs after all queued prompts complete. Useful for orchestrator gates, cleanup-and-commit workflows, PR review steps, or final reporting. If allowDynamicExtension is true and finalPrompt appends prompts, those prompts run first and then finalPrompt executes again."
}
```

### Parsing Behavior

`finalPrompt.prompt` should go through the same normalization path as normal prompt bodies:

- inline text works unchanged
- prompt-file references such as `./something.prompt.md` should resolve exactly as `prompts[].prompt` does today

That means `PromptFileParser` needs explicit support for normalizing `finalPrompt`, not just schema validation.

---

## Type Changes (`src/types/FlightPathTypes.ts`)

Add to `PromptFile`:

```typescript
export interface PromptFile extends ExecutionProperties {
  prompt?: string;
  prompts?: PromptItem[];
  finalPrompt?: PromptItem;
}
```

Also extend working-file runtime types with final prompt execution state as described above.

### Important Naming Note

There are currently two `WorkflowContext` interfaces in the codebase:

- a shared harness-facing one in `src/types/FlightPathTypes.ts`
- an executor-specific one in `src/flightpath/WorkflowExecutor.ts`

This plan refers to the executor-specific context when discussing workflow execution. Rename one of them during implementation to avoid ongoing ambiguity.

---

## `PromptQueue` Changes

`PromptQueue` should continue to treat only normal prompts as queue entries.

No changes are needed to:

- `hasNext()`
- `currentIndex`
- prompt append/extend behavior

But `PromptQueue` and its working-file helpers do need to preserve and expose:

- `workflowFile.finalPrompt`
- `_runtime.finalPrompt`

This is not a queue API change, but it is a working-file persistence change.

---

## Parser, Loader, Serializer, and Settings Plumbing

This is easy to miss and must be part of the plan explicitly.

### `PromptFileParser`

Update normalization so `finalPrompt` is fully normalized and prompt-file references are resolved.

### `PromptFileLoader`

When loading a workflow into a working file, carry `finalPrompt` through with other workflow-level properties.

### `WorkingFileManager`

Support updating, deleting, and persisting `finalPrompt` on the working file just like other editable workflow-level properties.

### `WorkflowSerializer`

Include `finalPrompt` in save/export round-trips. Current serializer logic uses explicit allowlists for workflow and prompt fields, so `finalPrompt` must be added deliberately.

### `WebviewSettingsSync`

Do not treat `finalPrompt` as a normal workflow-level setting in the settings drawer. It belongs in the prompts/editor UX, but the working-file sync layer still has to read and write it.

### Session Restore / Recent Workflow Load

Ensure `FILE_SELECTED`, `SESSION_RESTORED`, and working-file reloads all send `finalPrompt` back to the webview.

---

## Webview and Message Architecture

### Do Not Assume a Single State Update Message

The current UI uses granular extension-to-webview messages rather than a monolithic `WORKFLOW_STATE_UPDATE` payload.

Implementation should follow the existing message architecture instead of inventing a state update that does not exist today.

### Recommended Extension-to-Webview Messages

Add one or both of the following patterns:

```typescript
UPDATE_FINAL_PROMPT: "updateFinalPrompt";
FINAL_PROMPT_STATUS_CHANGED: "finalPromptStatusChanged";
```

Suggested payloads:

```typescript
{ finalPrompt: PromptItem | null }
{ status: StepStatus | null, loopCount: number, phase: "queue" | "finalPrompt" }
```

Also include `finalPrompt` in:

- initial state
- file selected
- session restored
- prompt list refresh messages where appropriate

### Webview Store Shape

Recommended additions to `workflowStore`:

```typescript
finalPrompt: PromptItem | null;
finalPromptStatus: StepStatus | null;
finalPromptLoopCount: number;
finalPromptPhase: "queue" | "finalPrompt" | null;
finalPromptOutputs: Record<number, StepOutput>; // keyed by loopIndex
```

If live output storage is converted to execution keys rather than raw numeric indices, store queue and final prompt outputs under separate key namespaces.

---

## UX Plan

### Prompts Panel Footer

Add a dedicated footer section below the normal prompt list.

The footer is **bottom-anchored**. In collapsed state it behaves like a persistent bottom bar. In expanded state, the footer keeps its bottom edge pinned to the panel and reveals its detail body **above** the summary bar. That means the scrollable prompt list above loses height when the footer expands.

States:

- No final prompt configured
- Final prompt configured and collapsed
- Final prompt configured and expanded
- Final prompt running
- Final prompt completed
- Final prompt failed

Recommended collapsed default when configured.

### Interaction Model

- Clicking the footer selects `finalPrompt` in the editor.
- Checkbox or enable toggle disables/re-enables `finalPrompt`.
- Expand/collapse is local UI state and does not persist to disk.
- The summary bar remains pinned to the bottom edge in both collapsed and expanded states.
- When expanded, the detail body opens above the summary bar rather than below it.
- In CLI watch mode, the entire footer is read-only.

### Footer Layout

Recommended structure:

1. **Bottom summary bar**
   Always visible when the footer is present. Contains:

- status icon
- `Orchestrator` label
- enabled toggle
- expand/collapse affordance
- loop badge when relevant

2. **Expanded detail body**
   Revealed above the summary bar when expanded. Contains:

- name or truncated prompt summary
- harness/model metadata
- retry state
- duration/session/context stats when useful
- end-condition result when available

This should visually reuse the language of normal prompt rows, but it should not pretend to be a numbered queue item.

### Editor Selection Model

Do **not** use `selectedPromptIndex = -1`.

Use an explicit selection target instead:

```typescript
type EditorSelectionTarget =
  | { kind: "newPrompt" }
  | { kind: "queue"; index: number }
  | { kind: "finalPrompt" };
```

This avoids broken assumptions in current UI code that treats any non-null index as a normal queue prompt.

### Editor Behavior

When `finalPrompt` is selected:

- Title should read `Orchestrator Prompt` or `finalPrompt.name`
- All normal prompt properties are editable
- Save path writes back to workflow-level `finalPrompt`
- Delete becomes "Disable orchestrator prompt"

### Progress and Status UX

The current progress model is queue-count based. Without explicit design, the UI can show `N/N` while `finalPrompt` is still running.

Recommended behavior:

- Keep the main queue progress counter based on normal prompts only
- Show a distinct execution badge/state when `finalPrompt` is running, for example:
  - `3/3 • Orchestrator Running`
  - `3/3 • Final Gate`
- Status bar should follow the same rule

### Output Panel UX

`finalPrompt` output must appear in chronological order and remain distinguishable from queue prompts.

Recommended rendering:

- Queue outputs keep normal step ordering
- Each `finalPrompt` run renders as a labeled section, for example `Orchestrator Loop 1`, `Orchestrator Loop 2`
- Anchor IDs use a distinct namespace, for example:
  - `output-step-queue-2`
  - `output-step-final-1`

### Rationale For Upward Expansion

Because the footer is the last element in the prompt panel, "expanding downward" is misleading. The correct behavior is:

- the footer bar stays pinned at the bottom
- the expanded content appears above it
- the prompt list above shrinks to make room

This preserves the footer as a stable anchor while still allowing glanceable orchestrator details without opening the editor.

---

## History Storage

Current history storage is keyed by numeric queue step index. That does not work for `finalPrompt` if it can loop and if queue size can grow between final prompt executions.

Recommended history extension:

```typescript
interface WorkflowOutputHistory {
  schemaVersion: "1.1.0";
  workflowId: string;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  runStepCount: number;
  promptOutputs: { [stepIndex: number]: StepOutput };
  finalPromptOutputs?: { [loopIndex: number]: StepOutput };
}
```

Notes:

- `promptOutputs` remains queue-only for backward compatibility
- `finalPromptOutputs` is loop-indexed, not queue-indexed
- output panel history loading must render both collections in a stable order

If backward compatibility matters for old files, add tolerant loading for both `1.0.0` and `1.1.0`. If not, document the migration clearly.

---

## End Condition and Session Edge Cases

### End Conditions

`finalPrompt.endCondition` should behave exactly like a normal prompt end condition:

- retries supported
- retry prompt supported
- timeout supported
- failure after retries ends the workflow in `error`

### Session IDs

`finalPrompt` supports `resumeSession` and `sessionId`, but two rules should be documented:

1. Numeric `sessionId` references should continue to target normal queue prompts only.
2. Whether later normal prompts may resume the `finalPrompt` conversation should be explicitly unsupported for v1 unless a strong use case exists.

Recommended v1 simplification:

- `finalPrompt` may resume itself across loops if configured
- normal prompts do not reference `finalPrompt` by numeric session index

---

## Settings

No new user settings are required.

Loop termination remains governed by:

- `maxQueueSize`
- `maxWorkflowExecutionTime`
- `unlimitedMode`

However, the plan should explicitly mention that a looping `finalPrompt` is still subject to execution-time limits, not only queue-size limits.

---

## Implementation Order

1. **Schema + core types**
   Add `finalPrompt` to the schema and `PromptFile`. Add runtime metadata for final prompt phase and loop count.

2. **Parser normalization**
   Normalize `finalPrompt` prompt content exactly like normal prompts.

3. **Working-file plumbing**
   Thread `finalPrompt` and `_runtime.finalPrompt` through prompt loading, working-file updates, and restore flows.

4. **Executor refactor**
   Extract `executeSinglePrompt()` and add the outer loop. Introduce explicit execution target identity for queue vs final prompt.

5. **History model**
   Extend `OutputHistoryManager` and history loading/rendering for final prompt loop outputs.

6. **Webview messages and stores**
   Add final prompt data, status, loop count, and outputs to the existing granular message flow and Zustand stores.

7. **Prompts panel footer**
   Add the new footer component and read-only CLI watch behavior.

8. **Editor integration**
   Replace index sentinel logic with an explicit selection target model and add save/disable behavior for `finalPrompt`.

9. **Serializer and save/load round-trips**
   Ensure `finalPrompt` survives save, reload, session restore, recent workflow loading, and clear/reset paths.

10. **Tests**
    Add unit and integration coverage for executor, parser, working-file persistence, history, and UI state transitions.

---

## Testing Plan

### Core Executor Tests

- `finalPrompt` runs once after a normal queue drains
- no `finalPrompt` behaves exactly like today
- `finalPrompt.allowDynamicExtension = false` ends the workflow after one final run
- `finalPrompt.allowDynamicExtension = true` plus queue growth re-enters the outer loop
- `maxQueueSize` still stops infinite queue growth
- `maxWorkflowExecutionTime` still stops infinite looping even if queue growth is small

### Collision Regression Tests

- output from `finalPrompt` loop 0 is not overwritten by a newly appended queue prompt that later occupies the next numeric queue index
- retry state and streaming buffers remain isolated between queue steps and final prompt loops

### Pause / Stop / Resume Tests

- pause during queue prompt
- pause during `finalPrompt`
- stop during `finalPrompt`
- restore from working file while phase is `finalPrompt`
- resume after restore reruns the correct final loop

### Parser / Schema Tests

- valid workflow with `finalPrompt`
- invalid `finalPrompt` missing `prompt`
- `finalPrompt.prompt` file-path normalization
- save/load round-trip preserves all `finalPrompt` properties

### History Tests

- history stores queue outputs and final prompt outputs separately
- history render order is deterministic across loops
- old history files still load safely if backward compatibility is retained

### Webview Store / Message Tests

- initial load includes `finalPrompt`
- session restore includes `finalPrompt`
- enabling, disabling, and editing `finalPrompt` updates the working file correctly
- CLI watch mode renders footer as read-only

### UX Behavior Tests

- progress badge remains coherent while `finalPrompt` runs after queue count is complete
- selecting `finalPrompt` opens the correct editor state
- switching workflows while editing `finalPrompt` preserves or discards draft state intentionally

### Manual Testing

- Ralph Loop with repeated append cycles
- cleanup-only `finalPrompt`
- `finalPrompt` with end condition retries
- save as YAML and JSON, reload, run again
- CLI-managed workflow watch mode with live final prompt output

---

## Risks and Mitigations

### Risk: Runtime Identity Collisions

Mitigation: use explicit queue vs final prompt execution keys, never numeric virtual indices.

### Risk: Resume Logic Becomes Ambiguous

Mitigation: persist execution phase and loop count in working file runtime.

### Risk: UI Assumptions Around `selectedPromptIndex`

Mitigation: use a discriminated editor target instead of sentinel values.

### Risk: Save/Load Omissions

Mitigation: treat parser, working-file manager, serializer, and restore flows as first-class implementation steps, not incidental cleanup.

### Risk: Output Panel Complexity

Mitigation: keep queue outputs and final prompt outputs in separate namespaces, then render them in a deliberate chronological order.

---

## Out of Scope (Future)

- **Multiple final prompts**: v1 supports one orchestrator gate. Chained cleanup can still be expressed inside that prompt or as static queue prompts.
- **Conditional finalPrompt metadata outside the prompt text**: keep condition logic inside the prompt for v1.
- **Allowing normal prompts to reference finalPrompt by numeric session index**: too much session-model complexity for v1.
