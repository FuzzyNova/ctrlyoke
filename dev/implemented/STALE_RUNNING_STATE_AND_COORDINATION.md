# Stale RUNNING State & Extension–CLI Coordination

> **Status: Fully Implemented** (Phases 1, 2, 3 + CLI Watch Mode)
>
> Key files: `src/utils/WorkflowLockManager.ts`, `src/flightpath/WorkflowInstance.ts`,
> `src/flightpath/WorkflowOrchestrator.ts`, `src/ui/WorkflowSerializer.ts`,
> `src/flightpath/PromptQueue.ts`, `src/cli.ts`

---

## Problem Statement

When VS Code restarts after a workflow was interrupted mid-run (crash, force-quit, window close),
working files on disk retained `_runtime.executionState = "running"`. This caused two visible bugs:

1. **Dropdown showed stale RUNNING badges** — Workflows in the "Recent Workflows" section displayed
   a RUNNING badge even though nothing was executing.
2. **Selecting a stale RUNNING workflow auto-started it** — If any code path loaded the file without
   the `isAutoLoad=true` guard, the queue restored execution state as RUNNING and may have resumed
   automatically.

A secondary concern was coordinating between the VS Code extension and the FlightPath CLI, which
share the same `.flightpath/.queue/` directory — so a blindly applied normalization would corrupt
the state of a genuinely CLI-driven workflow.

---

## Root Cause Analysis

### Root Cause 1: `handleGetRecentWorkflows` read raw disk state

`WorkflowSerializer.handleGetRecentWorkflows()` scanned `.flightpath/.queue/*.flightpath.json`,
read `_runtime.executionState` verbatim, and sent it to the webview. No normalization.

### Root Cause 2: Existing guard only applied to in-memory loads

`PromptQueue.loadWorkingFileIntoState(isAutoLoad=true)` converted RUNNING→PAUSED in memory.
The disk file was not updated and PAUSED was semantically wrong (implies intentional user action).
STOPPED is correct: it preserves run position (per-prompt `_runtime.completedAt` intact),
signals the workflow was aborted, and allows resuming from the current prompt.

### Root Cause 3: No coordination between VS Code and CLI

Both the VS Code extension and the FlightPath CLI can run workflows sharing the same
`.flightpath/.queue/` directory. There was no mechanism to distinguish a genuinely CLI-running
workflow from a stale crash remnant.

---

## Implementation

### Phase 1 — Immediate fix (stale RUNNING state)

All three items are implemented:

1. **`WorkflowSerializer.handleGetRecentWorkflows`** (`src/ui/WorkflowSerializer.ts`):
   When `_runtime.executionState === "running"` and the workflow is not in any active in-memory
   `WorkflowInstance`, the state is reported as `"stopped"` to the webview without touching disk.
   A check against the lock file bridges the timing gap where a genuinely CLI-active workflow's
   watcher event hasn't fired yet — those are kept as `"running"`.

2. **`PromptQueue.loadWorkingFileIntoState`** (`src/flightpath/PromptQueue.ts`):
   When `isAutoLoad=true` and state is `RUNNING`, it is forced to `STOPPED` (not `PAUSED`).
   The normalized state is immediately persisted to the disk working file so future
   `handleGetRecentWorkflows` reads see the correct state.

3. **Startup normalization scan** (`WorkflowOrchestrator.setupCliWatching`):
   On extension activation, before auto-loading workflows, `WorkflowLockManager.normalizeStaleLocks`
   scans `.queue/*.flightpath.json`. Any file with `executionState === "running"` and a stale or
   absent lock is atomically written to `"stopped"` on disk. Files with an `active-cli` lock are
   preserved and registered as CLI Watch Sessions instead.

### Phase 2 — Process lock file coordination

Implemented in `src/utils/WorkflowLockManager.ts`. Lock files live at
`.flightpath/.queue/{workflowId}.runner.json` alongside working files.

#### Lock file format

```json
{
  "runner": "vscode",
  "pid": 12345,
  "startedAt": 1700000000000,
  "lastHeartbeat": 1700000005000,
  "instanceId": "uuid-v4",
  "workflowId": "uuid-v4"
}
```

