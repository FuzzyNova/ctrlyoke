# Dropdown Toolbar: Search, Hide All, Unhide All

**Status:** Not started.

## Goal

Give every hideable dropdown three new controls:

- **Search**: a plain, case-insensitive substring filter on the option label.
- **Hide all**: hide every hideable option currently listed.
- **Unhide all**: bring every hidden option back.

These go in the trigger-mode dropdowns and in the inline lists hosted by the editor
footer quick pickers (`FooterQuickPicker`).

## Scope

The hide feature is implemented four times. Each one renders `DropdownHiddenToggle` and
partitions with `useHideableOptions`, and all four should get the same toolbar so they
stay identical:

| Component                                     | Used by                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `components/shared/CustomSelect.tsx`          | Model, Agent, Permissions, Context, Execution-mode footer pickers (inline); PromptPropertiesDrawer, WorkflowPropertiesPanel, settings (trigger) |
| `components/shared/MultiCheckboxDropdown.tsx` | Workflow- and prompt-level skills (trigger only)                                                                                          |
| `components/shared/SkillsSelect.tsx`          | SkillsQuickPicker (inline) and its trigger mode                                                                                           |
| `components/shared/HarnessDropdown.tsx`       | HarnessQuickPicker (inline) and its trigger mode                                                                                          |

The user named the first two, plus the footer versions. Those footer versions are
`CustomSelect`, `SkillsSelect` and `HarnessDropdown` in `inline` mode. Leaving
`SkillsSelect`/`HarnessDropdown` out would make the Skills and Harness footer pickers
differ from the Model picker beside them.

Search is useful even where hiding is off (long settings selects). Hide all and unhide
all apply only when `namespace` is set.

## Current layout and its problems

Screenshot reference (Model picker with `Show hidden` expanded): visible rows, a divider,
the hidden rows in italics with an eye icon, then a `Hide hidden` bar at the bottom.

- The show/hide bar lives at the bottom, so with a long hidden list it moves away from the
  rows it controls. In `MultiCheckboxDropdown` it changes edge depending on whether the
  popup opens up or down (`dividerSide`), so its position is not predictable.
- Unhiding eight models takes eight clicks; hiding the long tail of a fresh harness's
  model list takes one click per row.
- Long lists (models across several generations, skills) have no filter. Typeahead
  (`useListboxKeyboardNavigation`) only works once the list has keyboard focus, and it
  moves the highlight without narrowing the list.

## Proposed layout

Replace the bottom `DropdownHiddenToggle` bar with a single **toolbar row pinned at the
top** of the popup, above the scroll area:

```
┌──────────────────────────────────────────────┐
│ 🔍 Filter…                  [👁 8] [⊘] [👁+] │  ← toolbar (shrink-0, border-b)
├──────────────────────────────────────────────┤
│ None                                         │
│ Opus 5.5                              ✓      │  ← visible rows (scrolls)
│ Fable 5.1                                    │
│ ─────────────────────────────────────────    │
│ 👁 Haiku 4.5                    (italic)     │  ← hidden rows, when shown
│ …                                            │
└──────────────────────────────────────────────┘
```

- **Filter input** takes the remaining width: `codicon-search` leading icon, placeholder
  `Filter`, and a `codicon-close` clear button once there is text.
- **Show-hidden toggle**: an icon button (`eye` / `eye-closed`) with the hidden count as a
  small badge. It replaces the text bar and keeps its `aria-pressed` state and the
  `Show hidden (N)` / `Hide hidden` wording as `title`/`aria-label`. It is disabled when
  N = 0, as now.
- **Hide all** (`eye-closed` with a slash, or `codicon-eye-closed` + `codicon-close`
  overlay; pick from the codicons already in the icon font) and **Unhide all**
  (`codicon-eye`). Icon buttons with tooltips, disabled when there is nothing to act on.

Why the top and not the bottom:

- A filter field conventionally sits at the top (VS Code Quick Pick, the command palette),
  where the eye lands first.
