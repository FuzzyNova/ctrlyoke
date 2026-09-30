# Recoverable history deletes and a hard-to-hit Clear History

Fix plan for `dev/bugs/backlog/clear-history-one-tap-permanent-wipe-including-live-runs.md`.

## Goals

1. **Clear History can't be hit by accident.** It leaves the workflow dropdown
   (the footer sits right where the iOS home gesture lands) and moves into
   Settings, behind its own dialog that can't be switched off.
2. **Every history delete can be undone.** Single-run, whole-workflow, "delete
   all runs", and clear-all move files into a per-project trash instead of
   calling `fs.rm`. You can restore them from an Undo toast or from a
   Recently Deleted list.
3. **Live runs are never deleted.** Any lineage with an active `runner.json`
   lock is refused (single delete) or skipped and reported (bulk delete).
4. **Deletes show up in the session log** at INFO level, along with the client
   that asked for them.

The per-run trash icons stay exactly where they are, and so does
`confirmDeleteOperations`. Once a delete can be undone, skipping the
confirmation for single runs becomes a safe choice.

## 1. Where Clear History lives

**Settings → General → Run History** (`RunHistorySection.tsx`). This section
already covers run storage: it has the location picker and the resolved
`.runs` path. Add a **Manage history** block under the existing content:

```
Run History
  Location            [ User (default) ▾ ]
  Resolved location   C:\Users\…\projects\ctrlyoke-3fa1…\.runs

  Recently deleted    12 items · 48 MB       [ View ]
  Keep deleted items  [ 30 ] days
  ─────────────────────────────────────────────
  Clear all history
  Moves every workflow and run in this project
  to Recently deleted.                  [ Clear all history… ]
```

- The button is small, right-aligned, uses the danger variant, and sits below
  the fold of a settings page. Nothing on the navigation path leads to it.
- Settings search can find it. Add a `settingsCatalog` entry such as
  `history.clearAll` that points at the section, so typing "clear history"
  still gets you there.
- **Remove from the dropdown:** delete the `workflow-menu-footer` block and the
  `onClearHistory` prop from `WorkflowList.tsx`. Drop `handleClearHistory` and
  the `WORKFLOW_DELETE_SCOPES.ALL` branch from `WorkflowStatus.tsx`, which then
  handles only `LINEAGE` and `RUN`. The settings section gets its own flow
  (below), so `ALL` stops being a dropdown concern.

## 2. The Clear All dialog

This is a new `ClearHistoryModal`, not `DeleteConfirmModal`:

- **Ignores `confirmDeleteOperations` and has no "Don't ask again" checkbox.**
  The shared modal's checkbox currently shows up on the delete-everything
  dialog too, and that is how one setting quietly turned off the most
  destructive confirmation in the app.
- **Shows the real scope before you confirm.** It asks the host for a preview
  (`HISTORY_CLEAR_PREVIEW` → `{ lineageCount, runCount, bytes, liveLineages[] }`)
  and states it outright: "Move 1,326 workflows (1,612 runs, 2.1 GB) to
  Recently deleted."
- **Lists live workflows that will be skipped:** "2 running workflows will be
  kept: reply-to-step-plan, …"
- **Type-to-confirm:** the Delete button stays disabled until the user types
  `clear history`. This works well on a phone. A stray tap can't produce it,
  and it doesn't depend on a long-press, which iOS Safari handles badly.
- The result is reported as a toast with **Undo**: "Moved 1,326 workflows to
  Recently deleted · Undo".

## 3. The trash

### Location

Put the trash in a per-project directory **next to `.runs`**, not in a global
`~/.ctrlyoke/.trash`:

| Mode           | Runs                                          | Trash                                          |
| -------------- | --------------------------------------------- | ---------------------------------------------- |
| user (default) | `<stateHome>/projects/<slug>-<hash12>/.runs/` | `<stateHome>/projects/<slug>-<hash12>/.trash/` |
| workspace      | `<stateRoot>/.ctrlyoke/.runs/`                | `<stateRoot>/.ctrlyoke/.trash/`                |

Reasons:

- **Same volume, so moves are renames.** A workspace-mode project on `D:` would
  otherwise need a recursive copy into `C:\Users\…`, which is slow for
  thousands of runs and not atomic. `fs.rename` of a directory is a single
  metadata operation on the same volume.
- **Restore knows where to go.** Each project's trash only holds that project's
  entries, so the UI never has to work out which project an entry came from.
- **Outside `.runs`, not `.runs/.trash`.** `isLineageDirEntry` already skips
  dot-directories, but `inspectRunner`, the search-index rebuild, and
  `history prune` all walk `.runs`. Keeping the trash out of that tree means
  none of them need a new exclusion.
