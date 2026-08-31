# Output Panel Context Capture Plan

> **Status:** Not implemented.

## Goal

Let users pull content out of a VS Code **Output panel** channel (e.g. the built-in "Agent
Host" log, or any extension's output channel) into a ctrlyoke prompt as attached context —
either a selected line range or the whole channel — the same way `@file` and `#selection:`
already do for real files on disk.

## Bug This Fixes

Today, selecting text in an Output-panel editor produces a completion that looks correct but
can never resolve:

- `getSelectionCompletions()` (`src/completions/CompletionHelpers.ts:889`) walks
  `vscode.window.visibleTextEditors` and treats every entry alike. VS Code implements each
  Output channel as a real `TextEditor`/`TextDocument` pair with URI scheme `output:`, so it
  shows up in that list indistinguishably from a real file editor.
- The handler calls `vscode.workspace.asRelativePath(document.uri, ...)` on that `output:` URI
  and gets back a garbled pseudo-path (e.g. `agenthost` for the "Agent Host" channel), then
  offers a normal `#selection:agenthost:17-28` completion for it.
- That completion lints and inserts cleanly — it looks like a valid reference — but can never
  expand. `ContextExpander.buildAttachmentXml()` (`src/utils/ContextExpander.ts:944-956`)
  resolves every `#selection:` reference to an absolute filesystem path and reads it with
  `fs.readFile`. Output-channel content only ever exists in memory (the channel's own
  `TextDocument`), never on disk, so no path resolution fix can make this work — the
  file-based resolution path is structurally the wrong mechanism for it.

Fixing this means *not* offering a plain `#selection:` completion for `output:`-scheme editors
at all, and replacing it with a real capture mechanism (below).

## Design: Snapshot, Not Live Reference

Already decided in discussion: capture the text once, at reference-creation time, and store it
as a real file — do **not** try to re-resolve an `#output:` reference against the live output
document at run time. A workflow step can execute long after the log has scrolled, changed, or
the panel has closed, so "live re-read by channel name" is fragile in a way that plain
`#selection:file:range` isn't (files are stable; scrollback isn't). A captured log excerpt is
inherently a point-in-time record anyway — that's the correct semantic, not a compromise.

This mirrors the pasted-image flow exactly, which already solves "capture ephemeral content
now, store it as a durable file, reference the file":

- `TempFileManager.getAttachmentsDir()` — a **content-addressed, globally deduped** store at
  `.ctrlyoke/temp/attachments/` (gitignored; a sibling of the swept `temp/` dir, but this one
  persists — see the doc comment on `getAttachmentsDir()`).
- `TempFileManager.createPastedImageFile()` (`src/utils/TempFileManager.ts:341`) sha256-hashes
  the bytes, writes `pasted-image-<hash>.<ext>` only if it isn't already present, and refreshes
  mtime on a dedup hit.
- `PromptEditorSupportService.handleSavePastedImage()` (`src/ui/PromptEditorSupportService.ts:637`)
  is the message handler VS Code-side; `MESSAGE_TYPES.SAVE_PASTED_IMAGE` /
  `MESSAGE_TYPES.PASTED_IMAGE_SAVED` is the round trip; `CodeMirrorEditor.tsx`'s
  `processPastedImageFile`/`handlePastedImageSaved`/`resolvePendingPaste`
  (`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx:962-1051`) is the editor-side
  placeholder-then-resolve flow.

Proposed equivalents:

- A text-oriented sibling of `createPastedImageFile` (either a new
  `createOutputSnapshotFile(text, targetDir)` or a small generalization of the existing method
  to accept text as well as binary) that hashes the UTF-8 bytes and writes a readable filename
  (convention below) under the same `getAttachmentsDir()`.
- A new message pair mirroring `SAVE_PASTED_IMAGE`/`PASTED_IMAGE_SAVED` (e.g.
  `SAVE_OUTPUT_SNAPSHOT` / `OUTPUT_SNAPSHOT_SAVED`) and a
  `PromptEditorSupportService.handleSaveOutputSnapshot()`.
- A size cap analogous to `MAX_PASTED_IMAGE_BYTES` (15 MB) — a full "Agent Host" channel could
  be enormous; cap and/or truncate-from-the-end with a note in the attachment, rather than
  writing an unbounded file.

### Filename convention

