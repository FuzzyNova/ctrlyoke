# `ctrlyoke run` crashes on a closed stdout pipe and leaves the run "running"

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, running the compiled CLI)
- **Area:** `src/cli.ts` (`run`/`rerun`/`append`/`continue` execution path, ~1480-1530), `src/cli/CliClosedPipe.ts`
- **Severity:** medium

## Symptom

When the process reading `ctrlyoke run`'s stdout goes away mid-run (`| head`, a CI log
collector that dies, `| grep -m1`), the next write raises `EPIPE`. Nothing listens for
the stream's `error` event on the run path, so Node rethrows it and the CLI dies with:

```
node:events:505
    throw er; // Unhandled 'error' event
Error: write EPIPE
```

The workflow is killed between steps or mid-step, without the stop path:

- The run stays `running` in `history list` / `history steps`. `ctrlyoke status`
  shows its lock as `stale (stale-dead-pid)`.
- Later steps never run, and the exit code is `1`, which the documented table
  says means "the workflow failed (a step or end condition failed)".
- A harness or script subprocess started for the current step is not stopped by
  `instance.shutdown()`.

The history commands already handle this case (`runHistoryCommand` →
`exitQuietlyOnClosedPipe`, `src/cli.ts` ~1736). `dev/implemented/ERROR_HANDLING_CONSISTENCY_PLAN.md`
§C3 recorded "Only history handles EPIPE". R6 then centralized closed-pipe handling in
`reportCliError`, but that only runs when an error is reported, not while a run is
streaming output.

## Steps to Reproduce

1. In a scratch Git repository, create `slow.ctrlyoke.yaml`:
   ```yaml
   executionMode: headless
   steps:
     - name: a
       type: script
       script: printf 'one\n'
     - name: b
       type: script
       script: sleep 1; printf 'two\n'
     - name: c
       type: script
       script: touch reached-c
   ```
2. `ctrlyoke run slow.ctrlyoke.yaml | head -2; echo ${PIPESTATUS[0]}` (zsh: `${pipestatus[1]}`).
3. Observed: exit status `1`, the unhandled `EPIPE` stack trace on stderr, no
   `reached-c` file, and `ctrlyoke status` lists the run as `running` with a
   `stale-dead-pid` lock. `ctrlyoke continue --workflow … --run …` later finishes it,
   which shows the run was only stranded, not failed.

## Root Cause

The run path renders through `outputGate.write(...)` / `console.log` to
`process.stdout` (`src/cli.ts` ~1400-1475). It installs `installTwoStageShutdown` for
SIGINT/SIGTERM (~1483), but nothing listens for the stdout (or stderr) stream's
`error` event. Node ignores SIGPIPE, so a closed reader surfaces only as an
`EPIPE` `error` event, and with no listener the event becomes an uncaught exception.
Reusing `exitQuietlyOnClosedPipe` as-is would be wrong here: it calls
`process.exit(0)` immediately, so the run would report success and still be
stranded.

## Suggested Fix

On the run path (`run`, `rerun`, `append`, `continue`, everything that executes a
workflow), listen for `EPIPE` on `process.stdout` and `process.stderr` and treat it
like an interrupt:

- stop writing further output to the dead stream;
- run the same graceful stop the SIGTERM handler runs (`instance.shutdown()`,
  `releaseLiveOutputState()`), so the run is persisted as `stopped` and its runner
  lock is released;
- exit with `CLI_INTERRUPTED_EXIT_CODE` (5). Its documented meaning is "the run is
  stopped and its runner lock released", and the exit-code table doesn't change.

The cleanest seam is probably a trigger on the two-stage shutdown that starts the
stop without a signal, shared with the signal listeners, so the EPIPE path doesn't
duplicate the dispose logic. Add a unit test for that seam. If it can run
cheaply, add an integration test that runs a script-only workflow into a pipe
closed early and checks the run ends `stopped` with exit code 5. Note the
behavior under **Changed** in `CHANGELOG.md`, and add a line to the exit-code
section of `docs/cli/ctrlyoke.md` saying a closed output pipe counts as an
interruption.
