# CLI Diff Rendering Skips Dashboard Patch Normalization

- **Found:** 2026-11-10 by smell hunt
- **Area:** `src/cli/CliTerminalFormatter.ts`
- **Resolution:** fixed in this commit

## Symptom

CLI file edit diffs can display patch metadata as content, show duplicate hunks,
and mark unchanged lines as changed when old and new content use mixed Windows
and Unix line endings.

## Steps to Reproduce

1. Render a structured patch containing `\\ No newline at end of file` or git
   hunk metadata.
2. Render a structured patch with an exact duplicate hunk.
3. Render identical old/new content with mixed `\r\n` and `\n` endings.
4. Observe metadata lines or duplicate content in the first two cases, and
   unnecessary additions/removals in the third.

## Root Cause

`CliTerminalFormatter` carried private copies of diff helpers from the webview.
Those copies did not skip non-displayable patch metadata, normalize structured
patches, or normalize CRLF before comparing raw content.

## Suggested Fix

Keep diff-line parsing, structured-patch normalization, and raw-content diffing
in a shared, browser-safe utility used by both the CLI and webview.
