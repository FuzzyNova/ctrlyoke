# Stop and parallel fail-fast do not kill a running script step's process

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/CliProcessManager.ts`, `src/core/orchestration/ScriptProcessRunner.ts`, `src/core/WorkflowInstance.ts`
- **Resolution:** fixed in this commit

## Symptom

Cancelling a running `type: script` step does not terminate the script. On
Windows the script runs to completion after Stop / fail-fast, keeps writing to
the workspace, and the step is then reported with a fabricated
`Script exited with code 1`.

Observed with the CLI and a parallel group using the documented
`failFast: true` ("cancels other in-flight members after a terminal failure"):

```yaml
steps:
  - parallel:
      - name: p1
        type: script
        script: node -e "setTimeout(()=>{console.log('p1 done')},6000)"
      - name: p2
        type: script
        script: node -e "process.exit(3)"
    failFast: true
```

`ctrlyoke run t.ctrlyoke.yaml --headless --json`: the session log shows `p2`
failing at +0.3 s, but `p1` is not killed. It prints `p1 done` at +6 s, and the
run lasts the full 6 s. The JSON reports `p1` as
`status: "cancelled"` with `script.stdout: "p1 done"`, `exitCode: 1` and
`error: "Script exited with code 1"`, although the script really exited 0.

A direct probe of `ScriptProcessRunner` confirms the root cause. It runs
`node -e "setTimeout(()=>console.log('child finished'),5000)"` and calls
`dispose()` at 725 ms. `run()` still resolves only at 5263 ms, with
`stdout: "child finished"` and `exitCode: 1`.

The same `processRunner.dispose()` call is the user **Stop** path for script
steps (`WorkflowInstance.ts` stop loop over `activeTargetResources`, plus
`cancelTarget` and the dispose loops over `targetScriptProcessRunners`). So Stop,
which is documented to stop a workflow immediately and mid-step if needed,
leaves long-running script steps (test suites, builds, servers) running
unattended.

## Steps to Reproduce

1. Save the YAML above in a scratch git repo on Windows.
2. `node out/cli.js run t.ctrlyoke.yaml --headless --json`.
3. The run takes ~6 s instead of ~0.3 s, and `p1` shows `stdout: "p1 done"`,
   `exitCode: 1`, `status: "cancelled"`.

## Root Cause

`ScriptProcessRunner.dispose()` calls `CliProcessManager.dispose()` →
`disposeProcess()` (`src/utils/CliProcessManager.ts`), which does
`this.currentProcess.kill()`. That signals only the direct child. Script steps
are spawned through the platform shell (`resolveScriptInvocation` →
`cmd.exe /d /s /c …` on Windows, `sh -c …` elsewhere). Killing the shell leaves
the actual command (the grandchild) alive. It keeps the stdout pipe open, so
`close` only fires when that process exits on its own, and the killed shell's
status becomes the reported exit code 1. On POSIX the same orphaning happens
for any compound command (`npm test && …`, pipelines), where `sh` does not
`exec` the last command.

The kill paths that do work (`cancel()` → `killImmediately`, and the timeout
path → `killGracefully`) use `tree-kill`. `disposeProcess()` is the only one
that doesn't.

Secondary: `ParallelGroupRun.runMember` maps a cancelled member's `FAILED`
outcome to `CANCELLED`, but the attempt timeline and step `error` still carry
the executor's `Script exited with code N` message. A cancelled member should
not report an exit-code failure.

## Suggested Fix

- Make the cancellation path for script runners kill the whole process tree,
  e.g. a `ScriptProcessRunner.cancel()` that calls
  `CliProcessManager.cancel()` (tree-kill), used by `cancelTarget`, the Stop
  loop, and `releaseTargetResources`. Alternatively, make `disposeProcess()`
  tree-kill when a process is still live. Check the harness callers of
  `disposeProcess()` in `CliTransportCoordinator.ts` too: harness CLIs launched
  through `.cmd` shims have the same shell/grandchild shape.
- Record a cancelled script attempt as cancelled (no `Script exited with code`
  failure reason) when the kill was requested by ctrlyoke.
- Tests: a unit test proving that disposing/cancelling a `ScriptProcessRunner`
  whose shell command spawns a long-lived child resolves promptly (well before
  the child's natural exit), and a parallel-group test where a `failFast`
  failure cancels a slow script member promptly and reports it `cancelled`
  without an exit-code error.
