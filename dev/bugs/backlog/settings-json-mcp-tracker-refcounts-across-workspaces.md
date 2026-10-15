# SettingsJsonMcpTracker ref-counts servers by name across all workspaces, leaking entries (and secrets) into another checkout's config

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/SettingsJsonMcpTracker.ts`
- **Severity:** medium

## Symptom

Two Antigravity workflows overlap in different execution roots: the main checkout and a managed worktree. Afterwards the main checkout's `.agents/mcp_config.json` still holds a stale ctrlyoke MCP entry. It may also hold user MCP server entries with resolved secret `env`/`headers`. ctrlyoke never removes that entry. The temporary `.agents/.gitignore` that hid the file has been deleted, so the file now shows up as untracked and can be committed. The worktree's config file was never git-ignored at any point while it existed.

## Steps to Reproduce

1. Make sure `/a` has no `.agents/mcp_config.json` and no `.agents/.gitignore`. Use the `antigravity-cli` harness with MCP enabled.
2. Start workflow A in the main checkout `/a`. `registerServers` sets `refCounts.ctrlyoke=1`, writes `/a/.agents/mcp_config.json` and creates `/a/.agents/.gitignore` (`gitignorePath=/a/.agents/.gitignore`).
3. While A is still running, start workflow B in a managed worktree `/b`. `refCounts.ctrlyoke` becomes 2. `/b/.agents/mcp_config.json` is written and `managedServerValues.ctrlyoke` is overwritten with B's entry. `writeGitignore` returns early because `gitignorePath` is already set, so `/b` gets no `.gitignore`.
4. Let A finish. `unregisterWorkflow(A, /a)` drops the count to 1. Nothing is removed from `/a`, and the `.gitignore` stays.
5. Let B finish. `unregisterWorkflow(B, /b)` drops the count to 0. `/b`'s entry matches `managedServerValues`, so it is removed and `/b`'s file is unlinked. `refCounts` is now empty and `/b` had no baseline file, so `deleteCtrlYokeGitignore` deletes `/a/.agents/.gitignore`.
6. Run `git status` in `/a`. `.agents/mcp_config.json` is untracked and still holds A's ctrlyoke entry. Later Antigravity runs in `/a` never remove it, and after a restart the baseline treats it as user-configured.

## Root Cause

The tracker is a singleton for the whole process. `AntigravityCliProvider.ts:102` holds it as a static `mcpTracker`, and `SettingsJsonMcpTracker.ts:208-218` creates one instance per tool name. Its `baselines` are keyed per config path (line 248), but the rest of its lifecycle state is global:

- `refCounts` (line 254) is keyed by server name only.
- `managedServerValues` (line 260) is keyed by server name only, and each insert overwrites it (line 452).
- `gitignorePath` (line 251) holds a single value.

`unregisterWorkflow` (lines 509-524) decrements the global count. When that count reaches 0, it edits only the unregistering workflow's file (lines 529-571), so the other root's entry is left orphaned. The value comparison (lines 540-545) also fails for that orphan, because `managedServerValues` holds the other root's value.

The gitignore handling has the same flaw. `writeGitignore` (lines 752-755) skips any second root. `deleteCtrlYokeGitignore` runs when the global count hits 0 (lines 573-579, 776-791), so it deletes the first root's `.gitignore` while that root's config file is still on disk. `writeOrRemoveManagedConfig`'s `hasManagedState` (line 717) also checks the global `refCounts` rather than the count for the path it is writing.

## Suggested Fix

Key all lifecycle state by the resolved config path, as `baselines` already is:

- `refCounts`: `Map<settingsPath, Map<serverName, number>>`
- `managedServerValues`: `Map<settingsPath, Map<serverName, unknown>>`
- `gitignorePath`: `Map<settingsPath, string>`
- `workflowServers`: record the `settingsPath` alongside the server names, so unregistration uses the stored path even if the caller passes a different root.

In `unregisterWorkflow`, decrement, remove and check emptiness against that path's map only. Base `writeOrRemoveManagedConfig`'s `hasManagedState` on that path's map, and call `deleteCtrlYokeGitignore` for that path only once its count map is empty.

Add a unit test in which two workflows in two roots register and unregister in interleaved order. Once both have finished, it should assert that both config files and both temporary `.gitignore` files are gone.
