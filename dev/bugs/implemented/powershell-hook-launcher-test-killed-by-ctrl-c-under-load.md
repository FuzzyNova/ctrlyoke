# PowerShell hook launcher test is intermittently killed by Ctrl+C during `npm test` on Windows

- **Found:** 2026-11-16 while verifying the fix for `windows-script-fixtures-assume-posix-shell`
  (`npm test` on Windows 11)
- **Area:** `src/test/unit/UserHookEnvironment.test.ts`
  (`runs a PowerShell-syntax command under PowerShell on Windows`)
- **Resolution:** fixed in this commit

The PowerShell case now launches its Node hook runner with `windowsHide: true` and
`detached: true`, giving the runner and its PowerShell child an isolated console. The
PowerShell process is spawned by the production hook runner, whose child lifecycle and
termination behavior must remain unchanged; isolating the test's own launcher avoids
changing production spawn semantics. This flake was not reproduced, but the isolation is
in place.

## Symptom

In one of two full `npm test` runs on the same tree, the case failed with
`3221225786 !== 0`: the `powershell.exe` child exited with `0xC000013A`
(`STATUS_CONTROL_C_EXIT`), meaning it received a console Ctrl+C event. The full log is
`.ctrlyoke/logs/test-runs/npm-test-2026-11-16T15-10-29-090Z.log`, around line 3803.

## Steps to Reproduce

1. On Windows, run `npm test` (six extension-host shards plus Vitest, all in one console).
2. Sometimes the case above fails with exit status 3221225786.
3. Not reproduced in isolation: `npm run test:extension:run -- UserHookEnvironment` passed
   3/3, and the next full `npm test` passed it too.

## Root Cause

Unknown. `STATUS_CONTROL_C_EXIT` means a `CTRL_C_EVENT` reached the console process group.
Every shard and its children share the console that started `npm test`, so a Ctrl+C event
raised by any process in that console, including a test elsewhere or a harness CLI probed at
extension-host startup, reaches a `powershell.exe` started with `spawnSync`. ctrlyoke's own
source never calls `GenerateConsoleCtrlEvent`, so the sender is most likely a third-party
process.

## Suggested Fix

Next time it fails, look at what the other shards were running at that timestamp. If the
sender cannot be found, spawn the PowerShell child with `windowsHide: true` and
`detached: true` (its own console) so console control events from siblings cannot reach it.
