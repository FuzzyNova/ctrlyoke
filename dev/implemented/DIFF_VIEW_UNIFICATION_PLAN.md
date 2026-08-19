# Multi-File Diff View Unification Plan

## Overview

ctrlyoke renders "a list of changed files, each with a diff" in two places that were built
independently and have drifted apart in both styling and correctness:

| Surface                    | File                                                                     | Rows are…                                        |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Undo/Redo Changes dialog   | `src/ui/webview-react/components/output/UndoChangesDialog.tsx`           | selectable (checkbox) undo candidates            |
| Workspace viewer diff pane | `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx` | read-only files in a git ref (commit/stash/tree) |

Both already render through the same leaf renderer (`components/output/DiffView.tsx`) and the
same expand/collapse control (`shared/ExpandCollapseAllDiffsButton`), but everything _around_
the diff — the file card, the path label, the change-type badge, the selection affordance — is
duplicated or missing on one side.

**Goal:** one shared "diff file card / diff file list" layer used by both surfaces, styled on
`WorkspaceDiffPane`'s card look (bordered block, tinted sticky header, compact rows), plus the
bug fixes that fall out of unifying them.

**Non-goals:** changing `DiffView.tsx`'s internals (tokenization, gap expansion, split/unified
switching), reworking the undo _execution_ protocol beyond the ordering fix in §4.6, adding
download-diff to the undo dialog.

---

## 1. Current state

### 1.1 Undo dialog (`UndoChangesDialog.tsx`, ~900 lines)

One component covers four modes: single-step undo, single-step redo, workflow undo, workflow
redo. Row markup is written out **four times** — `FileRowItem` (undo rows), an inline redo row
in workflow mode (`:660-695`), an inline redo row in single-step mode (`:735-770`), and the
workflow-mode wrapper that rebuilds a `FileRow` from a workflow row (`:696-719`). Consequences:

- The change-type badge (`CHANGE_TYPE_LABEL` / `CHANGE_TYPE_COLORS`, `:110-120`) exists only on
  the undo path; redo rows use a _separate_ vocabulary (`redoActionBadgeLabel`, `:127-145`) that
  collapses `restore-content` to the string `"modified/created"`.
- `hasDiff` is computed independently in three places, each with the same truthiness bug (§4.3).
- Diffs hang below the row rather than inside a card, so on a long list there is no visual
  boundary between "file B's diff" and "file C's row".

### 1.2 Workspace diff pane (`WorkspaceDiffPane.tsx`, ~240 lines)

Two modes in one component: multi-file git-ref mode (`diffFiles !== null`) and single-file
working-tree mode (`selectedDiffPath`). The multi-file mode has the card styling we want
(`:190-204`) — `border border-panel-border rounded overflow-hidden` wrapping a `FileHeader`
with `bg-editor-bg` and a sticky top. The single-file mode renders a bare `DiffView` with no
header, no path, and no change-type label at all, even though the store already holds
`diffKind` (`workspaceViewerStore.ts:97`, values from `DiffKind` in
`src/types/HostedWorkspaceViewerTypes.ts:105`).

### 1.3 The three change-type vocabularies

| Vocabulary         | Values                                                         | Defined in                                |
| ------------------ | -------------------------------------------------------------- | ----------------------------------------- |
| `PromptChangeType` | `created` \| `modified` \| `deleted`                           | `src/types/OutputHistoryTypes.ts`         |
| `DiffKind`         | `modified` \| `added` \| `deleted` \| `renamed` \| `untracked` | `src/types/HostedWorkspaceViewerTypes.ts` |
| `DiffType` (rdv)   | `add` \| `delete` \| `modify` \| `rename` \| `copy`            | `react-diff-view`                         |

Three names for the same concept, and the surface that has the richest one (`DiffKind`, which
knows about renames) is the one that displays nothing.

---

## 2. Target architecture

### 2.1 New shared module: `src/ui/webview-react/components/diff/`

A new top-level component folder (not under `output/`, since the workspace viewer is not
output, and not under `shared/`, which is already a large flat grab-bag):

```
components/diff/
  DiffFileCard.tsx        # one file: header + optional checkbox + DiffView body
  DiffFileList.tsx        # vertical stack of cards + optional group headings
  DiffFilePathLabel.tsx   # dir/basename split label (fixes the truncation bug)
  DiffChangeBadge.tsx     # created / modified / deleted / renamed pill
  index.ts
```

