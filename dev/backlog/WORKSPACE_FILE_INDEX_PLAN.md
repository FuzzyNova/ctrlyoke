# Workspace File Index Plan

**Status:** Backlog — not started
**Priority:** P1
**Bug:** `dev/bugs/backlog/at-completion-misses-files-past-walk-cap.md`

## The problem in one sentence

`@` file completion can only rank files that discovery listed, and discovery
with `ui.respectGitignoreForCompletions: false` stops walking at 100,000 files
or 10 s, so an ignored file past that point can never be completed, however
exactly it is typed. That is the one case the setting exists for.

## What already shipped

These pieces stay useful under this plan:

- `listCompletionFiles()` (`src/utils/CompletionFileDiscovery.ts`) puts the
  uncapped `git ls-files --cached --others --exclude-standard` list first and
  appends the capped walk after it. Git-visible files can no longer be cut
  off, but ignored files still can.
- `walkSearchFiles()` (`src/utils/WorkspaceSearchFileWalker.ts`) is
  breadth-first, so a truncated walk loses the deepest paths rather than whole
  top-level directories. A depth-first walk of this repo used the entire cap
  inside `.vscode-test/` and never reached `.github/`.
- `FuzzyRanking` breaks equal scores by input order, and
  `CompletionCore.pathEntries` keeps the discovery order, so Git-visible files
  beat ignored copies with the same basename.
- `CompletionCore.getFileCompletions()` ranks an unscoped query through a
  prepared `FuzzyIndex` with a 500-result limit. This is fast (~1 ms per
  keystroke on 100k entries), but a prepared index costs several times the
  memory of the raw paths, so it is not the long-term data structure (see
  "Query" below).

## Why the cap exists, and why it can go

The cap guards against two things, both caused by re-listing rather than by
file count:

- **Waiting time.** `getCompletionFiles()` (`src/completions/CompletionHelpers.ts`)
  and `CompletionCore.pathEntries()` each expire their list after 5 s. The next
  keystroke then re-walks the workspace, and the completion request awaits
  that walk. The 10 s limit only bounds the wait.
- **Memory.** The list lives on the extension-host heap, and an extension-host
  OOM takes VS Code down (see "Crash investigation" in
  `.github/copilot-instructions.md`).

An index that is built once, kept current incrementally and held off the
extension-host heap removes the reason for both limits.

## Measurements (this repo, 2026-10-16, setting off)

