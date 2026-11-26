# A Codex app-server or Copilot ACP child that exits mid-handshake hangs the step forever

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/shared/CliTransportCoordinator.ts` (`executeHeadless`), `src/core/harness/codex/CodexAppServerHeadlessControlChannel.ts`, `src/core/harness/copilot/CopilotHeadlessControlChannel.ts`
- **Resolution:** fixed in this commit

## Symptom

A headless Codex (app-server) or Copilot (ACP) step whose child process exits
before it answers the control handshake never settles. The log shows
`Process exited - execution complete` and then nothing. The step stays
running until the user presses Stop. `execution.maxPromptTimeoutSec` (default
`-1`) doesn't help, because its timer belonged to the spawn that has already
ended.

Real triggers are an app-server that crashes or exits early: a bad `-c`
override or config, an auth failure, a panic on `thread/resume` of a damaged
rollout, or Copilot exiting before it answers `initialize`.

## Steps to Reproduce

Reproduced by bundling the real coordinator and channel classes with esbuild
against a fake process manager. Its `spawnProcess` calls `onStdinReady`, never
writes a JSON-RPC response, and resolves `{ exitCode: 1 }`. For both the Codex
and Copilot channels, `executeHeadless` was still pending after 2 s
(`codex HUNG after 2s`, `copilot HUNG after 2s`).

## Root Cause

- `CliTransportCoordinator.ts:1111` runs `await controlReady;` after
  `spawnProcess` resolves, which happens once the child has exited.
- `controlReady` (around lines 976-1063) awaits `controlChannel.start()`, and
  then the first `sendUserMessage()`. Both wait on JSON-RPC responses that can
  only arrive through stdout.
- Codex: `CodexAppServerHeadlessControlChannel.request()` (around lines
  403-432) creates a promise that only `observe()` or `close()` settles. It is
  awaited for `initialize`, `config/read`, `thread/start`/`thread/resume` and
  `turn/start`.
- Copilot: `CopilotHeadlessControlChannel.start()` (around lines 112-128)
  awaits the `initialize` and `session/new`/`session/load` results. In
  `AcpJsonRpcClient` only `close()` rejects those results.
- The channel's `close()` is reached only through `closeControlChannel`. That
  runs from the `.catch` on `controlReady` (which never fires here) or from
  `cancel()`. Nothing closes the channel when the process exits.
- Qwen and Claude don't hang because they have an initialize timer
  (`QwenHeadlessControlChannel.ts:52`).

## Suggested Fix

Once `spawnProcess` has returned, the child is gone. Before awaiting
`controlReady`, close the control channel (`closeControlChannel()`), which
rejects every pending request. Report a handshake rejected after exit as a
`CliTransportError` (`HARNESS_ERROR`) that carries the exit code and stderr,
so the step fails promptly and goes through `errorBehavior`.

Test in `src/test/unit/CliTransportCoordinator.test.ts`, for both the Codex
and Copilot channels: a spawn mock that calls `onStdinReady`, never responds,
and returns `exitCode: 1` must make `executeHeadless` reject.
