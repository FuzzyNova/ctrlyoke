# Prompt file watcher misses appends while pausing

- **Found:** 2026-11-08 by smell hunt pass 6
- **Area:** `src/core/orchestration/PromptFileWatcher.ts`
- **Resolution:** fixed in this commit

## Symptom

An MCP append written while a workflow is PAUSING is not reloaded into the live
queue, so the executor can finish pausing without seeing the appended step.

## Steps to Reproduce

1. Start a workflow and request pause while its current step is still running.
2. Append a step through MCP before the current step exits.
3. Observe that the working file changes but the live queue does not reload.

## Root Cause

`PromptFileWatcher.onFileChanged` checked RUNNING, PAUSED, and CANCELLING
explicitly, leaving out PAUSING even though the executor still owns the queue
and the current step may still append work.

## Resolution

The watcher now uses `ACTIVE_EXECUTION_STATES`, and a regression test verifies
that a PAUSING working-file change reloads the queue.
