# "View N changes" Entry Point Plan

**Status:** Backlog — not started
**Priority:** P2
**Area:** `src/ui/webview-react/` (output pane headers, minimap, undo dialog, `promptUndo.ts`)

## The problem in one sentence

The only place a user can see everything a step or workflow changed — including
edits the harness never reported as file operations — is behind a button whose
verb says "destroy work", so the disclosure never reaches the person it exists
for.

## Why this is a rename plus a small model change, not a redesign

Four facts about the current code make the neutral entry point cheap, and one
makes it non-trivial. All five are load-bearing for the design below.

1. **No header button performs an action.** The workflow button
   (`OutputSectionHeader.tsx:280-317`), the step button
   (`OutputRow.tsx:1247-1276`) and the minimap popup buttons
   (`OutputMinimap.tsx:744-781`) all end at `openMinimapUndoDialog` /
   `openMinimapRedoDialog` (`useOutputUndoActions.ts:238-269`). Nothing is
   destroyed until the dialog's footer button. Collapsing the pair into one
   control removes no affordance — only a status signal.
2. **Undo and redo are already disjoint per file.** Both count sites filter
   undo candidates against the paths in `redoInstructions`
   (`useOutputUndoActions.ts:206-214`, `promptUndo.ts:1062-1067`), so within a
   step a file is either *applied* (undoable) or *undone* (redoable), never
   both. A flat list with a per-row state is therefore the accurate
   representation, not a compromise.
3. **The dialog already renders non-actionable rows.** `buildUndoDialogRow`
   assigns a `disabledReason` ("Content not captured" / "Cannot undo") when
   `instruction === null` (`promptUndo.ts:408-440`), and `DiffFileCardProps`
   carries `selection.disabledReason` for it.
4. **The tier grouping is orthogonal to direction.** "Changes the AI reported"
   / "Other changes we detected" (`promptUndo.ts:831-849`) is what makes a
   shell-mediated or generated-file change visible at all. Tabs for
   undo/redo would nest a second grouping inside it and hide half the answer to
   "what changed?" behind another click — the exact failure being fixed.
5. **Across steps, one file *can* hold both directions.** The redo filter in
   (2) is applied per step. A file edited in Prompt 2 and again in Prompt 5,
   with only Prompt 5's change undone, is simultaneously an undo candidate
   (step 2) and a redo instruction (step 5). The two current dialogs sidestep
   this by aggregating a single direction each (`aggregateWorkflowUndoFiles`
   branches on which side the entry carries — `promptUndo.ts:663-675`). A
   unified workflow list must handle it; see §3.3.

## 1. Entry points

### 1.1 What changes

Three surfaces collapse from an Undo button + a Redo button to **one neutral
button**:

| Surface | File | Today | After |
| --- | --- | --- | --- |
| Workflow header | `OutputSectionHeader.tsx:280-317` | `Undo N changes` + `Redo M changes` | `View N changes (M undone)` |
| Step header | `OutputRow.tsx:1247-1276` | same pair | same single button |
| Minimap popup | `OutputMinimap.tsx:744-781` | stacked pair | same single button |

Label shape: **`View N changes (M undone)`**, with the `(M undone)` fragment
omitted when `M === 0` and rendered as `(all undone)` when `M === N`. The
parenthetical keeps the existing redo green (`text-terminal-ansiGreen`) so the
"something is undone" signal survives without a second control; the button
itself is neutral (`text-link-fg`, a files/diff icon rather than `discard`).
Tooltip carries the full sentence: `7 files changed · 2 undone, can be redone`.

Compact/narrow variants shorten to `View N` (never dropping the count).

### 1.2 What does not change

**`FileOperationOutput.tsx` keeps its inline Undo/Redo buttons.** The diff is
already on screen there, so "view changes" would be a no-op verb; its dialog is
a confirmation sheet, reached from an explicit destructive verb, and keeps
today's pre-checked behaviour (§4).

### 1.3 Counting rules

- **`N` is every file the scope touched that the dialog will list** — undoable,
  undone, *and* non-actionable rows. It does not move as the user undoes and
  redoes; only `M` moves. That stability is what makes the number read as a
  fact about the step rather than a shifting counter.
- **`M` is the count of files currently undone** (i.e. rows whose action is
  redo).

This is a behaviour change, not just a label change: today both counts are
*actionable* counts. `OutputSectionHeader.tsx:87-94` sums
`undoCandidates.length`, and `useOutputUndoActions.ts:215-220` has already
dropped every candidate with `instruction === null` before storing the entry;
`computePromptUndoActions` uses `getPromptUndoSummary().undoableCount` the same
way. Under the new promise, `N` must count what the dialog actually lists.

Side benefit worth keeping in mind while implementing: a step whose only changes
are non-undoable currently renders **no button at all**, so the change is
invisible. Under the new rule it gets `View 3 changes`, and the dialog explains
per row why each is disabled.

## 2. Model changes

### 2.1 `PromptUndoActions` → a scope summary (`promptUndo.ts:1028-1086`)

Replace the `{ undo, redo }` action pair with a summary the three surfaces
render identically:

