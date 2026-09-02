# Output Panel Context Menu Plan

> **Status:** Implemented. Captures where to hook menu entries into
> the VS Code Output panel, and how to route them through the capture backend
> [`OUTPUT_PANEL_CONTEXT_CAPTURE_PLAN.md`](../implemented/OUTPUT_PANEL_CONTEXT_CAPTURE_PLAN.md)
> already implemented for `@`/`#` completions.

## Goal

Add ctrlyoke entries to VS Code's own Output panel — both a "capture the current selection"
entry and a "capture the whole channel" entry — as right-click/menu actions, not just as
`@`/`#` completions typed inside a ctrlyoke prompt editor. Two surfaces:

1. Right-click inside the Output panel's text content (selection, or no selection = whole
   channel).
2. The Output panel's own title-bar `...`/toolbar menu (whole channel only — there's no
   selection concept in a toolbar button).

## Where these menus actually are (verified against VS Code source)

Checked directly against `C:\dev\vscode` (commit `42b84d2c`, 2026-09-02 — same checkout used
for `CONTEXT_MENU_PLACEMENT_PLAN.md`'s research).

- **The Output panel's text area is a full standard code editor, not a stripped-down
  viewer.** `OutputEditor._getContributions()`
  (`src/vs/workbench/contrib/output/browser/outputView.ts:342`) returns
  `...EditorExtensionsRegistry.getEditorContributions()` — every standard editor contribution,
  unfiltered, including `ContextMenuController`. So `editor/context` (ctrlyoke's existing
  manifest key) already fires there today. `editor/lineNumber/context` does **not** apply —
  `getConfigurationOverrides()` sets `options.lineNumbers = 'off'` (line 259), so there is no
  gutter to right-click.
- **The right `when` condition is a dedicated context key, not `resourceScheme`.** VS Code's
  own "Clear Output" command is the working precedent — it registers into
  `MenuId.EditorContext` with `when: CONTEXT_IN_OUTPUT`
  (`src/vs/workbench/contrib/output/browser/output.contribution.ts:326`), where
  `CONTEXT_IN_OUTPUT = new RawContextKey<boolean>('inOutput', false)`
  (`src/vs/workbench/services/output/common/output.ts:40`). The manifest-facing key string is
  `inOutput`. ctrlyoke's *existing* `editor/context` entries
  (`addSelectionToPromptEditor`/`addSymbolToPromptEditor`) are gated
  `"resourceScheme == file"`, which is why they correctly don't show up in the Output panel
  today — this plan adds new, separate entries gated on `inOutput` instead, it does not touch
  the existing file-scoped ones.
- **The panel's title/toolbar menu is `view/title`, scoped by view id.** VS Code's own Clear
  Output / Toggle Auto Scrolling / Save Output As buttons all register into `MenuId.ViewTitle`
  with `when: ContextKeyExpr.equals('view', OUTPUT_VIEW_ID)`
  (`output.contribution.ts:319-429`), where `OUTPUT_VIEW_ID = 'workbench.panel.output'`
  (`src/vs/workbench/services/output/common/output.ts:38`). The manifest key is `view/title`,
  confirmed in `menusExtensionPoint.ts:246`.
- **Neither of these is a proposed/unstable API.** Unlike the SCM Graph's
  `scm/historyItem/context` (see `CONTEXT_MENU_PLACEMENT_PLAN.md`'s "Blocked" section —
  gated behind the still-open `contribSourceControlHistoryItemMenu` proposal), `editor/context`
  and `view/title` are both fully finalized, standard `contributes.menus` keys any published
  extension can use today. No upstream blocker here.

## Proposed manifest additions

Two new commands, three new menu entries:

```json
"editor/context": [
  { "command": "ctrlyoke.addOutputSelectionToPromptEditor",
    "when": "inOutput && editorHasSelection",
    "group": "<TBD — see CONTEXT_MENU_PLACEMENT_PLAN.md>" },
  { "command": "ctrlyoke.addOutputChannelToPromptEditor",
    "when": "inOutput && !editorHasSelection",
    "group": "<TBD — see CONTEXT_MENU_PLACEMENT_PLAN.md>" }
],
"view/title": [
  { "command": "ctrlyoke.addOutputChannelToPromptEditor",
    "when": "view == workbench.panel.output",
    "group": "<TBD>" }
]
```

The group/placement question is explicitly deferred to `CONTEXT_MENU_PLACEMENT_PLAN.md` —
these are new entries in the exact `editor/context` location that doc is already deciding a
placement convention for (`2_ctrlyoke@N` today). Land that decision first, or land both
together; don't invent a fourth, one-off group naming style here.

## Design: reuse the attachment-writing backend, but *not* the completion-resolve plumbing

The user's ask was to route through "the current backend that exports the text to a file in
attachments and inserts the attachment file in `CodeMirrorEditor.tsx`." Read literally, ctrlyoke
actually has **two** separate mechanisms today, and this feature only needs one of them:

1. **The attachment-writing backend** (what to reuse): `TempFileManager.createOutputSnapshotFile`
   writes the captured text into the content-addressed `.ctrlyoke/temp/attachments/` store, and
   `buildFileReference`/`buildFileReferenceValue` (`src/completions/ContextReferenceBuilder.ts`)
   turn the resulting relative path into an `@path` reference string. This part is a clean,
   direct reuse.
2. **The completion placeholder-resolve plumbing** (what *not* to reuse): `OutputCaptureCache`,
   the `CAPTURING_OUTPUT_PLACEHOLDER` insert-then-resolve dance in `CodeMirrorEditor.tsx`, and
   `NativeOutputCaptureCommand`/`executeNativeOutputCaptureCommand` all exist to solve one
   specific problem — a completion **list** is built once, but the user's **pick** happens
   asynchronously later, by which time the live output document may have changed (see
   `OUTPUT_PANEL_CONTEXT_CAPTURE_PLAN.md`'s "Capture-Timing Gotcha" section). A context-menu
   command has no such gap: VS Code invokes the command handler synchronously, in direct
   response to the click, with the right-clicked editor still active — there is nothing to
   cache-and-resolve-later. Routing this feature through the placeholder/cache machinery would
   be solving a problem this trigger doesn't have.

**What "insert into the prompt editor" already means for every other context-menu reference
command** (`addFileToPromptEditor`, `addSelectionToPromptEditor`, `addScmResourcesToPromptEditor`,
`addTimelineCommitToPromptEditor` — all in `src/completions/ContextMenuReferenceCommands.ts`) is
the **generic, editor-location-agnostic insert path**, not the completion-specific one:

```
ContextMenuReferenceCommands.insertReferences(references)
  → builds a PromptEditorInsertRequest
  → webviewProvider.enqueuePromptEditorInsert(request)
  → extension → webview message MESSAGE_TYPES.INSERT_PROMPT_REFERENCES
  → useMessageHandler.ts → useEditorStore.enqueuePromptEditorInsert(message.data)
  → CodeMirrorEditor.tsx consumes `pendingInsertRequest` and inserts at the cursor
```

This is *also* implemented in `CodeMirrorEditor.tsx` — just a different, already-generic queue
than the completion-pick placeholder logic, and it's the one every existing "right-click
somewhere else in VS Code, insert a reference into the ctrlyoke prompt editor" command already
uses. The new output commands should be one more caller of this same path, exactly like
`addFileToPromptEditor` is for a real file today — not a new consumer of the completion-specific
cache/placeholder flow.

## Implementation sketch

1. **Export the two helpers `CompletionHelpers.ts` already has module-private:**
   - `getOutputChannelSlug(document)` (`src/completions/CompletionHelpers.ts:622`) — the
     `asRelativePath`-based channel slug (`agenthost`), already the single source of truth for
     naming an output channel. Add `export`.
   - The cache-seeding half of `cacheOutputCapture` isn't needed here (see above) — only the
     slug derivation is shared.
2. **Factor the write-and-build-reference step out of `OutputSnapshotService.ts` so both
   callers share it** (single-source, per this repo's DRY convention — see root `CLAUDE.md`).
   Today `savePendingOutputSnapshot` does: take-from-cache → `TempFileManager.createOutputSnapshotFile`
   → `buildFileReferenceValue`. Split out the write+build half:
   ```ts
   export async function writeOutputSnapshotAttachment(
     getWorkspaceRoot: () => string,
     entry: OutputCaptureEntry
   ): Promise<string> { /* the last two steps of today's savePendingOutputSnapshot */ }

   export async function savePendingOutputSnapshot(
     getWorkspaceRoot: () => string,
     captureId: string
   ): Promise<string> {
     const entry = outputCaptureCache.take(captureId);
     if (!entry) throw new Error("Output capture expired — try again");
     return writeOutputSnapshotAttachment(getWorkspaceRoot, entry);
   }
   ```
   The new context-menu commands call `writeOutputSnapshotAttachment` directly with a
   synchronously-built `OutputCaptureEntry` — no cache round trip.
3. **New methods on `ContextMenuReferenceCommands`** (`src/completions/ContextMenuReferenceCommands.ts`),
   alongside the existing `addFileToPromptEditor` etc.:
   ```ts
   async addOutputSelectionToPromptEditor(uri: vscode.Uri): Promise<void> {
     const editor = this.activeOutputEditor(uri);
     if (!editor || editor.selection.isEmpty) return;
     await this.captureOutputToPromptEditor(editor, editor.document.getText(editor.selection), {
       startLine: editor.selection.start.line + 1,
       endLine: editor.selection.end.line + 1,
     });
   }

   async addOutputChannelToPromptEditor(uri: vscode.Uri): Promise<void> {
     const editor = this.activeOutputEditor(uri);
     if (!editor) return;
     await this.captureOutputToPromptEditor(editor, editor.document.getText(), undefined);
   }
   ```
   where `captureOutputToPromptEditor` calls `getOutputChannelSlug`, then
   `writeOutputSnapshotAttachment(this.getWorkspaceRoot, { text, channel, range })`, then
   `buildFileReference(relativePath)`, then the existing private `insertReferences([reference])`.
   `activeOutputEditor` mirrors the existing `addSelectionToPromptEditor` pattern of comparing
   `vscode.window.activeTextEditor?.document.uri` against the passed `uri` — VS Code passes the
   focused editor's document URI as arg0 for `editor/context` commands the same way it does for
   the existing file-scoped ones; `view/title`'s `addOutputChannelToPromptEditor` invocation
   passes no `uri`, so that path should fall back to
   `vscode.window.activeTextEditor` directly when `uri` is undefined (only reachable when its
   document is already the focused output channel, since the command's `when` already requires
   `view == workbench.panel.output`).
4. **Constructor change:** `ContextMenuReferenceCommands` currently takes only
   `webviewProvider`. It needs a `getWorkspaceRoot: () => string` callback added to its
   constructor — the exact same callback already passed to `registerNativeOutputCaptureCommand`
   in `extension.ts:545` (`() => vscode.workspace.workspaceFolders?.length ? getVsCodeWorkspaceRoot() : ""`).
   Thread the same callback into `new ContextMenuReferenceCommands(webviewProvider, getWorkspaceRoot)`
   at `extension.ts:541`.
5. **Register the two commands** in `extension.ts` next to the existing `addSelectionToPromptEditorCommand`/
   `addSymbolToPromptEditorCommand` registrations, add both to the subscriptions array.
6. **`package.json`** — the three menu entries above, plus command titles (e.g. "Add Output
   Selection to ctrlyoke" / "Add Output Channel to ctrlyoke") and `contributes.commands` entries.

No changes needed in `CodeMirrorEditor.tsx`, `OutputCaptureCache.ts`, `NativeOutputCaptureCommand.ts`,
`PromptCompletionProvider.ts`, or any completion-list code — this feature is a second, independent
entry point into the same attachment-writing backend, reusing the pre-existing generic insert
queue rather than the completion-specific placeholder/cache path.

## Affected files

| File | Role |
| --- | --- |
| `package.json` | New commands + `editor/context`/`view/title` menu entries |
| `src/extension.ts` | Register the two new commands; thread `getWorkspaceRoot` into `ContextMenuReferenceCommands` |
| `src/completions/ContextMenuReferenceCommands.ts` | New `addOutputSelectionToPromptEditor`/`addOutputChannelToPromptEditor` methods, constructor change |
| `src/ui/OutputSnapshotService.ts` | Split out `writeOutputSnapshotAttachment` so both the completion path and the new command path share it |
| `src/completions/CompletionHelpers.ts` | Export `getOutputChannelSlug` instead of leaving it module-private |

## Non-Goals

- Adding a right-click entry to the *detached* Output editor tab (`editor/title`/
  `editor/title/context`) reachable via "Open Output in Editor" — same mechanism would apply
  (it's a real editor input by then), but that's a secondary, rarely-used path; not part of
  this pass unless it turns out to be free.
- Changing anything about the `@`/`#` completion-based capture flow
  `OUTPUT_PANEL_CONTEXT_CAPTURE_PLAN.md` already implemented — this is a second entry point
  into the same backend, not a rework of the first one.
- Deciding the final `group` value for the new `editor/context` entries — deferred to
  `CONTEXT_MENU_PLACEMENT_PLAN.md`.

## Open Questions

Resolved for this implementation:

- The command titles are "Add Output Selection to ctrlyoke" and "Add Output Channel to
  ctrlyoke", matching the existing `addFileToPromptEditor` naming pattern.
- The `view/title` toolbar entry is visible by default; it does not set `isHiddenByDefault`.
- The `view/title` entry has no icon and uses the standard `navigation` group.
