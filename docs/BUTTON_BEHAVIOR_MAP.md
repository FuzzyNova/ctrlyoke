# Button Behavior Map

Comprehensive mapping of the 5 main UI buttons across all `ExecutionState` values.

**Buttons:**

1. **[Play/Restart]** — Header.tsx top-right, first icon button
2. **[Continue/Pause]** — Header.tsx top-right, second icon button
3. **[Stop]** — Header.tsx top-right, third icon button
4. **[Queue]** — EditorFooter.tsx, new-prompt mode (secondary action)
5. **[Run]** — EditorFooter.tsx, new-prompt mode (primary action)

All states assume `fileName !== null` (a workflow is loaded) and editor has content.

---

## Button Visual Appearance Per State

| State          | [Play/Restart]           | [Continue/Pause]         | [Stop]           |
| :------------- | :----------------------- | :----------------------- | :--------------- |
| **IDLE**       | ▶ Play icon, enabled     | ⏸ Pause icon, disabled   | ⏹ Stop, disabled |
| **RUNNING**    | ▶ Play icon, disabled    | ⏸ Pause icon, enabled    | ⏹ Stop, enabled  |
| **PAUSED**     | 🔁 Restart icon, enabled | ▶ Continue icon, enabled | ⏹ Stop, enabled  |
| **STOPPED**    | 🔁 Restart icon, enabled | ▶ Continue icon, enabled | ⏹ Stop, disabled |
| **CANCELLING** | ▶ Play icon, disabled    | ⏸ Pause icon, disabled   | ⏹ Stop, enabled  |
| **COMPLETED**  | 🔁 Restart icon, enabled | ⏸ Pause icon, disabled   | ⏹ Stop, disabled |
| **ERROR**      | ▶ Play icon, enabled     | ⏸ Pause icon, disabled   | ⏹ Stop, disabled |

### Appearance Logic (from Header.tsx)

- **isRerun** (restart icon): `COMPLETED || PAUSED || STOPPED` → shows `codicon-debug-restart`; otherwise `codicon-debug-start`
- **canRun**: `hasFile && !isCancelling && !(isRunning && !isCompleted && !isPaused && !isStopped)` — effectively enabled in all states except RUNNING and CANCELLING
- **canPause**: `isRunning && !isCancelling`
- **canResume**: `isPaused || isStopped`
- **canStop**: `isRunning || isPaused || isCancelling`

### Editor Footer Buttons

The **[Queue]** and **[Run]** buttons are always visible in new-prompt mode, always show the same icons, and are only disabled when the editor is empty (`!hasContent`). Their labels change:

| State                          | [Queue] label | [Run] label                      |
| :----------------------------- | :------------ | :------------------------------- |
| **IDLE** (no pending prompts)  | "Queue"       | "Run"                            |
| **IDLE** (has pending prompts) | "Queue"       | "Run Next"                       |
| **RUNNING**                    | "Queue"       | "Run Next"                       |
| **PAUSED**                     | "Queue"       | "Run Next"                       |
| **STOPPED**                    | "Queue"       | "Run Next"                       |
| **CANCELLING**                 | "Queue"       | "Run Next"                       |
| **COMPLETED**                  | "Queue"       | "Run Next" (if pending) or "Run" |
| **ERROR**                      | "Queue"       | "Run"                            |

`hasPendingPrompts()` checks if any prompt from `currentStep` onward has `PENDING` status.

---

## Detailed Behavior Per State

### IDLE

