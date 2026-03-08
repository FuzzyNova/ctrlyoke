# Final Prompt Mid-Execution Edit Plan

## Problem

`WorkflowExecutor.execute()` captures `finalPrompt` as a local `const` on line 156:

```typescript
const workflowFile = this.promptQueue.getWorkflowFile();
const finalPrompt = workflowFile.finalPrompt;
```

This snapshot is used throughout the entire execution loop. Even though `WorkflowInstance.updateFinalPromptInQueue()` correctly updates the queue's working file and the dashboard, the executor never sees those changes — it keeps running with the original value.

**Consequences:**
- Deleting the final prompt while the queue is running → final prompt still executes when queue drains
- Updating final prompt text while the queue is running → updated text is never used
- Adding a final prompt when none existed at start → final prompt phase never triggers

The infrastructure for persisting edits is already complete (`updateFinalPromptInQueue`, `PromptQueue.updateWorkflowProperty`, working file updates, dashboard sync). The broken pieces are:
1. The executor's stale local variable
2. No UI lock during final prompt execution (normal prompts lock while running; final prompt doesn't)

---

## Design Decision: Lock During Final Prompt Execution

Normal prompts are locked while they are the currently-executing step. The final prompt must follow the same rule for consistency: **the final prompt editor is locked while `phase === "finalPrompt"` and `status === "running"`**.

This eliminates the confusing scenario where a user disables the final prompt while it's actively running, the UI immediately shows "disabled", but the AI call continues — the user has no idea what will happen next. Locking makes the mental model clear: if you want to edit mid-run, pause or stop the workflow first.

**Lock condition** (evaluated in `PromptsPanel.tsx`):
```typescript
const finalPromptIsRunning =
  finalPromptPhase === FINAL_PROMPT_PHASES.FINAL_PROMPT &&
  finalPromptStatus === STEP_STATUS.RUNNING;
```

When locked:
- Clicking the footer row (to select/open in editor) is disabled
- The trash (disable) button is hidden
- `isReadOnly` is already wired into `FinalPromptFooter` — no new prop needed

When unlocked (all other states):
- `phase === "queue"` — queue is draining, final prompt is waiting → editable
- `phase === "finalPrompt"` but `status !== "running"` — completed/failed → editable
- `phase === null` — no runtime, workflow idle → editable
- Between dynamic-extension loops (phase briefly returns to `"queue"`) → editable

---

## Supported Edit Scenarios

| Action | When | Expected Result |
|---|---|---|
| Delete or update final prompt | While queue is running (`phase === "queue"`) | Editor unlocked; edit commits immediately; executor picks it up at the loop boundary before final prompt fires |
| Delete final prompt | Between dynamic-extension loops (phase briefly `"queue"`) | Editor unlocked; executor detects null at next loop start → final prompt phase skipped |
| Update final prompt text/properties | Between dynamic-extension loops | New value used on next final prompt iteration |
| Add a final prompt (was null at start) | While queue is running | Final prompt phase begins after queue drains |
| Delete or update while final prompt is executing | `phase === "finalPrompt"` + `status === "running"` | **Editor locked** — not possible via UI; use pause/stop to edit |

---

## Executor Fix: Live Getter

Replace the local `const finalPrompt` with a live getter. Reads in the main execution loop switch from the stale variable to the getter, so queue-phase edits, between-loop edits, and dynamically-added final prompts are all picked up correctly.

### `src/flightpath/WorkflowExecutor.ts`

**Before** (line ~155–156):
```typescript
const workflowFile = this.promptQueue.getWorkflowFile();
const finalPrompt = workflowFile.finalPrompt;
```

**After**:
```typescript
const workflowFile = this.promptQueue.getWorkflowFile();
const getFinalPrompt = () => this.promptQueue.getWorkflowFile().finalPrompt;
```

`workflowFile` is still captured once for `PropertyResolver.resolve(...)` — workflow-level defaults don't change mid-run.

---

## Changes by Location in `execute()`

### Initialization block (one-time, before the loop)

Use a one-time snapshot for the `runFinalPromptFirst` calculation — this runs once at startup and is not repeated:

```typescript
const initialFinalPrompt = getFinalPrompt();

if (initialFinalPrompt && !this.promptQueue.getFinalPromptRuntime()) {
  await this.setFinalPromptRuntime(context, {
    phase: FINAL_PROMPT_PHASES.QUEUE,
    loopCount: 0,
  });
} else if (initialFinalPrompt) {
  const runtime = this.promptQueue.getFinalPromptRuntime();
  context.dashboardProvider?.updateFinalPromptStatus(
    runtime?.status ?? null,
    runtime?.loopCount ?? 0,
    runtime?.phase ?? null
  );
} else {
  context.dashboardProvider?.updateFinalPromptStatus(null, 0, null);
}

let runFinalPromptFirst =
  !!initialFinalPrompt &&
  this.promptQueue.getFinalPromptRuntime()?.phase === FINAL_PROMPT_PHASES.FINAL_PROMPT;
```

### Loop: post-queue check for final prompt

**Before**:
```typescript
if (!finalPrompt) {
  break;
}
```

**After**:
```typescript
const currentFinalPrompt = getFinalPrompt();
if (!currentFinalPrompt) {
  break;
}

// Initialize runtime if a final prompt was added after execution started
if (!this.promptQueue.getFinalPromptRuntime()) {
  await this.setFinalPromptRuntime(context, {
    phase: FINAL_PROMPT_PHASES.QUEUE,
    loopCount: 0,
  });
}
```

### Loop: executing the final prompt

**Before**:
```typescript
const shouldContinue = await this.executeSinglePrompt(
  { kind: "finalPrompt", loopIndex },
  finalPrompt,         // stale
  context
);
```

**After**:
```typescript
const shouldContinue = await this.executeSinglePrompt(
  { kind: "finalPrompt", loopIndex },
  currentFinalPrompt,  // live value captured at top of this iteration
  context
);
```

### Loop: `allowDynamicExtension` check

**Before**:
```typescript
const finalPromptAllowsDynamic = PropertyResolver.resolve(
  finalPrompt,       // stale
  workflowFile
).allowDynamicExtension;
```

**After**:
```typescript
const finalPromptAllowsDynamic = PropertyResolver.resolve(
  currentFinalPrompt,  // snapshot from before executeSinglePrompt — correct for this run
  workflowFile
).allowDynamicExtension;
```

---

## UI Lock: `PromptsPanel.tsx`

`FinalPromptFooter` already accepts `isReadOnly`. Currently it receives `isCLIManaged`. Extend the condition:

```typescript
const finalPromptIsRunning =
  finalPromptPhase === FINAL_PROMPT_PHASES.FINAL_PROMPT &&
  finalPromptStatus === STEP_STATUS.RUNNING;

<FinalPromptFooter
  ...
  isReadOnly={isCLIManaged || finalPromptIsRunning}
  ...
/>
```

`FINAL_PROMPT_PHASES` and `STEP_STATUS` are already imported in `PromptsPanel.tsx` (they flow through from `DashboardConstants`). No new imports or props required.

---

## Behavior Details

### Queue-phase edits (primary use case)

While the queue is draining (phase = `"queue"`), the final prompt editor is fully unlocked. The user can:
- Edit the prompt text → new text captured by `currentFinalPrompt = getFinalPrompt()` just before `executeSinglePrompt` is called
- Delete the final prompt → `getFinalPrompt()` returns null after queue drains → executor breaks before entering final prompt phase
- Add a final prompt that didn't exist → detected at the post-queue null check; runtime initialized; phase begins

### Between-loop edits (dynamic extension workflows)

In dynamic-extension workflows the outer loop can repeat: `finalPrompt → queue → finalPrompt → ...`. Between a completed final prompt iteration and the next, the runtime phase is briefly set to `"queue"`. The editor is unlocked during this window. Any edit committed here is picked up by `getFinalPrompt()` at the top of the next outer iteration.

### Stopped + restarted after deletion (the `runFinalPromptFirst` path)

If the workflow was paused mid-final-prompt, stopped, the final prompt deleted, then the workflow restarted (`execute()` called fresh):

1. `initialFinalPrompt = getFinalPrompt()` → `null`
2. `runFinalPromptFirst = false` — phase-resume logic doesn't fire
3. Queue phase runs (empty queue, zero iterations)
4. `currentFinalPrompt = getFinalPrompt()` → `null` → `break`
5. Workflow completes immediately with no final prompt execution

### Retries within `executeSinglePrompt` use the same snapshot

`executeSinglePrompt` receives a single `promptItem` and passes it to `EndConditionHandler` for retries. All retry iterations — AI call, end condition script evaluation, retry-prompt re-run — use the same `PromptItem` snapshot captured as `currentFinalPrompt` before the call. Because the editor is locked while the final prompt is running, this is never observable from the UI. It remains true for any programmatic access that bypasses the UI lock (MCP, etc.).

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Delete while queue running | Editor unlocked; `updateFinalPromptInQueue(null)` commits immediately; `getFinalPrompt()` → null after queue drains → break; final prompt never fires |
| Edit text while queue running | Editor unlocked; new text in queue; `currentFinalPrompt = getFinalPrompt()` picks it up just before execution |
| Add final prompt mid-queue (was null) | Editor unlocked; detected at post-queue check; runtime initialized; final prompt fires |
| Delete between dynamic-extension loops | Phase briefly `"queue"` → editor unlocked → edit commits; next iteration's `getFinalPrompt()` → null → break |
| Delete while final prompt is executing | Editor locked (`phase === "finalPrompt"` + `running`) → not reachable from UI |
| Programmatic delete during execution (MCP, etc.) | `executeSinglePrompt` runs to completion with `currentFinalPrompt` snapshot; next iteration detects null → break; no UI inconsistency since footer reflects live state |
| Stopped/paused mid-final-prompt, final prompt deleted, then restarted | `initialFinalPrompt = getFinalPrompt()` → null; `runFinalPromptFirst = false`; workflow completes immediately |
| `persistInterruptedFinalPromptRuntime` after programmatic delete | Already null-safe — reads `getFinalPromptRuntime()` at line 459, returns early if null |

---

## File Change Summary

| File | Change |
|---|---|
| `src/flightpath/WorkflowExecutor.ts` | Replace `const finalPrompt = workflowFile.finalPrompt` with `const getFinalPrompt = () => ...`; update loop body to use `currentFinalPrompt = getFinalPrompt()` per iteration; add runtime init guard for dynamically-added final prompts |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx` | Extend `isReadOnly` to also lock when `finalPromptPhase === FINAL_PROMPT_PHASES.FINAL_PROMPT && finalPromptStatus === STEP_STATUS.RUNNING` |

No other files require changes.

---

## Not In Scope

- Editing while the final prompt is actively executing — locked by design; use pause/stop
- Mid-stream prompt text injection — architecturally impossible
- UI indication that a queued edit is "pending" — not needed; edits commit immediately when the editor is unlocked