- One fixed edge for every dropdown, whichever way it opens. `MultiCheckboxDropdown`'s
  `popupPos.bottom`/`popupPos.top` branching and `DropdownHiddenToggle`'s `dividerSide`
  prop are no longer needed.
- Footer pickers open upward with a heading bar (`FooterQuickPicker` `heading`). The
  toolbar sits directly under that heading, so the popup reads heading → controls → list,
  which is how the drawers already read.
- The toolbar no longer competes with `MultiCheckboxDropdown`'s sticky `All (n/m)` header:
  the toolbar sits outside the scroll area and the sticky `All` / group headers stay
  inside it, unchanged (`top-0` / `top-7` offsets still hold because they are relative to
  the scroll container).

`DropdownHiddenToggle` is removed (or renamed and rewritten as `DropdownToolbar`). Its
"single source for the four selects" role carries over to the new component.

### When the toolbar appears

- Hide enabled (`namespace` set): always shown, because the eye toggle lives there.
- Hide disabled: shown only for the search field, and only when the select has at least
  `DROPDOWN_SEARCH_MIN_OPTIONS` options (proposed 8). Short selects (Yes/No, a
  three-value enum) stay as they are.
- Callers can force it on or off with a `searchable?: boolean` prop. `undefined` uses the
  threshold.

## Behavior

### Search

- Matches the label as a case-insensitive substring after trimming. No fuzzy matching or
  description matching in v1 (the request is "a simple filter by name").
- Applies to visible **and** hidden options. While a query is non-empty, matching hidden
  rows are listed in the hidden section even when Show hidden is off, so a search finds a
  hidden model without two extra clicks. Clearing the query returns to the toggle's state.
- Rows that are always present stay visible regardless of the query: the
  `nonHideableValues` sentinels (`Inherit`/`default`, `(mixed)`) and the currently
  selected value. Hiding the current selection would leave the user unable to see what is
  set. The `All` and group headers in `MultiCheckboxDropdown` reflect the filtered set
  only (`All (2/3)` counts the matches) and a group with no matching rows is omitted.
- With no matches: one muted `No matches` row (replacing `No skills available` while
  filtering).
- The query resets when the popup closes, like `showHidden`.
- Not persisted.

### Hide all / Unhide all

Both act on the **filtered** set, which makes search plus hide a bulk tool: type `4.` and
hide all hides every 4.x model. When a query is active the tooltips say so: `Hide 6
matching options` / `Unhide 3 matching options`. Without one they say `Hide all options`
/ `Unhide all N hidden options`.

- **Hide all** hides every listed visible option that `canHide` already allows: not in
  `nonHideableValues`, not the current value (`CustomSelect`), not disabled, not locked
  (`MultiCheckboxDropdown` `lockedValues`).
- In `MultiCheckboxDropdown` and `SkillsSelect`, **Hide all skips checked values**. The
  per-row hide auto-unchecks (`handleHide`), but a bulk action that silently removes
  several skills from a workflow is a surprise edit to the user's file. Checked rows stay
  visible, which matches `CustomSelect` never hiding the selected value.
- **Unhide all** unhides every listed hidden option.
- No confirmation dialog: both are UI preferences, not workflow edits, and each is undone
  by the other. The cost is that Unhide all after Hide all does not restore the exact set
  that was hidden before; that is acceptable for a view preference.
- Focus: after the action, focus stays on the clicked button, so a keyboard user can
  reverse it immediately.

### Keyboard

The list keeps its current keyboard model (`usePickerListbox` /
`useListboxKeyboardNavigation`). The filter input adds:

- `ArrowDown` from the input focuses the list with the first match highlighted
  (`focusList`).
- `Enter` in the input commits the single remaining match in `CustomSelect` /
  `HarnessDropdown`. With several matches it focuses the list instead, so a stray Enter
  never picks the wrong row.
- `Escape` in the input clears a non-empty query first; a second Escape dismisses as now.
  `MultiCheckboxDropdown`'s capture-phase Escape listener needs the same "clear first"
  check, or it closes the popup before the input sees the key.
