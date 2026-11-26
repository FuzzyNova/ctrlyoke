# A script timeout never sends SIGKILL once the wrapping shell has died, so descendants that ignore SIGTERM survive

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli, via subagent; reproduced on macOS)
- **Area:** `src/utils/CliProcessManager.ts` (`killGracefully`)
- **Severity:** medium

## Symptom

When a headless script (end condition, precondition, headless script step or
worktree setup) exceeds `timeoutSec`, ctrlyoke sends SIGTERM to the process tree
and, per `killGracefully`'s own contract, should escalate to SIGKILL after 3 s.
When the script is a shell command with more than one part (`a; b`, `a && b`,
a pipe), the direct child is the shell. The shell dies on SIGTERM, but a
descendant that ignores SIGTERM or is slow to exit (a dev server, a test runner,
`node` with a SIGTERM handler) keeps running. It is reparented to init and never
killed. Because it still holds the stdout pipe, `close` never fires and
`cleanupProcessState` never runs, so `currentProcess` keeps pointing at the dead
shell. A later `cancel()` then signals a dead PID.

## Steps to Reproduce

1. Using `CliProcessManager.spawn` (compiled `out/utils/CliProcessManager.js`),
   run `bash -c 'node -e "process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000)"; echo after'`
   with `timeout: 1000`.
2. The log shows "Process timeout - sending SIGTERM" and the promise rejects
   with `CliProcessTimeoutError`.
3. 6 s later, `pgrep -f setInterval` still finds the `node` process. No
   "escalating to SIGKILL" line is ever logged.

## Root Cause

`CliProcessManager.ts:465-478`: the escalation timer only sends SIGKILL when
`child.exitCode === null && child.signalCode === null`. These fields describe
the *direct* child (the shell). Once the shell dies of the SIGTERM,
`signalCode === "SIGTERM"` and the escalation is skipped. Even if it ran,
`tree-kill` on the dead shell's PID can no longer find the reparented
descendants. The liveness guard came from
`dev/bugs/implemented/kill-escalation-skipped-when-next-process-becomes-current.md`,
which did not consider a wrapping shell.

## Suggested Fix

Decide whether to escalate from whether the child's stdio has closed (the
`close` event), not from the direct child's exit status. Also capture the
descendant PIDs before the SIGTERM is sent, because a descendant reparented
after its shell dies can no longer be found from the shell's PID. Two ways to
do that:

- On POSIX, spawn with `detached: true` and kill the process group
  (`process.kill(-pid, sig)`). That also reaches reparented grandchildren.
- Snapshot the tree with the same listing `tree-kill` uses, then SIGKILL every
  PID that is still alive after `KILL_ESCALATION_DELAY_MS`.

Windows already uses `taskkill /F /T`, so it is unaffected as long as the tree
is captured first. Keep the protection from the earlier bug: escalation must
target this `child`, not whatever `currentProcess` is now. Add a regression test
in `src/test/unit/CliProcessManager*.test.ts` that spawns a shell whose
grandchild ignores SIGTERM and asserts the grandchild is gone after the
escalation delay (POSIX-only is fine).
