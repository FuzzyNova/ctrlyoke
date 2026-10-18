# `#selection` excerpts are refused when the range starts past the first 512 KB of a file

- **Found:** 2026-10-18 by user (appending a step that cited a session log)
- **Area:** `src/utils/ContextExpander.ts`, `src/utils/TextLines.ts`
- **Resolution:** fixed in this commit

## Symptom

A prompt referencing a few lines near the end of a session log, such as
`#selection:.ctrlyoke/logs/ctrlyoke-1792346879606.log:9617-9625` (a 2.4 MB, 11,182-line
file), attached no excerpt. The step recorded only:

> Reference ".ctrlyoke/logs/ctrlyoke-1792346879606.log" could not be attached: Excerpt
> skipped: file exceeds the 512 KB excerpt size limit

The excerpt itself was nine lines. Every `#sym` reference into a file over 512 KB was
refused the same way. The warning also named only the path, not the reference and its
line range, so it was not clear which reference had failed.

## Steps to Reproduce

1. Reference `#selection:<log>:<start>-<end>` where `<log>` is over 512 KB and `<start>`
   begins past byte 524,288 (line 9617 of the log above begins at byte about 2,072,896).
2. Run the step. No excerpt is attached and the warning above is recorded.

## Root Cause

The fix for `selection-symbol-excerpts-read-whole-file-uncapped` streamed files over
`MAX_CONTENT_SIZE` through `readCappedLineRange`. That function passed
`streamFileLines(..., { maxBytes: MAX_CONTENT_SIZE })`, which stops _reading the file_
after 512 KB, so any range beyond that point could never be reached. Over-cap `#sym`
refs were refused outright, on the assumption that finding the symbol needs the whole
file. In fact `buildAttachmentXml` only ever uses the reference's line range.

Capping how far into the file the read may go does not protect memory. Streaming keeps
only the requested lines, so the size that needs a bound is the excerpt, not the
position of the range in the file.

## Fix

- `streamLineRange` in `ContextExpander` streams to `endLine` from anywhere in the file,
  for both `#selection` and `#sym`. The bound is on what is kept: `MAX_EXCERPT_BYTES`
  (4 MB, about a million tokens, more than any harness's context window).
- `streamFileLines` replaces `maxBytes` with `maxLineLength`, which throws
  `LineTooLongError`. Without it, a file with no line breaks would buffer one unbounded
  line on the way to the range.
- The live token counter (`estimateExcerptReferenceTokens`) estimates from the streamed
  size of the requested lines, not from the size of the whole file.
- Every `SkippedReference.ref` is now the reference exactly as typed, as its doc comment
  already promised (`#selection:<path>:9617-9625`, `@dir/`). An unexpected failure of
  the whole expansion now reports every reference as skipped instead of dropping them
  silently.
