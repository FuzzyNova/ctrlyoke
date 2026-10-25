# Prompt-to-file conversion and image-paste timeouts report failure for work the host still completes, leaving orphan files

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (ui)
- **Area:** `src/ui/webview-react/components/editor/PromptEditor.tsx`
- **Resolution:** fixed in this commit

## Symptom

When the extension host takes more than 30 s to answer, these actions fail in the UI even though the host then does the work:

- "Convert prompt to file" shows "Timed out converting prompt to a file", but `.ctrlyoke/prompts/<name>` is still created.
- Pasting an image shows "Timed out saving pasted image" and removes the placeholder, but the image is still written to disk.
- Capturing an output snapshot behaves the same way.

The editor never references the file, and the natural retry creates a second copy.

## Steps to Reproduce

1. Get a message stuck behind a long handler on the shared `routeQueue` (a 46.7 s `loadRunView` and a 19.4 s `ready` appear in the session logs). On the hosted dashboard, a socket that reconnects just after the post has the same effect.
2. Click "Convert to prompt file", or paste an image into the prompt editor.
3. After 30 s the error toast appears and the editor is unchanged. When the queue drains, the host writes the file. Its `PROMPT_FILE_CREATED` / `PASTED_IMAGE_SAVED` reply is ignored.
4. Retry: a second file is created (e.g. `name-2.prompt.md`, or another pasted image).

## Root Cause

- `src/types/DashboardConstants.ts:3091`, `:3094`, `:3097`: `PASTED_IMAGE_SAVE_TIMEOUT_MS = 30_000`, `OUTPUT_SNAPSHOT_SAVE_TIMEOUT_MS` (same value) and `PROMPT_FILE_CONVERSION_TIMEOUT_MS = 30_000`. These are fixed client-side deadlines on requests that wait in the shared serialized `routeQueue` (`src/ui/WebviewMessageRouter.ts:466`). Waits there can be longer than 30 s.
- `PromptEditor.tsx:704-713`: on timeout, `conversionSeqRef.current = 0` and an error is shown. `:738` then drops the late reply (`message.seq !== conversionSeqRef.current`).
- `CodeMirrorEditor.tsx:785-787` (paste) and `:703` (snapshot): the timeout calls `handlePastedImageSaved(seq, undefined, "Timed out ...")`. `resolvePendingPlaceholder` (`:649-652`) deletes the pending entry, so the late success has nothing to resolve.
- Host side: `CONVERT_PROMPT_TO_FILE` / `SAVE_PASTED_IMAGE` / `SAVE_OUTPUT_SNAPSHOT` (`WebviewMessageRouter.ts:1423`, `:1453`, `:1457`) are not in `OFF_QUEUE_MESSAGE_TYPES` (`:191-198`), and no cancel message exists. `PromptEditorSupportService.handleConvertPromptToFile` (`:700`, `createPromptFile` at `:718`) and `handleSavePastedImage` (`:840`) always run to completion.

The timeout is treated as a failure, but it only means the request has not been answered yet.

## Suggested Fix

These are short file writes that only got slow because they queued behind unrelated work. A longer timeout is not the fix.

- Move these three message types off-queue (they write a new file and touch no state that other handlers serialize on), so they are answered in milliseconds no matter what else is running.
- Keep a client deadline only as a guard against a dead transport. When it expires, keep the seq so a late success can still be applied, or tell the user "still waiting" rather than reporting a failure. If a late success arrives after the user has moved on, insert or announce the created file rather than dropping it.
- Alternatively, send a cancel message so the host can skip the write if it has not started yet.
