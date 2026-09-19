# "View N changes" Entry Point Plan

**Status:** In progress — staged as a five-step ctrlyoke workflow on 2026-09-19.
Spec verified against the tree that day: all cited line numbers are current;
three file paths, the display-name extraction, the third
`computePromptUndoActions` consumer, and two affected test files were corrected
in the same pass.
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
   step a file is either _applied_ (undoable) or _undone_ (redoable), never
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
5. **Across steps, one file _can_ hold both directions.** The redo filter in
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

| Surface         | File                                                               | Today                               | After                       |
| --------------- | ------------------------------------------------------------------ | ----------------------------------- | --------------------------- |
| Workflow header | `components/layout/output-section/OutputSectionHeader.tsx:280-317` | `Undo N changes` + `Redo M changes` | `View N changes (M undone)` |
| Step header     | `components/output/OutputRow.tsx:1247-1276`                        | same pair                           | same single button          |
| Minimap popup   | `components/output/OutputMinimap.tsx:744-781`                      | stacked pair                        | same single button          |

> **Paths in this document** are relative to `src/ui/webview-react/`. Three files
> sit in less obvious places than earlier drafts of this plan assumed:
> `OutputSectionHeader.tsx` and `OutputUndoDialogs.tsx` are under
> `components/layout/output-section/`, and `WorkflowStatus.tsx` is under
> `components/workflow/` (not `components/layout/`). All line numbers cited
> below were verified against the current tree.

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
  undone, _and_ non-actionable rows. It does not move as the user undoes and
  redoes; only `M` moves. That stability is what makes the number read as a
  fact about the step rather than a shifting counter.
- **`M` is the count of files currently undone** (i.e. rows whose action is
  redo).

This is a behaviour change, not just a label change: today both counts are
_actionable_ counts. `OutputSectionHeader.tsx:87-94` sums
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
  total: number; // N — every row the dialog will list
  undoable: number; // rows whose action is undo
  undone: number; // M — rows whose action is redo
  blocked: number; // instruction === null (shown, not actionable)
  label: string; // "View 7 changes (2 undone)"
  compactLabel: string; // "View 7"
  title: string; // tooltip sentence
}
```

`computePromptUndoActions` becomes `computePromptChangeSummary` with the same
inputs and the same candidate/redo filtering; only the return shape and the fact
that `blocked` candidates are no longer discarded change. Label construction
lives here so the workflow header, step header and minimap cannot drift — they
currently each build their own string.

`getPromptUndoSummary` keeps its role as the low-level counter and gains the
blocked count if it does not already expose what the summary needs.

**There are three consumers of `computePromptUndoActions`, not two**, and the
third carries the only real performance hazard in this plan:

| Consumer                                | Feeds                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hooks/useOutputMinimapModel.ts:359`    | minimap dot + popup buttons                                                                                              |
| `utils/outputRows.ts:2332`              | `OutputRowPromptUndoMeta.undo/redo` (`outputRows.ts:101-113`) → the **step header** buttons at `OutputRow.tsx:1247-1276` |
| `test/utils/outputRowsUndoMemo.test.ts` | mocks it **by name** via `vi.mock`                                                                                       |

The `outputRows.ts` call sits behind a deliberate per-target memo,
`getPromptUndoActionsForTarget` (`outputRows.ts:2325-2335`), whose comment
records the measurement that motivated it: on an 18-step run (4 653 messages,
19 targets) the unmemoized version burned 6 413 ms of a 6 527 ms row build —
98 % — across 4 652 calls that produced 19 distinct answers. **That memo must
survive the rename.** `PromptChangeSummary` is a per-target value exactly as
`PromptUndoActions` was, so the memo keeps working unchanged; a refactor that
computes the summary inside the per-message loop instead silently reintroduces
a measured multi-second regression that no test asserts against.

`OutputRowPromptUndoMeta`'s `undo`/`redo` pair collapses to a single
`summary: PromptChangeSummary`, and `OutputRowPromptUndoAction`
(`outputRows.ts:101-104`) is deleted — `PromptChangeSummary` supersedes it.

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

Two call sites read the old pair and must move with it:
`OutputSection.tsx:1286-1290` (see §5.4) and `OutputUndoDialogs.tsx:55`, which
passes `workflowDialogState.entries[0].target` as the dialog's `target` prop.
That index is unguarded — it throws on an empty list. Today it is safe only
because the header renders no button when the matching direction's list is
empty, so the dialog cannot open empty. Under §1.3 the button appears whenever
_any_ row exists, including blocked-only steps, so keep the entry list
non-empty whenever the button renders, or guard the index.

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