- Add `WorkflowPaths.trashRoot(stateRoot)` and `trashRootForProjectState()`
  next to `runsRoot` / `runsRootForProjectState`, with the same
  `assertContained` checks.

### Entry layout

```
.trash/
  <deletedAt RunRef-style stamp>-<shortId>/
    entry.json
    payload/
      <workflowKey>/            # lineage delete: whole lineage dir, renamed in
        workflow.json
        run-…/
      <workflowKey>/run-…/      # run delete: just that run dir
```

`entry.json`:

```jsonc
{
  "schemaVersion": 1,
  "id": "…",
  "kind": "run" | "lineage" | "lineageRuns" | "all",
  "deletedAt": 1790726533000,
  "requestedBy": "webview" | "browser:<id>" | "cli",
  "items": [
    { "workflowKey": "…", "workflowName": "…", "runRefs": ["run-…"], "runIds": [12], "wholeLineage": false }
  ],
  "skippedLive": ["reply-to-step-plan-…"],
  "bytes": 123456
}
```

A clear-all is **one entry** holding many lineages, so one Undo or Restore
brings everything back. Register `entry.json` with `PersistedSchemaGuard` like
the other persisted stores.

### Service

Add a `HistoryTrashRepository` in `src/core/orchestration/`. It holds all the
logic, and the UI, hosted server, and CLI call it:

- `trashRun(stateRoot, workflowKey, runRef, requestedBy)`: called from inside
  `WorkflowLineageRepository.deleteRun`. The existing lock, protected-run check,
  prior-context check, and descriptor repair all stay; only the
  `fs.promises.rm(runDir)` becomes a rename into the entry's `payload/`.
- `trashLineage(…)`: replaces the `fs.rm` in
  `WorkflowSerializer.handleRemoveWorkflowHistory`.
- `trashLineageRuns(…)`: used by `deleteAllRunsForLineage` (the RunPanel's
  "Delete all runs").
- `trashAll(…)`: replaces the loop in `handleClearWorkflowHistory`.
- `list()`, `restore(id)`, `purge(id)`, `purgeAll()`, `purgeExpired(now)`.

**Write order for a move:** create `.trash/<id>.pending/`, write `entry.json`,
rename the payload dirs in, then rename `<id>.pending` → `<id>`. On startup,
`purgeExpired` also finishes or rolls back any leftover `*.pending` entry: if
it has payload, restore it; if it is empty, remove it. A crash in the middle of
a move can then never lose a run.

### Live-run guard

Before moving any lineage, read its runner lock with
`readWorkflowLockInspectionAtPath`, the same check `inspectRunner` uses, and
compare it against the orchestrator's in-memory executing set
(`findExecutionRunRef`).

- Single lineage (`REMOVE_WORKFLOW_HISTORY`): refuse, and show a toast:
  "Stop _X_ before deleting it."
- Clear-all / lineage-runs: skip, and list the skipped items in the entry and
  the toast.

On Windows, renaming a directory that has open handles fails with `EPERM`, so
the rename would usually fail on its own. The guard makes that failure a clear
message instead of a half-moved lineage.

### Restore

- **Run into an existing lineage:** rename it back under the lineage lock, then
  recompute `latestRunRef` and bump `nextRunId` to
  `max(nextRunId, maxRestoredRunId + 1)` so a later run can't reuse an ID.
- **Run whose lineage was deleted since:** recreate a minimal descriptor. The
  recovery script's `workflow.json` construction is the reference.
- **Lineage whose key exists again:** keys carry a timestamp suffix, so this is
  practically impossible. If it happens, merge the run dirs whose `runRef`
  isn't already present, and report any that are.
- After a restore, send `RECENT_WORKFLOWS` / run-summary refreshes to every
  client. Verify during implementation that the search index picks restored
  runs up again on its next incremental pass. It prunes runs it can't find, so
  a restore has to look like a new run to it.

### Retention

- New user-scoped setting `storage.trashRetentionDays` (default **30**,
  minimum 1). Put it in `settings-schema.json` and `CtrlYokeSettings.ts`; there
  is no `package.json` entry (see copilot-instructions).
- Run `purgeExpired` on activation and once a day while the extension or CLI
  runner is up. Purging is the only `fs.rm` left on history, and it logs every
  entry it removes.
- The Recently Deleted header shows the total size so a large trash is
  visible. This version has no size cap.

## 4. Undo and Recently Deleted UI

- **Undo toast** after every history delete (run, lineage, lineage-runs, all),
  using `ToastViewport`'s existing `action` support:
  `{ label: "Undo", onClick: () => post(HISTORY_TRASH_RESTORE, { id }) }`. The
  host returns the trash `id` in the delete reply, so the toast works for both
  webview and hosted-browser clients.
