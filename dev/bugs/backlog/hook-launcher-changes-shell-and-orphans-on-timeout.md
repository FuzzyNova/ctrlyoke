# Hook launchers change the hook's shell and leave it running after a timeout

- **Found:** 2026-10-12 by Claude (bug-drain review of ~f31da1790 and ~33d934f87)
- **Area:** `src/scripts/ctrlyoke-hook-run.js`, `src/scripts/ctrlyoke-opencode-plugin.ts`, hook timeout builders
- **Severity:** medium

## Symptom

1. **Shell changes when `env` is added.** `src/scripts/ctrlyoke-hook-run.js:19` runs the user's
   command with `spawn(command, { shell: true })`, which is cmd.exe on Windows and `/bin/sh` on
   POSIX. Without `env`, the same command runs under the harness's own shell (PowerShell for
   Copilot's `powershell` field on Windows, bash for its `bash` field, Git Bash for Claude on
   Windows). Adding an `env` key silently changes how the command is parsed, so PowerShell syntax,
   `$VAR` expansion and bashisms break.
2. **Timeouts orphan the hook.** When the harness kills a hook after `timeoutSec`, only the
   launcher dies. `ctrlyoke-hook-run.js` forwards no signals, and on Windows killing a parent does
   not kill its children, so the user's command keeps running. The OpenCode plugin has the same
   problem: `spawnSync(..., { shell: true, timeout })` (`ctrlyoke-opencode-plugin.ts`, the
   `_runUserHooks` path) kills only `cmd.exe`, leaving e.g. `node slow.js` running.
3. **Timeout field built separately per harness (DRY).** ~f31da1790 added `timeoutSecToNative`
   (`src/core/harness/shared/interfaces/INotificationMonitor.ts:17`), but the spread
   `...(timeoutSecToNative(x) !== undefined ? { timeout: timeoutSecToNative(x) } : {})` is
   repeated in `INotificationMonitor.ts`, `ClaudeNotificationMonitor.ts`, `CodexHookUtils.ts` and
   `QwenCliProvider.ts`, each calling the helper twice, and the unit is a loose string literal.
   `ClaudeNotificationMonitor.buildUserOnlyConfig` also rebuilds what the default group builder
   already produces.

## Steps to Reproduce

1. Copilot on Windows: hook `{ event: stop, command: "Write-Output $env:FOO", env: { FOO: bar } }`.
   It runs under cmd.exe and prints the literal text instead of `bar`.
2. Any harness: hook `{ command: "node -e \"setInterval(()=>{},1000)\"", timeoutSec: 2, env: { A: b } }`.
   After the timeout, the `node` process is still alive.

## Suggested Fix

1. Pass the intended shell to `ctrlyoke-hook-run.js` as an argument, chosen per harness to match
   the shell the harness itself would use for that hook (PowerShell for Copilot's `powershell`
   field, bash for its `bash` field, the harness default otherwise), and spawn the command under
   it. Document any harness where the shell cannot be matched.
2. In `ctrlyoke-hook-run.js`, forward SIGTERM/SIGINT/SIGHUP to the child; on Windows, kill the
   child's process tree (`taskkill /T /F /PID`) when the launcher is terminated. In the OpenCode
   plugin, replace the `spawnSync` timeout with a tree kill on timeout. Reuse an existing
   tree-kill helper if the repo has one (search `src/utils` and `src/core/harness/shared`).
3. Replace the repeated spread with one helper that returns `{ timeout }` or `{}` for a given
   `timeoutSec` and a typed unit constant, and use it in every builder.
