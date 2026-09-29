# Icon colorizing chains its replacements, so custom colors can collide

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/PngIconService.ts` (around lines 79-82), `src/server/CtrlYokeHostedServer.ts` (`serveColorizedSvg`, around lines 1915-1918)
- **Resolution:** fixed in this commit

## Symptom

If the configured icon background equals the default foreground color (`#051923`), for example
when a user swaps the two defaults, the icon renders as one solid color.

## Steps to Reproduce

Applying the replacement chain to `images/ctrlyoke-app-icon.svg` with bg `#051923` and fg
`#3994BC` leaves only `#3994BC` (×5) in the output.

## Root Cause

Both call sites replace `#3994BC` → bg, then `#051923` → fg, one after the other. The second pass
also rewrites the background that the first pass just inserted. The two sites are copies of the
same logic.

## Suggested Fix

Single-source the colorize step in one helper that does a single-pass replace, e.g.
`svg.replace(/#3994BC|#051923/gi, (m) => (m.toUpperCase() === "#3994BC" ? bg : fg))`, and use it
from both call sites. Add a test with swapped colors.
