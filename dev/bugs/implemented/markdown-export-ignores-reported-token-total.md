# Markdown Export Ignores the Reported Token Total

- **Found:** 2026-11-08 by smell hunt pass 4
- **Area:** `src/ui/webview-react/utils/markdownExport.ts`
- **Resolution:** fixed in this commit

## Symptom

When a provider reported a total that differed from input plus output, the
Markdown export showed the calculated sum instead of the provider's total.

## Root Cause

The export added prompt and completion counts directly rather than using the
shared `resolveTokenTotal` helper.

## Fix

The export now resolves totals through the shared helper and computes the
context-window percentage through `calcContextPct`.
