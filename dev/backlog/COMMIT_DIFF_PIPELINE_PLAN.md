# Git Ref Diff Pipeline — Render diffs properly, drop the raw-text modal

> **Status:** Phase 2 (VS Code native diff) ✅ shipped — all four ref kinds open natively. Phase 1 (browser multi-file pane) and Phase 3 (cleanup) remain. **Prerequisite for** `COMMIT_HISTORY_PANEL_PLAN.md` (the history panel's "View Diff" rides on this pipeline).

---

## Problem

Clicking a `~<ref>` git link (in the CodeMirror prompt editor today, and in the
planned commit history view) runs the same pipeline in **both** VS Code and browser
modes:

1. `CodeMirrorEditor.openContextReferenceLink()` (`data-type="git"`) posts
   `REQUEST_GIT_CHANGE_PREVIEW` with the raw ref.
2. The handler (`WebviewMessageRouter.buildGitChangeContent()` → `GitUtils`) returns the
   text of `git show --stat -p <hash>` (or `getWorkingTreeDiff`/`getStagedDiff`/
   `getStashDiff` for `~diff`/`~staged`/`~stash:N`).
3. `useMessageHandler` (`GIT_CHANGE_PREVIEW_RESULT`) drops that text into
   `ContentPreviewModal` with `language: "diff"`.
4. `ContentPreviewModal` renders it as a `<pre>` block — **raw unified-diff text, not a
   rendered diff** — and its "Open in Editor" button sends `EXPORT_CONTENT_PREVIEW`,
   which opens the raw diff text as a throwaway untitled document (it does *not* open a
   real VS Code diff of the change).

Two things are wrong:

- **The diff isn't rendered.** We have a first-class diff renderer (`DiffView`, built on
  `react-diff-view`) used everywhere else in the output, but git-ref previews bypass it.
- **VS Code mode shouldn't use an in-app modal at all.** The workspace viewer (and its
  `WorkspaceDiffPane`) is **browser-only** — in VS Code we should open the change in the
  editor's *native* diff UI, not a webview `<pre>`.

> Note: the existing `ctrlyoke.openGitChange` command (`extension.ts`) already opens a
> generated diff in an untitled `language: "diff"` document — same raw-text shortcoming,
> just in an editor tab instead of a modal. This plan supersedes it.

---

## Desired behavior

Branch on `isStandalone` at the click site instead of always posting one message:

| Mode | What clicking a `~<ref>` link does |
| --- | --- |
| **VS Code** (`isStandalone === false`) | Bypass the modal entirely. Invoke a **native VS Code diff** command — including stash, via `vscode.changes`. No `ContentPreviewModal`. |
| **Browser** (`isStandalone === true`) | Open the workspace viewer to its **Source Control tab** (`activeTab: "sourceControl"`) and render the diff in `WorkspaceDiffPane`, extended to show **multi-file** diffs, with a **Download** button in the pane header. No `ContentPreviewModal`. |

After this change, `ContentPreviewModal` is **no longer used for git diffs** in either
mode. (It stays for `$prior-context` XML previews — see "ContentPreviewModal" below.)

**Why a pane (not a modal) in the browser:** clicking an `@file` link in the prompt
editor *already* opens the workspace viewer (`openToFile` → `isOpen: true`, explorer
tab) rather than a modal. A `~git` link opening the same viewer's Source Control tab is
the **consistent** behavior; a separate git-only modal would be the odd one out. The
pane is also persistent/non-blocking, which suits multi-file diffs better than a
transient overlay.

**Export/download:** the old modal's only capability worth keeping is "save the diff to
hand to another agent," and that only has real value in the browser (in VS Code you're
already in an editor). It's preserved as a **Download** button on the browser diff pane —
not by keeping the modal alive.

---

## VS Code command mapping — RESOLVED ✅

`git.openChange` was the wrong guess — it opens the working-tree-vs-HEAD diff for an
**SCM resource**, not a commit. Verified against the `vscode.git` extension source
(`extensions/git/src/commands.ts`) and the public commands reference, the mapping is:

