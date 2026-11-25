# Stream-json headless control channel reports every later turn as interrupted

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, code trace plus a scratch script against the compiled channel)
- **Area:** `src/core/harness/shared/StreamJsonHeadlessControlChannel.ts` (`observe` ~97-104, `interrupt` ~139-150)
- **Resolution:** fixed in this commit

## Symptom

After the user clicks **Interrupt Turn** once on a Claude or Qwen headless step,
every later `result` record on that channel is reported as
`{ kind: "turn-end", interrupted: true }`. A scratch script that calls
`interrupt()` and then feeds two `result` records gets `interrupted: true` back
for both.

## Steps to Reproduce

1. On a Qwen headless step (its steers queue as separate turns), queue a steer
   message, then click Interrupt Turn.
2. The channel stays open for the queued steer, which runs as its own turn.
3. Make that turn fail (an `is_error` result or a nonzero exit).
4. The step is recorded as a successful, interrupted partial step instead of a
   failure.

## Root Cause

`interrupt()` sets `this.interruptRequested = true` (line ~140) and clears it
only if the write throws. `observe()` adds `interrupted: true` to every later
`result` while the flag is set (line ~102) and never resets it.

The coordinator keeps the last turn's value
(`CliTransportCoordinator.ts:830`, `interruptedTurnCompleted =
observation.interrupted === true`). It is passed on as `result.interrupted`,
which makes `CliResponseCollector.ts:178` skip `getHeadlessFailure` and
`CliExecutionRunner.ts:1206` skip the recoverable-session check.

The Codex channel does this correctly: it reads and resets the flag when a turn
completes (`CodexAppServerHeadlessControlChannel.ts:239-240`).

## Suggested Fix

In `observe()`, when a `result` record is seen, capture `interruptRequested`,
reset it to `false`, and report the captured value, as the Codex channel does.
Add a channel test (Qwen and Claude subclasses share the base) where one
interrupt is followed by two `result` records: only the first reports
`interrupted: true`.
