# Markdown export shows 1M-token context windows as "1000.0k"

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/ui/webview-react/utils/markdownExport.ts`
- **Severity:** low

## Symptom

A scratch vitest calling the real `generateMarkdownExport` with
`contextWindowUsed: 999_960, contextWindowSize: 1_000_000` printed
`*Context: 1000.0k/1000.0k (100%) …*`. With 150k/200k it printed `150.0k/200.0k (75%)`, which is
fine. Any value of 1,000,000 or more is shown in "k" with no "M" unit.

## Steps to Reproduce

1. Export a step's output to markdown from a run using a 1M-context model.
2. The context line reads `1000.0k`.

## Root Cause

`markdownExport.ts:~531` has a private formatter, `n >= 1000 ? (n/1000).toFixed(1)+"k" : n`. The
earlier `token-count-unit-rollover-shows-1000k` fix unified the other formatters on the shared
ladder in `src/utils/TokenFormatting.ts` but missed this copy.

## Suggested Fix

Delete the private formatter and use the shared `formatTokenCount` (or the matching compact helper)
from `src/utils/TokenFormatting.ts`. Add tests for 1,000,000 and 999,960.
