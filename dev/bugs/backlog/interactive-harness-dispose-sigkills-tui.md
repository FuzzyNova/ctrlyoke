# Normal interactive harness completion now SIGKILLs the TUI process tree

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/CliProcessManager.ts` (`disposeProcess`), `src/core/harness/shared/CliTransportCoordinator.ts`
- **Severity:** medium

## Symptom

8b119e21e changed `CliProcessManager.disposeProcess()` from `child.kill()`
(SIGTERM to the direct child) to `killImmediately()` (SIGKILL of the whole
tree, no grace period) so that script Stop/fail-fast kills grandchildren.
`disposeProcess()` is also how `CliTransportCoordinator` ends an interactive
harness session that finished normally (Stop hook detected, ~215 and ~227).
A SIGKILLed TUI gets no chance to leave raw mode, restore the alternate screen
or show the cursor, and cannot flush its own session state. On Linux/macOS
the user's terminal can be left in raw/alternate-screen mode after every
interactive step (`cli.ts` only resets cursor and colour codes). This follows
from the code; it was not reproduced (Windows host).

## Steps to Reproduce

1. On Linux/macOS, `ctrlyoke run` a workflow interactively with a harness whose
   TUI uses the alternate screen (e.g. claude-cli).
2. Let the step complete normally.
3. The TUI is SIGKILLed rather than asked to exit.

## Root Cause

A single `disposeProcess()` serves two different intents: cancellation (needs
to be immediate and tree-wide) and routine teardown after a completed session
(should be graceful).

## Suggested Fix

Make `disposeProcess()` use `killGracefully` (SIGTERM to the tree, SIGKILL after
the existing escalation delay), which still reaps grandchildren, and keep
`killImmediately` for user Stop / `cancel()`. Check that the script-cancellation
tests from 8b119e21e still pass (they go through the cancel path or tolerate
the escalation delay). Add a unit test that `disposeProcess()` sends a graceful
signal first.
