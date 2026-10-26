# Workspace Viewer Worktree Switcher

**Status:** Not started. Written 2026-10-22 against current code, deliberately
held until after 0.2.1.
**Priority:** P2

Last reviewed against code: 2026-10-26.

## Problem

The workspace viewer only shows the checkout the dashboard was started from.
To look at another worktree of the same repository (its files, its uncommitted
changes, its history) you have to open that folder in a separate VS Code
window, which the hosted browser dashboard cannot do at all. Settings →
Worktrees already shows each worktree's posh-git status (`WorktreeGitStatus`),
so the natural next step is "show me that worktree" from the same place.

Two pieces of work:

1. A **worktree dropdown in the viewer header** that switches Explorer, Source
   Control and Search to another linked worktree of the same repository.
2. In the **browser**, the worktree buttons that open a VS Code window instead
   open the viewer with that worktree already selected.

## How things work today

- **The viewer exists only in the hosted browser.** `WorkspaceViewerModal` and
  its Header button are gated on `isStandalone` (`components/layout/Header.tsx`).
  The VS Code panel has no viewer, so the VS Code path keeps opening native
  windows.
- **The worktree "open" buttons are hidden in the browser.**
  `DASHBOARD_HOST_CAPABILITIES.openFolderWindow` is in
  `HOST_SCREEN_CAPABILITIES` (`types/DashboardConstants.ts`), which is withheld
  from hosted clients because a VS Code window would open on the host machine's
  screen, not the user's. Two buttons depend on it:
  - **Open owning workspace** on an in-use row in `WorktreesSection.tsx`
    (`MESSAGE_TYPES.OPEN_WORKTREE_OWNER`). It opens `lease.stateRoot`, the
    checkout that started the run, not the worktree itself.
  - **Open worktree** in `RunSummaryBanner.tsx` (`MESSAGE_TYPES.OPEN_WORKTREE`),
    which opens `worktree.worktreePath`.
- **The viewer's file boundary** is `HostedWorkspaceViewerService.trustedRoots`:
  the workspace roots plus `runtimeTrustedRootRegistry.getRoots()`. That
  registry (`utils/RuntimeTrustedRootRegistry.ts`) already grants process-only
  trust to managed worktrees while a run holds them, and `register()` refuses a
  path that does not resolve to the expected repository. So trusting a sibling
  worktree has a precedent, but those grants live only as long as the run.
- **Repos are per request.** The multi-repo picker in `WorkspaceCommitArea`
  sends `repo=<id>` on SCM calls; `resolveRepoRoot(repoId)` maps it to a git
  toplevel server-side, and `WorkspaceRepo.rootPath` never reaches the client
  as a viewer path. Viewer paths are relative to the roots in `viewerContext`
  (`primaryRoot`, `namedRoots`), and in multi-root mode they are prefixed with
  the root's folder name.

## Security boundary

**Rule:** the viewer may switch to a directory only if `git worktree list`
returns it for a repository that contains a workspace root. Nothing else is
accepted, and no path ever comes from the client.

Why this is a fair trade:

- **Same repository.** Linked worktrees share the object database and refs, so
  their committed content is already readable through the viewer's history
  and diff views. The new exposure is uncommitted and untracked files (e.g. a
  `.env`) in those other checkouts.
- **Same user.** Worktree metadata (`.git/worktrees/*`) is local-only and is
  never cloned, so only someone who can already write to the repository's `.git`
  can add an entry pointing somewhere unexpected.
- **Same token.** Anyone holding the hosted dashboard token can already run
  workflows that execute harnesses and scripts in these worktrees, which is a
  strictly stronger capability than reading their files.

How to enforce it:

- Resolve on every switch and re-check on each request through a short-TTL
  cache keyed by the repository's common dir. Never persist a grant.
- Accept only entries whose directory exists and that Git does not mark
  prunable (`GitWorktreeEntry.prunableReason`). Verify each one with the same
  same-repository check `RuntimeTrustedRootRegistry.register()` uses: extract
  `sameRepository`/`repositoryIdentity` into a shared helper rather than
  calling `register()`, whose grants are owner-counted for runs.
- Keep `realpath` and symlink containment exactly as it is today
  (`safeResolveWorkspacePath`, `isPathWithinDirectory`). The worktree only
  replaces the root that containment is measured against.
- The client refers to a worktree by an opaque id (a hash of its normalized
  path), mirroring `WorkspaceRepo.id`. A stale or unknown id is a 404, never a
  fallback to the primary root.
- Parity with the primary checkout: reading, saving, staging, committing,
  discarding, checkout. A read-only first cut is possible, but every SCM
  endpoint would then need a second code path, and the token already allows
  more than this.

## Design

### Server

- **`GET /api/workspace-viewer/worktrees`** returns, per repository, the
  worktrees eligible under the rule above:
  `{ id, label, branchName, isCurrent, workingTree, sourceComparison }`. The
  status fields come from the same `getWorkingTreeCounts`/`getAheadBehind`
  calls `WorktreeManager.getManagementState`
  (`src/core/orchestration/WorktreeManager.ts`) makes, so the dropdown can render
  `WorktreeGitStatus`. Factor that per-entry status into one helper instead of
  calling git twice in two places.
- **Every viewer endpoint accepts an optional `worktree=<id>`**, the way SCM
  endpoints accept `repo`. It is per request rather than service state because
  one `HostedWorkspaceViewerService` serves every connected client: a phone and
  a desktop tab must be able to view different worktrees at once.