| Scope mode    | Title              | Subtitle                                          |
| ------------- | ------------------ | ------------------------------------------------- |
| `WORKFLOW`    | `Workflow changes` | `<workflow name> · 7 files · 2 undone`            |
| `PROMPT`      | `Step changes`     | `<step label> — <step name> · 7 files · 2 undone` |
| `SINGLE_FILE` | `File changes`     | `<path>` (as today)                               |

The name goes in `Modal`'s existing `headerSubtitle` slot — already used this
way for the single-file path (`UndoChangesDialog.tsx:291-295`) — because step
and workflow names get long and the title row must not wrap.

**Pass the label in via dialog state; do not derive it inside the dialog.** The
step surfaces already hold `stepLabel`/`stepName` on `CliHeaderRow`
(`outputRows.ts:237-246`).

**The workflow subtitle is always the name shown in the `WorkflowStatus` header
— the one the user edits by clicking it — and there is no bare-title
fallback.** That name is not simply `workflowStore.workflowName`; the header
derives it (`WorkflowStatus.tsx:392-398`) as

```ts
pendingRunViewSwitch?.workflowName ??
  (fileName
    ? workflowName || getWorkflowNameFromPath(fileName)
    : DEFAULT_WORKFLOW_NAME);
```

and the `pendingRunViewSwitch` arm is load-bearing: during a cross-lineage
switch the store still holds the _previous_ workflow's name while the displayed
address already targets the new one, which is the same trap the header's inline
rename guards against (`WorkflowStatus.tsx:768-777`). Reading the raw store
field from the dialog would reproduce that bug — the dialog would title itself
with the workflow the user just navigated away from.

So **extract the derivation before using it twice.** `getWorkflowNameFromPath`
is currently module-private at `WorkflowStatus.tsx:1934`. Move it into a shared
helper (`utils/workflowDisplayName.ts`) together with a
`useWorkflowDisplayName()` hook over the two stores, and have `WorkflowStatus`
and the dialog's opener read the same value. Per the project's single-source
rule this is a prerequisite of the subtitle, not a follow-up.

**The four sites in `WorkflowStatus.tsx` are not the same expression, and
repointing all four at the hook would introduce a bug.** They are:

| Site       | Expression                                                                                                                       | Uses `pendingRunViewSwitch`?                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `:394`     | `pendingRunViewSwitch?.workflowName ?? (fileName ? workflowName \|\| getWorkflowNameFromPath(fileName) : DEFAULT_WORKFLOW_NAME)` | **yes** — this is the header display name                             |
| `:253-257` | `workflowName \|\| (fileName ? getWorkflowNameFromPath(fileName) : DEFAULT_WORKFLOW_NAME)`                                       | no                                                                    |
| `:775`     | `workflowName \|\| getWorkflowNameFromPath(fileName)`                                                                            | no — guarded by an early `if (pendingRunViewSwitch) return` at `:774` |
| `:787`     | `workflowName \|\| getWorkflowNameFromPath(fileName \|\| "")`                                                                    | no                                                                    |

Only `:394` is the display name. The rename path (`:775`/`:787`) deliberately
excludes the `pendingRunViewSwitch` arm — it early-returns on that state
instead, because mid-switch a rename would pair the _old_ name with the _new_
address (the comment at `:771-774` says so). Feeding it the switch target would
re-create precisely the bug that guard exists to prevent.

So the extraction is two things, not one: **(a)** the pure
`getWorkflowNameFromPath`, shared by all four sites; **(b)** the display-name
chain (`useWorkflowDisplayName()`), used by `:394` and the dialog's opener
**only**. Leave `:253-257`, `:775` and `:787` reading `workflowName ||
getWorkflowNameFromPath(...)` as they do today.

Because the header always names the lineage currently displayed, and the output
pane shows that same displayed run, the header's name is correct for the dialog
by construction — including while viewing history.

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
with a one-line hint under the selection summary: _"Undo and redo are applied
separately."_

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
takes `mode`; it now takes the _active direction_ and filters to rows of that
direction before expanding.

Cancel becomes **Close** when the intent is `VIEW`.

## 4. The safety change that matters most

`initialChecked` currently pre-checks everything
(`UndoChangesDialog.tsx:137-153`). That is right when the user arrived by
clicking _Undo_. It is wrong once a neutral button leads here: a curious click
would land on a fully-checked list with a primary "Undo Selected (7)".

