# Workspace Search Plan

> **Status:** Approved for implementation. Filename + file-content search inside the workspace
> viewer (`WorkspaceViewerModal.tsx`), staged as the five steps in **Implementation Steps** below.
>
> A **2026-08-19 orchestration review** corrected five points where the original proposal conflicted
> with the codebase: the candidate-list helper already exists (`getGitTrackedFiles`),
> `truncateSnippet` belongs in the existing `utils/string.ts`, result paths are folder-name-prefixed
> _viewer_ paths, repo scoping must iterate workspace roots rather than repo toplevels, and
> `hideGitIgnoredFiles` is a global setting rather than Explorer-local state. Each correction is
> marked inline below.

## Goal

Let a user search the open workspace's files — by filename and by in-file text — from inside the
workspace viewer, and jump straight to a matching file (and matching line, for content matches)
without leaving the modal. Respect the same git-ignore/multi-root rules the Explorer already
applies, and stay responsive on large repositories.

## Design Decisions

These were open questions in the request; each is resolved below with its rationale so the
implementation doesn't have to re-litigate them.

### 1. Placement: a third "Search" tab, not an Explorer-embedded bar or a header bar

`WorkspaceViewerHeader.tsx` already renders `Explorer` / `Source Control` as tabs
(`activeTab: "explorer" | "sourceControl"`, `NavHistoryControls` alongside them). Add `"search"`
as a third tab using the same pattern, backed by a new `WorkspaceSearchPane.tsx` full-width pane —
structurally the sibling of `WorkspaceExplorerPane.tsx` / `WorkspaceSourceControlPane.tsx` that
`WorkspaceViewerModal.tsx` already switches on.

Rejected alternatives and why:

- **Search bar inline in the Explorer's left column** (below the toolbar at
  `WorkspaceExplorerPane.tsx:517`): that column defaults to
  `WORKSPACE_VIEWER_SIDE_PANEL_DEFAULT_SIZE` — a narrow tree view. Content matches need a snippet
  plus surrounding context (see `HistorySearchDrawer`'s result cards), which doesn't fit that
  width without either truncating results into uselessness or replacing the tree entirely while
  searching (at which point it's a separate mode, not really "inline").
- **Search bar in `WorkspaceViewerHeader.tsx`**: the header is deliberately a thin, centered title
  bar (`flex-1 min-w-0 flex flex-col items-center`, `pointer-events-none` on the title). A
  functional input competes with that centered title/subtitle for space, and results still need
  somewhere full-size to render — so it doesn't avoid the "where do results go" problem, it just
  moves the entry point. A tab already owns full pane real estate for exactly this.

To keep the feature discoverable while browsing (the instinct behind the original "bar under the
Explorer toolbar" idea), add a small search icon button to the Explorer's existing toolbar row
(next to Refresh/Sync, `WorkspaceExplorerPane.tsx:487-514`) that calls `setActiveTab("search")` and
focuses the input — a shortcut into the tab, not a second search implementation.

### 2. Filenames and content in one query, not two modes

Search both by default; a compact scope toggle (`Files` / `Content` / `Both`, `Both` selected by
default) lets a user narrow it, mirroring how the Explorer toolbar already has small icon toggles.
Filename matches render first (cheap, usually what the user wants when typing a known name), then
content matches grouped by file. This avoids forcing the user to pick a mode before they know
which one they need.

### 3. Filtering: keep it minimal, don't reuse `HistorySearchDrawer`'s filter drawer as-is

`HistorySearchDrawer`'s filters (event kind, harness, outcome, date range, "this workflow only")
exist because history events carry that metadata and a query can otherwise return years of
unrelated runs. Workspace files don't carry most of that metadata, and the workspace itself is
already a much smaller, bounded corpus. Proposed filter set for v1, rendered inline (no separate
drawer needed — three controls fit in the pane's toolbar row):

- Scope toggle: `Files` / `Content` / `Both` (§2).
- "Include git-ignored files" checkbox. Corrected 2026-08-19: `hideGitIgnoredFiles` is **not**
  Explorer-local state — it is the global setting `ui.hideGitIgnoredFiles`, read from
  `settingsStore.globalSettings.hideGitIgnoredFiles` (`WorkspaceExplorerPane.tsx:140-148`) and
  written back through the settings path by the Explorer's eye toggle. Per the workspace-viewer
  instructions ("do not add viewer-local copies" of global settings), the search checkbox seeds
  its initial value from `!globalSettings.hideGitIgnoredFiles` and then acts as a per-search
  override in `workspaceViewerStore` — it must not write the global setting back.
- Repo picker, but **only rendered when `repos.length > 1`** — same conditional the SCM pane
  already uses (see `webview-react-workspace.instructions.md`'s multi-repo note) — scopes the
  search to one repo instead of all workspace roots.

Explicitly deferred (not v1): case-sensitive/whole-word/regex toggles, file-extension filters,
result highlighting. These are standard "search in files" features but add surface area the
request didn't ask for; call out as natural fast-follows in Non-Goals.

### 4. No persistent search index — live scan per query

`HistorySearchIndexService` builds a persisted JSONL index because run history is large, mostly
immutable once written, and accumulates across the project's lifetime. None of that applies here:
a workspace's tracked+untracked-not-ignored file set is what `git ls-files` already enumerates in
one call, files change constantly while an AI harness is actively running, and the corpus is
normally a single repo's working tree, not months of accumulated history. Building and
invalidating a persisted index would be strictly more complexity for a smaller, more volatile
corpus. Do a debounced (400ms, same as `HistorySearchDrawer`) live scan per keystroke instead —
same approach VS Code's own Search view takes.

If a live scan proves too slow on very large repos (profile before assuming this), the fast-follow
is adding `@vscode/ripgrep` as a dependency for the actual content grep, not building an index —
see Non-Goals.

## Existing Patterns to Reuse

- **`GitUtils.getGitTrackedFiles()` already _is_ the candidate list — do not add a new helper for
  it.** (Corrected 2026-08-19.) `src/utils/GitUtils.ts` exports `getGitTrackedFiles(repoRoot)`,
  which runs exactly `git ls-files --cached --others --exclude-standard -z` with `cwd: repoRoot`
  and a 500 MB `maxBuffer` sized for monorepos. Because `git ls-files` with no pathspec lists only
  the cwd's subtree and emits cwd-relative paths, calling it with a _workspace root_ that sits
  below its git toplevel returns exactly that root's files — no extra scoping needed and nothing
  outside the root leaks in. Reuse it.
  The only genuinely missing piece is the ignored-file union for the "include git-ignored" case:
  add one sibling export `getGitIgnoredFiles(repoRoot)` running
  `git ls-files --others --ignored --exclude-standard -z` (recursive, **no** `--directory`).
  `getIgnoredEntryNames()` cannot serve this — it is `--directory`-scoped and returns bare entry
  _names_ for one directory — and `getGitIgnoredPaths()` is a `check-ignore` over paths you already
  have, not an enumeration.
  For a non-git root (`isGitRepo` false in the existing tree response), fall back to a bounded
  recursive `fs.promises.readdir` walk skipping a small hardcoded set (`.git`, `node_modules`,
  `dist`, `build`, `out`, `coverage`) — same spirit as the existing non-git fallback in
  `listDirectory`, which currently shows everything unfiltered.
- **Binary/size guards from `readFile`.** `HostedWorkspaceViewerService.isBinaryFile()` (null-byte
  sniff on the first `BINARY_CHECK_BYTES`) and `MAX_FILE_SIZE` (2 MB) already gate what the editor
  will open. Content search must apply the same two checks per candidate file before reading it,
  both to avoid scanning binaries and to keep memory bounded — reuse the methods directly rather
  than re-implementing them.
- **`pendingNavigation` for "jump to result."** `workspaceViewerStore` already has exactly the
  mechanism a result click needs: `openToFile(filePath, startLine?, endLine?)` sets
  `activeTab: "explorer"` and `pendingNavigation: { type: "file", filePath, startLine, endLine }`
  (see `store/workspaceViewerStore.ts:723-724`), which `WorkspaceExplorerPane`'s existing effect
  (`WorkspaceExplorerPane.tsx:315-333`) already consumes to open the file and select the given line
  range — this is the same path CodeMirror in-file link clicks use today. A filename result calls
  `openToFile(path)`; a content match result calls `openToFile(path, matchLine, matchLine)`. No new
  navigation plumbing needed — the pane switch plus file-open plus line-select is already wired.
- **`HistorySearchDrawer`'s debounce-and-issue-search shape.** Reuse the same 400 ms debounce
  (`useEffect` + `window.setTimeout`), the 2-character minimum query length, and the loading /
  empty / results tri-state rendering — not by importing `HistorySearchDrawer` itself (its state
  lives in `uiStore`, is keyed by workflow, and its result shape is unrelated), but by copying the
  same small effect shape into the new pane. It's ~15 lines; not worth abstracting into a shared
  hook for one additional consumer.
- **Genuinely shared, worth extracting now:** `truncateSnippet()` (`HistorySearchDrawer.tsx:162-168`)
  is generic string truncation with no history-specific logic. Move it into the **existing**
  `src/ui/webview-react/utils/string.ts` (which already owns `truncate()`) and re-export it from
  `utils/index.ts` alongside the other string helpers — not into a new `textSnippets.ts` file,
  which would split string utilities across two modules for one function (corrected 2026-08-19).
  Import it in both `HistorySearchDrawer` and the new `WorkspaceSearchPane` instead of
  duplicating it.
- **Not worth sharing:** the result-card JSX itself. History results show workflow name / run id /
  relative time / harness badge; workspace results show a file path / line number / breadcrumb.
  The visual rhythm (title row + badge + snippet) is similar but the data shapes don't overlap
  enough to justify a generic `SearchResultRow<T>` component for two call sites — revisit if a
  third search surface appears.

## Proposed Architecture

### 1. Types (`src/types/HostedWorkspaceViewerTypes.ts`)

```ts
export type WorkspaceSearchScope = "files" | "content" | "both";

export interface WorkspaceSearchRequest {
  query: string;
  scope: WorkspaceSearchScope;
  includeGitIgnored?: boolean;
  repo?: string;
  limit?: number; // results cap; re-issued with a higher limit for "Load more"
}

export interface WorkspaceSearchFileMatch {
  kind: "file";
  /** Viewer path: plain workspace-relative single-root, folder-name-prefixed
   *  (`root2/src/index.ts`) multi-root — the same convention every other
   *  `HostedWorkspaceViewerTypes` path uses, and what `openToFile()` expects.
   *  (Corrected 2026-08-19; always build it with `toViewerPath`.) */
  path: string;
  name: string;
}

export interface WorkspaceSearchContentMatch {
  kind: "content";
  path: string;
  line: number; // 1-based
  matchSnippet: string; // the matching line, trimmed/truncated
}

export type WorkspaceSearchResult =
  | WorkspaceSearchFileMatch
  | WorkspaceSearchContentMatch;

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  truncated: boolean; // true if the scan hit its file/time budget before finishing
}
```

### 2. Server (`src/server/HostedWorkspaceViewerService.ts`)

Add `async searchWorkspace(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse>`:

1. Resolve the candidate root(s) by iterating **workspace roots** (`this.namedRoots`, or
   `this.workspaceRoot` in single-root) — **not** repo toplevels (corrected 2026-08-19).
   `WorkspaceRepo.rootPath` is the git toplevel, which can sit _above_ a workspace root, so
   scanning from `resolveRepoRoot()` would surface files outside the workspace the user can browse.
   When `request.repo` is set, filter the roots to those whose folder-name prefix maps to that repo
   id via `mapRootPrefixesToRepos()` — the same authoritative map
   `GET /api/workspace-viewer/repos` already returns (never re-derive it from `label`/`id`).
2. Per root, get the candidate file list via `getGitTrackedFiles(root)` (plus
   `getGitIgnoredFiles(root)` when `includeGitIgnored`), or the bounded fs-walk fallback when the
   git call fails (non-git root). Convert each absolute candidate back to a viewer path with
   `this.relativePath()` (the `toViewerPath` wrapper) — never by string-joining prefixes.
3. Filename matches (scope `files`/`both`): case-insensitive substring match of `query` against
   each candidate's basename, capped at some count (e.g. 30) so content matches still get room in
   `limit`.
4. Content matches (scope `content`/`both`): for each remaining candidate (skip anything already
   surfaced as a filename match to avoid double-counting the same file twice in the list), check
   `isBinaryFile()` and size via `fs.promises.stat()` against `MAX_FILE_SIZE`, then scan the file
   with `readline` doing a case-insensitive substring match per line. Stop after the file's first N
   matches (e.g. 3) and the overall result cap. Run with bounded concurrency (a small fixed pool,
   e.g. 8 files in flight) rather than sequentially, so one huge repo doesn't serialize on disk I/O.
5. Enforce a scan budget (file-count and/or wall-clock, e.g. 5,000 files or ~3 seconds) across
   steps 3–4; set `truncated: true` and return whatever was found so far rather than blocking the
   request indefinitely on a huge monorepo.
6. Path safety (added 2026-08-19): candidates come from `git ls-files` under an already-trusted
   root, but a listed entry can still be a symlink pointing outside it. Before **reading** a file's
   content, confirm containment asynchronously (`fs.promises.realpath` + the existing
   `isPathWithinAnyDirectory(…, this.trustedRoots)`); add a small private async helper for this.
   Do **not** call the existing `safeResolve()` per candidate — it is `realpathSync`, and thousands
   of sync realpath calls per keystroke would block the extension host's event loop.
7. No new persisted state — this method is stateless per call (§ Design Decisions #4).

### 3. Route (`src/server/CtrlYokeHostedServer.ts`)

Add `GET /api/workspace-viewer/search?query=&scope=&includeGitIgnored=&repo=&limit=` alongside the
existing `/api/workspace-viewer/*` routes, following the same auth/token middleware and error
handling those already use.

### 4. Client fetch (`src/ui/webview-react/utils/hostedApi.ts`)

```ts
export async function workspaceSearch(
  req: WorkspaceSearchRequest
): Promise<WorkspaceSearchResponse> {
  const params = new URLSearchParams({ query: req.query, scope: req.scope });
  if (req.includeGitIgnored) params.set("includeGitIgnored", "true");
  if (req.repo) params.set("repo", req.repo);
  if (req.limit) params.set("limit", String(req.limit));
  return hostedFetch<WorkspaceSearchResponse>(
    `/api/workspace-viewer/search?${params.toString()}`
  );
}
```

### 5. Store (`src/ui/webview-react/store/workspaceViewerStore.ts`)

- Widen `activeTab` to `"explorer" | "sourceControl" | "search"`.
- Add search state: `searchQuery`, `searchScope` (default `"both"`), `searchIncludeGitIgnored`
  (default `false`), `searchResults`, `searchLoading`, `searchTruncated`, plus setters — same shape
  as the Explorer/SCM state already living here, not a separate store. This state should **not**
  live in `uiStore` alongside `historySearchFilters`; it's workspace-viewer-scoped exactly like
  `explorerPath`/`sourceControlFiles` already are, and closing the workspace viewer should clear it
  the same way `WorkspaceViewerModal.tsx`'s close handling clears other transient state (per the
  existing gotcha in `webview-react-workspace.instructions.md`: "closing the modal should clear
  transient loading/error flags through the store").

### 6. New pane (`src/ui/webview-react/components/workspace-viewer/WorkspaceSearchPane.tsx`)

Modeled on `HistorySearchDrawer`'s layout (search input with icon, scope/filter row, summary line,
scrollable result list, "Load more" by re-calling `workspaceSearch` with a higher `limit`) but
talking to `workspaceViewerStore` + `hostedApi.workspaceSearch` instead of `uiStore` + postMessage.
Each result row calls `openToFile(path)` or `openToFile(path, line, line)` (§ Existing Patterns) on
click, which switches to the Explorer tab and opens/selects the match — no bespoke navigation code
in the new pane.

### 7. Wiring

- `WorkspaceViewerHeader.tsx`: add the `Search` tab button next to `Source Control`
  (`codicon-search`), update the `activeTab`/`onTabChange` prop type.
- `WorkspaceViewerModal.tsx`: extend the `activeTab === "explorer" ? ... : ...` branch to a
  three-way switch rendering `WorkspaceSearchPane` for `"search"`.
- `WorkspaceExplorerPane.tsx`: add the shortcut search icon button to the toolbar
  (`WorkspaceExplorerPane.tsx:487-514`), calling `setActiveTab("search")`.

## Test Plan

- **Server (`src/test/unit/`, new `HostedWorkspaceViewerService.search.test.ts` or extend the
  existing `HostedWorkspaceViewerService.test.ts`):** filename matches, content matches with
  correct line numbers, binary files skipped, oversized files skipped, git-ignored files excluded
  by default and included when requested, multi-root/`repo` scoping, `truncated: true` once the
  scan budget is exceeded, non-git-root fallback walk.
- **`GitUtils.getGitIgnoredFiles` (`src/test/unit/GitUtils.test.ts`):** recursive ignored-file
  listing against a fixture repo (nested `.gitignore`, ignored subdirectory contents enumerated
  rather than collapsed to a directory name), and an empty result for a repo with nothing
  ignored.
- **Client (`src/ui/webview-react/test/components/workspace-viewer/`):** new
  `WorkspaceSearchPane.test.tsx` — debounced query issuing, scope toggle, min-length gating, empty
  state, loading state, "Load more", clicking a result calls `openToFile` with the right
  path/line.
- **Update existing tests:** `WorkspaceViewerModal.test.tsx` and any `WorkspaceViewerHeader` test
  for the third tab; `WorkspaceExplorerPane` toolbar test for the new shortcut button.

## Affected Files

| Area                                                                         | Planned change                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/types/HostedWorkspaceViewerTypes.ts`                                    | New search request/response/result types                                           |
| `src/utils/GitUtils.ts`                                                      | New `getGitIgnoredFiles()` only; reuse existing `getGitTrackedFiles()`             |
| `src/server/HostedWorkspaceViewerService.ts`                                 | New `searchWorkspace()` method                                                     |
| `src/server/CtrlYokeHostedServer.ts`                                         | New `GET /api/workspace-viewer/search` route                                       |
| `src/ui/webview-react/utils/hostedApi.ts`                                    | New `workspaceSearch()` client call                                                |
| `src/ui/webview-react/store/workspaceViewerStore.ts`                         | `activeTab` widened; new search state + setters                                    |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceSearchPane.tsx`   | New component                                                                      |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceViewerHeader.tsx` | New `Search` tab button                                                            |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceViewerModal.tsx`  | Three-way pane switch                                                              |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx` | Shortcut search icon button in the toolbar                                         |
| `src/ui/webview-react/utils/string.ts` (+ `utils/index.ts`)                  | `truncateSnippet()` moved here from `HistorySearchDrawer.tsx` and re-exported      |
| `src/ui/webview-react/components/search/HistorySearchDrawer.tsx`             | Import `truncateSnippet()` from the new shared util instead of defining it locally |
| Tests under `src/test/unit/**` and `src/ui/webview-react/test/**`            | New + updated coverage per Test Plan                                               |

## Non-Goals

- A persisted search index (§ Design Decisions #4).
- Regex, case-sensitive, or whole-word content search — v1 is plain case-insensitive substring.
- Result text highlighting inside snippets.
- Searching file content the AI harness hasn't written to disk yet (in-editor unsaved drafts) —
  search reads from disk like the Explorer's `workspaceStatus()`/`workspaceTree()` already do.
- Bundling `@vscode/ripgrep` (or any grep binary) for v1. Only revisit this if profiling on a real
  large repository shows the Node-native `readline` scan is inadequate — it's a swap-in for the
  content-matching half of `searchWorkspace()`, not an architecture change.
- A generic cross-feature `SearchResultRow` component (§ Existing Patterns — not worth it for two
  call sites yet).

## Implementation Steps

Staged 2026-08-19. Each step is one session: it lands, verifies, and commits on its own, and ticks
its box here (plus any correction to this document that the work uncovers).

- [x] **1 — Contracts.** Search types in `src/types/HostedWorkspaceViewerTypes.ts`; new
      `getGitIgnoredFiles()` in `src/utils/GitUtils.ts` (+ `GitUtils.test.ts` coverage).
- [ ] **2 — Server.** `HostedWorkspaceViewerService.searchWorkspace()` + the
      `GET /api/workspace-viewer/search` route, with unit coverage per the Test Plan.
- [ ] **3 — Client data layer.** `hostedApi.workspaceSearch()`; `workspaceViewerStore` search state
      and `activeTab` widening; `truncateSnippet()` moved into `utils/string.ts`.
- [ ] **4 — Search pane.** `WorkspaceSearchPane.tsx` + `WorkspaceSearchPane.test.tsx`.
- [ ] **5 — Wiring.** Header tab, modal three-way pane switch, Explorer toolbar shortcut, and the
      existing tests those touch.

## Definition of Done

- A `Search` tab exists in the workspace viewer alongside `Explorer` and `Source Control`, plus a
  shortcut button in the Explorer toolbar that jumps to it.
- Typing a query returns filename and content matches (per the selected scope) across all
  workspace roots the user can browse, honoring git-ignore rules and the multi-repo picker.
- Clicking a result opens the file in the Explorer tab, with the matching line selected for
  content matches.
- Binary and oversized files are never scanned; a scan that hits its budget reports `truncated`
  rather than hanging.
- New server and client tests cover the cases in the Test Plan.