- **Per-request root context.** `viewerContext`, `trustedRoots`,
  `primaryRootName`, `resolveRepoRoot`, `getReposInternal` and `searchRoots`
  are getters over constructor fields today. They become one per-request root
  context resolved from the request's worktree id and passed down. Note that
  `ViewerRootContext` already exists (`src/platform/WorkspaceViewerPath.ts`,
  just `{ primaryRoot, namedRoots }` for viewer-path conversion); give the
  per-request object its own name (e.g. `ViewerRequestRoots`) that contains a
  `ViewerRootContext` rather than overloading that type. This is the bulk of
  the change: it touches nearly every method in a 3,000-line service, so do it
  as a mechanical refactor commit first, with no behavior change.
- **Mapping roots into a worktree.** A workspace root at `<repo>/packages/a`
  maps to `<worktree>/packages/a`, the same relative path inside the selected
  worktree. In a multi-repo workspace, only the roots inside the selected
  worktree's repository are remapped; roots from other repositories stay put.
  Viewer path prefixes (root folder names) stay the same, so stored refs,
  back/forward history and `prefixRepoIds` keep working.
- **Language intelligence** (`server/lsp/`) is rooted at the workspace roots.
  Phase 1 disables references/definitions while a non-current worktree is
  selected and says so in `WorkspaceLanguageReferencesPanel`. Starting language
  servers per worktree is a follow-up, if anyone wants it.
- **Change notifications.** Whatever pushes explorer/SCM refreshes for the
  primary root must either watch the selected worktree too, or the client
  falls back to polling and refresh-on-focus while one is selected. Check which
  before starting; this is a likely gap.

### Client

- **Store:** `workspaceViewerStore.selectedWorktreeId` (null = the dashboard's
  own checkout), plus `openWorktree(id)`, which opens the modal with that
  worktree selected. `hostedApi.ts` appends `worktree=` to every viewer call
  when it is set, in one place (`hostedFetch` or a shared params builder), not
  per function.
- **Header dropdown:** a `WorkspaceWorktreePicker` in `WorkspaceViewerHeader`,
  beside the workspace title. Each option shows the `WorktreeGitStatus` line.
  Move that component from `components/settings/` to `components/shared/`; its
  branch coloring (`scmGraphBranchColorClass`, trunk for the current checkout)
  carries over unchanged. Hidden when the repository has only one worktree. In
  a multi-repo workspace, options are grouped by repository.
- **Relationship to the repo picker:** the worktree picker chooses which
  checkout each repository's roots point at, and the SCM pane's repo picker
  keeps choosing which repository's source control to show. They are
  orthogonal, so the repo picker needs no change.
- **Switching resets per-checkout state:** open file and editor tabs, diff
  selection, file history, the commit-history listing (`usePagedCommitHistory`
  already re-keys on `repo`, so add `worktree` to its key), and search
  results. Unsaved edits in the open file must block the switch with the
  existing unsaved-changes prompt.
- **Navigation:** `navigation/navState.ts` records the worktree id so
  back/forward and deep links restore it. An id that no longer resolves falls
  back to the current checkout with a toast.
- **Header subtitle** shows the selected worktree's path and branch so it is
  always clear which checkout is being edited.

### Browser versions of the "open" buttons

In the browser (`isStandalone`, no `openFolderWindow` capability):

- **`WorktreesSection` rows** show **Open in viewer** on every row whose
  directory exists, not just in-use rows. It calls `openWorktree(id)` for
  `entry.worktreePath`. This gives the settings view the same "view this
  worktree" action the header dropdown has.
- **The in-use row's "Open owning workspace"** becomes **Open in viewer** for
  the worktree itself. The VS Code button opens `lease.stateRoot` because a
  window has to be the owning workspace to show the run; the viewer's job is to
  show files, so the worktree is the useful target. Keep the VS Code behavior
  as it is.
- **`RunSummaryBanner`'s "Open worktree"** gets the same treatment.
- The worktree id comes from the `/worktrees` listing. Settings must not
  compute it client-side; it can look it up by path once the listing has
  loaded, or the management state can carry the id.

VS Code keeps the native-window buttons and gets no viewer.

## Tests

- **Service:** `/worktrees` lists only `git worktree list` entries for
  workspace repositories. A prunable entry, a missing directory and a
  different-repository directory are all rejected. An unknown id returns 404 on
  every endpoint. Path containment holds inside a selected worktree (`..`, a
  symlink out of it). Multi-root remapping keeps roots from other repos
  unchanged.
- **Per-request isolation:** two concurrent requests with different worktree
  ids read different files.
- **Client:** the picker is hidden with one worktree. Switching resets editor,
  diff, history and search state. Unsaved edits block the switch. navState
  round-trips the id. In the browser, `WorktreesSection` and
  `RunSummaryBanner` render **Open in viewer** and call `openWorktree`, while
  VS Code still renders the native buttons.

## Docs and changelog

- `docs/workflows/worktrees.md` → "Managing worktrees": Open in viewer.
- The workspace viewer guide page: the worktree dropdown and what it changes.
- `CHANGELOG.md` under **Changed** for the release that ships it.

## Phasing

1. Mechanical refactor: per-request `ViewerRootContext` in
   `HostedWorkspaceViewerService`, with no behavior change and the existing
   tests green.
2. Worktree resolution, the `/worktrees` endpoint, the `worktree=` parameter,
   and the security tests.
3. Header picker, store, navState, and state reset.
4. Browser **Open in viewer** buttons in `WorktreesSection` and
   `RunSummaryBanner`.
5. Follow-up, optional: language servers per worktree.

## Open questions

- **Worktrees outside the workspace's parent directory.** They are allowed by
  the rule, since `git worktree list` is the boundary rather than a location.
  Confirm that is still the intent once it is built.
- **Submodules:** out of scope; `git worktree list` does not enumerate them.
- **Discovered vs. managed worktrees:** list both. A managed worktree in use
  by a run should show a warning in the picker, because editing it races the
  harness.