```ts
export interface PromptChangeSummary {
  total: number;      // N — every row the dialog will list
  undoable: number;   // rows whose action is undo
  undone: number;     // M — rows whose action is redo
  blocked: number;    // instruction === null (shown, not actionable)
  label: string;      // "View 7 changes (2 undone)"
  compactLabel: string; // "View 7"
  title: string;      // tooltip sentence
}
```

`computePromptUndoActions` becomes `computePromptChangeSummary` with the same
inputs and the same candidate/redo filtering; only the return shape and the fact
that `blocked` candidates are no longer discarded change. Label construction
lives here so the workflow header, step header and minimap cannot drift — they
currently each build their own string.

`getPromptUndoSummary` keeps its role as the low-level counter and gains the
blocked count if it does not already expose what the summary needs.

### 2.2 `WorkflowStepEntry` must stop discarding rows

`useOutputUndoActions.ts:215-220` filters `undoCandidates` to
`instruction !== null` before pushing the entry, which is why the workflow count
and the workflow dialog can disagree. Push all candidates; let
`aggregateWorkflowUndoFiles` and the dialog decide actionability (they already
branch on `instruction === null`). `buildUndoAggregationPart` returns `null` for
an instruction-less candidate (`promptUndo.ts:589-593`) — that must become a
part with a `null` instruction so the row still renders, disabled, rather than
vanishing from the aggregate.

`WorkflowStepEntry` also stops being direction-scoped at the call site: the hook
returns **one list of entries**, each carrying both `undoCandidates` and
`redoInstructions`, instead of today's `{ undoEntries, redoEntries }` pair.
`workflowUndoRedoData` becomes `workflowChangeEntries` plus a
`PromptChangeSummary`.

### 2.3 Rows carry a direction

`PromptUndoDialogRow` gains `direction: UndoRedoDirection` (reusing
`UNDO_REDO_DIRECTIONS`, `DashboardConstants.ts:3730`) — which action this row's
instruction performs, i.e. `redo` for an undone file and `undo` for an applied
one. Blocked rows inherit the direction of the side they came from and are
simply not selectable.

## 3. The dialog

### 3.1 Intent: viewer vs. confirmation sheet

Add `UNDO_DIALOG_INTENTS = { VIEW: "view", ACT: "act" }` to
`DashboardConstants.ts` next to the existing undo constants, and carry it on
`MinimapDialogState` / `WorkflowDialogState`
(`OutputUndoDialogs.tsx:9-23`). The three header surfaces open with `VIEW`; the
inline per-file buttons open with `ACT`. Intent drives exactly two things —
initial selection (§4) and the footer's default emphasis — and nothing else, so
the two modes stay one component.

### 3.2 Title and subtitle

Extend `UNDO_DIALOG_SCOPE_MODES` (`DashboardConstants.ts:2734`) with
`WORKFLOW: "workflow"` and use that one union for the title, rather than
introducing a parallel set of scope strings:

| Scope mode | Title | Subtitle |
| --- | --- | --- |
| `WORKFLOW` | `Workflow changes` | `<workflow name> · 7 files · 2 undone` |
| `PROMPT` | `Step changes` | `<step label> — <step name> · 7 files · 2 undone` |
| `SINGLE_FILE` | `File changes` | `<path>` (as today) |

The name goes in `Modal`'s existing `headerSubtitle` slot — already used this
way for the single-file path (`UndoChangesDialog.tsx:291-295`) — because step
and workflow names get long and the title row must not wrap.

**Pass the label in via dialog state; do not read it from a store inside the
dialog.** The step surfaces already hold `stepLabel`/`stepName` on
`CliHeaderRow` (`outputRows.ts:237-246`), and reading `workflowStore.workflowName`
inside the dialog would be wrong whenever a historical run of a different
lineage is being viewed.

### 3.3 One flat list, direction shown per row

Keep the existing `reported` / `detected` grouping for the step and file scopes,
and the single aggregate group for the workflow scope
(`promptUndo.ts:789-791`). Within a group, each row gains a small state chip:
nothing for an applied file, **`Undone`** (redo green) for an undone one, and
the existing `disabledReason` treatment for a blocked one. `DiffFileCardProps`
already has a `note` field and a `headerActions` slot; the chip belongs with the
change-type badge, not in `note` (which the workflow aggregate already uses for
its step list).

**Cross-step mixed files (fact 5) get one row per direction.** The aggregate key
becomes `` `${normalizeFilePath(path)}::${direction}` `` so a file that is
undoable from Prompt 2 and undone from Prompt 5 appears twice, adjacent, each
row labelled by the steps it came from (the existing `note` already lists step
labels). This is honest about the underlying model — the wire protocol is
per-step-per-direction — and avoids inventing a merged diff across two
directions, which `composeAggregateDiff` cannot express. Add a unit test for
this case; it is derived from the per-step filter, not observed in the wild.

Consequence to expect visually: `buildRedoDialogRow` builds its diff source from
`structuredPatch` alone (`promptUndo.ts:740`), so undone rows can render without
a diff beside applied rows that have one. Acceptable; not worth blocking on.

