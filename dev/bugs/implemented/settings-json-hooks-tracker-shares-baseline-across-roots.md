# SettingsJsonHooksTracker uses one baseline for every workspace root, so another root's hooks are overwritten and leftover hooks are restored

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/SettingsJsonHooksTracker.ts`
- **Resolution:** fixed in this commit

## Symptom

When two Qwen workflows run at once in different execution roots (the main checkout and a managed worktree, or two worktrees), each root's `.qwen/settings.json` gets the other root's hooks. After both runs finish, the root that finished last has its hooks section replaced with the first root's original hooks, and its own user hooks are permanently lost. The root that finished first keeps the other workflow's ctrlyoke hook groups. Those groups point at another root's notify directory and stay in the file indefinitely.

If neither root had a `.qwen/settings.json` to begin with, the file created in the second root is never deleted. The temporary `.gitignore` is only written, and only removed, in the first root.

## Steps to Reproduce

1. In checkout `/a`, create `.qwen/settings.json` with a user hooks section `H_a` (for example a Stop hook running `echo a`).
2. In a managed worktree `/b`, create `.qwen/settings.json` with a different hooks section `H_b` (for example `echo b`).
3. Start Qwen workflow A, which executes in `/a`. The tracker reads `H_a` as its single baseline and writes A's hooks plus `H_a` to `/a`.
4. While A is still running, start Qwen workflow B, which executes in `/b`. Because `workflowHooks.size` is 1, B's baseline is never read, and `/b` is rewritten as A's hooks plus B's hooks plus `H_a`. `H_b` is no longer in the file.
5. Let A finish. `cleanupWorkspaceArtifacts('/a')` sees that one workflow is still registered and rebuilds `/a` as B's ctrlyoke hooks plus `H_a`.
6. Let B finish. The size is now 0, so `restoreBaseline` writes `H_a` into `/b/.qwen/settings.json`.
7. Result: `/b` has permanently lost `H_b` and now contains `H_a`, and `/a` still contains B's stale ctrlyoke hook groups.

## Root Cause

`SettingsJsonHooksTracker` keeps one instance per tool name (`instances` map, line 28; `getInstance`, lines 66-73). That instance is shared by every workspace root in the process, but all of its baseline state is a single set of values:

- Lines 31-46: `baselineHooksSection`, `baselineFileExisted`, `baselineDirExisted` and `gitignorePath` are single scalar fields. They are not keyed by settings path.
- Lines 108-116: the baseline is captured only when `workflowHooks.size === 0`. A workflow that registers later in a different root never has its own baseline read.
- Lines 119-122: `workflowHooks` does not record which root each workflow belongs to.
- Lines 282-311: `rebuildAndWriteSettings` merges the hooks of every active workflow with the single baseline, then writes the result to whatever `settingsPath` the caller passed.
- Lines 153-158 and 325-365: `restoreBaseline` writes the single baseline into whichever root the last unregister names.
- Lines 128-129: the `.gitignore` is written only for the first root.

The roots really are different. `QwenCliProvider.ts` registers hooks (lines 523-539) and unregisters them (lines 755-763) using the workflow's execution root. That root comes from `CliIntegration.getExecutionRoot()` (`CliIntegration.ts:326`, `executionWorkspace.executionRoot`). It reaches the provider through the `ExecutionPlanBuilder` deps (`CliIntegration.ts:1022`, read at `ExecutionPlanBuilder.ts:108`) and through `cleanupWorkflowArtifacts` (`CliIntegration.ts:2086`).

A contributing factor is that the tracker serializes only with an in-process `AsyncMutex` (lines 52, 81-88). Unlike `SettingsJsonMcpTracker`, it has no `withFileLock`. Two ctrlyoke processes in the same root, such as a VS Code window and the standalone CLI, can therefore each record the other's injected hooks as their own baseline.

## Suggested Fix

Give the tracker per-settings-path state, the way `SettingsJsonMcpTracker` keeps its baselines:

- Store `workflowHooks` as `Map<workflowKey, { settingsPath, layers }>`.
- Keep baselines in `Map<resolvedSettingsPath, { hooks, fileExisted, dirExisted, gitignorePath }>`.
- Capture a root's baseline the first time any workflow registers for that settings path.
- Rebuild a path only from the workflows registered for that same path.
- When the last workflow for a path unregisters, restore that path's baseline and then delete it from the map.
- Wrap register, rebuild and restore in `withFileLock(settingsPath, ...)` so that concurrent ctrlyoke processes cannot capture each other's injected hooks.
- Have Qwen pass a `discardHookGroup` policy that recognizes ctrlyoke's own notify-hook groups, so groups left behind by a crashed run are not taken in as baseline.

Add tests for:

- two roots registered at the same time with different user hooks,
- unregistering in either order,
- a root that had no settings file at first.
