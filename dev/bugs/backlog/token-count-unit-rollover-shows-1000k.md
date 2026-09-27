# Token counts just under a unit boundary render as "1000k" / "1000M"

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/utils/TokenFormatting.ts` (`formatTokenCount`), `src/utils/StatuslineFormat.ts` (`compactTokenCount`)
- **Severity:** low

## Symptom

Token counts that round up to the next unit are shown with the smaller unit:

```
formatTokenCount(999_949)     // "999.9k"  (correct)
formatTokenCount(999_950)     // "1000k"   expected "1M"
formatTokenCount(999_999)     // "1000k"   expected "1M"
```

(Reproduced by running the source with `tsx`.) `formatTokenCount` feeds the CLI
token/context line (`CliTerminalFormatter.ts`), the dashboard output row
(`OutputRow.tsx`), step token labels (`WorkflowStep.tsx`) and the stats harness
share rows. The statusline's private `compactTokenCount` has the same shape and would
render `999_999` as `"1000.0k"` and `999_999_999` as `"1000.0M"`.

## Steps to Reproduce

1. `npx tsx -e 'import {formatTokenCount} from "./src/utils/TokenFormatting"; console.log(formatTokenCount(999_999))'`
2. Output is `1000k`.

## Root Cause

Both helpers pick the unit by comparing the raw value against the threshold, then
round with `toFixed(1)`. Values in `[999_950, 1_000_000)` pass the `>= 1_000`
branch but round to `1000.0`. The same happens at the M→B boundary in
`compactTokenCount`. There are no boundary tests in
`src/test/unit/TokenFormatting.test.ts`, and none for `compactTokenCount`.

## Suggested Fix

Choose the unit from the *rounded* value: after scaling and rounding to one decimal,
if the result is `>= 1000` promote to the next unit. Single-source the unit ladder
(k/M/B) in `TokenFormatting.ts` and have `StatuslineFormat.compactTokenCount` reuse it
(keeping the statusline's sign handling and its always-one-decimal style if that is
intentional, e.g. via an option) instead of maintaining a second copy. Add tests for
`999_949`, `999_950`, `999_999`, `1_000_000` in both paths, plus `999_999_999` for the
statusline's M→B boundary.
