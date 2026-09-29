# `history --since/--until` accept impossible dates and read date-times as local time while showing UTC

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli/HistoryTime.ts` (`parseHistoryTime`, around lines 32-36), `src/cli/HistoryInspectionCommands.ts` (time display, around lines 823-831), `docs/cli/ctrlyoke.md`
- **Resolution:** fixed in this commit

## Symptom

1. Impossible calendar dates are silently rolled forward instead of rejected, so a typo filters the
   wrong range.
2. Date-only input is read as UTC, but a date-time without an offset is read as **local** time.
   The history listings print UTC times with no `Z` (e.g. `2026-09-20 17:00`). So pasting a
   displayed time back into `--since 2026-09-20T17:00` is off by the machine's UTC offset and misses
   the run it was copied from.

Verified by an agent with the real `parseHistoryTime` on a UTC-5 machine:

| Input              | Parsed as           | Problem                            |
| ------------------ | ------------------- | ---------------------------------- |
| `2026-02-30`       | `2026-03-02T00:00Z` | should be rejected                 |
| `2026-04-31`       | `2026-05-01T00:00Z` | should be rejected                 |
| `2026-09-20`       | `2026-09-20T00:00Z` | UTC                                |
| `2026-09-20T00:00` | `2026-09-20T05:00Z` | local, 5 hours off from line above |

## Root Cause

`parseHistoryTime` only checks the shape with a regex, then calls `Date.parse`. V8 rolls invalid
days forward, and ECMAScript treats date-only strings as UTC but offset-less date-times as local.

## Suggested Fix

- Reject dates whose year/month/day don't round-trip through the parsed `Date`.
- Read offset-less date-times as UTC, matching the date-only case and the UTC display. Say so in
  the `--since/--until` help and `docs/cli/ctrlyoke.md`. Explicit offsets (`Z`, `+02:00`) keep
  working.
- Unit tests for the table above plus an explicit-offset case.

## Related docs defect (same area)

`docs/cli/ctrlyoke.md`'s `history search` section says the printed
`--workflow … --run … --step …` selector is copy-pasteable "for `history show` and the step
commands". The step commands (`step edit/remove/reorder`) take a required `--index` and have no
`--step` option (`src/cli/StepCommandDefinitions.ts`), and `--step final` has no step-command
equivalent. Reword the docs to say the selector is for `history show` only.
