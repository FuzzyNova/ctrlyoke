# Commit History Panel

> **Status:** Not yet implemented — design draft, needs scope sign-off before implementation.

---

## Is This Worth Building?

**Yes, in a lean form.** The workspace viewer's source control pane (`WorkspaceSourceControlPane.tsx`)
currently shows staged/unstaged files and a commit/push/pull box
(`WorkspaceCommitArea.tsx`), but there's no way to see what was *already* committed
without leaving FlightPath. Common needs that come up constantly during workflow-driven
development:

- "What did the last few commits actually change?" (sanity-check before/after a workflow run)
- "Let me grab that commit hash/message so I can reference it in a prompt"
- "I want to poke around at an older commit without disturbing my branch" (detached HEAD)

All three are satisfied by a short scrollable commit list plus a right-click menu — no
graph rendering, no branch management UI, no merge/rebase tooling.

---

## Goals / Non-Goals

**Goals:**
- Lightweight, linear list of recent commits on the current branch (hash, message, author, relative date)
- "View Diff" on a commit reuses the existing `~<hash>` content-preview pipeline — no new diff UI
- Right-click menu mirroring `useWorkspaceExplorerContextMenu.tsx`'s ergonomics: copy info, add to FlightPath, checkout (detach)
- Clear indication when the workspace is in a detached HEAD state, with a one-click way back

**Non-Goals (explicitly out of scope):**
- Branch graph / commit graph visualization
- Branch creation, merging, rebasing, cherry-pick, revert UI
- Stash management
- Full `git log` feature parity (no author filters, date ranges, search — can revisit later if requested)
- Multi-branch comparison views

---

## UI Placement

Add `WorkspaceCommitHistoryPane.tsx` to
`src/ui/webview-react/components/workspace-viewer/`, mounted in
`WorkspaceSourceControlPane.tsx`'s `leftColumn` (and the mobile stack), directly below
the existing staged/changes sections — i.e. the left column becomes:

```
WorkspaceCommitArea        (push/pull, commit message, generate)
─────────────────────────
Staged / Changes sections  (existing)
─────────────────────────
Commit History             (new — collapsible section, default expanded)
```

A collapsible `<details>`-style header ("History") keeps it out of the way when the
user is focused on staging/committing, similar to how the staged/changes sections are
already collapsible-by-emptiness.

The commit's "View Diff" action reuses the existing `~<hash>` content-preview
pipeline (`REQUEST_GIT_CHANGE_PREVIEW` → `ContentPreviewModal`) — see "Viewing a
Commit's Diff" below. No new diff pane is needed.

---

## Data Model

### New types — `src/types/HostedWorkspaceViewerTypes.ts`

The commit list reuses `CommitInfo` from `src/utils/GitUtils.ts`
(`{ hash, shortHash, subject, author, relativeDate }`, produced by
`getRecentCommits()`) rather than redefining an equivalent shape:

```typescript
import type { CommitInfo } from "../utils/GitUtils";

export interface WorkspaceCommitLogEntry extends CommitInfo {
  isHead: boolean; // true for the commit HEAD currently points at
  pushed: boolean; // false if this commit is ahead of @{upstream}
}

export interface WorkspaceCommitLogResponse {
  commits: WorkspaceCommitLogEntry[];
  hasMore: boolean;
  currentBranch: string | null; // null when detached
  detached: boolean;
}

export interface WorkspaceCheckoutCommitRequest {
  hash: string;
}

export interface WorkspaceCheckoutBranchRequest {
  branch: string;
}
```

No `WorkspaceCommitFilesResponse` / per-commit file list type — "View Diff" (see
"Viewing a Commit's Diff" below) already shows the changed-files summary via
`git show --stat`.

### Backend — `src/server/HostedWorkspaceViewerService.ts`

New methods, following the existing `execFileAsync("git", [...])` pattern:

```typescript
// ── Git log ──────────────────────────────────────────────────────────────

async getCommitLog(skip = 0, limit = 30): Promise<WorkspaceCommitLogResponse> {
  // Reuse GitUtils.getRecentCommits() for the `%H%x00%h%x00%s%x00%an%x00%ar`
  // format string — add an optional `skip` parameter there
  // (`git log --skip=<skip> -n <limit + 1> ...`) rather than duplicating the
  // command/format here.
  //
  // hasMore = (rows returned > limit); trim to `limit` before returning
  // currentBranch via existing currentBranch(); detached = branch === "HEAD"
  // headHash via `git rev-parse HEAD` → isHead = entry.hash === headHash
  // pushed: commits NOT in `git rev-list @{upstream}..HEAD` (fallback: all
  //   pushed = true if no upstream — same try/catch pattern as getSyncCounts())
}

// ── Checkout ─────────────────────────────────────────────────────────────

async checkoutCommit(hash: string): Promise<{ detached: boolean }> {
  // git -C <root> checkout <hash>   → enters detached HEAD
  // validate hash exists first (git cat-file -e <hash>^{commit}) to give a clean error
}

async checkoutBranch(branch: string): Promise<{ branch: string }> {
  // git -C <root> checkout <branch>  → used by "Return to <branch>" banner action
}
```

