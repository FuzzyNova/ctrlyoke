# Editor @ completion's 150 ms budget never reaches files past the first ~20-60k index entries

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/completions/PromptCompletionProvider.ts`
- **Severity:** medium

## Symptom

In a large index, VS Code editor `@` completions never offer files that sit later in
the workspace file index, however exactly the user types their name. This happens in a
monorepo with tens of thousands of Git-visible files, or in any repo with
`ui.respectGitignoreForCompletions: false`, where the index also holds the walked
ignored trees. Better-ranked matches further along in the store are also lost, so the
list shows weak fuzzy matches from the first part of the store instead. The
dashboard's prompt editor passes no budget, so it does not have this problem. The
symptom is the same as the already-fixed `at-completion-misses-files-past-walk-cap`.
This time the cause is the query time budget, not the walk cap.

## Steps to Reproduce

1. Open a workspace whose file index holds about 200k entries. This repo with
   `ui.respectGitignoreForCompletions: false` works: 178,012 files, 203,556 store
   entries, mostly under `.vscode-test/`.
2. In a `.ctrlyoke.yaml` prompt, type `@` and then the name of a file that is stored
   late in the index (any file under a walked ignored tree, or near the end of Git's
   listing order).
3. Keep typing more of the name. The file never shows up.

Measured with `out/completions/WorkspacePathStore` + `WorkspacePathQuery` over this
repo's 203,556 entries (a full scan with no budget):

| query        | full scan | entries scanned by ~150 ms |
| ------------ | --------- | -------------------------- |
| `ws`         | 719 ms    | 20k-40k (20k at 113 ms)    |
| `readme`     | 380 ms    | ~60k (60k at 177 ms)       |
| `searchsess` | 295 ms    | ~60k (60k at 131 ms)       |

So each keystroke ranks only about 10-30% of the index.

## Root Cause

- `src/completions/PromptCompletionProvider.ts:183-186` calls
  `getCompletionCore().getFileCompletions(query, { budgetMs: 150, signal })` and
  returns the list with `isIncomplete: true` (line 203). VS Code therefore asks again
  on every keystroke.
- `src/completions/CompletionCore.ts:242-251`: when the budget timer fires, it calls
  `controller.abort()` and resolves with `latest`, the last `onProgress` snapshot. That
  snapshot is the top-K of only the prefix of the store scanned so far (the scan works
  in 20k-entry chunks, `SCAN_CHUNK_SIZE` at `WorkspacePathQuery.ts:12`).
- `src/completions/WorkspacePathQuery.ts:197-201`: an aborted scan deliberately skips
  `rememberNarrowing`, because its survivors are not a superset. The next keystroke
  therefore gets no narrowed candidate set. `narrowedPositions` returns `undefined`,
  the scan starts again at position 0, and the 150 ms budget cuts it off at the same
  point.

Because no keystroke ever completes a scan, narrowing never starts. The part of the
store that gets scanned stays the same no matter how specific the query becomes.

## Suggested Fix

Make the editor query resumable instead of restarting it under a fixed budget, the same
way `src/server/WorkspaceSearchSession.ts` pages search:

- Keep one in-flight scan per prefix chain. When the next keystroke extends the
  previous query, let the scan continue in the background rather than aborting it. Keep
  its scanned position and its partial survivors, then filter those survivors for the
  new query and resume the scan from where it stopped. Once a scan finishes,
  `rememberNarrowing` works as it does today, and later keystrokes are fast.
- Alternatively, record for an aborted scan the store position it reached plus its
  survivors. A query that extends it can reuse the survivors for `[0, position)` and
  scan only `[position, size)`.

Raising `budgetMs` alone only moves the cutoff. A larger store reaches it again.
