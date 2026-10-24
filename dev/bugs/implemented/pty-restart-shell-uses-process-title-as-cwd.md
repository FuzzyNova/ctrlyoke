# restartShellSession passes the PTY's process title as the new shell's cwd

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (harness-cli)
- **Area:** `src/core/harness/PtyProcessManager.ts`
- **Resolution:** fixed in this commit

## Symptom

Restarting a shell terminal session (`MESSAGE_TYPES.TERMINAL_RESTART_SHELL`) starts the new shell
with a cwd like `pwsh.exe` or `bash`, which is the name of a program, not a directory. The spawn then
fails: `ERROR_DIRECTORY` on Windows, `chdir` failure on Unix. Even when it does not fail, the shell
does not start in the original working directory. The bug is latent today: the handler is wired up,
but the React client does not appear to send this message.

## Steps to Reproduce

1. Open a shell PTY session for a workflow.
2. Send `{ type: "terminalRestartShell", workflowId, sessionId }` to the extension (for example from
   a future restart button).
3. `TerminalMessageHandlers.handleRestartShell` reports a failure, or the new shell starts in the
   wrong directory.

## Root Cause

- `src/core/harness/PtyProcessManager.ts:924`: `const cwd = session.pty.process;`. `session.pty` is a
  node-pty `IPty` (:353). `IPty.process` is documented as "The title of the active process", not its
  working directory.
- `:930-935` passes that value to `spawnShell({ cwd: cwd || process.cwd(), ... })`.
- `PtySession` does not store the cwd it was spawned with, so the original directory cannot be
  recovered.
- Wiring: `src/ui/WebviewMessageRouter.ts:3054` → `src/ui/TerminalMessageHandlers.ts:187`. No test
  covers `restartShellSession`.

## Suggested Fix

Store the canonicalized spawn `cwd` on `PtySession` when it is created in `spawnShell`, and have
`restartShellSession` use `session.cwd`. Add a unit test asserting that the restarted shell is spawned
with the original cwd.
