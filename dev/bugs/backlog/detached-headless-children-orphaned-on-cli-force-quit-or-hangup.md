# Headless harness and script children outlive a force-quit or hung-up `ctrlyoke run`

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli), reviewing 88edf57db
- **Area:** `src/utils/CliProcessManager.ts` (`spawn`), `src/cli.ts` (`installTwoStageShutdown` call), `src/cli/SignalShutdown.ts`
- **Severity:** high

## Symptom

Since 88edf57db ("escalate timed out shell descendants"), every headless child
`CliProcessManager.spawn` starts on macOS/Linux is `detached: true`. A detached
child calls `setsid()`, so it leaves ctrlyoke's process group **and** its
session. The terminal therefore no longer delivers Ctrl+C (SIGINT) or a hangup
(SIGHUP) to it. Until that commit the terminal signalled the whole foreground
group, so a headless harness CLI (`codex exec`, `claude -p`, …) or a script
step died together with `ctrlyoke run` no matter how ctrlyoke itself exited.

Now the child is only stopped if ctrlyoke's own graceful shutdown reaches
`CliProcessManager.cancel()`. Every path that skips it leaves an orphan that
keeps running (and, for a harness, keeps editing files and spending tokens):

- the second Ctrl+C ("Force quitting.", `SignalShutdown.ts` `handleSignal`),
- the 5 s shutdown deadline (`cli.ts` `deadlineMs: 5000` → `requestExit`),
- closing the terminal window: SIGHUP is not in `signalNames` (`cli.ts`
  `[PROCESS_SIGNALS.INTERRUPT, PROCESS_SIGNALS.TERMINATE]`), so Node's default
  SIGHUP action kills ctrlyoke without running any handler,
- a crash of the ctrlyoke process.

## Steps to Reproduce

Reproduced with the compiled `out/utils/CliProcessManager.js` inside a real PTY
(node-pty), which delivers Ctrl+C to the foreground process group like a terminal:

1. A parent script runs `new CliProcessManager(cwd).spawn("sleep", ["47.5"])`
   and on SIGINT immediately calls `process.exit(5)` (what the force-quit path does).
2. Drive it in a PTY and write `\x03`.
3. Output: `parent got SIGINT, force-exiting`, then `pgrep -fl "sleep 47.5"`
   shows `25626 sleep 47.5` still running, reparented to launchd/init.

The same child without `detached` dies with the parent, because the PTY's
SIGINT reaches it directly.

## Root Cause

`detached: leadsProcessGroup` in `CliProcessManager.spawn` was added so a
timeout can signal `-pid` and reach descendants after the wrapping shell exits.
On POSIX, Node implements `detached` with `setsid()`, which also detaches from
the controlling terminal. Nothing replaced the terminal's signal delivery with
an explicit kill on ctrlyoke's own abrupt exit paths.

## Suggested Fix

Keep the process group (the timeout fix needs it) but make ctrlyoke own the
children's lifetime:

1. Keep a module-level registry of live group-leader PIDs in
   `CliProcessManager` (add on spawn, remove on `close`/`error`).
2. Register one `process.on("exit")` handler that synchronously sends SIGKILL
   to `-pid` for every live entry (`process.kill` is synchronous, so it works
   inside `exit`). This covers force-quit, the shutdown deadline, and any
   `process.exit`.
3. Add `PROCESS_SIGNALS.HANGUP` to the `ctrlyoke run` shutdown `signalNames` in
   `src/cli.ts` (as `src/cli/ServerCommand.ts` already does), so a closed
   terminal runs the normal graceful shutdown instead of Node's default kill.

Tests: a `CliProcessManager` unit test showing the exit hook signals live
group leaders and forgets closed ones (inject the kill function); a
`SignalShutdown`/CLI test showing SIGHUP starts the run shutdown. Add a
**Changed**/fix line to `CHANGELOG.md` under `## [Unreleased]`.
