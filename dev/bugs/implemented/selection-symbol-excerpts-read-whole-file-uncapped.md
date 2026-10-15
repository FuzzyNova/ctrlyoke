# #selection / #sym excerpts read the whole referenced file into memory with no size cap

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/ContextExpander.ts`
- **Resolution:** fixed in this commit

## Symptom

A `#selection:` or `#sym:` reference to a very large file makes the extension host read the entire file into one string. This happens on every live token-count refresh in the prompt editor, and again when the step runs.

- A file larger than V8's maximum string length fails with `ERR_STRING_TOO_LONG`. The excerpt is dropped: the token count shows 0 and the runtime skips the reference.
- A file of a few hundred MB up to about 1 GB triggers one large allocation followed by a full line split, which can OOM the extension host.

Full-file `@` refs to the same file are already protected by `MAX_CONTENT_SIZE` in the token counter. Excerpt refs have no such guard.

## Steps to Reproduce

1. Put a large file in the workspace, e.g. `logs/huge.log` at 600 MB or more.
2. In the prompt editor, type a step prompt containing `#selection:logs/huge.log:1-20`.
3. The attachment token counter runs `PromptEditorSupportService` -> `estimateFileReferenceTokens` (which returns `null` for a line-range ref) -> `expander.expandContext(rawRef)` -> `buildAttachmentXml`, and that calls `fs.readFile` on the whole file.
4. Extension-host memory spikes (visible in `[MemoryWatchdog]` lines), or `ERR_STRING_TOO_LONG` appears in the log. The reference's token count shows 0.
5. Run the step. `expandContextSplit` -> `buildAttachmentXml` reads the whole file again, and either the excerpt is skipped or the host runs out of memory.

## Root Cause

`buildAttachmentXml` at `src/utils/ContextExpander.ts:969` does `const rawContent = await fs.readFile(absolutePath, "utf8");`. Nothing calls `fs.stat` first to check the size. It also reads the full file when it only needs a line range: lines 1003-1009 split every line of the content and then slice out the requested range.

None of the callers guard against large files either:

- `expandContextSplit` (`ContextExpander.ts:412-418`) passes line-range and symbol refs straight to `buildAttachmentXml`.
- `expandContext` reaches it through `buildAttachmentForReference` (`ContextExpander.ts:935-941`).
- The live counter in `src/ui/PromptEditorSupportService.ts:1554-1563` uses the `MAX_CONTENT_SIZE`-guarded `estimateFileTokens` (`src/utils/FileTokenEstimator.ts:35-36`) only for bare full-file refs. Any other ref falls through to `expandContext`, so excerpt refs skip the guard.

The `FileTokenEstimator.ts` header comment already documents a single huge `readFile` as the extension-host OOM failure mode (a 10 GB attachment read in one call).

## Suggested Fix

- In `buildAttachmentXml`, call `fs.stat` before reading anything.
- For a line-range or symbol excerpt, stream the file with `readline` over `fs.createReadStream` and stop once `endLine` is reached. If the bytes read go over a cap, abort or skip the excerpt and give a clear reason.
- For a full-file inline read, refuse or truncate above a single-sourced cap. That can be `MAX_CONTENT_SIZE` or a dedicated excerpt cap in `DashboardConstants.ts`.
- In the live token counter, add an estimate path for excerpt refs that never loads the whole file. Either tokenize the streamed slice, or fall back to a size-based approximation when the file is over the cap.
- Add tests that pin the cap for `#selection` and `#sym` refs in both `expandContextSplit` and the `PromptEditorSupportService` counter.

## Decision

Files at or under `MAX_CONTENT_SIZE` keep the original read-and-slice path, so
normal excerpts are byte-for-byte unchanged. Over the cap, a `#sym` excerpt is
refused outright (locating the symbol needs the whole file), while a
`#selection` line range is streamed through `streamFileLines` with a
`maxBytes` read limit and attaches if the range ends before the cap; a range
past the cap is skipped with the excerpt-size-limit reason.
