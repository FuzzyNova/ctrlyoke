# `parseAllFileReferences` does not return references in prompt order

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/FileReferenceParser.ts`
- **Resolution:** fixed in this commit

## Symptom

`parseAllFileReferences` is documented as returning references "ordered by appearance in prompt",
and `ContextExpander.expandContext` relies on that so the attachment order matches the user's
intent. The order is wrong:

- **Symbol references always sort first.** The comparator searches the prompt for
  `#sym:${symbolName}`, but real tokens look like `#sym:path:Name:1-5` or `#sym.kind:...`. That
  search string never occurs, so `indexOf` returns `-1`.
- **`@` and `#selection` references can sort by an earlier plain-prose mention of the same path**,
  because they are ordered by `prompt.indexOf(path)`.

## Steps to Reproduce

1. Call `parseAllFileReferences("First read @src/a.ts, then look at #sym:src/b.ts:Foo:1-5, then #selection:src/c.ts:3-4")`.
2. Actual order: `src/b.ts#Foo`, `src/a.ts`, `src/c.ts`.
3. Expected order: `src/a.ts`, `src/b.ts#Foo`, `src/c.ts`.

## Root Cause

`FileReferenceParser.ts:604-612` searches the prompt text again instead of using the offsets the
parsers already recorded. Every reference produced by `parseAtReferences`,
`parseSelectionReferences` and `parseSymbolReferences` carries `startOffset`.

## Suggested Fix

Sort by `startOffset`, e.g. `allRefs.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))`.
If every producer sets it, consider making it required on the returned type. Add a unit test that
mixes all three syntaxes, plus a case where the path also appears earlier in plain prose.