| Ref | VS Code command | Notes | Status |
| --- | --- | --- | --- |
| `~<hash>` (commit) | **`git.viewCommit`** | `viewCommit(repository, historyItemId)`, registered `{ repository: true }`. The wrapper resolves `args[0]` to a repo via `model.getRepository()`, so invoke as `executeCommand("git.viewCommit", Uri.file(workspaceRoot), hash)`. Opens the native multi-file commit viewer. | ✅ done |
| `~diff` (working tree) | `git.viewChanges` | `viewChanges(repository)` — pass the repo Uri. | ✅ done |
| `~staged` | `git.viewStagedChanges` | `viewStagedChanges(repository)` — pass the repo Uri. | ✅ done |
| `~stash:N` | **`vscode.changes`** | No built-in per-index stash command, so build the native multi-file diff ourselves (see below). | ✅ done |

`git.viewCommit`/`viewChanges`/`viewStagedChanges` are implemented in
`ctrlyoke.openGitChange` (`extension.ts`), native-first with a generated-diff-document
fallback on any failure (older VS Code / Git extension disabled). Command IDs are
single-sourced as `VSCODE_GIT_COMMANDS` in `DashboardConstants.ts`. This also upgrades
the `PromptLinkProvider` markdown hover links and the `OPEN_GIT_CHANGE` message, which
already route through `ctrlyoke.openGitChange`.

### Native stash diff — `vscode.changes` ✅ implemented

`git.stashView` only shows a stash *quick-pick* (no index argument), so for `~stash:N`
we open the native multi-file diff editor directly with the **public** `vscode.changes`
command — the same UI the other refs get, no raw text. Implemented in
`ctrlyoke.openGitChange` (`extension.ts`) as `openNativeStashDiff()`:

