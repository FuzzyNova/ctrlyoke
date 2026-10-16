# Workspace File Index Plan

**Status:** Backlog — not started. Ready to implement: every decision below is
settled. Work through the phases in order (1, 2a, 2b, 3, 4a, 4b, 5). Each one
is sized for a single session, leaves the build and `npm test` green, ticks
its heading here as `(done)`, and commits its own work.
**Priority:** P1
**Bug:** `dev/bugs/backlog/at-completion-misses-files-past-walk-cap.md`

## Goal

`@` file completion must be able to return **any** file in the workspace,
whether tracked, untracked or ignored (the last only when
`ui.respectGitignoreForCompletions` is off), however large the workspace is.
Results must show up fast and improve as the search continues, and indexing
must never block typing or put VS Code at risk of running out of memory.

Today `listCompletionFiles()` (`src/utils/CompletionFileDiscovery.ts`) stops
the walk at `MAX_COMPLETION_FILES = 100_000` / `MAX_COMPLETION_WALK_MS =
10_000`. A file the walk never reaches never enters `CompletionCore`'s
candidates, so no ranking can surface it. That covers the ignored files the
setting exists to expose.

## Already shipped (commit `02d8ab1e1`; keep all of it)

- `listCompletionFiles()` puts the uncapped
  `git ls-files --cached --others --exclude-standard` list first and appends
  the capped walk after it, with forward-slash paths and no duplicates.
- `walkSearchFiles()` (`src/utils/WorkspaceSearchFileWalker.ts`) is
  breadth-first.
- `FuzzyRanking` (`src/completions/FuzzyRanking.ts`) breaks equal scores by
  input order, and `CompletionCore.pathEntries()` keeps discovery order,
  inserting each directory where it is first seen.
- `CompletionCore.getFileCompletions()` ranks unscoped queries through a
  cached prepared `FuzzyIndex`. **Phase 3 removes this**: a prepared index
  costs several times the memory of the raw paths, so it does not scale to
  millions of files.

## Why the cap existed, and what replaces it

It guarded against waiting time and memory, and both came from re-listing,
not from file count. `getCompletionFiles()`
(`src/completions/CompletionHelpers.ts`) and `CompletionCore.pathEntries()`
each expire their list after 5 s, so the next keystroke re-walked the
workspace and awaited it. And the list lived on the extension-host heap,
where an out-of-memory error takes VS Code down. This plan builds the list
once, keeps it current incrementally, and holds it in a worker thread whose
memory limit replaces the cap as the safety net.

## Measurements (this repo, 2026-10-16, setting off)

|                                                | Result   |
| ---------------------------------------------- | -------- |
| Uncapped file count                            | 152,893  |
| Node `walkSearchFiles`, uncapped               | 5.3 s    |
| ripgrep `--files --no-ignore --hidden`         | 2.5 s    |
| `git ls-files` (Git-visible list, 7,441 files) | ≈ 0.13 s |
| Heap for all paths plus lowercase copies       | ≈ 41 MB  |
| Linear scan, `copilot-instruction`             | 47 ms    |
| Linear scan, `cme` (84k subsequence matches)   | 492 ms   |

