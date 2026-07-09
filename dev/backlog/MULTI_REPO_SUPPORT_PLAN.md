# Multi-repo workspace support — implementation plan

## Core model

Introduce a **`WorkspaceRepo`** abstraction discovered from git toplevels, decoupled from workspace roots. Everything git-related keys on a `repoId`; every file path stays in the existing folder-name-prefixed viewer-path language, so `relativePath()` remains the single bridge between absolute paths and what the UI/resolver understand.

New shared type in `HostedWorkspaceViewerTypes.ts`:

```ts
export interface WorkspaceRepo {
  id: string; // stable key — the repo's toplevel folder name, disambiguated if collisions
  label: string; // display name for the selector
  rootPath: string; // absolute git toplevel
}
```

---

## Phase 1 — Server: repo discovery + parametrized git

**`HostedWorkspaceViewerService.ts`**

1. **Discovery** (cached, invalidated on root change): for each `namedRoots` entry (or `workspaceRoot` in single-root), run `git -C <root> rev-parse --show-toplevel`; dedupe toplevels → `WorkspaceRepo[]`. Non-repo roots drop out. Add `getRepos()` + a `repoForPath(abs)` helper (find the repo whose `rootPath` contains the abspath).
2. **Parametrize every git helper** by a `repoRoot` argument, replacing the hardcoded `this.workspaceRoot`: `getStatus`, `getSyncCounts`, `getDiff`, `stageFile`, `unstageFile`, `discardFile`, `commit`, `push`, `pull`, `currentBranch`, `currentRemote`, `getCommitLog`, `resolveBranchHint`, `checkoutCommit`, `checkoutBranch`, `getGitRefDiff`, `generateCommitMessage`.
3. **Delete `assertWithinPrimaryRoot`** and `relativeToPrimaryRoot`; replace with `relativeToRepo(abs, repoRoot)`. Path-carrying ops (`diff`/`stage`/`unstage`/`discard`) infer their repo via `repoForPath(resolved)`.
4. **`getStatus(repoId?)`**: `repoId` omitted → run per-repo across all repos and concat, prefixing each file via `relativePath(join(repoRoot, gitRelPath))` (drop the hardcoded `primaryRootName` prefix at line 808). `repoId` set → that repo only. Same for sync counts (per-repo).

**`CtrlYokeHostedServer.ts`** — add `GET /api/workspace-viewer/repos`; thread an optional `repo` query/body param into `status`, `commit`, `push`, `pull`, `commit-log`, `checkout-commit`, `checkout-branch`, `generate-commit-message`.

**`hostedApi.ts`** — add `workspaceRepos()`; add optional `repo` arg to the eight repo-scoped wrappers.

**Outcome:** the explorer's `loadGitStatus()` (`WorkspaceExplorerPane` line 303) now colors files across _all_ roots with no UI change, since it calls `workspaceStatus()` with no repo → aggregate.

---

## Phase 2 — SCM UI: repo selector

**`workspaceViewerStore.ts`** — add `repos: WorkspaceRepo[]`, `selectedRepoId: string | null`, `setRepos`, `setSelectedRepoId`. On repo load, default `selectedRepoId` to the repo containing `selectedFilePath`/`selectedDiffPath`, else the first repo.

**`WorkspaceSourceControlPane.tsx`**

- On mount, `workspaceRepos()` → store. Thread `selectedRepoId` into `loadStatus`/`loadHistory`/`loadMoreHistory` (pass `repo` to `workspaceStatus`/`workspaceCommitLog`), and re-run all three when `selectedRepoId` changes.
- Render a **repo picker** at the top of `leftColumn` (and the mobile column), shown only when `repos.length > 1`: repo label + dirty-count badge + ahead/behind. Sits above `WorkspaceCommitArea`.

**`WorkspaceCommitArea.tsx`** — `handleCommit`/`handlePush`/`handlePull` pass `selectedRepoId`. Staging loop already uses per-file paths (repo inferred server-side), so it's correct once Phase 1 lands.

**`WorkspaceCommitHistoryPane.tsx`** — `handleReturnToBranch`/`workspaceCheckoutBranch` pass `selectedRepoId`; commit-row checkout likewise. No visual change beyond being repo-scoped.

**Diff pane** — repo inferred from the file path server-side; no change needed. `WorkspaceGitRefDiffResponse`/commit clicks need the `repo` param plumbed through `openToGitRef`.

---

## Phase 3 — Per-repo snapshots + undo/redo

**`OutputHistoryTypes.ts`**

- `SnapshotFileChange`: add `repo?: string` (repoId; absent → filesystem/non-repo root). Keep `path` as the folder-name-prefixed viewer path.
- `WorkspaceSnapshot`: replace top-level `strategy`/`git` with a per-repo map, e.g. `repos?: Record<string, { strategy; git?: WorkspaceSnapshotGitInfo }>`, plus a workspace-level `strategy` retained only for the no-repo filesystem case. (Pre-release, no migration needed.)

**`WorkspaceSnapshotService.ts`**

- `RawWorkspaceState` becomes per-repo: `{ repos: Map<repoId, { strategy, git, files }>, filesystemFiles }`. `captureWorkspaceState(repos, ...)` iterates repos (each own `selectStrategy`/`getGitSnapshotInfo`/`git status`), keying files by viewer path and tagging `repo`. One filesystem pass covers roots in no repo.
- `computeSnapshotChanges` runs its existing per-repo logic (HEAD lookups, `getCommitRangeChanges`) once per repo against that repo's `rootPath` + `headCommit`.
- `undoFiles(files, resolver)`: resolve each instruction's path via the same folder-name-prefix resolver used everywhere (not a single `workspacePath`). The path-traversal guard checks against the file's repo/root, not one workspace root.

**Callers** — `WorkflowInstance.ts` (line 2250 and the `workspaceFolderPath` plumbing), `OutputHistoryManager`, `WorkflowExecutor`, `UndoRedoCoordinator.ts` (lines 45-162): pass the discovered repo set / resolver instead of the single `workspacePath`. Reuse the same discovery logic as the server (extract a shared `discoverRepos(roots)` helper into `src/utils` or `src/platform` so server and core single-source it).

---

## Cross-layer sync checklist (per CLAUDE.md)

- Shared types: `WorkspaceRepo`, `SnapshotFileChange.repo`, `WorkspaceSnapshot.repos`.
- `hostedApi.ts` ↔ `CtrlYokeHostedServer.ts` route params.
- Tests: `HostedWorkspaceViewerService.test.ts` (repo discovery, aggregate vs scoped status, path-carrying-op repo inference), snapshot tests for multi-repo capture/undo, and React tests for the selector + repo-scoped loads.
- Instruction files to update afterward: `server.instructions.md`, `utils.instructions.md`, `webview-react-workspace.instructions.md`, `types-hosted.instructions.md`.

---

A shared **`discoverRepos(roots)`** helper is the linchpin — server SCM and core snapshots must discover repos identically, or undo will disagree with the SCM pane about which repo a file belongs to. I'd build that helper first.
