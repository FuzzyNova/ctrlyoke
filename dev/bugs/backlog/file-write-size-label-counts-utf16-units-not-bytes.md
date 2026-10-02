# File-write header "Wrote (N KB)" reports UTF-16 code units, not bytes

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with `formatBytes`
- **Area:** `src/ui/webview-react/utils/outputLineMetrics.ts` (`fileWriteActionLabel`)
- **Severity:** low

## Symptom

The completed file-write header in the dashboard output reads "Wrote (N KB)",
but N is the file content's JavaScript string length, not its byte size. For
non-ASCII content it under-reports: 3,000 CJK characters are 8.8 KB of UTF-8, yet
the header says "Wrote (2.9 KB)". Content outside the BMP (emoji) is also
counted as two units per character.

## Steps to Reproduce

1. Run a step that writes a file of `"日本語".repeat(1000)`.
2. The output row header shows `Wrote (2.9 KB)`. The file on disk is 9,000 bytes.

## Root Cause

`fileWriteActionLabel` (`outputLineMetrics.ts:234-236`) calls
`formatBytes(content.length)`, and `formatBytes` expects a byte count.

## Suggested Fix

Pass the UTF-8 byte length: `new TextEncoder().encode(content).length`. This is
webview code, so `Buffer` isn't available. The label also feeds the header-width
estimator, so keep the function as the single source both use. Add a Vitest case
with multibyte content.
