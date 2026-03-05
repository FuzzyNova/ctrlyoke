# Stale RUNNING State & Extension–CLI Coordination Plan

## Problem Statement

When VS Code restarts after a workflow was interrupted mid-run (crash, force-quit, window close),
working files on disk retain `_runtime.executionState = "running"`. This causes two visible bugs:

1. **Dropdown shows stale RUNNING badges** — Workflows in the "Recent Workflows" section display
   a RUNNING badge even though nothing is executing.
2. **Selecting a stale RUNNING workflow auto-starts it** — If any code path loads the file without
   the `isAutoLoad=true` guard, the queue restores execution state as RUNNING and may resume
   automatically.

---

## Root Cause Analysis

### Root Cause 1: `handleGetRecentWorkflows` reads raw disk state

`WorkflowSerializer.handleGetRecentWorkflows()` scans `.flightpath/.queue/*.flightpath.json`,
reads `_runtime.executionState` verbatim, and sends it to the webview. No normalization.

```
Disk file: { _runtime: { executionState: "running" } }
                     ↓
  RECENT_WORKFLOWS message: { executionState: "running" }
                     ↓
  Dropdown badge: [RUNNING]  ← stale, wrong
```

### Root Cause 2: Existing guard only applies to in-memory loads

`PromptQueue.loadWorkingFileIntoState(isAutoLoad=true)` converts RUNNING→PAUSED in memory.
This guard works for workflows auto-restored into `loadedWorkflows`, but:
- The disk file is **not updated** — still says "running" for future `handleGetRecentWorkflows` calls.
- PAUSED is semantically wrong for a crashed/closed workflow — it implies the user intentionally paused.
- STOPPED is the correct state: it preserves run position (per-prompt `_runtime.completedAt` intact),
  signals the workflow was aborted, and allows resuming from the current prompt or inspecting progress.

### Root Cause 3: No coordination between VS Code and CLI

Both the VS Code extension and the FlightPath CLI can run workflows sharing the same
`.flightpath/.queue/` directory. There is currently no mechanism to distinguish:

- "This workflow is truly running right now (by CLI)" vs.
- "This workflow was running when VS Code crashed and the CLI is not involved."

If we blindly normalize all RUNNING→IDLE on startup, we corrupt the state of a genuinely
CLI-driven workflow.

---

## Scenarios to Handle

| Scenario | Current Behavior | Desired Behavior |
|---|---|---|
| VS Code closed while workflow was running (no CLI) | File shows RUNNING; dropdown shows RUNNING badge | Normalize to STOPPED on next load |
| VS Code extension crash mid-run | Same as above | Normalize to STOPPED on next load |
| CLI is actively running a workflow, user opens VS Code | File shows RUNNING (correctly) | Preserve RUNNING; show as active |
| CLI was running, crashed, then VS Code opens | File shows RUNNING (stale) | Normalize to STOPPED on next load |
| Both VS Code and CLI run different workflows in same workspace | No conflict (separate queue files per workflow) | Continue as-is; lock per-workflow |
| User closes VS Code; reopens it; workflow was PAUSED | File shows PAUSED (correct) | Preserve PAUSED; show in dropdown with option to resume |

---

## Proposed Solutions

### Option A: Normalize RUNNING→STOPPED on extension startup (immediate fix)

**What**: On extension activation, scan `.flightpath/.queue/`, read each working file, and if
`_runtime.executionState === "running"` with no active in-memory workflow, write `"stopped"` to disk.

**Also fix `handleGetRecentWorkflows`**: Normalize the returned `executionState` from "running" to
"stopped" at read time when there is no corresponding loaded workflow in memory.

**Why STOPPED and not IDLE**: STOPPED preserves run position — per-prompt `_runtime.completedAt`
remains intact so the user can see how far the workflow got and resume from the current prompt.
IDLE implies the workflow was never started, which is false and loses that context.

**Pros**: Simple, fixes the immediate UI bug, no new files, preserves progress visibility.
**Cons**: Cannot distinguish "genuinely running via CLI" from "stale RUNNING". Falsely normalizes
CLI-driven workflows.

**Verdict**: Correct for Phase 1 (single-agent, no CLI coordination). Not safe long-term.

---

### Option B: Process lock file (recommended — Phase 2)

**What**: When any runner (VS Code or CLI) starts executing a workflow, it writes a lock file
alongside the working file in `.flightpath/.queue/`:

```
.flightpath/.queue/{workflowId}.runner.json
```