| Button               | Enabled | Sends                                                                                                                           | Extension Action                                                                                                                                                                                                                                                                        |
| :------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ✅      | `MESSAGE_TYPES.RUN`                                                                                                             | `WorkflowOrchestrator.executeLoadedPromptFile()` → Queue state is already IDLE, no restart needed → calls `startWorkflowExecution()` → begins executing from step 0                                                                                                                     |
| **[Continue/Pause]** | ❌      | —                                                                                                                               | —                                                                                                                                                                                                                                                                                       |
| **[Stop]**           | ❌      | —                                                                                                                               | —                                                                                                                                                                                                                                                                                       |
| **[Queue]**          | ✅      | `EXECUTE_PROMPT` action=`"queue"`                                                                                               | Calls `executeEphemeralPrompt()` → appends prompt to end of queue with `position=END`, `shouldRun=false` → prompt sits in queue, state stays IDLE                                                                                                                                       |
| **[Run]**            | ✅      | `EXECUTE_PROMPT` action=`"run"` → resolved to `"runBeforeCurrent"` (IDLE + currentStep=0) or `"runNext"` (IDLE + currentStep>0) | If no existing workflow: creates new workflow, calls `executeLoadedPromptFile()`. If existing workflow: appends prompt at `BEFORE_CURRENT` position (inserting before current index), then calls `executeLoadedPromptFile(undefined, true)` (continue from current) since state is IDLE |

### RUNNING

| Button               | Enabled    | Sends                                                                             | Extension Action                                                                                                                                                                                                                                                                                     |
| :------------------- | :--------- | :-------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ❌         | —                                                                                 | — (disabled because already running)                                                                                                                                                                                                                                                                 |
| **[Continue/Pause]** | ✅ (Pause) | `MESSAGE_TYPES.PAUSE`                                                             | `PromptQueue.pause()` → sets `status=PAUSED`, `isPaused=true`, records `pausedTime`. The `WorkflowExecutor` loop checks `isPaused` and will NOT send the next prompt when current one completes. Current prompt continues to completion.                                                             |
| **[Stop]**           | ✅         | `MESSAGE_TYPES.STOP`                                                              | `PromptQueue.stop()` → sets `status=CANCELLING`, marks SENT prompts as CANCELLED. Then calls `integration.cancel()` to kill the CLI process. Waits for `onResponseComplete` event → calls `confirmedStopped()` → sets `status=STOPPED`. 10s timeout fallback forces STOPPED if process doesn't exit. |
| **[Queue]**          | ✅         | `EXECUTE_PROMPT` action=`"queue"`                                                 | Appends to end of queue with `position=END`, `shouldRun=false`. Prompt will be picked up when executor reaches it.                                                                                                                                                                                   |
| **[Run]**            | ✅         | `EXECUTE_PROMPT` action=`"run"` → resolved to `"runNext"` (RUNNING + has pending) | Appends prompt at `NEXT` position (after current prompt). Since state is RUNNING, does NOT call `executeLoadedPromptFile()` again — the already-running executor loop will pick it up when it gets to that index.                                                                                    |

### PAUSED

| Button               | Enabled      | Sends                                                                            | Extension Action                                                                                                                                                                                                                                                                                                                                                                                          |
| :------------------- | :----------- | :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ✅ (Restart) | `MESSAGE_TYPES.RUN`                                                              | `executeLoadedPromptFile()` → sees `status=PAUSED` → calls `promptQueue.restart()` which resets ALL prompts to PENDING, sets currentIndex=0, clears all runtime data → then calls `startWorkflowExecution()` → begins fresh from step 0. **This discards all progress.**                                                                                                                                  |
| **[Continue/Pause]** | ✅ (Resume)  | `MESSAGE_TYPES.RESUME`                                                           | `PromptQueue.resume()` → calculates paused duration, sets `status=RUNNING`. Then `WorkflowInstance.resume()` checks: if `hasPendingResponse()` → resumes buffered response; if `isAwaitingResponse()` → waits for completion; otherwise calls `startWorkflowExecution()` to continue from current position. Current prompt already completed (PAUSED means prompt finished), so continues to next prompt. |
| **[Stop]**           | ✅           | `MESSAGE_TYPES.STOP`                                                             | `PromptQueue.stop()` → sets `status=CANCELLING`. Since no CLI process is actively running (current prompt already finished), `integration.cancel()` is called. `onResponseComplete` fires or 10s timeout → `confirmedStopped()` → `status=STOPPED`.                                                                                                                                                       |
| **[Queue]**          | ✅           | `EXECUTE_PROMPT` action=`"queue"`                                                | Appends to end of queue, `shouldRun=false`. State stays PAUSED. User can Resume later to process it.                                                                                                                                                                                                                                                                                                      |
| **[Run]**            | ✅           | `EXECUTE_PROMPT` action=`"run"` → resolved to `"runNext"` (PAUSED + has pending) | Appends prompt at `NEXT` position (after current). Since state is PAUSED, does NOT auto-start — the `executeEphemeralPrompt` code only calls `executeLoadedPromptFile` for IDLE/COMPLETED/STOPPED. User still needs to click Resume.                                                                                                                                                                      |

