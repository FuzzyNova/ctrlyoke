# `@` completion inserts root-level extensionless files as references that never attach

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (confirmed with a scratch vitest)
- **Area:** `src/completions/CompletionCore.ts`, `src/utils/FileReferenceParser.ts`, `src/utils/ReferencePatterns.ts`
- **Resolution:** fixed in this commit

## Symptom

Typing `@Makef` offers `Makefile`; accepting inserts `@Makefile`. The same
happens for `Dockerfile`, `LICENSE`, `Procfile` and similar at the workspace
root. The inserted token is never recognised: no link or chip, no missing-file
lint, and the file is not attached when the step runs. The quoted form
`@"Makefile"` is not recognised either, so in a single-root workspace no syntax
reaches these files at all.

## Steps to Reproduce

- `getFileCompletions("Makef")` with files `["Makefile", ...]` returns `@Makefile`.
- `parseAtReferences("Read @Makefile now")` returns `[]`; so does
  `parseAtReferences('Read @"Makefile" now')`.
- `parseAllFileReferences` finds 0 references; neither `fullFile` nor
  `fullFileQuoted` in `ReferencePatterns.ts` matches.

## Root Cause

`docs/workflows/context-files.md` states that an **unquoted** path must contain
`/`, `\` or `.` (so `@workspace` stays plain text). But:

- `FileReferenceParser.ts` (around lines 745-752) applies that rule to quoted
  paths too, and the `fullFileQuoted` pattern mirrors it;
- `CompletionCore.ts` (around lines 264-266) builds the insert text with
  `buildFileReferenceValue` for any path, without quoting separator-less names.

## Suggested Fix

Let a quoted `@"name"` count as a file reference even without `/`, `\` or `.`
(in `parseAtReferences` and the `fullFileQuoted` pattern, keeping the editor
and runtime parsers in agreement), and make the completion's insert text
always quote a path with no separator or dot. Add tests for both the parser
and the completion insert text.