`components/output/index.ts` re-exports `DiffView` today (`ToolCallOutput.tsx:39`); keep that
export working so no unrelated import churn is needed.

### 2.2 `DiffFileCard` contract

```ts
export interface DiffFileCardProps {
  path: string;
  /** Previous path — set only for a true rename. Never a /dev/null sentinel. */
  oldPath?: string;
  changeType: DiffChangeType;

  /** Exactly one diff source. */
  source:
    | { kind: "hunks"; hunks: HunkData[]; diffType: DiffType }
    | { kind: "content"; oldContent?: string; newContent?: string }
    | {
        kind: "patch";
        structuredPatch: UnifiedDiffHunk[];
        oldContent?: string;
      };

  language?: string;

  /**
   * Present ⇒ the card renders a checkbox. Absent ⇒ read-only card.
   * Only the undo dialog passes this today; the workspace pane is read-only
   * (see the stage/unstage follow-up in §7).
   */
  selection?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Rendered in place of the checkbox when the row cannot be acted on. */
    disabledReason?: string;
  };

  /** Small italic note on the header row (e.g. "may include other changes"). */
  note?: string;
  /** Right-aligned slot (per-file undo button, download, …). */
  headerActions?: React.ReactNode;

  globallyCollapsed: boolean;
  localResetVersion?: number;
  findQuery?: string;
  findCaseSensitive?: boolean;
  /** Forwarded to DiffView; lets a virtualized parent skip the ResizeObserver. */
  viewType?: "split" | "unified";
}
```

The shared undo/redo contracts the card and the dialog consume — `UndoFileCandidate`,
`UndoFileInstruction`, `UNDO_FILE_ACTIONS` — live in `src/types/WebviewMessageTypes.ts` and are
re-exported through `src/ui/webview-react/types/messages.ts`; `SnapshotFileChange` and
`PromptChangeType` live in `src/types/OutputHistoryTypes.ts`.

**DiffView needs one new prop, not an internals change.** `DiffView` applies `my-2 ${className}`
at `DiffView.tsx:477`, so a caller-supplied `className` cannot win against `my-2` without
`!important`. Add an explicit optional margin prop (e.g. `outerMarginClassName?: string`
defaulting to `"my-2"`) and have `DiffFileCard` pass a tighter value. This is additive and does
not violate the §Overview non-goal, which is about tokenization / gap expansion / view switching.

Header row layout (mobile-first, one line, wraps to two only below `sm`):

```
[☑] src/ui/webview-react/components/…/  DiffFileCard.tsx   [created]  (note)   [actions]
     └ dir, truncates from the left      └ basename, never truncated
```

### 2.3 `DiffFileList` contract

```ts
export interface DiffFileGroup {
  /** Optional heading; omit for a flat list. */
  heading?: string;
  /** Optional one-line explainer under the heading (see §4.7). */
  headingHint?: string;
  files: Array<DiffFileCardProps & { key: string }>;
}

export interface DiffFileListProps {
  groups: DiffFileGroup[];
  emptyMessage: string;
  /** Rendered above the list: "N of M files selected" + Select all. */
  selectionSummary?: React.ReactNode;
}
```

Both surfaces then reduce to: build `DiffFileGroup[]`, hand it to `DiffFileList`. The undo
dialog keeps its selection state and message sending; the workspace pane keeps its ref banner,
commit details, and download button.

### 2.4 Single-source the change-type vocabulary

Add to `src/types/DashboardConstants.ts`:

```ts
export const DIFF_CHANGE_TYPES = {
  CREATED: "created",
  MODIFIED: "modified",
  DELETED: "deleted",
  RENAMED: "renamed",
} as const;
export type DiffChangeType =
  (typeof DIFF_CHANGE_TYPES)[keyof typeof DIFF_CHANGE_TYPES];
```

DashboardConstants (not a webview-local util) because three layers feed it — the snapshot layer
(`PromptChangeType`), the hosted viewer server (`DiffKind`), and the webview's own rdv parse —
and the values are used for `switch`/`===` dispatch, which the coding principles say must be
constants. Mappers live next to the badge in `components/diff/diffChangeType.ts`:
`fromPromptChangeType`, `fromDiffKind`, `fromRdvDiffType`, plus `DIFF_CHANGE_LABEL` and
`DIFF_CHANGE_COLOR` maps (seeded from the existing `CHANGE_TYPE_LABEL`/`CHANGE_TYPE_COLORS` in
`UndoChangesDialog.tsx:110-120`, extended with `renamed`).