### STOPPED

| Button               | Enabled      | Sends                                                                          | Extension Action                                                                                                                                                                                                                                                                                                                        |
| :------------------- | :----------- | :----------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ✅ (Restart) | `MESSAGE_TYPES.RUN`                                                            | `executeLoadedPromptFile()` → sees `status=STOPPED` → calls `promptQueue.restart()` which resets ALL prompts to PENDING, currentIndex=0, clears runtime → calls `startWorkflowExecution()`. **Starts completely fresh from step 0, discarding all progress.**                                                                           |
| **[Continue/Pause]** | ✅ (Resume)  | `MESSAGE_TYPES.RESUME`                                                         | `PromptQueue.resume()` → resets the current (CANCELLED) prompt to PENDING, sets `status=RUNNING`. Then `WorkflowInstance.resume()` calls `startWorkflowExecution()` → executor restarts the cancelled prompt from the beginning. Progress on completed prompts is preserved.                                                            |
| **[Stop]**           | ❌           | —                                                                              | — (already stopped)                                                                                                                                                                                                                                                                                                                     |
| **[Queue]**          | ✅           | `EXECUTE_PROMPT` action=`"queue"`                                              | Appends to end of queue, `shouldRun=false`. State stays STOPPED.                                                                                                                                                                                                                                                                        |
| **[Run]**            | ✅           | `EXECUTE_PROMPT` action=`"run"` → resolved to `"runBeforeCurrent"` (isStopped) | Appends prompt at `BEFORE_CURRENT` position (inserts before the cancelled prompt). Since state is STOPPED, calls `executeLoadedPromptFile(undefined, true)` (continue from current). This triggers the workflow to restart from the current index — the newly-inserted prompt runs first, then the previously-cancelled prompt follows. |

### CANCELLING

| Button               | Enabled | Sends                | Extension Action                                                                                                                                                                                                          |
| :------------------- | :------ | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Play/Restart]**   | ❌      | —                    | — (disabled during cancellation)                                                                                                                                                                                          |
| **[Continue/Pause]** | ❌      | —                    | — (disabled during cancellation)                                                                                                                                                                                          |
| **[Stop]**           | ✅      | `MESSAGE_TYPES.STOP` | `PromptQueue.stop()` called again — re-entering stop. Sets `status=CANCELLING` again (already was). Calls `integration.cancel()` again. Useful as a "force stop" gesture or to confirm cancellation is still in progress. |
| **[Queue]**          | ❌      | —                    | `canAppend()` returns false for CANCELLING state, so `appendPrompts()` would throw. However, the button is still enabled in the UI — clicking it would trigger an error.                                                  |
| **[Run]**            | ❌      | —                    | Same as Queue — the button is enabled in UI but the backend would reject the append.                                                                                                                                      |

> **Note:** The Editor [Queue] and [Run] buttons don't check execution state for their disabled prop — they only check `hasContent`. So they appear enabled during CANCELLING, but the backend `canAppend()` check will reject and throw an error.

### COMPLETED