### 3.4 Selection is direction-exclusive, the footer follows it

Checking a row sets the dialog's active direction. Checking a row of the
opposite direction switches the direction and clears the other side's checks,
with a one-line hint under the selection summary: *"Undo and redo are applied
separately."*

The footer keeps **one** primary button whose verb follows the active direction
— `Undo 3 files` / `Redo 2 files`, disabled at zero selection. Two live buttons
were considered and rejected: `handleConfirm` sends one message
(`UNDO_WORKFLOW_CHANGES` / `REDO_WORKFLOW_CHANGES` /
`UNDO_PROMPT_CHANGES` / `REDO_PROMPT_CHANGES`) and the result banner is keyed by
a single `requestId` (`UndoChangesDialog.tsx:168-186`), so two in-flight
directions would race on one result slot. Direction-exclusive selection keeps
the protocol, the ordering convention (undo entries newest-step-first, redo
entries oldest-step-first — see `webview-react.instructions.md`) and the banner
untouched.

`expandAggregatedWorkflowSelection` (`UndoChangesDialog.tsx:86-112`) already
takes `mode`; it now takes the *active direction* and filters to rows of that
direction before expanding.

Cancel becomes **Close** when the intent is `VIEW`.

## 4. The safety change that matters most

`initialChecked` currently pre-checks everything
(`UndoChangesDialog.tsx:137-153`). That is right when the user arrived by
clicking *Undo*. It is wrong once a neutral button leads here: a curious click
would land on a fully-checked list with a primary "Undo Selected (7)".

**Intent `VIEW` opens with nothing checked; intent `ACT` keeps today's
behaviour.** The confirm button therefore starts disabled, and the
direction-exclusivity rule of §3.4 is invisible in the common case because the
first checkbox sets the direction.

## 5. Implementation order

1. **Model** — `promptUndo.ts`: `PromptChangeSummary`, row `direction`, blocked
   rows surviving aggregation, direction-suffixed aggregate keys.
   `useOutputUndoActions.ts`: single entry list, stop filtering blocked
   candidates. Unit tests first (`test/utils/promptUndo.test.ts`,
   `test/hooks/useOutputUndoActions.test.ts`).
2. **Dialog** — intent, scope title/subtitle, state chips, direction-exclusive
   selection, footer verb, empty initial selection for `VIEW`.
3. **Entry points** — the three surfaces, in one change so they cannot disagree:
   `OutputSectionHeader.tsx`, `OutputRow.tsx` (`CliHeaderRowView`), `OutputMinimap.tsx`
   + `useOutputMinimapModel.ts`. Delete `showCompactWorkflowUndoRedoLabels`
   (`OutputSection.tsx:1286-1290`) — it exists only to fit two buttons side by
   side, and today's mixed state is precisely when it drops the counts the user
   wants kept.
4. **Leave `FileOperationOutput.tsx` alone**, and verify its path still opens
   with intent `ACT` and a pre-checked single row.
5. **Tests** — see §6.

## 6. Testing

Existing suites that must be updated rather than deleted:

- `test/utils/promptUndo.test.ts` — summary counts (including `blocked`),
  direction on rows, cross-step mixed-direction aggregation.
- `test/hooks/useOutputUndoActions.test.ts` — single entry list, blocked
  candidates retained.
- `test/hooks/useOutputMinimapModel.test.ts` and
  `test/components/output/OutputMinimap.test.tsx` — one action per step.
- `test/components/layout/OutputSectionHeader.test.tsx` — one button, label
  shape, count stability across an undo.
- `test/components/output/UndoChangesDialog.test.tsx` — the two intents' initial
  selection, direction-exclusive checking, footer verb following the selection,
  the three titles.
- `test/components/output/FileOperationOutput.test.tsx` — unchanged, and that is
  the point; it should not need edits.

New coverage worth adding: a step whose only changes are blocked now renders a
button (§1.3), and the workflow header count equals the dialog's row count.

Extension-host tests (`src/test/unit/UndoRedoCoordinator.test.ts`) should be
untouched — the wire protocol does not change. If a change there becomes
necessary, that is a signal the design drifted.

## 7. Open decisions

- **Workflow subtitle name source.** Recommendation: pass the lineage name
  through dialog state from the surface that opens it, and fall back to the bare
  `Workflow changes` title with a `7 files · 2 undone` subtitle when no name is
  available, rather than reading `workflowStore.workflowName`.
- **Minimap dot colour.** It currently encodes mixed state as
  `text-warning-fg` (`OutputMinimap.tsx:678-690`). Suggest keeping the three
  states (has changes / has undone changes / mixed) since the dot is a status
  indicator, not an action — but it should be re-derived from
  `PromptChangeSummary` rather than from two nullable actions.
- **`(all undone)` wording** when `M === N`, versus plain `(7 undone)`.

## 8. Out of scope

- Per-*event* undo attribution (a before/after snapshot around every tool call).
  The step-level view approximates it and the hook cost is not worth it.
- Any change to snapshot capture, the undo wire protocol, or
  `UndoRedoCoordinator`.
