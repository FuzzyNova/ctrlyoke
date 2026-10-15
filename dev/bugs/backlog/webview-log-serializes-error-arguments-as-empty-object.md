# WebviewLog serializes Error arguments as {} and drops the error message from the session log

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/utils/logger.ts`
- **Severity:** low

## Symptom

If a webview log call passes a caught `Error` as an extra argument, the session log records only `[{}]`. The error message and stack are lost. If an argument is circular or contains a `BigInt`, the `WebviewLog` call itself throws a `TypeError` into the caller.

## Steps to Reproduce

1. Open the dashboard workspace explorer and copy a file.
2. Paste it somewhere the copy will fail, so that `workspaceCopyEntry` rejects with an `Error`. A read-only directory or a name collision the backend rejects both work.
3. Open `.ctrlyoke/logs/ctrlyoke-<timestamp>.log`. The line reads `[useWorkspaceExplorerContextMenu] Paste failed: [{}]` and has no message or stack.

## Root Cause

`log()` in `src/ui/webview-react/utils/logger.ts:13` builds the forwarded text with `JSON.stringify(args)`. The `message` and `stack` properties of an `Error` are non-enumerable, so an `Error` serializes to `{}`.

That `JSON.stringify` call also runs before the `try` block that starts at `logger.ts:14`. When serialization fails on a circular structure or a `BigInt`, the exception therefore reaches the caller instead of being contained by the logger.

These callers pass caught errors as extra arguments:

- `src/ui/webview-react/hooks/useWorkspaceExplorerContextMenu.tsx:181`: `WebviewLog.error("[useWorkspaceExplorerContextMenu] Paste failed:", err)`
- `src/ui/webview-react/components/output/DiffView.tsx:534`: `WebviewLog.warn("[DiffView] syntax tokenization failed", error)`
- `src/ui/webview-react/components/output/MarkdownText.tsx:675`: image thumbnail download failure
- `src/ui/webview-react/components/output/MarkdownText.tsx:1150`: Mermaid PNG export failure

## Suggested Fix

Add a safe formatter in `logger.ts` that formats each argument before the text is joined:

- An `Error` becomes `${name}: ${message}`, followed by its `stack`.
- A string is passed through unchanged.
- Anything else goes through `JSON.stringify` with a replacer that tracks seen objects in a `WeakSet` to handle cycles and converts `BigInt` values to strings. Wrap that call in `try/catch` and fall back to `String(arg)`.

Build `text` from the formatted arguments inside a `try` so the logger can never throw. Add a Vitest case that checks two things: the message of an `Error` argument appears in the posted `LOG_MESSAGE`, and a circular argument does not throw.