| Button               | Enabled      | Sends                                                                                        | Extension Action                                                                                                                                                                                                                                                                   |
| :------------------- | :----------- | :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ✅ (Restart) | `MESSAGE_TYPES.RUN`                                                                          | `executeLoadedPromptFile()` → sees `status=COMPLETED` → calls `promptQueue.restart()` → resets all to PENDING, starts fresh from step 0.                                                                                                                                           |
| **[Continue/Pause]** | ❌           | —                                                                                            | —                                                                                                                                                                                                                                                                                  |
| **[Stop]**           | ❌           | —                                                                                            | —                                                                                                                                                                                                                                                                                  |
| **[Queue]**          | ✅           | `EXECUTE_PROMPT` action=`"queue"`                                                            | `appendPrompts()` → since state is COMPLETED and `willRunImmediately=false`, automatically sets state to `STOPPED` (so user can Resume to run the new prompt). Prompt appended at END.                                                                                             |
| **[Run]**            | ✅           | `EXECUTE_PROMPT` action=`"run"` → resolved to `"runNext"` (has pending since newly appended) | Appends prompt at `NEXT` position with `willRunImmediately=true` (state stays COMPLETED, doesn't auto-flip to STOPPED). Then since `isCompleted=true`, calls `executeLoadedPromptFile(undefined, true)` → continues from current position, running only the newly added prompt(s). |

### ERROR

| Button               | Enabled | Sends               | Extension Action                                                                                                                     |
| :------------------- | :------ | :------------------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| **[Play/Restart]**   | ✅      | `MESSAGE_TYPES.RUN` | `executeLoadedPromptFile()` → sees `status=ERROR` → calls `promptQueue.restart()` → resets all to PENDING, starts fresh from step 0. |
| **[Continue/Pause]** | ❌      | —                   | —                                                                                                                                    |
| **[Stop]**           | ❌      | —                   | —                                                                                                                                    |
| **[Queue]**          | ❌      | —                   | `canAppend()` returns false for ERROR state, backend rejects. But button appears enabled in UI.                                      |
| **[Run]**            | ❌      | —                   | Same as Queue — backend rejects append in ERROR state.                                                                               |

---

## Message → Command → Method Call Chain

```
┌─────────────────────────┐
│  Webview Button Click   │
└───────────┬─────────────┘
            │ vscode.postMessage()
            ▼
┌─────────────────────────────────────┐
│  WebviewMessageRouter.route()       │
│  ├─ RUN       → flightpath.run     │
│  ├─ PAUSE     → flightpath.pause   │
│  ├─ RESUME    → flightpath.resume  │
│  ├─ STOP      → flightpath.stop    │
│  └─ EXECUTE_PROMPT → handleExecutePrompt() │
└───────────┬─────────────────────────┘
            │ vscode.commands.executeCommand() or direct call
            ▼
┌─────────────────────────────────────┐
│  WorkflowOrchestrator               │
│  ├─ .executeLoadedPromptFile()      │
│  ├─ .pause()                        │
│  ├─ .resume()                       │
│  ├─ .stop()                         │
│  └─ .executeEphemeralPrompt()       │
│       │ delegates to getActiveInstance()          │
└───────┼─────────────────────────────┘
        ▼
┌─────────────────────────────────────┐
│  WorkflowInstance                   │
│  ├─ .executeLoadedPromptFile()      │
│  │    └─ checks state → restart() or continue    │
│  │    └─ startWorkflowExecution()   │
│  ├─ .pause()  → promptQueue.pause()│
│  ├─ .resume() → promptQueue.resume() + startWorkflowExecution() │
│  ├─ .stop()   → promptQueue.stop() + integration.cancel() │
│  └─ .executeEphemeralPrompt()       │
│       └─ appendPrompts() + optionally executeLoadedPromptFile() │
└───────┼─────────────────────────────┘
        ▼
┌─────────────────────────────────────┐
│  PromptQueue (state machine)        │
│  ├─ .restart()  → IDLE, all PENDING │
│  ├─ .pause()    → PAUSED           │
│  ├─ .resume()   → RUNNING          │
│  ├─ .stop()     → CANCELLING       │
│  ├─ .confirmedStopped() → STOPPED  │
│  └─ .appendPrompts()               │
└─────────────────────────────────────┘
```

## Editor [Run] Action Resolution (PromptEditor.tsx)

When the user clicks the editor **[Run]** button, the action type is resolved based on the current execution state before being sent:

```
User clicks [Run] (action = "run")
  └─ hasPendingPrompts()?
      ├─ No  → finalAction = "run" (default, just append to end)
      └─ Yes → check execution state:
           ├─ STOPPED     → "runBeforeCurrent"  (insert before cancelled prompt)
           ├─ IDLE + step=0 → "runBeforeCurrent"  (insert at beginning)
           ├─ PAUSED      → "runNext"            (insert after current)
           ├─ RUNNING     → "runNext"            (insert after current)
           └─ else        → "runNext"            (insert after current)
```

When the user clicks **[Queue]**, no resolution happens — action stays `"queue"` which always appends to END.

## State Transitions Caused by Buttons

```
IDLE ──[Play]───────────────→ RUNNING
IDLE ──[Queue]──────────────→ IDLE (no state change)
IDLE ──[Run]────────────────→ RUNNING (if auto-starts)

RUNNING ──[Pause]───────────→ PAUSED
RUNNING ──[Stop]────────────→ CANCELLING → STOPPED (after process exits)
RUNNING ──[Queue]───────────→ RUNNING (no state change, prompt queued)
RUNNING ──[Run]─────────────→ RUNNING (no state change, prompt queued next)

PAUSED ──[Restart]──────────→ RUNNING (from step 0)
PAUSED ──[Resume]───────────→ RUNNING (from next step)
PAUSED ──[Stop]─────────────→ CANCELLING → STOPPED
PAUSED ──[Queue]────────────→ PAUSED (no state change)
PAUSED ──[Run]──────────────→ PAUSED (prompt queued, no auto-start)

STOPPED ──[Restart]─────────→ RUNNING (from step 0)
STOPPED ──[Resume]──────────→ RUNNING (restarts cancelled prompt)
STOPPED ──[Queue]───────────→ STOPPED (no state change)
STOPPED ──[Run]─────────────→ RUNNING (inserts before current, continues)

CANCELLING ──[Stop]─────────→ CANCELLING (re-sends cancel, no real effect)

COMPLETED ──[Restart]───────→ RUNNING (from step 0)
COMPLETED ──[Queue]─────────→ STOPPED (auto-transition, prompt appended)
COMPLETED ──[Run]───────────→ RUNNING (continues with new prompt)

ERROR ──[Restart]───────────→ RUNNING (from step 0)
```

## Known Issues / Observations

1. **PAUSED + [Run]**: Appends the prompt but does NOT auto-start. The user must still click Resume. This may be unintuitive — the button says "Run Next" implying it will run.

2. **CANCELLING + [Queue]/[Run]**: Editor buttons appear enabled (no execution state check on `disabled` prop), but `PromptQueue.canAppend()` returns `false` for CANCELLING. This causes an unhandled error.

3. **ERROR + [Queue]/[Run]**: Same issue as CANCELLING — buttons appear enabled but backend rejects.

4. **STOPPED + [Restart]**: Calls `restart()` which wipes ALL completed progress. The button title says "Restart from beginning" which is accurate, but may surprise users who expected Resume-like behavior.

5. **STOPPED + [Run]**: Inserts prompt BEFORE the cancelled prompt (`runBeforeCurrent`), then calls `executeLoadedPromptFile(undefined, true)`. This continues from current index, so the new prompt runs and then the previously-cancelled prompt will also re-run.