`redoActionBadgeLabel`/`redoActionBadgeColor` are deleted; a redo instruction maps to a change
type directly (`delete` → `deleted`, `restore-content` → `created`/`modified` depending on
whether the instruction carries a `structuredPatch`).

---

## 3. Styling decisions (WorkspaceDiffPane is the baseline)

- **Card**: `border border-panel-border rounded overflow-hidden`, stacked with `gap-3`
  (tighter than the pane's current `gap-4`, which is generous once every card has a header).
- **Header**: `bg-editor-bg` tint, `px-2.5 py-1 text-xs font-mono`, `sticky top-0 z-10`,
  bottom border. Sticky only works when the scroll container is the list — the undo dialog's
  scroll container is the `Modal` body, so the fullscreen change in §4.5 is a prerequisite for
  sticky headers there.
- **Row density**: header row is one line at `text-xs`; the undo dialog's current
  `py-1.5 px-2 text-sm` rows shrink to match.
- **Icon**: keep `codicon-file-diff`, but swap per change type (`diff-added` / `diff-modified` /
  `diff-removed` / `diff-renamed`) so the badge is reinforced at a glance.
- **Body**: `DiffView` renders inside the card with tighter spacing. `DiffView` hard-codes
  `my-2` at `DiffView.tsx:477`; parameterize the outer margin rather than fighting it with
  `!important` — **but `my-2` must remain the default.** That 16px is baked into
  `DIFF_VERTICAL_CHROME_HEIGHT = 28` (`utils/rdvAdapter.ts:163-167`: `my-2` 16 + header `mb-1` 4
  - 2px borders), which `outputRenderUtils.ts:91` feeds into the output row-height estimator.
    Changing the default desyncs every estimated diff row in the virtualized timeline. The undo
    dialog and workspace pane are not virtualized and never call `buildDiffRenderPlan`, so a
    non-default margin passed only by `DiffFileCard` is free.

---

## 4. Bugs

Each entry below states the verified root cause with file:line, then the fix.

### 4.1 [W] Created files show `/dev/null → path`

**Root cause.** `parseUnifiedDiffToFiles` (`utils/rdvAdapter.ts:101-111`) copies gitdiff-parser's
sentinel paths straight through. Verified against the installed parser:

```
added file  → { type: "add",    oldPath: "/dev/null", newPath: "src/new.ts" }
deleted file→ { type: "delete", oldPath: "src/old.ts", newPath: "/dev/null" }
renamed file→ { type: "modify", oldPath: "src/a.ts",   newPath: "src/b.ts" }
```

The adapter sets `oldPath` whenever `file.oldPath !== file.newPath`, so an added file keeps
`/dev/null`, and `FileHeader` (`WorkspaceDiffPane.tsx:10-13`) renders the arrow form.

**Also broken, same line, not yet reported:** for a _deleted_ file,
`path = file.newPath ?? file.oldPath` resolves to `"/dev/null"`. So the card's `path`, its React
`key`, and `languageFromPath()` all get the sentinel — the file displays as
`src/old.ts → /dev/null` and loses syntax highlighting. Two files deleted in one commit collide
on `key="/dev/null"`.

**Fix** (in the adapter, so the store, the pane, and any future consumer inherit it):

```ts
const DEV_NULL = "/dev/null";
const realPath = (p: string | undefined) =>
  p && p !== DEV_NULL ? p : undefined;

const oldReal = realPath(file.oldPath);
const newReal = realPath(file.newPath);
const path = newReal ?? oldReal ?? "";
return {
  path,
  // Only a genuine rename keeps oldPath. Note gitdiff-parser reports renames as
  // type:"modify" with differing real paths, so this must NOT gate on type === "rename".
  oldPath: oldReal && newReal && oldReal !== newReal ? oldReal : undefined,
  changeType: newReal
    ? oldReal
      ? oldReal !== newReal
        ? "renamed"
        : "modified"
      : "created"
    : "deleted",
  language: languageFromPath(path),
  hunks: (file.hunks ?? []) as HunkData[],
  diffType: (file.type as DiffType) ?? "modify",
};
```

`ParsedDiffFile` gains `changeType: DiffChangeType`, which also supplies §4.2's missing badge
for the git-ref mode.

### 4.2 [W] No created/modified/deleted label

**Root cause.** `FileHeader` renders path only. The data was already available in both modes:
`file.type` in git-ref mode, `diffKind` (`workspaceViewerStore.ts:97`) in single-file mode.

**Fix.** `DiffFileCard` always renders `DiffChangeBadge`. Single-file mode gets a card too
(currently a bare `DiffView`, `WorkspaceDiffPane.tsx:232-241`) — same header, same badge, so the
two workspace modes stop looking like different features.

### 4.3 [W] File path truncated on mobile

**Root cause.** `FileHeader` uses `<span className="truncate">` on the full path
(`WorkspaceDiffPane.tsx:16`). `truncate` ellipsizes the _end_, and a workspace-relative path is
front-loaded with directories, so the basename — the only part that identifies the file — is the
first thing lost.

**Fix.** `DiffFilePathLabel` splits into directory prefix + basename:

```tsx
<span className="flex min-w-0 items-baseline">
  <span className="truncate opacity-60">{dir}</span>
  <span className="shrink-0 font-medium [overflow-wrap:anywhere]">{base}</span>
</span>
```

The dir segment absorbs all truncation; the basename never shrinks. Use
`referenceBasename()` from `utils/atomicReferences.ts:306` for the split rather than a fresh
`lastIndexOf("/")` — it tolerates both separators, which matters because paths reaching the undo
dialog come from harness file-operation events and are backslashed absolute paths in multi-root
workspaces (see `webview-react.instructions.md`). Do **not** use the `direction: rtl` truncation
trick: it reorders leading punctuation (`./`, `@`) and reads wrong for paths.

Renames render as `oldBase → newBase` with both dirs truncatable, full paths in `title`.

### 4.4 [U] Created files show no diff at all

Two independent causes; both must be fixed.

**Cause A — the data is never collected.** `buildUndoCandidatesForOutputs`
(`utils/promptUndo.ts:178-188`) only pulls content out of `FILE_EDIT` events.
`FileWriteData.content` (`src/types/CliOutputTypes.ts:256-267`) — the full text of the created
file — is read for the path and then discarded. And the snapshot side has nothing to offer:
`WorkspaceSnapshotService` pushes `created` entries carrying only `{ path, repo, afterHash }`
(`src/utils/WorkspaceSnapshotService.ts:513-518` and `:905-911`) — no `beforeContent`, no
`structuredPatch`, because a create needs no content to undo (the instruction is just `delete`).
So a created file's candidate reaches the dialog with `oldContent`, `newContent`, and
`structuredPatch` all `undefined`.

**Cause B — the guard rejects an empty base even when data exists.** `hasDiff` in `FileRowItem`
(`UndoChangesDialog.tsx:168-170`) tests `(row.oldContent && row.newContent)` — truthiness. For a
created file the correct base is `""`, which is falsy, so the diff is suppressed. The identical
bug is in `FileOperationOutput.tsx:218-222` (`hasDiffData`). `DiffView` itself is already
correct — it tests `oldContent !== undefined && newContent !== undefined`
(`DiffView.tsx:244`) and renders an all-green `diffType: "add"` diff.

**Fix.**

1. In `promptUndo.ts`, extend the `FileAccum` loop to handle `FILE_WRITE`:
   `newContent = writeData.content` (last-write-wins, same as edits), and when the resolved
   change type is `created`, `oldContent = ""`. Skip the content when it exceeds
   `MAX_CONTENT_SIZE` and set `contentCaptureSkipped` instead — same threshold the snapshot
   layer already uses (§7.3).
2. Keep the existing preference order — snapshot `structuredPatch` first, then event patches,
   then raw content. A `FILE_WRITE` onto a pre-existing file is recorded by the snapshot as
   `modified` with a patch (`promptUndo.ts:229-231` already prefers the snapshot's change type),
   so a full-file rewrite still renders as a real diff, not as all-green.
3. Replace every truthiness guard with one exported helper used by `DiffFileCard`,
   `FileOperationOutput`, and anything else that asks "is there a diff to show". Put it in
   `src/ui/webview-react/utils/diffUtils.ts` (already the home of `normalizeStructuredPatch`,
   already imported by `rdvAdapter.ts`, and free of extension-only imports):

   ```ts
   export interface RenderableDiffSource {
     oldContent?: string;
     newContent?: string;
     structuredPatch?: UnifiedDiffHunk[];
   }

   export function hasRenderableDiff(s: RenderableDiffSource): boolean {
     if (s.structuredPatch && s.structuredPatch.length > 0) return true;
     return s.oldContent !== undefined && s.newContent !== undefined;
   }
   ```

   Call sites to convert (all five, not three — the dialog has four of them):
   `UndoChangesDialog.tsx:168-170` (`FileRowItem.hasDiff`), `:502-505` and `:512-516` (the two
   arms of the `hasDiffs` memo), `:662` / `:736-737` (the inline redo rows), and
   `FileOperationOutput.tsx:218-222` (`hasDiffData`, which keeps its extra `hideDiff` /
   `status !== FAILED` conditions around the helper).
   Timeline `FILE_WRITE` rows (`OutputRow.tsx:678-707` → `FileWriteOutput`'s raw content block)
   keep showing content, not a diff — **deliberately out of scope**, see the follow-up in §7.

### 4.5 [U] Workflow-level undo shows per-step diffs instead of aggregate

**Root cause.** `useOutputUndoActions.ts:86-158` builds one independent `WorkflowStepEntry` per
step, each with its own snapshot-derived candidates. `UndoChangesDialog` then keys rows
`` `${entryIdx}::${path}` `` (`:256-288`) and groups them under per-step headings (`:647-722`).
A file touched in steps 1 and 2 is therefore two rows with two partial diffs, and a
create-then-modify shows only the modify — exactly the reported symptom.

**Redo has the same shape** — redo entries come off the same loop
(`useOutputUndoActions.ts:135-137`), so a file undone across two steps produces two redo rows
too. Both sides aggregate, in this same change; shipping a dialog whose undo rows are merged and
whose redo rows are not would be worse than either state. The two differ only in replay order,
which §4.6 pins down.

New export:

```ts
export interface AggregatedUndoFile {
  /** Normalized key used to merge across steps (sameFilePath semantics). */
  key: string;
  path: string; // display path, from the first step that touched it
  changeType: DiffChangeType; // net change across all steps
  oldContent?: string; // base before the FIRST step touched it
  newContent?: string; // content after the LAST step touched it
  structuredPatch?: UnifiedDiffHunk[]; // fallback when content composition is impossible
  /** Steps that touched this file, ascending, each with its own instruction. */
  steps: Array<{
    target: UndoExecutionTarget;
    label: string;
    instruction: UndoFileInstruction;
  }>;
  /** True when the aggregate diff could not be composed and this is a partial view. */
  isPartialDiff: boolean;
}

export function aggregateWorkflowUndoFiles(
  entries: WorkflowStepEntry[]
): AggregatedUndoFile[];
```

The same function serves redo — a redo entry's `redoInstructions` populate `steps` identically,
and the net-change-type table below reads the instruction actions (`delete` → `deleted`,
`restore-content` → `created`/`modified`) instead of snapshot change types.

Net change type:

| First step | Last step | Net                                                |
| ---------- | --------- | -------------------------------------------------- |
| created    | modified  | `created`                                          |
| created    | deleted   | drop the row entirely (net no-op; nothing to undo) |
| modified   | deleted   | `deleted`                                          |
| deleted    | created   | `modified`                                         |
| modified   | modified  | `modified`                                         |

Aggregate diff composition, in order of preference:

1. **Compose forward.** Base = the earliest step's `oldContent`/`beforeContent` (or `""` when
   the net type is `created`) — see §7.1 for why the first step's base is the right base. Apply
   each step's forward `structuredPatch` in ascending order
   with `Diff.applyPatch` — jsdiff is already in the webview bundle (`rdvAdapter.ts:9` imports
   it, `utils/diff.ts` wraps it), so no new dependency. Then hand
   `{ oldContent: base, newContent: composed }` to the card; `toRdvFromContent` produces the
   single aggregate diff (`lines 4-7 changed`, per the request).
2. **Base + last newContent.** If any patch fails to apply, but we have the earliest base and
   the latest step's `newContent`, diff those directly. Same result, cheaper, but only available
   when the last step carried full content.
3. **Concatenated patches, flagged.** Fall back to today's behavior (`eventPatches.flat()`) and
   set `isPartialDiff`, which the card surfaces as a `note` — "diff shown per step; original
   content unavailable". This is the `contentCaptureSkipped` path.

The dialog then renders **one flat list** in workflow mode (§7.2). The per-step grouping goes
away entirely; each aggregated card lists its contributing steps as a subdued line in the
header (`Prompt 1, Prompt 3`). One checkbox per file toggles all of that file's step
instructions together; `handleConfirm` re-expands the selection into the existing per-step
`entries` payload, so `MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES` and `UndoRedoCoordinator` need no
protocol change.

### 4.6 [U] Workflow undo applies steps in the wrong order (latent, found while planning)

**Root cause.** The webview builds `entries` in ascending step order (`useOutputUndoActions.ts:86`
iterates `uniqueStepTargets`, which `buildOutputRows` derives from chronologically sorted
messages), and `UndoRedoCoordinator.applySnapshotEntries` applies them in exactly that order
(`src/ui/UndoRedoCoordinator.ts:155-175`). But a `reverse-patch` undo reads the file's _current_
content and reverses one step's hunks against it. When two steps edited the same file, step 1's
reverse patch has to be applied to content that still contains step 2's edits — its context
lines don't match, and jsdiff's fuzz either fails the hunk or, worse, applies it at a shifted
offset.

**Fix — a paired ordering invariant.**

> Undo replays **newest step first**. Redo replays **oldest step first** (the current ascending
> order).

Redo's order is not arbitrary: each step's `redoInstruction` captures the file's content at the
moment that step's undo overwrote it (`WorkspaceSnapshotService.ts:1101-1116`). Undoing
descending means step N's capture is the full final content and step 1's is the content after
everything newer was already reverted — so replaying those ascending lands back on the full
final content. Get either order wrong and a two-step redo silently restores an intermediate
state.

Both `applyUndoEntries` and `applyRedoEntries` funnel through the same `applySnapshotEntries`
loop, which applies entries in received order, so **the ordering lives entirely in what the
webview sends** and the two paths must send opposite orders. With §4.5's aggregation this is one
line at expansion time: sort each aggregated file's `steps` descending for undo, ascending for
redo.

Coverage on both sides — `src/test/**` for the coordinator ("two steps edit the same file, undo
both"), `src/ui/webview-react/test/**` for the payload builder's ordering, plus the round-trip
test in §6.

### 4.7 [U] Dialog should be full-screen / full-width

**Root cause.** `Modal` hard-codes a max width per size (`shared/Modal.tsx:62-67`, largest is
`xl: max-w-4xl`) and caps the body at `max-h-[70vh]` (`:108`). A file list with expanded diffs
is the worst possible fit for that box.

**Fix.** Add `size: "full"` to `Modal`:

- wrapper: `max-w-none w-full h-full rounded-none border-0` (drop `mx-4`),
- the modal element becomes `flex flex-col`, and the body becomes `flex-1 min-h-0 overflow-y-auto`
  instead of `max-h-[70vh]`,
- keep the existing header/footer rows so the confirm buttons stay pinned.

Size the outer container the way `WorkspaceViewerModal.tsx:63` already does
(`fixed inset-0 … flex flex-col`) rather than introducing `h-dvh` here — `webview-react.instructions.md`
documents that iOS Safari sizes `h-dvh` against a different viewport than the visual viewport
while the keyboard is open, and `App.tsx` already owns the compensation. Reusing the viewer's
proven pattern avoids re-litigating that.

Do this in `Modal` rather than in the dialog so the next full-screen surface inherits it.

### 4.8 [U] "Event-attributed changes" wording

**Root cause.** `UndoChangesDialog.tsx:784` and `:803` label the two tiers
"Event-attributed changes" / "Other snapshot changes" — internal implementation vocabulary. The
warning banner (`:610-620`) explains the _consequence_ but never defines the terms.

**Fix.** Keep two groups (they really do carry different confidence) but rename and explain,
using `DiffFileGroup.headingHint`:

| Old                      | New heading                   | Hint                                                                                                                                 |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Event-attributed changes | **Changes the AI reported**   | The harness told us it made these edits, so we know exactly what changed.                                                            |
| Other snapshot changes   | **Other changes we detected** | Found by comparing the workspace before and after — may include edits from other tools or another workflow running at the same time. |

Fold the current standalone tier-2 warning banner into that second hint so the same caveat isn't
stated twice, and move the per-row `(may include other changes)` note
(`UndoChangesDialog.tsx:211-215`) to the group level where it belongs. When only one group is
non-empty, render the list flat with no headings at all — the distinction is meaningless then,
and that is the common case.

---

## 5. Phasing

Each phase compiles, passes tests, and is independently shippable.

**Phase 1 — Adapter and vocabulary (no visual change) — done.**
`DIFF_CHANGE_TYPES` in DashboardConstants; `/dev/null` handling + `changeType` in
`parseUnifiedDiffToFiles` (§4.1); `hasRenderableDiff` helper (§4.4 step 3) wired into all six
existing diff-data guard sites. Tests: `rdvAdapter` add/delete/rename/modify fixtures, including
multiple deletes; direct helper coverage; `DiffView` renders an all-green diff for
`oldContent: ""`.

**Phase 2 — Shared card layer — done.**

Contract deviations: none. The DiffFileCardProps, DiffFileGroup, and DiffFileListProps
contracts were implemented as specified; DiffView additionally accepts the additive
outerMarginClassName prop while retaining its "my-2" default for virtualized output rows.
Build `components/diff/*`. Convert `WorkspaceDiffPane` to it first (it is the style donor and
the smaller consumer), including the single-file mode. Delivers §4.2 and §4.3.

**Phase 3 — Undo dialog conversion — done.**
Replace all four row implementations with `DiffFileList`, delete
`redoActionBadgeLabel`/`redoActionBadgeColor`/`FileRowItem`/`CHANGE_TYPE_*`. Add `Modal`
`size="full"` (§4.7) and the wording change (§4.8). This is also where
`UndoChangesDialog.tsx` should shed most of its length — the mode-specific _data shaping_ moves
into `promptUndo.ts` and the component becomes "build groups, render list, send message".
Implemented with no contract deviations; the single-non-empty-group rule also suppresses
workflow step headings when only one workflow group has files.

**Phase 4a — `FILE_WRITE` content capture — done.**
§4.4 cause A only: `MAX_CONTENT_SIZE` moves to `DashboardConstants`, and
`buildUndoCandidatesForOutputs` starts collecting `FileWriteData.content`. The change is
limited to `promptUndo.ts`, the shared constant, and the snapshot-service import; the card built
in Phase 2 already renders the result once the data exists.

Contract deviations: none. Webview capture uses UTF-8 byte length for the shared 512 KB
threshold, propagates `contentCaptureSkipped` from oversized writes, and preserves snapshot
patch precedence for writes to pre-existing files. No extension-host test changes were needed;
the moved constant has no directly asserted host behavior.

**Phase 4b — Workflow aggregation and ordering — done.**
Workflow aggregation for **both** undo and redo (§4.5) plus the paired ordering invariant
(§4.6), including the `UndoRedoCoordinator` coverage. Timeline `FILE_WRITE` rows are explicitly
not touched (§7 follow-up).

Implementation note: workflow dialog selection expands each aggregated file back into the
existing per-step payload, sorting undo entries newest-step-first and redo entries
oldest-step-first. `UndoRedoCoordinator.applySnapshotEntries` preserves that order. Its
per-entry `afterRestore` callback is order-independent because it persists only the target and
result passed to that callback; no coordinator or message-protocol change was required.

Phase 4 is split because 4b is the riskiest work in the plan and carries the largest test
matrix; keeping the content-capture fix separate means a regression in either is bisectable.
Both are deliberately last: by then both surfaces render from one component, so a data-shape
change can be verified in one place.

---

## 6. Testing

Existing suites to extend rather than duplicate:

- `src/ui/webview-react/test/components/output/UndoChangesDialog.test.tsx`
- `src/ui/webview-react/test/components/workspace-viewer/WorkspaceDiffPane.test.tsx`
- `src/ui/webview-react/test/components/output/DiffView.test.tsx`
- `src/ui/webview-react/test/utils/promptUndo.test.ts`
- `src/test/**` for `UndoRedoCoordinator` ordering (§4.6)

New cases:

| Case                                                                                                      | Covers |
| --------------------------------------------------------------------------------------------------------- | ------ |
| added-file diff → header shows `src/new.ts`, badge `created`, no `/dev/null`                              | 4.1    |
| deleted-file diff → `path` is the real path, not `/dev/null`; two deletes in one commit get distinct keys | 4.1    |
| rename (`type: "modify"`, differing real paths) → `old → new`                                             | 4.1    |
| narrow container → basename present in the DOM, dir truncated                                             | 4.3    |
| `FILE_WRITE`-only step → candidate has `oldContent: ""` + content, card renders a diff                    | 4.4    |
| step 1 creates + step 2 edits → one aggregated row, `created`, diff includes step 2's lines               | 4.5    |
| step 1 edits 4-5 + step 2 edits 6-7 → one row, diff spans 4-7                                             | 4.5    |
| create-then-delete across steps → row dropped                                                             | 4.5    |
| unappliable patch → falls back and sets `isPartialDiff`                                                   | 4.5    |
| two steps edit one file → undo payload lists steps descending                                             | 4.6    |
| file touched in two steps → one aggregated **redo** row, steps ascending                                  | 4.5    |
| undo two steps then redo two steps → file matches pre-undo content                                        | 4.6    |
| single non-empty tier → no group headings rendered                                                        | 4.8    |

Note the existing `MAX_RENDERS` guard convention in `DiffView.test.tsx` — `components/diff/*`
must not reintroduce the "fresh `[]`/`Map` in an effect dependency" infinite-render pattern
documented in `webview-react-components.instructions.md`. `DiffFileList` builds arrays of props
per render, so memoize group construction in the _callers_ (or key on stable inputs) rather
than inside the list.

---

## 7. Resolved decisions

1. **Aggregate diff base = the earliest step's base.** It differs from the true pre-workflow
   content only if something outside ctrlyoke edited the file between steps, which is the same
   caveat the tier-2 warning already covers. Available today with no protocol change.
2. **Workflow mode renders a flat aggregated list.** No per-step grouping, no "by step" toggle
   — each card carries a subdued "touched by Prompt 1, Prompt 3" line and that is enough.
3. **`FILE_WRITE` content reuses the snapshot capture threshold.** `MAX_CONTENT_SIZE`
   (`src/utils/WorkspaceSnapshotService.ts:38`, 512 KB) is currently a module-private constant
   in an extension-side file the webview must not import (it pulls in `fs`/`execFile`). Move it
   to `src/types/DashboardConstants.ts` and have both sides import it, rather than exporting
   from the service or duplicating the number. Over-threshold writes set the existing
   `contentCaptureSkipped` flag, which the card already renders as a non-undoable reason.
4. **No selection in the workspace pane for now** — `DiffFileCard.selection` stays optional and
   the pane passes nothing. Tracked as a follow-up below.
5. **Workflow redo aggregates alongside undo**, in the same change (§4.5), with the paired
   ordering invariant of §4.6: undo replays newest-step-first, redo oldest-first. Deferring redo
   would ship a dialog whose undo rows are merged and whose redo rows are not.
6. **Timeline `FILE_WRITE` rows stay as they are.** Turning them into all-green diffs would be
   consistent, but those rows are inside the virtualized output list — the row estimator has to
   move in lockstep with any change to what they render, which is its own profiling loop.
   Tracked as a follow-up below. The reported bug was in the dialog; that is what Phase 4 fixes.

### Follow-ups (not in scope)

**Timeline `FILE_WRITE` rows as all-green diffs.** Would make the output timeline and the undo
dialog agree on what a "create" looks like, reusing the same card. Deferred because those rows
live in the **virtualized** output list: a row that was "N lines of content" becomes "a
collapsible diff block", so `estimateOutputRowHeight` / `outputRowGroupPadding` must move with
it. The `outputRowEstimates` section of `webview-react.instructions.md` is explicit that what
renders and what the estimator predicts have to change in lockstep, or every such row
mis-measures — that is a self-contained chunk of work with its own profiling loop, not a
rider on this one.

**Stage/unstage from the workspace diff pane.** Once the shared card supports selection, the
SCM pane could check files directly in the diff view and stage/unstage the selection, instead of
round-tripping through the file list. Would reuse the existing `workspaceStage`/`workspaceUnstage`
endpoints in `utils/hostedApi.ts` and must preserve the refresh-after-mutation flow documented
in `webview-react-workspace.instructions.md` (refresh status first, then re-open the selected
diff only if it still exists).
