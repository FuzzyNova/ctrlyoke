# Collapsed output preview counts a trailing newline as an extra hidden line

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/ui/webview-react/utils/outputTruncation.ts` (`countLines`, `buildCollapsedOutputPreview`)
- **Resolution:** fixed in this commit

## Symptom

Scratch vitest against the real function:

- `buildCollapsedOutputPreview("a\nb\nc\nd\ne\n", { expanded: false, maxLines: 3, maxChars: 1000 })`
  returns `fullLineCount: 6`, `hiddenLineCount: 3` (label "show 3 more lines"). Expected 5 lines,
  2 hidden.
- `"a\nb\nc\nd\n"` with `maxLines: 3` returns `isTruncated: true` with 2 hidden lines. Only `d` is
  hidden, so the "don't hide just one line" rule should have shown everything.

Bash, tool and script output almost always ends with `\n`, so collapsed rows routinely overstate
the hidden count by one and collapse output the design says should stay visible. The row-height
estimate in `outputRows.ts` (~1369) inherits the same miscount.

## Steps to Reproduce

1. Produce a tool/script output of `maxLines + 1` lines ending in a newline.
2. It collapses with "show 2 more lines" instead of showing in full.

## Root Cause

`countLines` (`outputTruncation.ts:~182`) is `text.split("\n").length`, which counts the empty piece
after a trailing newline. `visibleText` has trailing newlines stripped, so `fullLineCount -
visibleLineCount` is one too high. The file's own `stripTrailingNewline`/`getLineStartOffsets`
helpers already handle this correctly.

## Suggested Fix

Count lines on the text with a single trailing newline removed (reuse `stripTrailingNewline`), and
check the `outputRows.ts` caller uses the same helper. Tests for both examples above.
