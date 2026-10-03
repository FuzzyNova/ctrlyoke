# Standalone (CLI-binary) interactive runs on a new session can claim another run's Stop file

- **Found:** 2026-10-03 by bug-hunt final step (claude-cli); traced by reading the code, not reproduced end to end
- **Area:** `src/core/harness/shared/CliTransportCoordinator.ts` (`executeStandaloneInteractiveProcess`, ~139-245; completion monitor call ~196-201), called from `CliExecutionRunner.ts` (~494) outside VS Code
- **Severity:** low (low confidence — needs two concurrent interactive runs on the same harness and workspace)

## Symptom

When a new (non-resumed) interactive step runs through the standalone CLI path,
`resolvedSessionId` is `undefined`, and `monitorForCompletion` is called with no
session ID. The monitor then falls back to accepting any `*-stop.json` in the
harness notification directory newer than `startTime`, and deletes it once read.

If a second run on the same harness and workspace is active at the same time
(e.g. the VS Code extension plus `ctrlyoke run --interactive`, or two CLI runs),
run B can consume run A's Stop file. B's TUI is then disposed mid-work and
reported as completed with A's session ID recorded for resume, while A's own
monitor never sees its Stop file.

## Root Cause (suspected)

Unlike the VS Code interactive path, this path never waits for the
session-start notification for its own `CTRLYOKE_RUN_ID` to learn the real
session ID before monitoring, so the monitor has nothing to match against. The
path also builds a `CTRLYOKE_RUN_ID` but never creates a `HookEventMonitor`.

## Suggested Fix

Before monitoring for completion, resolve the session ID from the run-ID-scoped
session-start notification (as the extension path does), or have the monitor
filter Stop files by `CTRLYOKE_RUN_ID` when no session ID is known. Reproduce
first with two concurrent interactive runs to confirm.
