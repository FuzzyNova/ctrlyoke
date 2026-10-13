# A settings number input keeps showing a value that was never stored when the commit normalizes back to the old value

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch vitest test rendering `LocalNumberInput`)
- **Area:** `src/ui/webview-react/hooks/useLocalInput.ts` (`useLocalValue`)
- **Resolution:** fixed in this commit

## Symptom

`LocalNumberInput` with `value = 1` and
`parse = (v) => parseInt(v, 10) || 1`. This is the pattern used for
`queue.maxParallelSteps` in `QueueSection.tsx` and in `CoordinationSection.tsx`.
Focus the field, type `0`, and blur. The stored value stays `1`, but the input
keeps displaying `0`. It looks as though the setting is 0 until the panel
re-renders from elsewhere.

## Steps to Reproduce

1. Render `LocalNumberInput` with `value={1}` and the parser above.
2. Focus, type `0`, blur.
3. The input shows `"0"`. Expected: `"1"`.

## Root Cause

`useLocalValue` resyncs its local state only in an effect keyed on
`externalValue` (`useLocalInput.ts` ~16-20). When the committed value is
parsed or clamped back to the value the field already had, the store doesn't
change, `externalValue` doesn't change, the effect doesn't run, and the raw
local text survives.

## Suggested Fix

After `onCommit` in `onBlur`, reset the local value to the latest external
value (kept in a ref). If the commit changes the store, the effect then
replaces it with the new value as usual. Don't break the existing guarantee
that external updates are ignored _while_ editing. Add
`src/ui/webview-react/test/hooks/useLocalInput.test.tsx` (no test exists for
this hook yet).
