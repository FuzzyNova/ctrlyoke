# Workflow user hooks go into the machine-global agy hooks.json and stay there forever if cleanup never runs

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/antigravity/AntigravityCliProvider.ts`
- **Severity:** medium

Category: bug

## Symptom

If an Antigravity workflow run ends abnormally (extension host crash or kill, VS Code force-close, CLI SIGKILL), its `ctrlyoke-<hash>` hook group stays in `~/.gemini/config/hooks.json` indefinitely. From then on, every `agy` session on the machine, in any repository, runs ctrlyoke's notify script on PreInvocation/Stop (and on tool events if those were enabled). It also runs any user-supplied `preToolUse`/`postToolUse` commands from that workflow. The notify script writes notification files into the old workspace's `.ctrlyoke/temp/antigravity-notifications`. Once the extension's install path changes, every event fails with node `Cannot find module`. This continues until the user edits `hooks.json` by hand.

## Steps to Reproduce

1. Create a workflow that uses harness `antigravity-cli` and has a user hook, e.g. `hooks: [{event: postToolUse, command: 'node C:/tmp/log-hook.js'}]`.
2. Run it interactively in VS Code (or the CLI) far enough that `planNotificationHookArgs` applies its mutation. `~/.gemini/config/hooks.json` now contains a `ctrlyoke-<12 hex>` group.
3. Before the run finishes and the PTY exits, kill the extension host process (or the ctrlyoke CLI process with SIGKILL / Task Manager).
4. Open `~/.gemini/config/hooks.json`. The `ctrlyoke-<hash>` group is still there.
5. Run `agy` in a different, unrelated repository and have it make a tool call. `log-hook.js` runs, and a notification file appears in the first workspace's `.ctrlyoke/temp/antigravity-notifications` directory.
6. Restart VS Code/ctrlyoke and do not rerun that workflow. The group is never removed.

## Root Cause

- `writeGlobalHooksConfig` (`src/core/harness/antigravity/AntigravityCliProvider.ts:936-952`) adds a group with no workspace scope to the user-global file returned by `getGlobalHooksPath` (`:924-926`).
- `AntigravityNotificationMonitor.buildHookConfig` (`src/core/harness/antigravity/AntigravityNotificationMonitor.ts:80`) ignores its `_workspaceRoot` parameter and adds no matcher or cwd guard, so the group fires for every agy session.
- The group is removed only in `cleanupWorkspaceArtifacts` (`AntigravityCliProvider.ts:634-661`), which is reached only through `CliIntegration.cleanupWorkflowArtifacts` (`src/core/harness/CliIntegration.ts:2067`, provider call at ~2086).
- `shouldRetainWorkflowArtifactsForReuse()` returns true (`AntigravityCliProvider.ts:181`), so `WorkflowInstance` (`src/core/WorkflowInstance.ts:4643-4670`) defers cleanup to the retained PTY's `onPtySessionEnded` callback. That callback never fires if the process dies.
- Runner locks are reclaimed by PID and heartbeat, but nothing does the same for hooks: no code sweeps orphaned `ctrlyoke-*` groups on startup or before the next write.

## Suggested Fix

Make the groups self-describing and reclaimable:

1. When writing a group, record its owner metadata (owning PID, heartbeat timestamp, `workspaceRoot`) in a ctrlyoke-owned sidecar such as `~/.gemini/config/ctrlyoke-hooks-owners.json`, keyed by group name.
2. In `writeGlobalHooksConfig`, under the same `withFileLock`, and also on extension/CLI activation, drop every `ctrlyoke-*` group whose owner PID is dead or whose heartbeat is stale. Reuse the runner-lock liveness rules. Also drop any `ctrlyoke-*` group that has no sidecar entry.
3. As defense in depth, pass the registered workspace root to `ctrlyoke-antigravity-hook.js` as an extra argv. Have the script exit with `{}` when the hook payload's `workspacePaths` do not include that root, or when the owner is no longer alive. A stale group that survives then cannot write into another workspace's notification directory.

Add a test in `src/test` that pins orphan reclamation.