Linear scan = lowercase in-order subsequence check on every path, then
`fuzzysort.single` scoring on the survivors, keeping the top results.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Lister: the Node walker** (`walkSearchFiles`), not ripgrep. No new dependency and no platform-specific VSIX. Indexing is in the background, so its 2× slower first build is acceptable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D2  | **No file-count cap and no time cap** on the completion index. `walkSearchFiles` keeps its bound parameters for its other caller (`HostedWorkspaceViewerService` search, which is out of scope and unchanged); the index passes `Number.POSITIVE_INFINITY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | **The index lives in a worker thread** created with `resourceLimits: { maxOldGenerationSizeMb: 2048 }`. Declare that limit once, as `FILE_INDEX_WORKER_HEAP_MB = 2048` in the index service module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D4  | **On worker failure** (exit with `ERR_WORKER_OUT_OF_MEMORY`, a crash, or a failed start), fall back to an in-process index holding the Git-visible list only. Log with `Log.warn` and show one warning per session through the host's `UserFeedbackSink` (`src/core/UserFeedbackSink.ts`): "Workspace file index stopped at its 2 GB memory limit; ignored files may be missing from @ completions." Do not respawn automatically; a settings change or window reload starts a fresh worker.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D5  | **One index per workspace root**, held in one worker. In a multi-root workspace, paths are prefixed with the folder name, matching what `getCompletionFiles()` produces today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D6  | **Build order:** the Git-visible list first (searchable as soon as it lands), then, with the setting off, the breadth-first walk skipping only `.git` (`COMPLETION_ALL_FILES_SKIP_DIRECTORIES`), adding only paths not already present. If Git fails, walk with `DEFAULT_SKIP_DIRECTORIES` and `.ctrlyoke/logs` excluded, the current fallback, now uncapped. List order is the ranking tie-break, as it is today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D7  | **When building starts:** in the background 2 s after the host is ready (VS Code activation, or the Node host's server start), or on the first completion request if that comes sooner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D8  | **Incremental updates replace the 5 s TTLs.** Watcher events are batched every 200 ms into one `applyChanges` message. On create, `stat` the path: a file is added; a directory is walked and its files added. On delete, the path and every path under it are removed. Change events are ignored. A rename arrives as a delete plus a create.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D9  | **Watcher scope per mode.** VS Code reuses the `**/*` `FileSystemWatcher` already created in `initializeCompletionHelpers()`. The Node host creates `fileWatcherFactory.create(cwd, "**/*")` (`NodeFileWatcherFactory`, chokidar). Events are filtered with the same skip set the build used for the current mode, instead of always `DEFAULT_SKIP_DIRECTORIES` (`isSearchPathIgnored`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D10 | **Respecting `.gitignore` incrementally:** with the setting on, created paths are checked in each batch with `git check-ignore --stdin -z` (NUL-safe, one process per batch), and only paths it doesn't list are added. A create, change or delete of any `.gitignore` file, or of `.git/info/exclude`, triggers a background rebuild (D11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D11 | **Rebuilds swap; they never block.** Toggling `respectGitignoreForCompletions`, changing workspace folders, a `.gitignore` change, or a query arriving when the last full build is older than **5 minutes** starts a background rebuild into a new store. Queries keep using the current store until the new one is complete, then it is swapped in. The periodic re-walk catches drift in trees the watchers exclude: VS Code's `files.watcherExclude` and `DEFAULT_FILE_WATCHER_EXCLUDES` (`node_modules/**` and others).                                                                                                                                                                                                                                                                                                                                                                                                             |
| D12 | **Query algorithm:** linear scan with a lowercase in-order subsequence prefilter on `relativePath`. The basename is a suffix of the path, so a path that fails this can match neither key. Survivors are scored by a scorer exported from `FuzzyRanking.ts` that applies `SECONDARY_KEY_WEIGHT` exactly as `rankByFuzzyQuery` does, so the two never disagree on scores. A bounded heap keeps the top K, ordered by score descending, then store position ascending (the tie-break; no epsilon needed). **Multi-word queries:** fuzzysort splits a query on spaces and requires every word to match, in any order, possibly on different keys. So the prefilter checks each whitespace-separated word separately as a subsequence of the lowercase path, and the scorer must reproduce `fuzzysort.go`'s keyed multi-word score. A randomized parity test against `rankByFuzzyQuery`, including multi-word queries, is what proves this. |
| D13 | **Narrowing:** the worker remembers the survivor positions and store version of the last unscoped query. When the next query's lowercase form starts with the previous one and the version is unchanged, only those survivors are scanned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D14 | **Query semantics stay exactly as today**, ported from `CompletionCore`: an unscoped query ranks name plus relative path. A query containing `/` takes the typed parent's direct children, filtered and ranked by the fuzzy child prefix. An empty query returns directories then files, in store order, each with today's `0_<depth>_<path>` `sortText`. Do not sort the whole store; the existing code only slices, and a global sort would not scale. Limit 500, minus the host-side output-channel items, which stay in `CompletionCore`. `getPromptFileCompletions()` (limit 200) and `getPathSuggestions()` move to the worker with their current logic.                                                                                                                                                                                                                                                                          |
| D15 | **The worker returns entries, not completion items** (`{ kind, relativePath, rank }`). `CompletionCore` keeps building `PlainCompletionItem`s (labels, docs, `ContextReferenceBuilder` insert text), so reference syntax stays single-sourced there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D16 | **Symbol indexes use the Git-visible list, not the completion index.** `VsCodeSymbolIndex`, `RegexSymbolIndex` and `LspSymbolIndex` take a `getSourceFiles()` that returns `git ls-files --cached --others --exclude-standard`, falling back to the default-skip walk. This deliberately changes behaviour: with the setting off they no longer scan `node_modules` or other ignored trees. That is wanted, since `RegexSymbolIndex` would otherwise read every ignored source file.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D17 | **Streaming, scan side:** the worker scans in chunks of 20,000 paths and yields (`await new Promise(setImmediate)`) between chunks, so cancel messages are received. It posts a progress snapshot of the current top K when at least 50 ms have passed since the last one. A cancel message (by query id) stops the scan at the next chunk boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D18 | **VS Code IntelliSense** (`PromptCompletionProvider.getAtCompletions`) awaits a query with a **150 ms budget** and the provider's `CancellationToken`. If the scan hasn't finished, it returns the latest snapshot. Its lists are already `new vscode.CompletionList(items, true)`, so VS Code re-queries on the next keystroke. VS Code gets no indexing row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D19 | **Dashboard streaming:** `PromptEditorSupportService.handleCompletionRequest` treats `@` like `#`, emitting each progress snapshot as `partial: true` and the finished result as `partial: false`, all under the same `seq`. `PromptCompletionClient.handleResponse` (`src/ui/webview-react/utils/promptCompletion/createPromptCompletionClient.ts`) currently uses only the first partial and ignores later ones. Change it so a later partial, like the final, updates the trigger+query cache and calls `startCompletion(view)` while keeping the pending entry. A newer `seq` still supersedes everything.                                                                                                                                                                                                                                                                                                                          |
| D20 | **While a build is in progress**, a dashboard `@` query also re-runs on build progress, at most every 500 ms, emitting partials until the build finishes or the request is superseded. Each such response ends with one row labelled "Indexing workspace files… (N so far)". The row has no `insertText`, is applied as a no-op, and carries a new `PlainCompletionItem` flag, `status: true`. Add that field to the `emitCompletionsResponse` whitelist and handle it in `buildCodeMirrorCompletionResult` (`src/ui/webview-react/utils/promptCompletion/promptCompletionResult.ts`).                                                                                                                                                                                                                                                                                                                                                  |
| D21 | **No on-disk persistence** of the index in this plan. A cold build is background work of a few seconds; persisting is a possible follow-up only if real workspaces show long cold builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Architecture

