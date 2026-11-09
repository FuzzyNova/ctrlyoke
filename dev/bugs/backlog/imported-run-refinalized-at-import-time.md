# Importing a run bundle re-finalizes the run: a second `runTerminated` at import time, wrong end time, and its duration is lost

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/RunMaterializer.ts` (`materialize`, the `history.finalizeRun(...)` call after the imported events are appended), `src/core/orchestration/OutputHistoryManager.ts` (`finalizeRun`)
- **Severity:** medium

## Symptom

After `ctrlyoke import <bundle>` (or the dashboard's Import), the imported
run's history differs from the run that was exported:

- `events.jsonl` has **two** `runTerminated` events: the one copied from the
  bundle (original end time) and a new one stamped with the import time.
  `ctrlyoke history show` prints `ℹ Run terminated: completed` twice.
- `manifest.json`'s `completedAt` and `lastUpdatedAt` become the import time,
  not the time the run ended. The dashboard's run row
  (`RunSummaryRow.tsx`, `formatRelativeTimeVerbose(summary.completedAt ?? …)`)
  shows the import time as when the run finished. A run exported a week ago
  reads as finished "just now".
- `manifest.json` loses `activeExecutionMs`, so the run row shows no
  duration at all.

## Steps to Reproduce

```sh
R=/tmp/cyexp; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q
export CTRLYOKE_HOME=$R/home
cat > e.ctrlyoke.yaml <<'EOF'
name: e
steps:
  - type: script
    script: echo hello-one
  - type: script
    script: echo hello-two
EOF
ctrlyoke run e.ctrlyoke.yaml --headless
ctrlyoke export --workflow e -o $R/b
sleep 5
ctrlyoke import $R/b.ctrlyokerun
ctrlyoke history show --workflow <imported key> | tail -3   # "Run terminated: completed" twice
grep -c runTerminated $CTRLYOKE_HOME/projects/*/.runs/<imported key>/run-*/events.jsonl   # 2
```

Observed manifests (original, then imported):

```
original: "completedAt":1794206394270,"activeExecutionMs":115
imported: "completedAt":1794206399310            (import time, no activeExecutionMs)
bundle:   "completedAt":1794206394270,"activeExecutionMs":115
```

## Root Cause

`RunMaterializer.materialize` appends every event from the bundle, including
its `runTerminated`, then calls
`history.finalizeRun(manifestPath, executionState, steps.length)`.
`finalizeRun` is the live-run completion path: it unconditionally appends a
new `RUN_TERMINATED` event with `timestampMs: Date.now()` and rewrites the
manifest's `completedAt`/`lastUpdatedAt` to now. No `activeExecutionMs` is
passed, so the value the bundle's manifest carried is never restored.

## Suggested Fix

Don't run the live finalization on an imported timeline that already ended.
In `materialize`, track whether the imported events contained a
`RUN_TERMINATED` event (and keep the last one's `timestampMs`). If they did,
update the manifest directly instead of calling `finalizeRun`: set
`completedAt`/`lastUpdatedAt` to that event's timestamp, `executionState`,
`stepCount`, and the bundle manifest's `activeExecutionMs` when the import
input carries it (add it to `RunMaterializationInput` from the bundle's
manifest in `RunBundleImporter` if it isn't already there). Keep the token
rollup and usage-store and search-index work `finalizeRun` does, either by
extracting it into a helper that both paths call, or by giving `finalizeRun`
an option to skip the event append and accept explicit `completedAt`/
`activeExecutionMs`. Only fall back to appending a terminal event when the
bundle had none.

Tests: in `src/test/unit/RunBundleImporter.test.ts` (or a `RunMaterializer`
test), import a bundle whose timeline ends in `runTerminated` and whose
manifest has `completedAt`/`activeExecutionMs`. Assert the imported
`events.jsonl` has exactly one `runTerminated`, and the imported manifest's
`completedAt` and `activeExecutionMs` equal the bundle's.
