# `@` after `/` inside a path or URL is parsed as a context reference

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced against `out/`)
- **Area:** `src/utils/ReferenceBoundary.ts`, `src/utils/FileReferenceParser.ts`
- **Resolution:** fixed in this commit

## Symptom

```
check node_modules/@types/node/index.d.ts please   -> reference "types/node/index.d.ts"
read https://medium.com/@alice/post first           -> reference "alice/post"
```

Each mention produces a skipped-reference warning and a reference chip in the
editor. `docs/workflows/context-files.md` says "An `@` in the middle of a word
is not a trigger." Scoped npm packages (`@types/…`, `@anthropic-ai/…`) inside
a path are common in prompts.

## Steps to Reproduce

```js
const P = require("./out/utils/FileReferenceParser");
P.parseAtReferences("check node_modules/@types/node/index.d.ts please").map(r => r.path);
// ["types/node/index.d.ts"] — expected []
```

## Root Cause

`NOT_AFTER_BOUNDARY` (`src/utils/ReferenceBoundary.ts` ~21-33) lists filename
characters (`\p{L}\p{N}_+=@#$%^&!~-`) but not path/URL separators `/`, `.`,
`:`, so `parseAtReferences` (`src/utils/FileReferenceParser.ts` ~733) and the
editor decoration patterns built on the same boundary accept an `@` right
after them. `dev/bugs/implemented/slash-token-matches-mid-word-and-in-urls.md`
fixed the same gap for `/skill:` tokens by refusing a preceding `/`, `.` or
`:`; the `@` trigger never got that treatment.

## Suggested Fix

Reject `/`, `\`, `.` and `:` before the `@` trigger in the parser and in every
decoration/completion pattern that shares `NOT_AFTER_BOUNDARY` (check
`findWordStartTriggerIndex` so `@` completion still opens where it should,
e.g. after `(` or `"`). Add parser and decoration tests for the two examples.
