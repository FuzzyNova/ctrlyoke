# Qwen hook tracker never discards leftover ctrlyoke hook groups, so a crashed run's hooks become a permanent baseline

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/SettingsJsonHooksTracker.ts`
- **Severity:** medium

## Symptom

If the extension host crashes, or the window is killed, while a Qwen workflow is running, ctrlyoke's SessionStart/UserPromptSubmit/Stop hook groups stay in `<workspace>/.qwen/settings.json` permanently. Every later Qwen workflow then treats them as the user's own hooks:

- it keeps them and fires them next to the fresh ctrlyoke hooks, so each notification fires twice;
- it writes them back when it finishes;
- if ctrlyoke had created the file, the file is no longer deleted, and the temporary `.qwen/.gitignore` is never removed.

The user's own `qwen` sessions in that workspace keep running the trusted ctrlyoke hook script. After a ctrlyoke upgrade, the script path points at the uninstalled extension version and the hook fails on every event.

## Steps to Reproduce

1. Use a workspace with no `.qwen/settings.json`, or one that holds only user hooks.
2. Start an interactive qwen-cli workflow in ctrlyoke. `.qwen/settings.json` now contains ctrlyoke groups running `node .../out/scripts/ctrlyoke-qwen-hook.js .../.ctrlyoke/temp/qwen-notifications`.
3. Kill the VS Code extension host, or the window, before the workflow finishes, so `QwenCliProvider.cleanupWorkspaceArtifacts` never runs.
4. Reopen VS Code and run any qwen-cli workflow to completion.
5. Observe: during the run, each ctrlyoke event has two identical groups (fresh plus stale). After the run, `.qwen/settings.json` still contains the ctrlyoke hook groups, and `.qwen/.gitignore` still exists if ctrlyoke had created the file.
6. Run `qwen` by hand in the workspace. The ctrlyoke hook script still runs on SessionStart, UserPromptSubmit and Stop without a trust prompt, because its key is in `~/.qwen/trusted_hooks.json`. After a ctrlyoke version upgrade, that command points to a script that no longer exists.

## Root Cause

- `src/core/harness/shared/SettingsJsonHooksTracker.ts:213-219`: `readBaseline` returns the raw hooks section as the baseline unless `policy.discardHookGroup` is given. Only the policy path (lines 221-256) removes ctrlyoke-owned groups and resets `fileExisted` to false for a file that contains nothing else.
- `src/core/harness/qwen/QwenCliProvider.ts:671-676`: `registerHooksInSettings` calls `hooksTracker.registerWorkflow(workflowKey, workspaceRoot, ctrlyokeHooksSection, workflowUserHooks)` without a baseline policy, so that protection is never active. The only other user, Codex, was inlined in 03f95262a.
- Tracker state is in memory only (`SettingsJsonHooksTracker.ts:31-49`), so after a crash nothing knows which groups ctrlyoke owns. The stale groups are merged into every rebuild (lines 305-308) and restored as the baseline (lines 349-353). Because `fileExisted` is true, `restoreBaseline` never takes the delete path (lines 327-339), so neither the file nor the gitignore is removed.
- `src/core/harness/shared/QwenTrustedHooksTracker.ts:18-24` deliberately keeps trust keys after unregister, so the leftover hooks keep running without a prompt.

## Suggested Fix

- Pass a `HookBaselinePolicy` from `QwenCliProvider.registerHooksInSettings`. Its `discardHookGroup(group)` returns true when every hook in the group is a `type: "command"` whose command runs `ctrlyoke-qwen-hook.js`. Match on the script basename, not the full versioned path, so groups from older extension versions are discarded too. Ideally share that predicate with `QwenNotificationMonitor.buildHookConfig` so the command format has a single source.
- Remove a leftover ctrlyoke `.qwen/.gitignore` when the sanitized baseline shows the file held only discarded groups. One option: recognize the gitignore by its `# ctrlyoke temp files` header and set `gitignorePath` so restore deletes it.
- Add a `SettingsJsonHooksTracker`/`QwenCliProvider` test that seeds `settings.json` with a stale ctrlyoke group plus a user group, runs register/unregister, and checks that only the user group remains. Also check that the file is deleted when it held only ctrlyoke groups.
- If the policy is still unused after that, remove the optional parameter instead.

**Resolution:** fixed in this commit

## Decision

New Qwen hook commands carry the extension host PID as an ignored trailing
argument. Baseline cleanup discards a marked group only when that PID returns
`ESRCH`; a live or permission-protected PID remains part of the baseline. For
legacy commands without an owner marker, cleanup discards the group only when
the referenced hook script no longer exists. This uses the command's existing
notify-directory argument and does not add a separate lock or marker file.

## Follow-up (review)

Review confirmed that active Qwen hook groups survive registrations from other
ctrlyoke processes, while groups from dead marked owners and legacy commands
whose installed script is gone can be removed. The temp `.qwen/.gitignore`
cleanup remains tied to a baseline containing only discarded groups.

## Follow-up (final review)

The owner-marker change briefly put the decision hook in a fixed argv slot with
an empty-string placeholder. Qwen hook commands are unquoted, so the empty
argument vanished and the hook script read `--ctrlyoke-owner-pid=N` as the
base64 decision hook on every PermissionRequest without a user hook. The script
now strips the owner marker before reading positional args, the decision hook is
again appended only to the PermissionRequest command, and liveness uses the
shared `isProcessAlive` from `LockSafetyPrimitives`.