**Intent `VIEW` opens with nothing checked; intent `ACT` keeps today's
behaviour.** The confirm button therefore starts disabled, and the
direction-exclusivity rule of §3.4 is invisible in the common case because the
first checkbox sets the direction.

## 5. Implementation order

1. **Model — done** — `promptUndo.ts`: `PromptChangeSummary`, row `direction`, blocked
   rows surviving aggregation, direction-suffixed aggregate keys.
   `useOutputUndoActions.ts`: single entry list, stop filtering blocked
   candidates. Unit tests first (`test/utils/promptUndo.test.ts`,
   `test/hooks/useOutputUndoActions.test.ts`).
2. **Display name — done** — extracted `getWorkflowNameFromPath` and the
   header's `pendingRunViewSwitch ?? workflowName ?? path` chain out of
   `WorkflowStatus.tsx` into a shared helper/hook. The four inline uses follow
   the §3.2 table: only the header uses the hook; the synthetic workflow and
   rename paths use the pure helper without `pendingRunViewSwitch`.
3. **Dialog — done** — intent, scope title/subtitle, state chips,
   direction-exclusive selection, footer verb, empty initial selection for
   `VIEW`.

   **§5.3 done.** The dialog and state now use `UndoRedoDirection`, the local
   `DIALOG_MODE` duplicate is gone, and the hook's direction assignments use
   `UNDO_REDO_DIRECTIONS`. The workflow dialog also carries the shared header
   display name so a pending cross-lineage switch cannot title it with the
   previous workflow.

4. **Entry points** — the three surfaces, in one change so they cannot disagree:
   `OutputSectionHeader.tsx`, `OutputRow.tsx` (`CliHeaderRowView`), `OutputMinimap.tsx`
   - `useOutputMinimapModel.ts`. Delete `showCompactWorkflowUndoRedoLabels`
     (`OutputSection.tsx:1286-1290`) — it exists only to fit two buttons side by
     side, and today's mixed state is precisely when it drops the counts the user
     wants kept.
5. **Leave `FileOperationOutput.tsx` alone**, and verify its path still opens
   with intent `ACT` and a pre-checked single row.
6. **Tests** — see §6.

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
  the three titles, and the workflow subtitle matching the header's display name
  (including the mid-switch `pendingRunViewSwitch` case, which is the one the
  raw store field gets wrong).
- `test/components/output/FileOperationOutput.test.tsx` — unchanged, and that is
  the point; it should not need edits.
- `test/utils/outputRowsUndoMemo.test.ts` — **breaks on the rename and is easy
  to miss.** It `vi.mock`s `@utils/promptUndo` and wraps
  `computePromptUndoActions` _by name_ to count calls, so renaming the export
  leaves the spy wrapping nothing: the mock still resolves (spread from
  `importOriginal`), the counter stays at 0, and the assertion fails with no
  hint that a rename caused it. Repoint it at `computePromptChangeSummary` and
  keep its once-per-target assertion — it is the only guard on the memo
  described in §2.1.
- `test/components/workflow/WorkflowStatus.test.tsx` — covers the display-name
  extraction (§5.2), including that the rename path still ignores
  `pendingRunViewSwitch`.

New coverage worth adding: a step whose only changes are blocked now renders a
button (§1.3), and the workflow header count equals the dialog's row count.

Extension-host tests (`src/test/unit/UndoRedoCoordinator.test.ts`) should be
untouched — the wire protocol does not change. If a change there becomes
necessary, that is a signal the design drifted.

## 7. Decisions (settled)

- **Workflow subtitle name source — always the `WorkflowStatus` header name**,
  the one the user edits inline, derived through the shared helper described in
  §3.2. There is no bare `Workflow changes` fallback: if the name is empty the
  helper's own chain (`getWorkflowNameFromPath(fileName)`, then
  `DEFAULT_WORKFLOW_NAME`) already produces what the header shows, and the
  dialog must show the same string.
- **Minimap dot colour stays.** Keep the three states (has changes / has undone
  changes / mixed, `OutputMinimap.tsx:678-690`) — the dot is a status
  indicator, not an action, so collapsing the popup's two buttons into one does
  not collapse it. Re-derive it from `PromptChangeSummary`
  (`undone > 0 && undoable > 0` → mixed) instead of from two nullable actions.
- **`(all undone)`** is the wording when `M === N`.

## 8. Out of scope

- Per-_event_ undo attribution (a before/after snapshot around every tool call).
  The step-level view approximates it and the hook cost is not worth it.
- Any change to snapshot capture, the undo wire protocol, or
  `UndoRedoCoordinator`.