`GIT_TIMEOUT_MS` and `safeResolve`/error conventions stay the same as existing methods.

### Frontend API — `src/ui/webview-react/utils/hostedApi.ts`

```typescript
export async function workspaceCommitLog(skip = 0, limit = 30): Promise<WorkspaceCommitLogResponse> {
  return hostedFetch<WorkspaceCommitLogResponse>(
    `/api/workspace-viewer/commit-log?skip=${skip}&limit=${limit}`
  );
}

export async function workspaceCheckoutCommit(req: WorkspaceCheckoutCommitRequest): Promise<{ detached: boolean }> {
  return hostedFetch("/api/workspace-viewer/checkout-commit", { method: "POST", body: JSON.stringify(req) });
}

export async function workspaceCheckoutBranch(req: WorkspaceCheckoutBranchRequest): Promise<{ branch: string }> {
  return hostedFetch("/api/workspace-viewer/checkout-branch", { method: "POST", body: JSON.stringify(req) });
}
```

Routes added in `FlightPathHostedServer.ts` `setupRoutes()` follow the exact same
try/catch/`requireToken`/`Log.error` shape as the existing `/commit`, `/push`, `/pull`
handlers (lines ~860-910).

### Store — `src/ui/webview-react/store/workspaceViewerStore.ts`

```typescript
// state
commitHistory: WorkspaceCommitLogEntry[];
commitHistoryLoading: boolean;
commitHistoryHasMore: boolean;
currentBranch: string | null;
detached: boolean;
previousBranch: string | null; // branch FlightPath was on before checkoutCommit, for the "Return to <branch>" banner

// actions
setCommitHistory(commits, hasMore, currentBranch, detached): void;
appendCommitHistory(commits, hasMore): void;   // for "load more"
setCommitHistoryLoading(v): void;
setPreviousBranch(branch: string | null): void;
```

`close()`/`reset()` should clear `commitHistoryLoading` alongside the existing flags,
same as other async-state cleanup.

---

## Viewing a Commit's Diff

"View Diff" rides on the shared git-ref click pipeline defined in
**`COMMIT_DIFF_PIPELINE_PLAN.md`** (a prerequisite for this feature) — it does **not**
introduce its own diff UI. After that pipeline lands, clicking a commit calls the same
two helpers the prompt-editor `~<hash>` links use:

- **Browser:** `useWorkspaceViewerStore.getState().openToGitRef(commit.hash)` — renders
  the commit's multi-file diff in the extended `WorkspaceDiffPane` (the pane already
  mounted next to `WorkspaceCommitArea`).
- **VS Code:** posts `OPEN_GIT_CHANGE` → native commit diff editor (`git.viewCommit`).

Because the commit history view lives **inside** the workspace viewer (browser-only),
the browser path is the common case and the diff opens right beside the history list —
no modal, no separate "changed files" endpoint (the rendered diff lists every file).

> If `COMMIT_DIFF_PIPELINE_PLAN.md` is not yet implemented when this feature is built,
> the interim fallback is the old `REQUEST_GIT_CHANGE_PREVIEW` → `ContentPreviewModal`
> path — but the two plans are intended to land pipeline-first.

---

## Context Menu — `useCommitHistoryContextMenu.tsx`

New hook in `src/ui/webview-react/hooks/`, structured like
`useWorkspaceExplorerContextMenu.tsx`: returns `{ openContextMenu, contextMenuPortal }`
and renders via the existing `StepContextMenu` component (no new menu primitive needed).

Menu items for a right-clicked commit:

| Item | Action | Notes |
| --- | --- | --- |
| **Copy Hash** | Copy full SHA to clipboard | `navigator.clipboard.writeText(commit.hash)` |
| **Copy Message** | Copy subject line to clipboard | |
| *(divider)* | | |
| **View Diff** | `openToGitRef(commit.hash)` (browser) / `OPEN_GIT_CHANGE` (VS Code) | Shared git-ref pipeline — see "Viewing a Commit's Diff" above and `COMMIT_DIFF_PIPELINE_PLAN.md` |
| **Add Commit to FlightPath** | Insert `~<hash>` via `enqueuePromptEditorInsert` | See below — the same `~<hash>` reference the VS Code timeline command produces |
| *(divider)* | | |
| **Checkout Commit (Detach HEAD)** | Confirm via `Modal` (reuse the discard-confirmation pattern), then `workspaceCheckoutCommit({ hash })`, refresh status/log | Disabled (with `disabledTitle`) if `commit.isHead && !detached` |

### "Add Commit to FlightPath" details

FlightPath already has a fully-wired `~<hash>` git reference type: it's recognized by
the prompt editor's completions/decorations (`CodeMirrorEditor.tsx`), expanded into a
full diff attachment by `ContextExpander.expandGitChanges()` via `getCommitDiff()`, and
is exactly what the existing `flightpath.addTimelineCommitToPromptEditor` VS Code
command inserts via `ContextMenuReferenceCommands.addTimelineCommitToPromptEditor()` →
`buildGitReference(hash)` (`src/completions/ContextReferenceBuilder.ts`, returns
`` `~${hash}` ``).

