# On Windows, a harness hook timeout still leaves the launched hook running

- **Found:** 2026-10-12 by Claude (bug-drain review of ~7d0de405d)
- **Area:** `src/scripts/ctrlyoke-hook-run.js`
- **Resolution:** fixed in this commit

## Symptom

~7d0de405d fixed `dev/bugs/implemented/hook-launcher-changes-shell-and-orphans-on-timeout.md` on
POSIX, but not on Windows. A hook with `env` and `timeoutSec` that outlives its timeout is still
running after the harness gives up on it:

1. Windows, any harness except OpenCode: hook
   `{ event: stop, command: "node -e \"setInterval(()=>{},1000)\"", timeoutSec: 2, env: { A: b } }`.
2. After the timeout the harness reports the hook as timed out, but the `node` process is still alive.

## Root Cause

The launcher only tree-kills its child from `process.on("SIGTERM" | "SIGINT" | "SIGHUP")`
handlers. On Windows, harnesses end a timed-out hook with `child.kill()`, which is
`TerminateProcess`: no signal handler runs, so `killWindowsProcessTree` never fires. Worse, most
harnesses run the launcher through a shell (Git Bash for Claude, PowerShell for Copilot, cmd.exe
for Qwen), so the harness kills the shell and the launcher itself survives along with the hook.

The Windows unit test (`uses taskkill for the launcher child tree on Windows` in
`src/test/unit/UserHookEnvironment.test.ts`) invokes the SIGINT handler directly in a VM, so it
never exercises a real termination.

## Suggested Fix

Make the launcher enforce the deadline itself instead of depending on a signal it will not get:

1. Store each hook's `timeoutSec` next to its env in the per-step env file
   (`prepareUserHookEnvironments` in `src/core/harness/shared/UserHookEnvironment.ts`), e.g.
   `{ "hook-0": { "env": {...}, "timeoutSec": 2 } }`, and update the launcher and the OpenCode
   plugin's `_getUserHookEnv` reader to match. Do not add a launcher argument.
2. In `ctrlyoke-hook-run.js`, when `timeoutSec` is set, start a timer and tree-kill the child
   (existing `killWindowsProcessTree` / process-group kill) shortly before the harness's own
   deadline, then exit non-zero.
3. Also watch the launcher's parent: poll `process.kill(process.ppid, 0)` every ~500 ms (unref'd
   timer) and tree-kill the child when the parent is gone. This covers harness default timeouts
   when `timeoutSec` is unset and a harness that kills the wrapping shell.
4. Add a Windows test that spawns the launcher through `cmd.exe /d /s /c`, kills the cmd.exe
   process with `child.kill()`, and asserts the hook's grandchild exits; and a cross-platform test
   that `timeoutSec` alone ends the hook's tree.
