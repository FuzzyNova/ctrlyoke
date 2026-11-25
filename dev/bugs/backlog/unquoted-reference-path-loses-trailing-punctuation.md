# Inserted `@path` references lose a trailing `+`, `~`, `_`, `-` or `)`

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced against `out/`)
- **Area:** `src/utils/ContextReferenceBuilder.ts`, `src/utils/FileReferenceParser.ts`
- **Severity:** low (affects unusual filenames; the wrong or a missing file is attached)

## Symptom

`quoteReferencePath` emits a path unquoted, and the parser then strips its
last characters:

| Path | Inserted | Parsed as |
| --- | --- | --- |
| `lib/foo.c++` | `@lib/foo.c++` | `lib/foo.c` |
| `src/x.ts~` | `@src/x.ts~` | `src/x.ts` |
| `docs/notes_` | `@docs/notes_` | `docs/notes` |
| `src/file(1)` | `@src/file(1)` | `src/file(1` |
| `src/a-` | `@src/a-` | `src/a` |

The quoted form (`@"lib/foo.c++"`) parses correctly. Every insertion path
goes through the builder: `@` completion (`src/completions/CompletionCore.ts`),
explorer/editor context menus, paste/drop in the dashboard editor, and
template `@{file:…}` substitution (`src/core/TemplateManager.ts`).

## Steps to Reproduce

```js
const B = require("./out/utils/ContextReferenceBuilder");
const P = require("./out/utils/FileReferenceParser");
P.parseAtReferences("see " + B.buildFileReference("lib/foo.c++") + " now").map(r => r.path);
// ["lib/foo.c"] — expected ["lib/foo.c++"]
```

## Root Cause

`quoteReferencePath` (`src/utils/ContextReferenceBuilder.ts` ~7-17) only
checks the path against `UNQUOTED_AT_REFERENCE_PATH`, but `parseAtReferences`
(`src/utils/FileReferenceParser.ts` ~747-749) strips trailing
`[^\p{L}\p{N}/\\]+` from every unquoted path as prose punctuation. The
builder and parser disagree about which unquoted paths survive.

## Suggested Fix

In `quoteReferencePath`, also quote when the last character is not
`[\p{L}\p{N}/\\]`, so the builder agrees with the parser's trailing-strip
rule. Add a builder→parser round-trip test over the paths above (and keep
existing unquoted outputs such as `src/a.ts` unchanged).
