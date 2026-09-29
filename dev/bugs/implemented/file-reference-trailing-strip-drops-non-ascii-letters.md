# `@` file references lose trailing non-ASCII letters

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `src/utils/FileReferenceParser.ts` (~L176)
- **Resolution:** fixed in this commit

## Symptom

An unquoted `@` reference that ends in non-ASCII letters is truncated:

- `@docs/résumé` resolves to `docs/résum`.
- `@notes/日本語` resolves to `notes/` with `isDirectory: true`, so the parent directory's tree
  is attached instead of the file.

## Steps to Reproduce

Verified with a tsx probe on `parseAtReferences`: `@docs/résumé` gives path `docs/résum`, and
`@notes/日本語` gives `notes/`.

## Root Cause

The trailing-punctuation strip uses `/[^a-zA-Z0-9/\\]+$/`, which treats every non-ASCII letter
as prose punctuation.

## Suggested Fix

Use a Unicode-aware class, `/[^\p{L}\p{N}/\\]+$/u`. Check that `ReferencePatterns.ts`
(decorations) and any completion-side twin use the same rule, so decoration and expansion
agree. Add parser tests for accented and CJK trailing characters, keeping the existing
`).`-style punctuation tests passing.
