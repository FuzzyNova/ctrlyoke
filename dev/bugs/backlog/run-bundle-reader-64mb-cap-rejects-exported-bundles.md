# Run bundle reader refuses events.jsonl over 64 MB, but the exporter writes bundles of any size and long runs exceed it

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (core-orchestration)
- **Area:** `src/core/orchestration/RunBundleReader.ts`
- **Severity:** low

## Symptom

`ctrlyoke run export` (`src/cli/RunExportCommand.ts`) writes a run bundle with no size limit. The only reader of those bundles, `readRunBundle`, used by the replay loader in `src/dev/replay/RunReplaySession.ts`, rejects any bundle file over 64 MiB with `events.jsonl in <dir> is too large to load.` Long agentic runs are the ones most worth exporting for a bug report or a replay, and they produce bundles that ctrlyoke cannot load. The exporter gives no warning, so the failure only appears when someone tries to open the bundle.

Measured on this user's history (`~/.ctrlyoke/projects/ctrlyoke-81d730fe53ae/.runs`), the largest `events.jsonl` files are 98.4 MB, 85.3 MB, 50.5 MB and 46.6 MB. In the 98.4 MB run, `cliOutputEventsAppended` (44.0 MB) and `cliOutputRecorded` (40.1 MB) make up most of it. The export keeps both. Only `workspaceSnapshotCaptured` (13.9 MB) is dropped by default, so the exported `events.jsonl` is still about 84 MB, over the cap.

## Steps to Reproduce

1. Find a long run whose `events.jsonl` holds more than 64 MB of non-snapshot events (here, `more-bug-backlog2-2026-10-02T00-06-20-309`).
2. Run `ctrlyoke run export` for that run. It succeeds and writes the bundle.
3. Load the bundle with the run replay tooling (`RunReplaySession`, which calls `readRunBundle`).
4. The load fails with `RunBundleFormatError: events.jsonl in <bundle> is too large to load.`

## Root Cause

- `src/core/orchestration/RunBundleReader.ts:27` sets `MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024`, and the comment justifies it by the hero fixture being under 1 MB.
- `readText` (`RunBundleReader.ts:89-108`) rejects any file over the cap (lines 102-106), then reads the whole file into one string. `readRunBundle` (lines 63-74) splits it into lines and parses each one.
- `writeEvents` in `src/core/orchestration/RunBundleExporter.ts:267-289` streams every event except snapshot, undo and redo events (`SNAPSHOT_EVENT_TYPES`, lines 59-64) into `events.jsonl`. It does no size accounting, so the writer and the reader disagree about what a valid bundle is.

## Suggested Fix

The fix is to stream the events instead of using a fixed whole-file cap:

- Read `events.jsonl` line by line (`readline` over `fs.createReadStream`), with a per-line size cap that protects against an untrusted bundle containing one enormous line. Keep the whole-file cap only for the small JSON files (`bundle.json`, `manifest.json`, the definition). The replay builds its script from the events, so if memory is the concern, consume them as an async iterable rather than an array.
- If a total cap stays, enforce the same constant in `writeEvents` and fail the export with a clear message (or offer an option to drop CLI output detail), so the exporter never writes a bundle the reader will reject.
- Add a test that exports a run larger than the reader's limit and loads it back.