|                                                                 | Result                                       |
| --------------------------------------------------------------- | -------------------------------------------- |
| Uncapped file count                                             | 152,893 (the 100k cap was ~1.5× too small)   |
| Node `walkSearchFiles`, uncapped                                | 5.3 s                                        |
| ripgrep `--files --no-ignore --hidden` (VS Code's bundled copy) | 2.5 s                                        |
| ripgrep, respecting `.gitignore`                                | 0.13 s (7,441 files)                         |
| Everything `es` (own resident index)                            | 0.6 s                                        |
| Heap for all paths plus lowercase copies                        | ≈ 41 MB                                      |
| Linear scan, `copilot-instruction`                              | 47 ms, top `.github/copilot-instructions.md` |
| Linear scan, `skill.md`                                         | 53 ms                                        |
| Linear scan, `cme` (84k subsequence matches)                    | 492 ms                                       |

The linear scan was a lowercase subsequence check over every path, then
`fuzzysort.single` on the survivors, keeping the top results. Listing is the
expensive step; searching everything is cheap.

## Design

### 1. One persistent index per workspace root

- The index is built in the background on activation, or on the first `@`
  completion if that comes sooner. It has **no file-count cap and no time
  cap**.
- It fills in two passes:
  1. the Git-visible list (fast; arrives first, so the common case is served
     almost immediately);
  2. the breadth-first walk for ignored files (setting off only).
- **Incremental updates replace the 5 s TTL.** `initializeCompletionHelpers()`
  already registers a `**/*` `FileSystemWatcher`. Instead of
  `clearFilesCache()`, its create and delete events add or remove one path.
  The Node host does the same through `NodeFileWatcherFactory`
  (`src/platform/NodeHostServices.ts`).
- **Stale-while-revalidate re-walk.** VS Code's watcher honours
  `files.watcherExclude`, which excludes `node_modules/**` by default, so
  ignored trees can drift. Re-walk in the background when the index is older
  than a few minutes and a query arrives. Keep serving the old index until the
  new one is complete, then swap. A completion never awaits a walk.
- Toggling `respectGitignoreForCompletions` or changing workspace folders
  rebuilds the index, with the same non-blocking swap.

### 2. Index lives in a worker thread

- The worker owns the path list and runs the queries. The extension host only
  sends a query and receives ranked items.
- The worker is created with `resourceLimits.maxOldGenerationSizeMb`. If the
  worker exceeds it, it exits with `ERR_WORKER_OUT_OF_MEMORY`; the host keeps
  serving the Git-visible list and shows an "index incomplete" notice. This
  memory ceiling is the only limit, and it is a safety net, not a cap that
  silently drops files.
- Follow the existing worker precedent: `HistorySearchMatcher.ts` /
  `historySearchMatcherWorker.ts` (resolution via `__dirname`, listed in
  `scripts/build-npm-package.mjs`).
- Store paths compactly (one string per path, no per-path prepared objects).
  Precompute lowercase forms only if the measured memory allows.

### 3. Query: linear scan with narrowing

- For each path: a lowercase in-order subsequence check, then
  `fuzzysort.single` scoring on survivors only, keeping the top K (500) in a
  heap. Ties break by index order, matching `FuzzyRanking`.
- **Narrowing.** When a query extends the previous one (`cop` → `copi`),
  scan only the previous query's survivors. This is what makes typing fast
  after the first character.
- The directory-scoped path (`src/ui/editor/Co`) filters by parent first and
  stays cheap; keep that branch.
- This replaces the prepared `FuzzyIndex` in `getFileCompletions()`. Keep the
  `FuzzyRanking` API for the small lists (symbols, secrets, prompt files).

### 4. Stream results

- **Dashboard (CodeMirror).** Reuse the progressive response that `#` already
  has (`PromptEditorSupportService.handleCompletionRequest`,
  `partial: true` then `partial: false` under one `seq`). For `@`, the worker
  posts the best results so far every ~50 ms while it scans, and again when
  it finishes. During the first build, append a non-insertable
  "Indexing workspace files… (N so far)" row.
- **VS Code IntelliSense.** A provider cannot push updates. Return the best
  results found within ~150 ms; the lists are already
  `new vscode.CompletionList(items, true)` (`PromptCompletionProvider.ts`), so
  VS Code asks again on the next keystroke and gets the improved list.
- Cancellation: a newer query (dashboard `seq`, VS Code `CancellationToken`)
  aborts the worker's current scan.

## Phases

1. **Index service, no streaming.** Worker, two-pass build, watcher updates,
   background re-walk, no caps. `getCompletionFiles()` and the Node host both
   read from it. Queries await the scan (fine at the measured 50–500 ms).
2. **Narrowing and time budget.** Survivor reuse and the 150 ms VS Code
   budget.
3. **Dashboard streaming.** Partial `@` responses and the indexing row.
4. **Optional faster lister.** ripgrep (see open decisions) if first-build
   time matters in practice.

## Tests

- An ignored file deeper than any former cap is returned for an exact query
  (generate a tree larger than a small injected cap in a unit test).
- The watcher adds and removes paths without a re-walk; a re-walk swaps
  atomically while queries keep answering.
- The worker exceeding an injected memory limit falls back to the Git-visible
  list and reports "incomplete".
- Narrowing returns the same results as a full scan.
- Dashboard: a partial `@` response followed by a final one under one `seq`;
  a stale `seq` is dropped.

## Open decisions

- **Lister.** The Node walker needs no dependency and is ~2× slower here.
  ripgrep is faster, but either we locate VS Code's copy, whose path changes
  between builds (seen here under
  `node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/<platform>/`), or
  we add `@vscode/ripgrep`, which needs platform-specific VSIXs. Recommended:
  start with the Node walker and revisit in phase 4.
- **Worker memory limit.** Recommended: 1–2 GB, which is millions of paths.
- **Everything (`es`).** Windows-only and must be installed, so it is not a
  base design. It could be an optional accelerator later.