New modules (pure ones have no `vscode` and no `fs`, so the core is unit-testable without a worker):

| Module                                         | Role                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/completions/WorkspacePathStore.ts` (pure) | Ordered path store for one or more roots: `replaceAll`, `add`, `removeTree`, a version counter. Directory entries are derived in first-seen order (the rule `pathEntries()` has today), and the lowercase form is cached per path.                        |
| `src/completions/WorkspacePathQuery.ts` (pure) | D12–D14 and D17 over a `WorkspacePathStore`: `queryFiles`, `queryPromptFiles`, `suggestPaths`, with chunked scanning, heap, narrowing, progress callback and abort signal.                                                                                |
| `src/completions/WorkspaceFileIndex.ts`        | Host-facing service: build pipeline (D6), change batching (D8, D10), rebuild and swap (D11), worker lifecycle and fallback (D3, D4). It runs the store and query either in the worker or in-process. In-process is the D4 fallback, and tests use it too. |
| `src/completions/workspaceFileIndexWorker.ts`  | Worker entry: owns the store, runs queries, posts progress. Bundled as `out/workspaceFileIndexWorker.js`.                                                                                                                                                 |

**The build runs inside the worker.** Git listing, the walk, `git check-ignore`
and the directory walks triggered by created paths all execute in the worker,
which has its own `fs` and `child_process`. Paths therefore never accumulate on
the extension-host heap. The host sends only commands (`build`,
`applyChanges` with raw watcher events, `query`, `cancel`, `dispose`) and
receives entries, progress, status and log messages. `Log` is not used inside
the worker: it posts `{ type: "log", level, message }` and the host logs it.
`GitUtils.ts` and `WorkspaceSearchFileWalker.ts` already import no `vscode`;
the bundle's `nodeBundleVscodeGuardPlugin` enforces that. In-process mode runs
the same pipeline object directly.

`CompletionWorkspace` (`src/completions/CompletionCore.ts`) replaces `getFiles()` with a `files: WorkspaceFileQueries` port: the three query methods, plus `getStatus(): { state: "building" | "ready" | "degraded"; indexed: number }`. Declare the status values in `src/types/DashboardConstants.ts`, as project convention requires for flow-control strings. `CompletionCore.pathEntries()`, its 5 s TTL, `pathIndex` and the `FuzzyIndex` import go away.

## Phases

### Phase 1 — Pure store and query core (done)

Deviation: none.

- Add `WorkspacePathStore.ts` and `WorkspacePathQuery.ts`, plus the exported
  scorer in `FuzzyRanking.ts` (D12). Refactor `rankByFuzzyQuery` and
  `rankIndexByFuzzyQuery` to use it internally, so the weighting has one
  source.
- No wiring yet; nothing calls the new modules in production.
- Tests (`src/test/unit/WorkspacePathQuery.test.ts`,
  `WorkspacePathStore.test.ts`):
  - parity with the current `CompletionCore` file tests (copy their fixtures:
    camelCase gaps, scoped children, directories first when unfiltered, rank
    before cap, ties in store order, prompt files, path suggestions);
  - narrowing gives the same results as a full scan;
  - the progress callback fires on large stores;
  - abort stops early;
  - `removeTree` drops nested paths and orphaned directories.

### Phase 2a — Index service, in-process (done)

Deviation: none. The existing NUL-safe `getGitIgnoredPaths()` helper is reused
for change batches.

- Add `WorkspaceFileIndex.ts` with the build pipeline (D5, D6), change
  batching (D8, D10), rebuild and swap (D11), and the
  `WorkspaceFileQueries` port and status values (declared in
  `DashboardConstants.ts`). It runs **in-process only** in this phase, but
  keep the pipeline as a self-contained object with a message-shaped API
  (`build`, `applyChanges`, `query`, `cancel`, `dispose`) so Phase 2b can run
  the same object inside the worker. The build uses `getGitTrackedFiles` and
  `walkSearchFiles` with infinite bounds. `git check-ignore --stdin -z`
  batching goes in `src/utils/GitUtils.ts`, next to `getGitTrackedFiles`, so
  Git execution stays in one place.
- Still unwired.
- Tests (in-process, with injected Git, walker and clock):
  - a build larger than any former cap returns a deep ignored file for an
    exact query;
  - the Git-visible list is queryable before the walk finishes;
  - create, delete and directory-create batches update the store with no
    rebuild;
  - a rebuild swaps atomically while queries keep answering;
  - with the setting on, created ignored paths are dropped via
    `check-ignore`;
  - a `.gitignore` change triggers a rebuild, as does a query when the last
    full build is over 5 minutes old.

### Phase 2b — Worker and fallback

- Add `workspaceFileIndexWorker.ts`, which hosts the Phase 2a pipeline, and the
  worker transport in `WorkspaceFileIndex.ts` (D3, D4, D17): progress posts,
  cancel by query id, log forwarding, and the OOM/crash/start-failure fallback
  to an in-process Git-visible-only index with one `UserFeedbackSink` warning.
- Register the worker everywhere `historySearchMatcherWorker` is listed: an
  `esbuild.context` in `esbuild.js` (around line 462) including its
  `watch()`/`rebuild()`/`dispose()`, `!out/workspaceFileIndexWorker.js` in
  `.vscodeignore`, and the file list in `scripts/build-npm-package.mjs`.
  Resolve the worker path the way `HistorySearchMatcher.ts` does, trying both
  `__dirname` candidates.
- Still unwired.
- Tests: the real worker answers a query after a build. Worker OOM falls back
  to the Git-visible list with exactly one warning; use a tiny injected
  `resourceLimits` with the real worker. Cancel stops a scan.

### Phase 3 — Wire hosts and fix the bug

- `CompletionCore`: switch to the `files` port (D15), remove
  `pathEntries()`, its TTL and the prepared index, and make
  `getFileCompletions`, `getPromptFileCompletions` and `getPathSuggestions`
  delegate to it.
- VS Code (`CompletionHelpers.ts`): create the index (D5, D7). Replace
  `getCompletionFiles()` and its 5 s cache with the index for completions,
  and with `getSourceFiles()` for the three symbol indexes (D16). Route the
  existing watcher into index batches (D9) instead of `clearFilesCache()`.
  The `configService` subscription triggers a rebuild only when the setting
  value actually changed. Dispose the index with the extension context.
- Node host (`src/platform/NodeHostServices.ts`): the same wiring. Its
  `getCompletionFiles()` currently re-lists on every call; it becomes the
  index plus `getSourceFiles()`. Add the D9 watcher.
- `listCompletionFiles()`: delete it once nothing calls it, or reduce it to
  `getSourceFiles()`. Remove `MAX_COMPLETION_FILES` and
  `MAX_COMPLETION_WALK_MS`.
- Update `src/test/unit/CompletionCore.test.ts`, `CompletionHelpers.test.ts`
  and `CompletionFileDiscovery.test.ts` to the new port. A `CompletionCore`
  test double implements `WorkspaceFileQueries` over an in-memory
  `WorkspacePathStore` (with an `implements` clause, per the
  nominal-relationship rule).
- Verify against this repo with the setting off: `@copilot-instruction`
  returns `.github/copilot-instructions.md`, and an exact query for a deep
  file under `.vscode-test/` returns it.
- `git mv` `dev/bugs/backlog/at-completion-misses-files-past-walk-cap.md`
  to `dev/bugs/implemented/`, with `**Resolution:** fixed in this commit`.

### Phase 4a — Webview client contract

Land this first: it is safe on its own, because the host does not send
repeated `@` partials or status rows yet.

- `PromptCompletionClient.handleResponse`: change it to the repeated-partial
  behaviour in D19.
- Add the `status?: boolean` field to the webview's completion-item type, and
  make `buildCodeMirrorCompletionResult` render a status row that is
  non-insertable and a no-op when picked (D20).
- Vitest (`src/ui/webview-react/test/**`): a second partial and then the
  final both update the open dropdown; a stale `seq` is ignored; the status
  row is non-insertable.

### Phase 4b — Host streaming

- `CompletionCore.getFileCompletions(query, options?)` gains
  `{ budgetMs?, onPartial?, signal? }`. Partial results are converted to
  items with the same `toItem` as final ones. Add `status?: boolean` to
  `PlainCompletionItem`.
- VS Code: the 150 ms budget plus `CancellationToken` (D18).
- Dashboard: `@` partials in `PromptEditorSupportService` (D19), re-running
  during a build plus the indexing row (D20), and `status` in the
  `emitCompletionsResponse` whitelist.
- Extension tests:
  - partial then final emissions under one `seq`;
  - the budget returns a snapshot;
  - cancellation stops the worker scan;
  - the indexing row appears only while the index is building.

### Phase 5 — Docs and close-out

- Rewrite the discovery and caching paragraphs of
  `.github/instructions/completions.instructions.md` (`<completionHelpers>`)
  to describe the index:
  - where it lives;
  - the worker and its 2 GB limit;
  - change batching and the 5-minute re-walk;
  - symbol indexes reading the Git-visible list;
  - the repeated-partial client contract.

  Drop the now-false 5 s cache and cap text, and keep only what the code
  can't tell a reader.

- Public docs: in `docs/guide/prompt-editor.md`, extend the **Respect
  .gitignore** row to say that, when the setting is off, ignored files are
  indexed in the background and may take a few seconds to appear in a large
  workspace. Run `npm run check:docs`.
- Move this plan to `dev/implemented/` and set its status line.

## Out of scope

- The hosted workspace viewer's own file search
  (`HostedWorkspaceViewerService.discoverSearchCandidates`).
- ripgrep or Everything as listers (D1).
- On-disk index persistence (D21).