`WorkflowRunnerLock` is defined in `src/types/FlightPathTypes.ts`.

#### WorkflowLockManager API

| Method                               | Description                                                    |
| ------------------------------------ | -------------------------------------------------------------- |
| `acquireLock(workingFilePath, lock)` | Writes lock atomically via `.tmp` → rename                     |
| `releaseLock(workingFilePath)`       | Deletes lock; swallows ENOENT                                  |
| `updateHeartbeat(workingFilePath)`   | Updates `lastHeartbeat` atomically                             |
| `readLock(workingFilePath)`          | Returns lock data or null                                      |
| `checkLock(workingFilePath)`         | Returns `"none" \| "stale" \| "active-vscode" \| "active-cli"` |
| `normalizeStaleLocks(queueDir)`      | Startup scan; returns active-CLI paths                         |
| `getLockPath(workingFilePath)`       | Derives `*.runner.json` path from `*.flightpath.json`          |

Staleness criteria: PID is dead (`process.kill(pid, 0)` throws `ESRCH`) **or** `lastHeartbeat`
is more than 30 seconds old (guards against PID recycling).

All writes use atomic `.tmp` → `rename` to prevent partial reads.

#### VS Code extension integration (`WorkflowInstance.ts`)

- `startWorkflowExecution` calls `acquireLock` with `{ runner: "vscode", pid: process.pid, ... }`.
- A `setInterval` every 5 seconds calls `updateHeartbeat`.
- The execution `finally` block clears the interval and calls `releaseLock`.
- `WorkflowInstance.dispose()` also clears the heartbeat interval; the `WorkflowOrchestrator`
  dispose path clears all locks on normal VS Code close via `deactivate()`.

#### CLI integration (`src/cli.ts`)

- Calls `acquireLock` with `{ runner: "cli", pid: process.pid, ... }` before execution begins.
- Starts a heartbeat interval.
- `process.on("exit")` / `SIGINT` / `SIGTERM` handlers call `releaseLock` and write STOPPED.
- Crash path is covered by staleness detection on next startup.

### Phase 3 — Heartbeat (PID recycling guard)

Built into Phase 2. The 30-second `lastHeartbeat` staleness threshold closes the PID-recycling
gap: even if a new process reuses the same PID, it won't write to the lock file, so the heartbeat
goes stale and the lock is treated as stale.

### CLI Watch Mode (Q4 scenario)

When `normalizeStaleLocks` returns an `active-cli` path, or when a new `*.runner.json` is created
while VS Code is already open, a **CLI Watch Session** is registered in `WorkflowOrchestrator`:

- `cliSessions: Map<string, CliWatchSessionEntry>` holds the per-workflow watch state.
- `setupRunnerJsonCreateWatcher` uses `vscode.workspace.createFileSystemWatcher` to detect new
  `.runner.json` files (Entry Point 3 — CLI starts workflow while VS Code is open).
- `ensureCliWatchSession(workingFilePath)` bridges the timing gap in `handleGetRecentWorkflows`
  (Entry Point 2 — user selects recently-ran CLI workflow from dropdown before watcher fires).
- `stopCliSession(workflowId)` sends SIGTERM to the CLI process via the PID in the lock file.

---

## Startup Classification Logic (summary)

For each working file with `executionState === "running"` on extension startup:

```
Lock file absent / parse error    → normalize to STOPPED
  runner === "vscode"             → can't be us (we just started) → normalize to STOPPED
  runner === "cli"
    pidAlive AND heartbeat fresh  → active-cli → register CLI Watch Session
    pidAlive=false OR stale hb    → normalize to STOPPED
```

---

## Why STOPPED (not IDLE or PAUSED)

| State     | Meaning                                      | Correct?                           |
| --------- | -------------------------------------------- | ---------------------------------- |
| `idle`    | Never started                                | ❌ Erases run context              |
| `paused`  | User intentionally paused                    | ❌ Misleading for a crash scenario |
| `stopped` | Aborted; position preserved; user can resume | ✅                                 |

STOPPED preserves per-prompt `_runtime.completedAt` so the user can see progress and resume
from the current prompt. It maps exactly to "VS Code was closed while this was running."