- Typeahead while the **list** has focus is unchanged. It does not redirect into the
  filter field, so the shortcut flow (Alt+Shift → list focused → type to jump → Enter)
  behaves exactly as it does today.
- The input is **not** auto-focused when the popup opens. On touch devices that would pop
  the on-screen keyboard over a footer picker, and on desktop it would steal the focus
  that `focusList` hands back to the prompt editor on commit.

`usePickerListbox`'s `options` becomes the filtered, enabled visible list, so arrows and
typeahead never land on a filtered-out row. When a query change removes the active row,
the highlight moves to the first match.

## Implementation

### 1. Shared filtering: extend `useHideableOptions`

`hooks/useHideableOptions.ts` already owns the visible/hidden split. Add an optional
config:

```ts
useHideableOptions(options, getKey, hiddenValues, namespace, {
  query, // string, default ""
  getLabel, // (o) => string, for matching
  isPinned, // (o) => boolean: sentinels + selected, always listed
});
```

and return `visible`, `hidden`, `listedVisible`, `listedHidden` (filtered), and
`hiddenCount`. All four components then filter the same way. Matching lives in one pure
helper in `utils/dropdownUtils.ts` (`optionMatchesQuery(label, query)`) so tests can cover
it directly.

### 2. Bulk store actions

`store/uiStore.ts` has `hideDropdownOption`, `unhideDropdownOption` and
`clearHiddenDropdownOptions`. Add:

```ts
hideDropdownOptions: (namespace: string, values: readonly string[]) => void;
unhideDropdownOptions: (namespace: string, values: readonly string[]) => void;
```

Each is one `set()` that updates both `hiddenDropdownOptions` and
`shownDropdownOptions` for all values. Make the singular actions call them with one
value so the add/remove logic exists once.

**Do not implement Unhide all with `clearHiddenDropdownOptions`.** That resets the
namespace to defaults, so models the harness hides by default
(`resolveHiddenDropdownValues` in `types/dropdownNamespaces.ts`) would go straight back
into the hidden list. Unhide all must write every value into `shownDropdownOptions`, as
the per-row unhide does.

### 3. Prop contract: `HideableProps`

Add optional bulk callbacks to `HideableProps` in `CustomSelect.tsx`:

```ts
onHideOptions?: (values: string[]) => void;
onUnhideOptions?: (values: string[]) => void;
```

When a caller omits them, the component falls back to calling `onHideOption` /
`onUnhideOption` once per value, so every existing call site gets the feature without
changes. Update the shared wiring to pass the bulk store actions:
`useModelDropdownHiding` (Model pickers in the footer, PromptPropertiesDrawer and
WorkflowPropertiesPanel) and the inline wiring in AgentQuickPicker, HarnessQuickPicker,
SkillsQuickPicker, PromptPropertiesDrawer, WorkflowPropertiesPanel, CommitSection,
HarnessesSection and TemplateModal. That makes each action a single store write and a
single persisted-state flush. If the inline wirings turn out to be identical apart from
the namespace, fold them into one `useDropdownHiding(namespace)` hook alongside
`useModelDropdownHiding` while doing this.

### 4. `DropdownToolbar` component

New `components/shared/DropdownToolbar.tsx`, replacing `DropdownHiddenToggle`. It renders
the input and buttons only; the selects own the state:

```ts
interface DropdownToolbarProps {
  query: string;
  onQueryChange: (q: string) => void;
  showSearch: boolean;
  onSearchKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  hide?: {
    // omitted when hide is disabled
    hiddenCount: number;
    showHidden: boolean;
    onToggleShowHidden: () => void;
    hideAllCount: number; // 0 → disabled
    unhideAllCount: number; // 0 → disabled
    onHideAll: () => void;
    onUnhideAll: () => void;
    filtered: boolean; // switches tooltip wording to "matching"
  };
}
```