Content:
```json
{
  "runner": "vscode",           // or "cli"
  "pid": 12345,                 // OS process ID of the runner process
  "startedAt": 1700000000000,  // Unix ms — when execution started
  "lastHeartbeat": 1700000005000, // Unix ms — updated every 5s while running
  "instanceId": "uuid-v4",     // unique ID generated at extension activation
  "workflowId": "uuid-v4"      // matches WorkflowInstance.id
}
```

#### Which PID to record

For the VS Code extension: `process.pid` inside the extension gives the **Extension Host** process
ID — the dedicated Node.js subprocess that VS Code spawns to run all extensions. This is the right
PID to record because:
- It is the process that owns the `WorkflowInstance` and the running CLI child process.
- When VS Code crashes (hard kill, OOM, force-quit), the Extension Host is killed with it.
- When VS Code closes normally, `deactivate()` runs in the Extension Host before it exits.

For the CLI: `process.pid` gives the CLI process itself.

#### How staleness is detected

**Normal close path** (VS Code window closed, VS Code gracefully shut down):
1. VS Code calls each extension's `deactivate()` before terminating the Extension Host.
2. `deactivate()` calls `WorkflowOrchestrator.dispose()`.
3. We add `releaseLock()` to the dispose path → lock file is deleted.
4. We also write `executionState = "stopped"` to the working file.
5. Next startup: working file already says "stopped", no lock file. Nothing to do. ✓

**Crash path** (Extension Host killed without `deactivate()`, VS Code force-quit, OOM):
1. `deactivate()` is **not called** — the process is dead.
2. Lock file persists on disk with the dead PID.
3. Next VS Code startup reads the lock file and calls:
   ```typescript
   function isPidAlive(pid: number): boolean {
     try {
       process.kill(pid, 0); // signal 0 = probe only, does not kill
       return true;
     } catch (e: any) {
       // ESRCH = "No such process" → dead
       // EPERM = "Not permitted" → alive but owned by different user (treat as alive)
       return (e as NodeJS.ErrnoException).code !== "ESRCH";
     }
   }
   ```
4. `process.kill(pid, 0)` throws `ESRCH` → PID is dead → lock is stale → normalize to STOPPED. ✓

**Cross-platform behavior of `process.kill(pid, 0)`**:
- **Linux/macOS**: Sends POSIX signal 0. The kernel checks if the process exists and the caller
  has permission. Throws `ESRCH` if the PID doesn't exist.
- **Windows**: Node.js implements this via `OpenProcess(PROCESS_QUERY_INFORMATION)`. No Unix
  signals are involved. Throws `ESRCH` if the PID is gone. Same API, same semantics.

#### Startup classification logic

For each working file with `_runtime.executionState === "running"` on extension startup:

```
1. Look for {workflowId}.runner.json
   │
   ├─ No lock file found
   │     → stale (VS Code crashed before lock was written, or lock was deleted)
   │     → normalize to STOPPED
   │
   └─ Lock file found
         │
         ├─ runner === "vscode"
         │     │
         │     ├─ isPidAlive(pid) AND lastHeartbeat fresh (< 30s ago)
         │     │     → another VS Code window has it (rare but possible in multi-root)
         │     │     → normalize to STOPPED, show warning
         │     │
         │     └─ isPidAlive(pid) is false OR lastHeartbeat stale
         │           → crash/close; this session can't be it (we just started)
         │           → normalize to STOPPED
         │
         └─ runner === "cli"
               │
               ├─ isPidAlive(pid) AND lastHeartbeat fresh (< 30s ago)
               │     → CLI is genuinely running this workflow right now
               │     → preserve RUNNING; show as externally managed in dropdown
               │
               └─ isPidAlive(pid) is false OR lastHeartbeat stale
                     → CLI crashed; normalize to STOPPED
```

#### The PID recycling edge case

Modern OSes recycle PIDs after the process dies. On Linux the PID namespace wraps at 32768 by
default; on Windows it wraps at ~4M. In practice recycling within the seconds between a crash and
VS Code restarting is extremely unlikely. The `lastHeartbeat` field closes this gap: even if a new
process inherits the exact same PID, it won't be writing to our lock file, so `lastHeartbeat` will
be stale (> 30s old) and we correctly call it stale.

**Pros**: Correctly identifies genuinely-running CLI workflows. Clean crash detection. Works on
Windows and Unix. Heartbeat guards against PID recycling.
**Cons**: Requires both VS Code and CLI to write and manage lock files consistently. Lock file
needs to be written atomically (write to temp path, then rename) to avoid partial reads.

#### Atomic lock file writes

To prevent a reader from seeing a half-written file during startup, write to a `.tmp` path first:

```typescript
async function acquireLock(lockPath: string, lock: WorkflowRunnerLock): Promise<void> {
  const tmp = lockPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(lock, null, 2), "utf8");
  await fs.rename(tmp, lockPath); // atomic on same filesystem
}
```

---

## Recommended Implementation Plan

### Phase 1 — Fix the immediate UI bug (no lock files)

**Goal**: Stop showing stale RUNNING badges in the dropdown. Unblock users now.

1. **Fix `handleGetRecentWorkflows`** in `WorkflowSerializer.ts`:
   When reading `_runtime.executionState` from disk, if the value is `"running"` and the workflow
   is not currently in any active `WorkflowInstance`, replace with `"stopped"` before sending to
   webview. This ensures the dropdown shows the correct badge without touching the disk file.

2. **Fix `PromptQueue.loadWorkingFileIntoState`**:
   When `isAutoLoad=true` and state is forced away from RUNNING, transition to `STOPPED` (not PAUSED).
   Also **persist** this normalized state back to the disk working file immediately, so future
   `handleGetRecentWorkflows` reads see the correct state.
   - STOPPED correctly reflects "aborted mid-run, position preserved" — the user can see progress
     and resume from the current prompt. PAUSED implies intentional user action; IDLE implies
     the workflow never ran.

3. **Add startup normalization scan** in `WorkflowOrchestrator` or extension activation:
   On activate, before loading workflows into memory, scan `.queue/*.flightpath.json` for any
   `_runtime.executionState === "running"` and write `_runtime.executionState = "stopped"` to disk.
   (Safe for Phase 1 since we have no CLI coordination yet.)

### Phase 2 — Process lock file coordination

**Goal**: Preserve RUNNING state when CLI is genuinely executing a workflow.

1. **Define lock type** in `src/types/FlightPathTypes.ts`:
   ```typescript
   export interface WorkflowRunnerLock {
     runner: "vscode" | "cli";
     pid: number;          // process.pid of the Extension Host (vscode) or CLI process
     startedAt: number;    // Unix ms
     lastHeartbeat: number; // Unix ms — updated every 5s; used for PID-recycling guard
     instanceId: string;   // UUID generated once at extension activation (vscode) or CLI startup
     workflowId: string;   // WorkflowInstance.id
   }
   ```

2. **Add `WorkflowLockManager`** (`src/utils/WorkflowLockManager.ts`):
   ```typescript
   // Lock path convention: {workflowId}.runner.json alongside the working file
   acquireLock(workingFilePath: string, lock: WorkflowRunnerLock): Promise<void>
   // Writes atomically via .tmp → rename

   releaseLock(workingFilePath: string): Promise<void>
   // Deletes lock file; swallows ENOENT

   updateHeartbeat(workingFilePath: string): Promise<void>
   // Reads lock, updates lastHeartbeat, writes atomically

   checkLock(workingFilePath: string): Promise<LockStatus>
   // "none" | "stale" | "active-vscode" | "active-cli"
   // Reads lock file; checks isPidAlive(pid) AND lastHeartbeat < 30s

   normalizeStaleLocks(queueDir: string, updateWorkingFile: (path, state) => Promise<void>): Promise<void>
   // Iterates *.runner.json; for each stale/none, writes "stopped" to working file and deletes lock
   ```

3. **VS Code extension — acquisition**:
   - Generate `instanceId = crypto.randomUUID()` once in `extension.ts` at activation.
   - In `WorkflowInstance.startWorkflowExecution()`: call `acquireLock` with
     `{ runner: "vscode", pid: process.pid, instanceId, workflowId: this.id, ... }`.
   - Start a `setInterval` every 5 seconds calling `updateHeartbeat`.
   - In the execution `finally` block: clear the interval, call `releaseLock`, write STOPPED to
     working file (normal stop path already does this; crash path is covered by staleness detection).

4. **VS Code extension — release on dispose**:
   - `WorkflowOrchestrator.dispose()` → `WorkflowInstance.dispose()` → calls `releaseLock` and
     writes STOPPED to disk. This covers normal VS Code window close.

5. **CLI** (`src/cli.ts`):
   - Generate `instanceId = crypto.randomUUID()` at startup.
   - Call `acquireLock` with `{ runner: "cli", pid: process.pid, instanceId, workflowId, ... }`.
   - Start heartbeat interval.
   - Register `process.on("exit")` / `process.on("SIGINT")` / `process.on("SIGTERM")` to call
     `releaseLock` and write STOPPED on clean exit. Crash path covered by staleness detection.

6. **On extension startup**: call `normalizeStaleLocks(queueDir, ...)` before auto-loading any
   workflows. This ensures working files are STOPPED before `loadWorkingFileIntoState` runs.

