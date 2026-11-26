# Unranked file completions sort path depth as text, so depth 10+ lists before depth 2

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/completions/WorkspacePathQuery.ts`, `src/completions/CompletionCore.ts`
- **Severity:** low

## Symptom

With an empty query, prompt-file completion and the bare `@` file list are meant
to list shallow paths first. Files 10 or more segments deep sort ahead of files
at depth 2-9. For prompt files, those deep entries can also use up slots under the
200-item `PROMPT_LIMIT` before shallower files are reached.

## Steps to Reproduce

```js
const {
  WorkspacePathStore,
} = require("./out/completions/WorkspacePathStore.js");
const {
  WorkspacePathQuery,
} = require("./out/completions/WorkspacePathQuery.js");
const store = new WorkspacePathStore();
store.replaceAll([
  "docs/guide.prompt.md",
  "a/b/c/d/e/f/g/h/i/deep.prompt.md",
  "README.md",
]);
new WorkspacePathQuery(store)
  .queryPromptFiles("")
  .then((r) => console.log(r.map((x) => x.relativePath)));
// [ 'README.md', 'a/b/c/d/e/f/g/h/i/deep.prompt.md', 'docs/guide.prompt.md' ]
```

Expected: `README.md`, `docs/guide.prompt.md`, then the depth-10 file.

## Root Cause

The depth is put into a sort string without padding and then compared as
text (`"10_…" < "2_…"`):

- `src/completions/WorkspacePathQuery.ts:111-114`: the unranked
  `queryPromptFiles` sort uses
  `` `${depth}_${path}`.localeCompare(…) `` and then slices to the limit.
- `src/completions/CompletionCore.ts:332`: prompt-file `sortText` is
  `` `${depth}_${path}` ``.
- `src/completions/CompletionCore.ts:284`: the empty-query `@` `sortText` is
  `` `0_${depth}_${path}` ``.

VS Code and CodeMirror both order items by `sortText` as a string.

## Suggested Fix

Compare depth numerically in `WorkspacePathQuery`
(`depthA - depthB || a.localeCompare(b)`) and zero-pad depth in both `sortText`
strings (e.g. `String(depth).padStart(4, "0")`, matching the existing
`padStart(6, "0")` used for ranks). Prefer one shared helper for the depth
sort key. Add tests that a depth-10 path sorts after a depth-2 path in
`queryPromptFiles` order and in both `sortText` values.