The new context menu item mirrors that exact pattern from the React side:

```typescript
import { buildGitReference } from "@root/completions/ContextReferenceBuilder";

const editorStore = useEditorStore.getState();
editorStore.preparePromptEditorForInsert();
editorStore.enqueuePromptEditorInsert({
  requestId: `commit-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  references: [buildGitReference(commit.hash)], // "~<hash>"
  mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
});
```

`@root/completions` isn't a Vite alias yet (only `@root/types` and `@root/utils` are,
in `vite.config.ts`) — add it alongside those so this stays single-sourced rather than
re-implementing the one-line `` `~${hash}` `` builder in the webview.

Once inserted, `~<hash>` gets the same completion, decoration, click-to-preview, and
context-expansion treatment as any other git reference — no prompt-resolution changes
needed.

---

## Detached HEAD Banner

When `workspaceViewerStore.detached === true` (returned from `getCommitLog`), render a
small banner above the commit list:

```
⚠ Detached HEAD at abc1234        [Return to main]
```

"Return to `<branch>`" needs *some* branch name — capture the branch FlightPath was on
before the checkout in the store (`previousBranch`, set when `checkoutCommit` succeeds)
and fall back to a manual branch-name prompt if unavailable (e.g. user detached via
terminal in a prior session and just opened the panel).

`[Return to <branch>]` → `workspaceCheckoutBranch({ branch })` → refresh status, log,
and source control files.

---

## Implementation Phases

### Phase 1 — Read-only history + diff viewing

- [ ] Add optional `skip` parameter to `GitUtils.getRecentCommits()`
- [ ] Add `WorkspaceCommitLogEntry`, `WorkspaceCommitLogResponse` to `HostedWorkspaceViewerTypes.ts`
- [ ] `HostedWorkspaceViewerService.getCommitLog()`
- [ ] Route: `GET /api/workspace-viewer/commit-log`
- [ ] `hostedApi.ts`: `workspaceCommitLog()`
- [ ] Store: `commitHistory`, `commitHistoryLoading`, `commitHistoryHasMore`, `currentBranch`, `detached`, `previousBranch` + setters
- [ ] `WorkspaceCommitHistoryPane.tsx`: collapsible list, "Load more"
- [ ] "View Diff" calls the shared git-ref click pipeline (`openToGitRef` / `OPEN_GIT_CHANGE` — see `COMMIT_DIFF_PIPELINE_PLAN.md`, the prerequisite)

### Phase 2 — Context menu actions

- [ ] Add `@root/completions` alias to `vite.config.ts`
- [ ] `useCommitHistoryContextMenu.tsx` (Copy Hash, Copy Message, View Diff, Add Commit to FlightPath)
- [ ] Wire context menu into `WorkspaceCommitHistoryPane.tsx` rows

### Phase 3 — Checkout / detached HEAD

- [ ] `WorkspaceCheckoutCommitRequest`/`WorkspaceCheckoutBranchRequest` types
- [ ] `HostedWorkspaceViewerService.checkoutCommit()` + `checkoutBranch()`
- [ ] Routes: `POST /api/workspace-viewer/checkout-commit`, `POST /api/workspace-viewer/checkout-branch`
- [ ] "Checkout Commit (Detach HEAD)" menu item + confirmation modal
- [ ] Detached HEAD banner + "Return to `<branch>`" + `previousBranch` tracking
- [ ] Refresh commit log, status, and source control files after any checkout

### Possible Future Extensions (not planned, just noted)

- Search/filter commit list by message or author
- "Create branch from commit" (would need a small input for the branch name)
- Surfacing the generated-commit-message tracker's last record inline in history

---

## Testing

- `src/test/server/HostedWorkspaceViewerService.test.ts` (or sibling): `getCommitLog` pagination/`hasMore`/`isHead`/`pushed` (including `pushed` against a fake upstream), `checkoutCommit`/`checkoutBranch` happy + error paths
- `src/test/unit/GitUtils.test.ts` (or sibling): `getRecentCommits` with `skip`
- `src/ui/webview-react/test/store/workspaceViewerStore.test.ts`: new state/actions, `close()`/`reset()` cleanup
- `src/ui/webview-react/test/components/workspace-viewer/WorkspaceCommitHistoryPane.test.tsx`: renders commits, load-more, detached banner, context menu wiring, "View Diff" and "Add Commit to FlightPath" dispatch the expected message/store calls
- Manual: verify detached HEAD checkout + return-to-branch round trip doesn't desync `sourceControlFiles`/diff state (mirrors the existing "refresh-after-mutation" gotcha)

---

## Open Questions

1. **Pane vs. tab**: collapsible section under source control (as drafted) vs. a third tab alongside Explorer/Source Control? Collapsible section keeps it lean and avoids new tab-routing state — recommended.
2. **History scope**: current branch only (via plain `git log`), or should it follow `HEAD` even when detached (i.e., `git log` always reflects whatever `HEAD` points at)? Recommend the latter — it's what `git log` does by default and keeps the implementation simple.