Unlike pasted images (`pasted-image-<hash>.<ext>`, where the hash alone is fine — there's
nothing else meaningful to name an image by), output snapshots should stay readable in a
directory listing rather than being named purely by hash. Decided:
`output-<channel>-<startLine>-<endLine>-<hash>.log`, e.g. `output-agenthost-17-28-123456abc.log`
for a range capture. `output` leads (not the channel name) specifically so every output
snapshot sorts and groups together alphabetically in the attachments folder, separate from
`pasted-image-*` and any other future attachment category. Full-channel capture (no range) uses
`output-<channel>-full-<hash>.log` — keep the same field order and an explicit `full` marker
rather than omitting the range fields outright, so the naming stays uniform and
`grep`/`ls`-scannable regardless of which capture mode produced a given file. `<channel>` is
the same mangled slug `asRelativePath` already produces today (`agenthost`) — no separate
slugification step needed, and no dependency on resolving a friendly display name (see Open
Questions) just to name the file. The trailing `<hash>` still does the real dedup/uniqueness
work; the rest is purely for human scanning.

## Syntax: No New Token — Reuse `@file`

**Decided in discussion, superseding an earlier draft of this plan that proposed a dedicated
`#output:channel:range` token.** Pasted images already establish the right precedent:
`handleSavePastedImage` writes the captured bytes into the content-addressed attachments store
and returns a plain `@<relativePath>` reference — no dedicated syntax, no new parser/builder/
chip/lint code, 100% reuse of the existing file-reference machinery. Output capture should do
exactly the same thing:

- **Whole-channel capture** shows up as an ordinary entry in the **`@` completions dropdown**
  (`getAtCompletions`/`getFileCompletions`), alongside real files — labeled something like
  "Agent Host (Output)". Picking it captures the channel's full text, writes it to the
  attachments store, and inserts a normal `@<attachmentPath>` — semantically identical to
  attaching a whole file.
- **Range capture** keeps showing up in the **`#` completions dropdown**
  (`getHashCompletions`/`getSelectionCompletions`) exactly as it does today for a real editor
  selection (the "selection: Agent Host (lines 17–28)" entry) — the discoverability and
  wording don't need to change. What changes is only what gets *inserted*: instead of the
  currently-broken `#selection:agenthost:17-28`, picking it captures the selected text, writes
  it to the attachments store, and inserts `@<attachmentPath>` — same conversion as the
  whole-channel case, just scoped to the selected range instead of the full document.

This eliminates essentially the entire "new syntax" surface from the earlier draft: no new
`ATOMIC_REFERENCE_KINDS`/`ContextReferenceType` value, no `FileReferenceParser`/
`ReferencePatterns` regex, no `ContextReferenceBuilder` functions, no chip-rendering changes in
`atomicReferences.ts`, no new lint/validation path. `ContextExpander` already knows how to
expand a plain `@file` reference — an output capture just becomes another file on disk that
happens to live in `.ctrlyoke/temp/attachments/`.

The one thing this design gives up: a generic file chip rather than a purpose-built
semantically-labeled one ("Output: Agent Host, lines 17–28"). The readable filename convention
above (`output-agenthost-17-28-123456abc.log`) softens this — the chip still reads as a plain
`@file` reference, but the filename itself carries the channel/range at a glance instead of
being an opaque hash — and the completion's own preview/documentation already told the user
what they were inserting at pick time. Acceptable trade for the much lower implementation cost.

## Capture-Timing Gotcha (read before implementing)

Pasted images capture at the moment of a direct user gesture (the paste event itself), a single
synchronous handler with the clipboard data already in hand. Output capture doesn't have an
equivalent single gesture — the completion **list** is built once (`getAtCompletions`/
`getSelectionCompletions`), but the user's actual **pick** is a separate round trip through
CodeMirror's async completion machinery, by which time the extension host has moved on and the
channel content or "current selection" may have changed (especially for a streaming/live log).