Build the tooltip and aria strings in the component (one place). Use `Icon` for every
glyph. Give each button an `aria-label`. Name the input `Filter options` and point it at
the listbox with `aria-controls`.

State per select: add `query` next to `showHidden` and reset both in the same close path
(`closeDropdown`, `handleSelect`, the toggle-close branch).

### 5. Per-component changes

- **CustomSelect**: render `DropdownToolbar` above `scrollableList` in both the inline
  and portal branches. Feed the filtered list to `usePickerListbox`. Render hidden rows
  from `listedHidden` when `showHidden || query`.
- **MultiCheckboxDropdown**: toolbar at the top unconditionally (drop both
  `popupPos`-gated toggle blocks). `All` / group headers and `toggleAll` / `toggleGroup`
  operate on the filtered set. Add the Escape-clears-query check to the capture listener.
  Hide all skips checked and locked values.
- **SkillsSelect**, **HarnessDropdown**: same as `CustomSelect`. Hide all in
  `SkillsSelect` skips checked skills.
- **FooterQuickPicker**: no structural change. The toolbar is inside its `children`,
  directly under the heading. Check that `popupMinWidth` (200–220 px) fits the input plus
  three icon buttons. If it doesn't, raise the Model and Skills pickers' min width rather
  than shrinking the input below ~90 px.

### 6. Tests (`src/ui/webview-react/test/`)

- `utils/dropdownUtils` matching: case, trimming, empty query.
- `useHideableOptions`: filtered partitions; pinned rows survive any query; hidden
  matches are listed while a query is active.
- `uiStore`: bulk hide/unhide update both maps in one write; Unhide all of a
  harness-default-hidden model leaves it shown (regression guard against using
  `clearHiddenDropdownOptions`).
- `CustomSelect.test.tsx`, `MultiCheckboxDropdown.test.tsx`, `SkillsSelect.test.tsx`,
  `HarnessDropdown.test.tsx`: filter narrows rows; `No matches`; Hide all skips
  selected/sentinel/disabled/locked/checked; the bulk callback is used when provided and
  the per-value fallback when not; Escape clears then dismisses; ArrowDown/Enter from the
  input; the toolbar is hidden below the threshold when hide is disabled; query resets on
  close.
- Existing tests that click the `Show hidden (N)` text button need their queries updated
  to the new `aria-label`.

### 7. Docs and changelog

- `CHANGELOG.md` → `## [Unreleased]` → **Changed**: dropdowns gain a filter field and
  hide all / unhide all, and the show-hidden control moves from the bottom bar to the
  toolbar.
- Find the hand-written `docs/` page that describes hiding dropdown options (grep `docs/`
  for "Show hidden") and update its wording and screenshot reference.
- No schema, settings or persisted-format change: `hiddenDropdownOptions` /
  `shownDropdownOptions` keep their shape.

## Non-goals

- Fuzzy matching, matching descriptions, or highlighting the matched substring.
- Persisting the query or remembering it per picker.
- Undo for Hide all beyond Unhide all.
- Adding search to selects that use neither the hide feature nor the shared components
  (`LimitSelect`, `PriorContextSelect`); revisit once the toolbar exists.
- The Prompt/Workflow target scope in `QUICK_PICKER_IMPROVEMENTS_PLAN.md`. It also adds a
  control row to the footer popup's title area; if both land, the target segmented
  control belongs in the heading bar and this toolbar stays under it.

## Open questions

1. **Search threshold** for non-hideable selects: is 8 options right, or should search
   be opt-in only (`searchable`) outside the hideable selects?
2. **Hide all and checked skills**: skipping checked rows is the conservative choice.
   The alternative is to match per-row hide and uncheck them, which is faster for "clean
   up this list" but edits the workflow.
3. **Toolbar icon for Hide all**: the codicon font has no clean "hide many" glyph.
   Options are `eye-closed` with a tooltip that carries the meaning, or a compact text
   button (`Hide all`) if the icon proves ambiguous in review.