### Phase 3 — Heartbeat is included in Phase 2

The `lastHeartbeat` field is already part of the Phase 2 lock format. The 5-second heartbeat
interval is established when `acquireLock` is called and cleared when `releaseLock` is called.
No separate phase needed — PID recycling guard is built in from day one.

---

## Edge Cases & Open Questions

### Q1: What state should a crashed/closed workflow show?

**STOPPED** — already an existing state defined as _"Execution aborted, state preserved, can resume
from current prompt."_ This is exactly right:
- Per-prompt `_runtime.completedAt` is preserved, so the user can see how far the workflow got.
- The workflow appears in the dropdown with a STOPPED badge (not RUNNING, not IDLE).
- The user can resume from the current prompt or inspect which prompts completed.
- No new state enum value required.

IDLE was considered but rejected: it implies the workflow was never started, erasing run context.
PAUSED was rejected: it implies the user deliberately paused, which is semantically misleading.

### Q2: What happens when the user clicks a stale-RUNNING workflow in the dropdown?

Currently: loads and may auto-start.
After Phase 1: shows as STOPPED; user must explicitly resume; it will restart the current prompt
(since `_runtime.completedAt` per-prompt is the source of truth — completed prompts are skipped).

### Q3: CLI and VS Code running different workflows in the same workspace

This is already safe — each workflow has its own queue file. Lock files are per-workflow.
No cross-workflow locking needed.

### Q4: CLI running a workflow the user then tries to open in VS Code

After Phase 2: `normalizeStaleLocks` classifies the lock as `active-cli`. Instead of normalizing
to STOPPED, the extension loads the workflow in **CLI Watch Mode** — a read-only view that mirrors
live progress from the CLI's history file and working file updates:

- `WorkflowSummary` gains a `managedBy?: "vscode" | "cli"` field.
- The dropdown shows a "CLI" pill badge instead of pause/stop controls.
- The main panel shows a banner: "Running via FlightPath CLI — controls disabled."
- Output updates live by watching `.flightpath/.history/{workflowId}/run-*.json` for changes.
- When the CLI finishes and deletes the lock file, VS Code detects the deletion, re-reads the
  working file state, and transitions the webview out of watch mode.

Full implementation details: see `docs/research/CLI_WATCH_MODE_PLAN.md`.

### Q5: What if the lock file itself is corrupted?

Treat as "no lock file" → normalize to STOPPED. Safe default.

---

## Files to Modify (Phase 1)

| File | Change |
|---|---|
| `src/ui/WorkflowSerializer.ts` | In `handleGetRecentWorkflows`, normalize RUNNING→STOPPED when no matching active instance |
| `src/flightpath/PromptQueue.ts` | In `loadWorkingFileIntoState`, transition to STOPPED (not PAUSED) and persist to disk when `isAutoLoad=true` forces away from RUNNING |
| `src/flightpath/WorkflowOrchestrator.ts` or `src/extension.ts` | Add startup scan: normalize RUNNING→STOPPED for all queue files before loading |

## Files to Add/Modify (Phase 2)

| File | Change |
|---|---|
| `src/utils/WorkflowLockManager.ts` | New: atomic lock CRUD, PID probe, heartbeat, startup normalization |
| `src/types/FlightPathTypes.ts` | Add `WorkflowRunnerLock` interface |
| `src/extension.ts` | Generate `instanceId` at activation; pass to orchestrator |
| `src/flightpath/WorkflowInstance.ts` | `acquireLock` on start, `releaseLock` in finally + dispose; heartbeat interval |
| `src/flightpath/WorkflowOrchestrator.ts` | Call `normalizeStaleLocks` during activation before auto-loading |
| `src/cli.ts` | `acquireLock` on start, `releaseLock` on exit/signal; heartbeat interval |

---

## Summary

The immediate fix (Phase 1) is:
1. Normalize RUNNING→STOPPED in `handleGetRecentWorkflows` when no matching loaded workflow.
2. Persist the normalized state to disk in `PromptQueue.loadWorkingFileIntoState` (STOPPED not PAUSED).
3. Add an on-startup scan that normalizes any remaining stale RUNNING files to STOPPED before loading.

STOPPED is the right state because it preserves per-prompt run progress, signals the workflow was
aborted, and allows the user to resume from the current prompt — matching the "VS Code was closed"
scenario exactly. IDLE was rejected (implies never ran); PAUSED was rejected (implies user intent).

The longer-term fix (Phase 2) adds process lock files so the extension correctly identifies
CLI-driven workflows as genuinely RUNNING rather than stale, enabling safe extension–CLI coexistence.