- **Recently Deleted view** (opened from the Run History section's "View"
  button): a list grouped by entry, newest first. Each row shows the workflow
  name, run IDs, when it was deleted, and "N days left", with **Restore** and
  **Delete forever** buttons. The header has **Empty trash**, which uses the
  same type-to-confirm dialog as Clear All.
- `DeleteConfirmModal` copy changes from "permanently delete … cannot be undone"
  to "moves … to Recently deleted".

## 5. CLI

Add under `history`, next to the existing `prune`, `relink`, `list`, `runs`,
`show`, and `search`:

```
ctrlyoke history trash list
ctrlyoke history trash restore <id>
ctrlyoke history trash empty [--yes]
```

This lets a user recover without a dashboard.

## 6. Logging

At INFO, from `HistoryTrashRepository`, one line per operation:

```
[HistoryTrash] trashed kind=all lineages=1326 runs=1612 skippedLive=2 requestedBy=browser:ab12 id=…
[HistoryTrash] restored id=… lineages=1 runs=3
[HistoryTrash] purged id=… reason=expired
```

The router passes the `ctx` client ID through as `requestedBy`.

## 7. Messages and constants

Add to `MESSAGE_TYPES` / `WebviewMessageTypes.ts`: `HISTORY_CLEAR_PREVIEW`
(+ reply), `HISTORY_TRASH_LIST` (+ reply), `HISTORY_TRASH_RESTORE`,
`HISTORY_TRASH_PURGE`, and `HISTORY_TRASH_EMPTY`. Existing delete replies gain
`trashEntryId`. Add `HISTORY_TRASH_ENTRY_KINDS` to `DashboardConstants.ts`.
`CLEAR_WORKFLOW_HISTORY` stays, but only settings sends it, and it now carries
the typed confirmation phrase. The host rejects the message if the phrase is
missing, so no client, including an old one, can trigger a wipe with one call.

## 8. Tests

- `src/test/**`:
  - trash, restore, and purge round-trips for each kind.
  - `nextRunId` / `latestRunRef` repair after a restore.
  - a live lineage is refused (single) and skipped (all).
  - a leftover `.pending` entry is recovered.
  - expiry.
  - `CLEAR_WORKFLOW_HISTORY` without the phrase is rejected.
- `src/ui/webview-react/test/**`:
  - the dropdown has no Clear History footer.
  - `ClearHistoryModal` stays disabled until the phrase is typed and shows the
    preview counts and the live-skip list.
  - the Undo toast posts a restore.
  - the Recently Deleted list renders correctly and its actions post the right
    messages.

## Suggested order

1. Remove the dropdown footer, and require the typed phrase on the host for
   `CLEAR_WORKFLOW_HISTORY`. Also add the live-lineage guard and INFO logging.
   These close the bug by themselves and are small.
2. Trash repository and paths, plus switching all delete paths to it.
3. Undo toast.
4. Settings section: Clear All dialog, Recently Deleted view, retention setting.
5. CLI `history trash`.

## Decisions

- Retention default is **30 days**.
- The per-row trash-can buttons in the workflow dropdown (lineage delete) and
  in the drilled-in run panel (single-run delete) **stay where they are**.
  With the trash and Undo toast they become recoverable; no other change.

## Implementation notes

What shipped differs from the plan above in these places:

- **Moves fall back to copy-then-delete.** A rename is retried for 2 seconds.
  If it is still refused (`EPERM`/`EACCES`/`EBUSY`/`EXDEV`), the files are
  copied and then deleted. On Windows, VS Code's watcher on an open
  workflow's run directory blocks renaming it indefinitely, which the dev-host
  test hit on the very first Clear all.
- **Crashed deletes are finished, not rolled back.** A `.pending` entry older
  than 5 minutes is committed from what is actually in its payload, so it can
  be restored like any other entry.
- **Toasts with an action stay up longer.** They get the 12-second
  warning/error lifetime instead of 5 seconds, which covers Undo and the
  existing "Open in New Tab".
- **CLI:** `history trash list|restore|purge|empty`. `purge` and `empty` ask
  first, and refuse without `--yes` when not run interactively. `list` also
  purges expired entries.
- **`WORKFLOW_DELETE_SCOPES.ALL` was removed.** The dropdown only deletes runs
  and whole workflows now.
- **Code:** the core is `src/core/orchestration/HistoryTrashRepository.ts`.
  The dashboard side is `ClearHistoryModal`, `RecentlyDeletedModal`,
  `TypedConfirmModal`, and `historyTrashStore`.
