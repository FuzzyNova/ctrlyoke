# An interactive script step killed by a signal is recorded as exit code 0 and passes

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/PtyProcessManager.ts`, `src/core/WorkflowInstance.ts` (`spawnScriptPty`), `src/core/WorkflowExecutor.ts`
- **Severity:** high

## Symptom

An interactive script step (or interactive end/pre-condition script) whose
process is killed by a signal is evaluated as if it had exited `0`. With the
default comparison (exit code equals `0`) the step **passes** and the workflow
carries on. Examples: the OOM killer, a user's `kill`, or a crash by signal.
This is easy to hit because `bash -c "<single command>"` execs the command
directly, so `script: npm test` goes green if the test runner is SIGKILLed.

Headless script steps handle the same case correctly: in
`src/core/orchestration/ScriptProcessRunner.ts` (around lines 153-192) an
external `terminationSignal` makes the result errored ("Process terminated by
SIGKILL"), and it then goes through `errorBehavior`. Interactive and headless
script steps are meant to give the same verdicts. The test "matches headless
verdicts across the comparison matrix" in
`src/test/unit/interactiveScriptStep.test.ts` asserts that.

## Steps to Reproduce

node-pty reports a signal death as `{ exitCode: 0, signal: N }`:

- `sh -c "exit 3"` gives `{"exitCode":3,"signal":0}`.
- External SIGTERM gives `{"exitCode":0,"signal":15}`. SIGKILL gives `{"exitCode":0,"signal":9}`.
- `pty.kill()` gives `{"exitCode":0,"signal":1}`.

Against ctrlyoke's compiled manager (after `npm run compile:extension`):

```js
const { initPtyProcessManager } = require(root + "/out/core/harness/PtyProcessManager.js");
const mgr = initPtyProcessManager(() => {});
mgr.spawnPty({
  workflowId: "wf", stepName: "probe", stepIndex: 0, kind: "ai-cli", sessionId: "s1",
  command: "/bin/bash", args: ["-c", "sleep 32; exit 1"], cwd: "/tmp", env: process.env,
  onData: () => {},
  onExit: (_s, exitCode) => { console.log("exitCode =", exitCode); process.exit(0); },
});
setTimeout(() => require("child_process").execSync("pkill -KILL -f 'sleep 32; exit 1'"), 500);
// prints: exitCode = 0   (the script would otherwise have exited 1)
```

## Root Cause

- `PtyProcessManager.ts:943` destructures only `exitCode` from node-pty's
  `onExit({ exitCode, signal })` and drops `signal`. Line 952 passes
  `exitCode ?? 1`, but the `?? 1` never applies because node-pty reports `0`,
  not `undefined`.
- `WorkflowInstance.spawnScriptPty` (around line 4146) resolves the bare number.
- `WorkflowExecutor.ts:3293` (`const exitCode = ptyExitCode ?? 1;`) compares it
  as a normal exit, with `success: exitCode === 0`. `errored` is set only for a
  PTY timeout or a spawn error.

A related case, traced in code but not run end to end: when the user presses
Stop, `killSession(..., STOPPED)` also ends in exit `0`. The interactive script
path does not report `cancelled`, so the stopped attempt may be recorded as
completed. `finalizeCancelledPromptAfterStop` may override that; check it.

## Suggested Fix

1. Have `PtyProcessManager`'s `onExit` read `signal`. Pass it to
   `options.onExit`, either as an extra argument or by mapping a nonzero signal
   to `128 + signal` the way shells do. Keep the existing behaviour for AI
   harness sessions unless they also need the change. Check every `onExit`
   consumer.
2. In `spawnScriptPty`, when a signal killed the process and ctrlyoke did not
   end the session itself (`session.endReason` is unset), resolve an errored
   result (`errored: true`, error "Process terminated by SIG…"). The executor
   then routes it through `errorBehavior` exactly as `ScriptProcessRunner`
   does for headless steps. When `endReason` is `TIMED_OUT`, keep the existing
   timeout handling. When it is `STOPPED`, return a cancelled result so the
   executor's existing `cancelled` handling runs.
3. Tests: a `PtyProcessManager` test that SIGKILLs a spawned `sleep` and sees
   the signal. A test in `src/test/unit/interactiveScriptStep.test.ts` that an
   externally killed interactive script errors exactly like the headless
   verdict.
