# Continuing an imported errored run skips the failed step instead of re-running it

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/RunBundleImporter.ts` (`normalizeImportedRuntime`, `materialize` call), `src/core/orchestration/RunBundleExporter.ts` (`getNextStep`), `src/core/PromptQueue.ts` (`rewindTerminalFailureForContinuation`)
- **Resolution:** fixed in this commit

## Symptom

A run stops because a step failed (execution state `error`). Locally,
`ctrlyoke continue` re-runs the failed step, as documented: "Resume runs the
failed step again" (`docs/workflows/error-handling.md`). If you export the run
and import it with `--continue`, the failed step is skipped instead.
Continuation starts at the step after it, and the run then completes with the
failed step still `failed` (1 attempt). `docs/guide/export-import.md` says an
imported run "moves the same way it continues locally".

The export manifest is already wrong: `nextStep` is `{stepIndex: 1}` and
`pendingStepCount` is `3` for a four-step run that failed at step 0, and the
import preview's `pendingSteps` leaves the failed step out.

This is the import-path counterpart of
`dev/bugs/implemented/resume-after-failure-skips-the-failed-step.md`.

## Steps to Reproduce

1. Use a workflow of four script steps where step 0 is `false`. Run it with
   `ctrlyoke run`, and it stops at step 0 in state `error`.
2. Export the run with `ctrlyoke export --workflow <key> --run 1 --out /tmp/b2`.
3. In a clone, run `ctrlyoke import /tmp/b2.ctrlyokerun --continue --changes skip`.
   (`--changes skip` gets around
   `import-continue-rejects-bundle-with-empty-patch.md`.)
4. Run `ctrlyoke history steps --workflow <imported>`. Step 0 is `failed`
   with 1 attempt, and steps 1-3 are `completed`.

For comparison, `ctrlyoke continue` on the original run retries step 0
(attempts go to 2).

## Root Cause

- `RunBundleImporter.normalizeImportedRuntime` sets
  `executionState = EXECUTION_STATES.STOPPED` (around line 515). The importer
  also passes `STOPPED` to `materialize` for continuable bundles (around lines
  211-213).
- `PromptQueue.rewindTerminalFailureForContinuation` (around line 933) works
  from the terminal-failure state and rewinds only when the run is in
  `error`. Because the imported run is `stopped`, continuation starts at
  `currentIndex`, one past the failure.
- `RunBundleExporter.getNextStep` (around line 352) reports that same
  un-rewound index, so `nextStep` and `pendingSteps` are wrong as well.

## Suggested Fix

Keep the source run's `error` state, including whatever terminal-failure
markers the rewind relies on, when importing a continuable bundle. Another
option is to apply the same terminal-failure rewind during import. Compute the
exporter's `nextStep` and the preview's `pendingSteps` from the rewound
position, so the preview, the manifest and the actual continuation agree.

Add regression tests in the importer/exporter unit tests: an imported errored
run continues by re-running the failed step, and `nextStep` names that step.
