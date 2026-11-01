# Context menus blocked on VS Code proposed APIs

Two native VS Code context menus that should offer **Add Commit to ctrlyoke** are
blocked by proposed (unstable) APIs. Proposed APIs only work under
`--enable-proposed-api` or through Microsoft's `product.json` allowlist, so a Marketplace
build can't use them. Re-check both whenever VS Code ships a release, and restore the
menus as soon as either one becomes stable.

The dashboard's own commit history (workspace viewer **History**, right-click a commit)
already offers **Add Commit to ctrlyoke** and isn't affected.

## 1. Timeline view: `timeline/item/context` (removed 2026-11-01)

**Status:** the menu used to work, and was removed from `package.json` because it always
failed.

- The menu contribution point `timeline/item/context` is stable. VS Code shows our item
  without complaint.
- The problem is the argument. The workbench passes the right-clicked item as a
  marshalled reference (`{ $mid: 12, handle, source, uri }`, the `TimelineActionContext`).
  The extension host's timeline argument processor (`ExtHostTimeline._resolveItem`) now
  returns `undefined` unless the extension running the command has the **`timeline`**
  proposal in its `enabledApiProposals`. Extensions that do have it get a frozen copy of
  the item. The timeline _provider_ API has always been proposed. Only this gate on
  argument resolution is new, and it was confirmed in VS Code 1.144.0.
- So the command received `(undefined, fileUri, "git-history", undefined)` and showed
  "Could not resolve a commit hash from the selected timeline item." every time. The git
  extension's `GitTimelineItem` still sets `id` to the full commit hash, so the existing
  extraction works as soon as the item comes through again.

**What's still in the code:** the command `ctrlyoke.addTimelineCommitToPromptEditor` is
still registered in `src/extension.ts`, and its handler is still in
`src/completions/ContextMenuReferenceCommands.ts`.

**To restore it:** add these back to `package.json`:

```json
// contributes.commands
{ "command": "ctrlyoke.addTimelineCommitToPromptEditor", "title": "Add Commit to ctrlyoke", "category": "ctrlyoke" }
// contributes.menus.commandPalette
{ "command": "ctrlyoke.addTimelineCommitToPromptEditor", "when": "false" }
// contributes.menus
"timeline/item/context": [
  { "command": "ctrlyoke.addTimelineCommitToPromptEditor", "when": "timelineItem =~ /git:file:commit\\b/", "group": "z_ctrlyoke" }
]
```

Then restore the `Add Commit to ctrlyoke | Timeline view context menu on a Git commit` row
in `docs/reference/commands.md` (`npm run check:docs` requires it), and add a CHANGELOG
entry. Newer git builds also emit `git:folder:commit` and `git:workspace:commit` items,
so consider widening the `when` clause to `/git:(file|folder|workspace):commit\b/`.

**How to check:** in the installed VS Code, open
`resources/app/out/vs/workbench/api/node/extensionHostProcess.js` and search for
`_resolveItem(`. Our menu is unblocked once the `enabledApiProposals` check for
`"timeline"` is gone, or the `timeline` proposal is finalized into `vscode.d.ts`.

**Possible workaround if it stays blocked:** the `uri` argument does arrive. The command
could fall back to a QuickPick of that file's commits (`git log -- <file>`) and insert the
one the user picks.

## 2. SCM Graph: `scm/historyItem/context` (never shipped)

**Status:** blocked from the start. Background is in
`dev/implemented/CONTEXT_MENU_PLACEMENT_PLAN.md` ("Why ctrlyoke can't join it today").

- In `menusExtensionPoint.ts`, the menu point itself carries
  `proposed: "contribSourceControlHistoryItemMenu"`, so VS Code ignores the contribution
  in a normal install.
- Tracking issue: `microsoft/vscode#201997`.
- Confirmed still proposed in VS Code 1.144.0. In the workbench bundle, the
  `"scm/historyItem/context"` entry still has `proposed:"contribSourceControlHistoryItemMenu"`.

**How to check:** search `workbench.desktop.main.js` for `"scm/historyItem/context"`. The
menu is unblocked once the `proposed` key is gone. Then add a `z_ctrlyoke` entry that
inserts `~<hash>` from the `ISCMHistoryItem` argument. Check what that argument looks
like when the time comes, since it isn't documented.