Do **not** capture-and-write-to-disk eagerly while building either completion list — both
re-run on every keystroke of the `@`/`#` query, and would spam the attachments store with
mostly-unpicked captures of a scrolling log (content-addressed dedup only mitigates *identical*
repeats, not a log that's actively changing).

Recommended approach: reuse the existing placeholder-then-resolve pattern already built for
pasted images (`PASTING_IMAGE_PLACEHOLDER` / `resolvePendingPaste` in `CodeMirrorEditor.tsx`).
Capture the actual text once, synchronously, when the completion *item* is built (the extension
host already reads `document.getText(selection)` for the preview shown in today's `#selection:`
completion `documentation` field — same moment, just also keep the full text, and the same for
a whole-channel `@` item's `document.getText()`) and hold it server-side in a short-lived
pending-capture cache keyed by a per-item id, not written to disk yet. Only on pick does the
webview send a follow-up message with that id; the handler writes the already-captured text to
the content-addressed attachment file and resolves the placeholder to `@<attachmentPath> ` —
mirroring `handleSavePastedImage`/`PASTED_IMAGE_SAVED` exactly, just fed from the cache instead
of a fresh clipboard read. This avoids both the staleness problem (re-reading a live document
later) and the disk-spam problem (writing on every keystroke).

## Completion Behavior Changes

Two independent completion sources change, both gaining an `output:`-scheme branch. Neither
introduces a new trigger character — both keep using the trigger that already fits the
semantic (`@` = attach the whole thing, `#` = attach a selection):

- **`getFileCompletions()`/`getAtCompletions()`** (`@` trigger): today only lists real
  workspace files/directories. Add entries for every visible `output:`-scheme editor
  (whole-channel attach), labeled like "Agent Host (Output)". Picking one triggers the
  capture-then-placeholder flow and resolves to `@<attachmentPath>` — same end shape as any
  other `@` file completion, just sourced from a live document instead of disk.
- **`getSelectionCompletions()`** (`#` trigger): keeps offering a "selection: Agent Host
  (lines 17–28)" entry for a non-empty selection in an `output:`-scheme editor exactly as it
  does today for real files — this is the fix for the reported bug, and requires no change to
  *when* the item appears, only to what picking it produces. Today it inserts
  `#selection:<mangled-path>:<range>` (broken); after this change it triggers the same
  capture-then-placeholder flow and resolves to `@<attachmentPath>`.

Both need the underlying capture: reading `document.getText()` (whole channel) or
`document.getText(selection)` (range) for an `output:`-scheme `TextEditor`, exactly as
`getSelectionCompletions()` already does for the preview text in its `documentation` field
today — just retained in full rather than truncated to 100 chars, per the pending-capture cache
described above.

## Affected Components

| Component | Planned role |
| --- | --- |
| `src/completions/CompletionHelpers.ts` (`getFileCompletions`/`getAtCompletions`, `getSelectionCompletions`) | Add `output:`-scheme entries to the `@` list; keep the `#` selection entry but reroute what picking it inserts |
| `src/utils/TempFileManager.ts` | Add a text/content-addressed sibling of `createPastedImageFile` |
| `src/ui/PromptEditorSupportService.ts` | New `handleSaveOutputSnapshot` mirroring `handleSavePastedImage`; pending-capture cache keyed by completion-item id |
| `src/ui/WebviewMessageRouter.ts` | Register the new message pair |
| `src/types/WebviewMessageTypes.ts` / `MESSAGE_TYPES` | New message type constants |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` | Placeholder-then-resolve flow for the picked capture item (both `@` and `#` sources), mirroring `processPastedImageFile`/`resolvePendingPaste` |
| `src/completions/PromptCompletionProvider.ts` (native VS Code editor path, not the webview) | Same `@`/`#` branching for prompt files edited directly in a VS Code text editor |

No changes needed in `FileReferenceParser.ts`, `ReferencePatterns.ts`, `ContextReferenceBuilder.ts`,
`atomicReferences.ts`, or `ContextExpander.ts` — the inserted token is always a plain `@file`
reference, which all of these already handle.

## Non-Goals

- Live/streaming attachment of output content that updates as the channel keeps logging —
  snapshot only, captured once at insertion time.
- Capturing terminal panel content (a different VS Code surface, `Terminal`/shell integration
  APIs, not `TextEditor`/`TextDocument`) — out of scope for this plan.
- Any change to how `#selection:`/`@file` behave for ordinary file editors.

## Open Questions

- **Recovering a friendly channel display name.** The `output:` URI's path segment is an
  internal slug (`agenthost`), not the channel's real label ("Agent Host"). VS Code doesn't
  expose a documented public API mapping an arbitrary `output:` URI back to its display name.
  `vscode.window.tabGroups` exposes tab labels for output channels opened as *editor tabs*, but
  the classic bottom **Output panel** (not detached into a tab) may not appear there at all —
  needs a spike before committing to a UX that shows the real name in the chip/completion list.
  If no reliable API exists, the slug itself becomes the best available label.
- Retention/sweep policy for output-snapshot attachment files — same as pasted images (kept
  forever in the global dedup store, cleaned up only via `Save As`'s asset-bundling flow per
  `ui.instructions.md`), or should stale, never-referenced output snapshots get swept
  separately given logs are more likely to be one-off/noisy than a deliberately reused image?
- Whether to cap/truncate a "full channel" capture of a very large or continuously-growing log,
  and how to signal truncation in the attachment content itself.
