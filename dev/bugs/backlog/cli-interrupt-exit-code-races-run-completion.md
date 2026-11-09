# Ctrl+C / SIGTERM on `ctrlyoke run` exits 1 instead of 5, and `--json` drops the final result line

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli.ts` (run signal handling around line 1404, run completion around lines 1513–1573), `src/cli/SignalShutdown.ts`
- **Severity:** medium

## Symptom

`docs/cli/ctrlyoke.md` documents exit code `5` for "Interrupted with Ctrl+C or
`SIGTERM`; the run is stopped and its runner lock released". The
"Continue after a stop" section also says: "Press Ctrl+C while the workflow is
running; it exits with code 5. The final JSON line includes `workflowKey` and
`runRef`; an interrupted run also records its status."

In practice:

- Text mode: the run prints `Interrupted. Stopping workflow...` and
  `✗ Workflow ended: stopped`, then exits with **1** (the generic "workflow
  failed" code). This happened every time for both SIGINT and SIGTERM (3 out of 3).
- `--json` mode: the process exits 5, but **writes nothing to stdout**. The
  final JSON line with `workflowKey`/`runRef` is never printed, so a script
  cannot find the run it needs to continue.

## Steps to Reproduce

```sh
export CTRLYOKE_HOME=/tmp/cyb/home; mkdir -p /tmp/cyb/ws && cd /tmp/cyb/ws && git init -q
cat > h.ctrlyoke.yaml <<'EOF'
name: h
steps:
  - type: script
    script: sleep 20
EOF
ctrlyoke run h.ctrlyoke.yaml & P=$!; sleep 3; kill -INT $P; wait $P; echo $?          # 1, expected 5
ctrlyoke run h.ctrlyoke.yaml --json > out.json & P=$!; sleep 3; kill -INT $P; wait $P; echo $?; wc -c out.json   # 5, 0 bytes
```

## Root Cause

Two code paths race to call `process.exit`:

1. The signal handler from `installTwoStageShutdown` (`src/cli.ts` around
   line 1407) runs `dispose` → `instance.shutdown()`, then
   `requestExit(successExitCode = 5)`.
2. `instance.shutdown()` stops the workflow, which resolves the
   `await instance.executeLoadedPromptFile()` (or addressed operation) that the
   main run path is waiting on. That path computes
   `getExitCode(state)` (STOPPED → `1`, `src/cli/CliExitCode.ts`) and calls
   `process.exit(exitCode)`.

In text mode the main path has no further awaits, so it wins and exits 1. In
`--json` mode it awaits `resolveCliJsonOutputProjection` before writing, so
the signal path wins, exits 5, and kills the process before the JSON line is
written. Neither path knows about the other. No test covers either outcome.

## Suggested Fix

Make the main run path the only thing that exits once a signal-triggered
shutdown has begun:

- Record that the run was interrupted (for example, a flag set by the run's
  `dispose` callback, or an `onShutdownStarted` hook on
  `installTwoStageShutdown`).
- In the main completion path, when interrupted, use exit code 5 (keep
  guardrail `6` and run-state refusal `2` precedence as they are now only if
  that is correct: an interrupt should win over the generic `1`) and still
  write the JSON result / text summary before exiting.
- The signal path should not exit on success while the main path is still
  completing. Keep its deadline/force-quit (second Ctrl+C) and timeout exits
  as the fallback when the run never settles.

`ServerCommand.ts` uses the same `installTwoStageShutdown` helper; leave the
server's behavior unchanged. Add tests: a unit test for the helper option you
add, and a CLI integration test (pattern: `src/test/integration/cli-*.integration.test.ts`)
that SIGINTs a running `sleep` script step and asserts exit 5 in text mode and
exit 5 plus a parseable final JSON line (with `workflowKey`, `runRef` and a
stopped status) in `--json` mode.