```typescript
// vscode.changes(title, resourceList: [resourceUri, originalUri, modifiedUri][])
const gitApi = vscode.extensions
  .getExtension<{ getAPI(v: 1): { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri } }>("vscode.git")
  ?.exports.getAPI(1);
const files = gitApi ? await getStashFiles(workspaceRoot, index) : []; // git stash show --name-only
if (!gitApi || files.length === 0) { await openGeneratedDiff(); return; }
const stashRef = `stash@{${index}}`;
const resources = files.map((rel) => {
  const fileUri = vscode.Uri.joinPath(repoUri, rel);
  return [fileUri, gitApi.toGitUri(fileUri, `${stashRef}^`), gitApi.toGitUri(fileUri, stashRef)];
});
await vscode.commands.executeCommand(VSCODE_GIT_COMMANDS.CHANGES, `Git Stash #${index}`, resources);
```

`vscode.changes` and `API.toGitUri(uri, ref)` are confirmed public API.
`CHANGES: "vscode.changes"` was added to `VSCODE_GIT_COMMANDS`, and
`GitUtils.getStashFiles(root, index)` (tracked changes only, parity with `getStashDiff`)
provides the file list. The generated-diff document remains the fallback when the Git
extension API is unavailable, the stash has no tracked files (untracked-only), or
`vscode.changes` throws — so stash never hard-fails, only (worst case) renders as text.

---

## Architecture

### 1. Click-site routing — `CodeMirrorEditor.openContextReferenceLink()`

Today (`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`, ~line 1747):

```typescript
if (type === "git") {
  const gitRef = target.getAttribute("data-git-ref");
  vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_GIT_CHANGE_PREVIEW, ref: gitRef });
  return true;
}
```

Split by mode:

```typescript
if (type === "git") {
  const gitRef = target.getAttribute("data-git-ref")!;
  if (isStandalone) {
    // Browser: open the diff pane to this ref (see store action below)
    useWorkspaceViewerStore.getState().openToGitRef(gitRef);
  } else {
    // VS Code: native diff, no modal (routes to ctrlyoke.openGitChange)
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_GIT_CHANGE, ref: gitRef });
  }
  return true;
}
```

> **Implemented (Phase 2):** the VS Code branch already posts `OPEN_GIT_CHANGE`. The
> browser branch still posts `REQUEST_GIT_CHANGE_PREVIEW` (modal) as an interim until
> `openToGitRef` lands in Phase 1.

This is the single source of truth for "click a git ref" — the planned commit history
view's "View Diff" action calls the **same** two helpers (`openToGitRef` /
`OPEN_GIT_CHANGE`) rather than reinventing routing.

### 2. VS Code side — native diff command

The VS Code branch posts `OPEN_GIT_CHANGE`, which routes through `ctrlyoke.openGitChange`
(reused, not a new message) to invoke the native commands per the mapping table above
instead of building a `language: "diff"` document. All four ref kinds are done —
commit/diff/staged via the dedicated git commands, and stash via `vscode.changes` +
`toGitUri` (see "Native stash diff" above), backed by `GitUtils.getStashFiles()`.

`REQUEST_GIT_CHANGE_PREVIEW` / `GIT_CHANGE_PREVIEW_RESULT` and `buildGitChangeContent`
become **dead code for the git path** once nothing posts them — delete them (and the
`GIT_CHANGE_PREVIEW_RESULT` handler in `useMessageHandler`) unless `$prior-context` still
needs the modal (it uses the separate `PRIOR_CONTEXT_PREVIEW_RESULT` pair, so the git
pair can go).

### 3. Browser side — multi-file `WorkspaceDiffPane`

Today `WorkspaceDiffPane` renders exactly one file from
`diffOldContent`/`diffNewContent` (full-file content → `DiffView`). A commit (or
`~diff`/`~staged`) spans many files, and for historical commits we have unified-diff
text, not old/new full-file content.

Plan:

- **New store state** in `workspaceViewerStore`:
  ```typescript
  // A rendered diff can be either a single working-tree file (existing) or a
  // multi-file git ref (new).
  diffFiles: ParsedDiffFile[] | null;   // null = single-file mode (existing path)
  diffRefLabel: string | null;          // e.g. "Commit abc1234" for the pane header
  ```
  where `ParsedDiffFile` carries `{ path, oldPath?, language, hunks }` (hunks already in
  the `react-diff-view` shape).

- **New action** `openToGitRef(ref: string)`:
  - `set({ isOpen: true, activeTab: "sourceControl" })` (the diff pane lives in the
    Source Control tab next to `WorkspaceCommitArea`; tab id is `"sourceControl"`),
  - `setDiffLoading(true)`,
  - fetch the unified diff via a new `workspaceGitRefDiff(ref)` hosted endpoint
    (thin wrapper over the same `GitUtils` helpers the VS Code path drops),
  - parse it with `parseDiff` from `react-diff-view` — **already used** in
    `src/ui/webview-react/utils/rdvAdapter.ts` (`toRdvFromContent` calls it) — into
    per-file entries, map each file's hunks via the existing `toRdvHunks`/adapter, infer
    `language` from the path, and `set({ diffFiles, diffRefLabel })`.

- **`WorkspaceDiffPane`** renders:
  - existing single-file branch when `diffFiles === null` (unchanged),
  - else a header banner (`diffRefLabel`, a **Download** button, and a close/back
    affordance) followed by one `DiffView` per `ParsedDiffFile` (each with its own
    file-path sub-header), reusing the `structuredPatch`/hunks input path of `DiffView`
    (no full old/new content needed for historical commits — the hidden-line expansion
    controls simply won't appear, which is correct since we don't have surrounding
    context for an arbitrary commit).
  - **Download** reuses the browser blob-download approach already in
    `ContentPreviewModal.handleExport` (build a `Blob` from the raw unified diff, anchor
    `a.download`); factor that into a shared `downloadTextFile()` util so the modal and
    the pane single-source it. Filename e.g. `ctrlyoke-<ref>.diff`.

- `clearDiff()` also clears `diffFiles`/`diffRefLabel`; `close()`/`reset()` likewise.

### 4. New hosted endpoint

`GET /api/workspace-viewer/git-ref-diff?ref=<ref>` → `{ unifiedDiff: string }`, served by
a `HostedWorkspaceViewerService.getGitRefDiff(ref)` that dispatches exactly like the
existing `buildGitChangeContent` (DIFF → `getWorkingTreeDiff`, STAGED → `getStagedDiff`,
STASH:N → `getStashDiff`, else → `getCommitDiff`). This is the single git-diff source for
the browser; parsing into files happens client-side so the wire payload stays a plain
unified diff.

---

## Implementation Phases

### Phase 1 — Browser multi-file diff pane
- [ ] `workspaceGitRefDiff(ref)` in `hostedApi.ts` + `GET /api/workspace-viewer/git-ref-diff` route + `HostedWorkspaceViewerService.getGitRefDiff()` (reuses `GitUtils` dispatch)
- [ ] Store: `diffFiles`, `diffRefLabel`, `openToGitRef(ref)` (sets `activeTab: "sourceControl"`), clearing wired into `clearDiff`/`close`/`reset`
- [ ] Client diff parsing: unified text → `ParsedDiffFile[]` via `parseDiff` + existing rdv adapter (factor a small `parseUnifiedDiffToFiles()` helper, likely in `rdvAdapter.ts`)
- [ ] `WorkspaceDiffPane`: multi-file rendering branch + ref header banner + **Download** button
- [ ] Factor `downloadTextFile()` shared util out of `ContentPreviewModal.handleExport`; use it from the pane
- [ ] `CodeMirrorEditor.openContextReferenceLink()`: `isStandalone` branch → `openToGitRef` (replaces the interim `REQUEST_GIT_CHANGE_PREVIEW` browser branch)

### Phase 2 — VS Code native diff ✅ DONE
- [x] `ctrlyoke.openGitChange` rewritten to invoke native commands (`git.viewCommit`/`git.viewChanges`/`git.viewStagedChanges`) with a generated-diff fallback; command IDs added as `VSCODE_GIT_COMMANDS`
- [x] `CodeMirrorEditor.openContextReferenceLink()`: VS Code branch posts `OPEN_GIT_CHANGE` (→ native); browser branch keeps `REQUEST_GIT_CHANGE_PREVIEW` (modal) until Phase 1 lands
- [x] Raw-text untitled-doc behavior is now fallback-only, not the default
- [x] **Native stash:** `GitUtils.getStashFiles(root, index)` + `~stash:N` branch in `ctrlyoke.openGitChange` using `vscode.changes` + `toGitUri`; added `CHANGES` to `VSCODE_GIT_COMMANDS`

### Phase 3 — Cleanup
- [ ] Delete `REQUEST_GIT_CHANGE_PREVIEW`/`GIT_CHANGE_PREVIEW_RESULT` + `buildGitChangeContent` + the `buildGitPreviewTitle` git branch (keep `$prior-context` path)
- [ ] `ContentPreviewModal`: drop the `"diff"` language branch if XML is the only remaining consumer (verify no other sender)
- [ ] Update `dev/reference/VSCODE_COMMANDS.md` / `CHAT_COMMANDS.md` notes if the command surface changes

---

## ContentPreviewModal — what remains

`ContentPreviewModal` is still triggered by `$prior-context` links
(`PRIOR_CONTEXT_PREVIEW_RESULT`, `language: "xml"`). That path is unaffected. Only the
git-diff usage is removed. If, after Phase 3, XML is the sole consumer, simplify the
modal's `language` typing/export-extension logic accordingly (optional tidy).

---

## Testing

- `src/test/server/HostedWorkspaceViewerService.test.ts`: `getGitRefDiff` dispatch for each ref kind (diff/staged/stash/commit)
- `src/ui/webview-react/test/utils/rdvAdapter.test.ts` (or new): `parseUnifiedDiffToFiles()` — multi-file output, adds/deletes/renames, binary-file stanzas ignored gracefully
- `src/ui/webview-react/test/store/workspaceViewerStore.test.ts`: `openToGitRef` sets tab/loading/`diffFiles`; `clearDiff`/`close` reset new fields
- `src/ui/webview-react/test/components/workspace-viewer/WorkspaceDiffPane.test.tsx`: single-file branch unchanged; multi-file branch renders N `DiffView`s + header
- Manual (VS Code): click `~<hash>` in the prompt editor → native commit diff opens, no modal
- Manual (browser): same click → Source Control tab opens with rendered multi-file diff

---

## Resolved Decisions

1. **VS Code command choice** — ✅ `git.viewCommit` for commits, `git.viewChanges`/`git.viewStagedChanges` for working-tree/staged, and **`vscode.changes` for `~stash:N`** (native, not raw text). All native; generated-diff document is fallback-only.
2. **Browser target** — ✅ the workspace viewer **Source Control tab + `WorkspaceDiffPane`**, not the modal. Consistent with how `@file` links already open the viewer; non-blocking; persistent. `ContentPreviewModal` is retired for git diffs.
3. **Export** — ✅ preserved as a **Download** button on the browser diff pane only (no value in VS Code, where you're already in an editor). Modal not kept for this.

## Open Questions

1. **Browser diff context** — historical-commit diffs come as unified text with limited context lines, so `DiffView`'s "expand hidden lines" controls won't function (they need full file content). Acceptable? (Recommend yes — matches what `git show` gives us; full context would require fetching each file's blob at the commit.)
