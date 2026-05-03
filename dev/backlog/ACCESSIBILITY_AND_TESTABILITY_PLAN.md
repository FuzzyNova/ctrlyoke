# Accessibility & Testability Improvement Plan

## Background

A header refactor broke a test because `getByText("FlightPath Workspace")` stopped matching when
the label became `"Workspace: {name}"`. The fix exposed two separate problems:

1. **Test query strategy** — `getByText` on composite/interpolated strings is fragile. The right
   query depends on whether the element has semantic meaning (role + accessible name) or is purely
   a display value (`data-testid`).
2. **Missing ARIA attributes** — several interactive and landmark elements are incomplete for screen
   readers, which also makes them harder to query in tests.

This plan addresses both together, since they share the same root cause: elements that don't
communicate their purpose clearly.

---

## Query Strategy (Rule of Thumb Going Forward)

| Element type                    | Preferred query                        | When to use `data-testid`               |
| ------------------------------- | -------------------------------------- | --------------------------------------- |
| Buttons, links, inputs, selects | `getByRole` + `{ name: '...' }`        | Almost never — add `aria-label` instead |
| Dialogs, regions, navigation    | `getByRole('dialog', { name: '...' })` | Almost never                            |
| Decorative/status display text  | `getByTestId`                          | Yes — composite strings, dynamic values |
| Form fields                     | `getByLabelText`                       | Fallback if no `<label>` association    |

`data-testid` is not a smell by itself — it's the correct tool for display-only elements with no
semantic role (status text, dynamic labels, composite strings). The smell is using it for things
that _should_ have a role.

---

## Phase 1 — Quick Wins (icon-only buttons)

Most impactful for both screen readers and test queries. Every icon-only button currently relies on
`title` for hover tooltips but `title` is not read by screen readers.

**Affected files:**

- `FooterQuickPicker.tsx` — trigger buttons use `title` but no `aria-label`
- `AgentQuickPicker.tsx`, `ModelQuickPicker.tsx`, `SkillsQuickPicker.tsx`,
  `PermissionsQuickPicker.tsx` — icon children with no accessible name
- `WorkspaceViewerHeader.tsx` — close button (already has `aria-label` ✓, good pattern)

**Fix:** Add `aria-label={title}` (or equivalent) to every icon-only button. This immediately
enables `getByRole('button', { name: 'Close workspace viewer' })` in tests without any `data-testid`.

---

## Phase 2 — Mode-switch and toggle buttons

Buttons that represent a selected state should expose that state to screen readers.

**Affected files:**

- `EditorSection.tsx` — Prompt/Script mode toggle (has `role="group"` but buttons lack `aria-pressed`)
- `GlobalSettingsDrawer.tsx` — User/Workspace scope toggle (same issue)
- `WorkspaceViewerHeader.tsx` — Explorer/Source Control tabs (uses `aria-selected` + `role="tab"` ✓,
  good pattern to follow)

**Fix:** Add `aria-pressed={isActive}` to toggle buttons. For grouped tab-style controls, use
`role="tablist"` + `role="tab"` + `aria-selected` (already done in WorkspaceViewerHeader — copy
that pattern).

---

## Phase 3 — Keyboard parity for `role="button"` divs

HTML `<button>` responds to both Enter and Space by default. Divs with `role="button"` must
replicate this manually or assistive tech users can't activate them with Space.

**Affected files:**

- `EditorSection.tsx` — collapsible section toggles
- `OutputSection.tsx` — collapsible section toggles

**Fix:**

```tsx
// Before
if (e.key === "Enter") handleToggle();

// After
if (e.key === "Enter" || e.key === " ") {
  e.preventDefault();
  handleToggle();
}
```

Prefer converting to `<button>` with `appearance: none` CSS where practical — it gets Enter, Space,
focus, and disabled handling for free.

---

## Phase 4 — Landmark regions

Screen reader users navigate by landmarks. Panels and drawers that appear/disappear should be
labelled so users know where they are.

**Affected files:**

- `PropertiesDrawer.tsx` — add `role="region" aria-label="Prompt Properties"` (or
  `aria-labelledby` pointing to the existing `<h3>`)
- `OutputSection.tsx` — the main `<section>` has an `id` but no label; add `aria-label`
- Modal/dialog wrappers — confirm they have `role="dialog"` and `aria-label`

---

## Phase 5 — `data-testid` for display-only dynamic elements

For elements with no semantic role whose text content is composite or dynamic, add `data-testid`.
These are display values, not interactive controls — `data-testid` is correct here.

**Priority candidates:**

- `WorkspaceViewerHeader.tsx` — `workspace-name` span (already done ✓)
- `EditorSection.tsx` — mode text like `"Editing: ${promptName}"`
- `Header.tsx` — execution state badge, pause-pending banner
- `OutputSection.tsx` — history run ID banner (`"Run {runId}"`)
- `SkillsQuickPicker.tsx` — inherited skills label (`"Inherit (${skills})"`)

**Naming convention:** `data-testid` values should be kebab-case and describe the _content role_,
not the component name. E.g. `workspace-name`, `execution-state-badge`, `pause-pending-banner`.

---

## Phase 6 — Decorative icons

Decorative codicon elements should be hidden from the accessibility tree so screen readers don't
announce them as unlabelled images.

**Fix:** Add `aria-hidden="true"` to all `<i className="codicon ...">` elements that are purely
decorative (i.e. the parent button/label already has an accessible name).

```tsx
<i className="codicon codicon-close" aria-hidden="true" />
```

---

## Test Updates Required

These are the existing tests that need to be updated once the component changes above are in place.
The goal: no test queries `getByText` on a button label, no test uses `getByTitle`, no test uses
`container.querySelector` with a CSS class selector.

### Already correct — good patterns to copy

- `Button.test.tsx` — all `getByRole('button', { name: '...' })` ✓
- `FileOperationOutput.test.tsx` — `getByRole('button', { name: 'Undo' / 'Redo' })` ✓
- `WorkspaceCommitArea.test.tsx` — `getByRole('button', { name: '...' })` throughout ✓
- `WorkspaceViewerModal.test.tsx` — `getByRole('tab', { name: /.../ })`, `getByTestId` ✓
- `ScriptConditionEditor.test.tsx` — `getByLabelText('Retry Prompt')` ✓
- `WorkflowFilePickerModal.test.tsx` — `getByPlaceholderText`, `getByRole('button', { name: '...' })` ✓

### WorkflowControls.test.tsx

| Line | Current                           | Replace with                                          |
| ---- | --------------------------------- | ----------------------------------------------------- |
| 34   | `getByText("New")`                | `getByRole('button', { name: 'New' })`                |
| 56   | `getByText(/New From Template/i)` | `getByRole('button', { name: /New From Template/i })` |
| 57   | `getByText(/Load from File/i)`    | `getByRole('button', { name: /Load from File/i })`    |
| 66   | `getByText(/New From Template/i)` | `getByRole('button', { name: /New From Template/i })` |
| 78   | `getByText(/Load from File/i)`    | `getByRole('button', { name: /Load from File/i })`    |
| 91   | `getByText(/Queue from File/i)`   | `getByRole('button', { name: /Queue from File/i })`   |
| 105  | `getByText(/Queue from File/i)`   | `getByRole('button', { name: /Queue from File/i })`   |

### WorkflowStatus.test.tsx

| Line | Current                                     | Replace with                                                                       |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| 77   | `getByTitle(EXECUTION_STATES.RUNNING)`      | `getByTestId('execution-state-badge')` (add testid in Phase 5)                     |
| 93   | `getByTitle('Click to edit workflow name')` | `getByRole('button', { name: /edit workflow name/i })` (add aria-label in Phase 1) |
| 100  | `getByTitle('Click to edit workflow name')` | same                                                                               |
| 113  | `getByTitle('Click to edit workflow name')` | same                                                                               |

### BashOutput.test.tsx

| Line                    | Current                           | Replace with                                                    |
| ----------------------- | --------------------------------- | --------------------------------------------------------------- |
| 50                      | `getByText('running')`            | `getByTestId('execution-state-badge')` or `getByRole('status')` |
| 61                      | `getByText(/exit: 0/)`            | `getByTestId('exit-code-badge')` (add testid to component)      |
| 68                      | `getByText(/exit: 1/)`            | `getByTestId('exit-code-badge')`                                |
| 81, 95–97, 111–113, 125 | `getByText(/show .* more line/i)` | `getByRole('button', { name: /show .* more line/i })`           |

### DiffView.test.tsx

| Line | Current                                                | Replace with                                       |
| ---- | ------------------------------------------------------ | -------------------------------------------------- |
| 128  | `getByText(/Show diff/)`                               | `getByRole('button', { name: /Show diff/i })`      |
| 139  | `getByText(/Hide diff/)`                               | `getByRole('button', { name: /Hide diff/i })`      |
| 151  | `getByText('undo')`                                    | `getByRole('button', { name: /undo/i })`           |
| 184  | `container.querySelector("[data-diff-anchor='true']")` | `getByTestId('diff-anchor')` (rename attr)         |
| 352  | `getByText(/4 hidden lines/i)`                         | `getByRole('button', { name: /4 hidden lines/i })` |

### CustomSelect.test.tsx

| Line | Current                                    | Replace with                                                            |
| ---- | ------------------------------------------ | ----------------------------------------------------------------------- |
| 67   | `container.querySelectorAll('.invisible')` | `getByTestId('dropdown')` or structural query                           |
| 139  | `getByText(/Show hidden/i)`                | `getByRole('button', { name: /Show hidden/i })`                         |
| 177  | `getAllByTitle('Hide this option')`        | `getAllByRole('button', { name: 'Hide this option' })` (add aria-label) |
| 196  | `getByText(/Show hidden/i)`                | `getByRole('button', { name: /Show hidden/i })`                         |
| 216  | `getByTitle('Unhide this option')`         | `getByRole('button', { name: 'Unhide this option' })`                   |
| 234  | `queryAllByTitle('Hide this option')`      | `queryAllByRole('button', { name: 'Hide this option' })`                |

### CliOutput.test.tsx

| Line | Current                                            | Replace with                                                   |
| ---- | -------------------------------------------------- | -------------------------------------------------------------- |
| 315  | `getByText('Re-run 1')`                            | `getByTestId('rerun-label')` (composite string with run index) |
| 317  | `container.querySelector('#fp-diff-q-0-r1-a0-e0')` | `getByTestId('diff-anchor')`                                   |

### Modal.test.tsx

| Line | Current                                                   | Replace with                                                          |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| 23   | `getByText('My Modal')`                                   | `getByRole('dialog', { name: 'My Modal' })` (if modal has aria-label) |
| 57   | `container.ownerDocument.querySelector('.fixed.inset-0')` | `getByTestId('modal-backdrop')`                                       |

### MarkdownText.test.tsx

| Line | Current                                                          | Replace with                                                                   |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 49   | `container.querySelector('code.fp-syntax.language-ts')`          | `getByTestId('code-block-ts')`                                                 |
| 60   | `container.querySelector('code.fp-syntax.language-unknownlang')` | `getByTestId('code-block-unknownlang')`                                        |
| 85   | `findByTitle(/Open src\/utils\/foo\.ts/)`                        | `findByRole('button', { name: /Open src\/utils\/foo\.ts/i })` (add aria-label) |
| 93   | `findByTitle(/Open src\/utils\/foo\.ts/)`                        | same                                                                           |
| 101  | `container.querySelector('.markdown-text')`                      | `getByTestId('markdown-text')`                                                 |

---

## What NOT to do

- Don't use `id` attributes for testing — IDs are for CSS, forms (`htmlFor`), and anchor links.
  They pollute the page identifier namespace.
- Don't add `data-testid` to buttons, inputs, or other interactive elements — use
  `getByRole + name` instead. That query validates both the role and the accessible name in one
  assertion.
- Don't warp DOM structure (extra wrapper spans/divs) to make a text string independently
  queryable — use `data-testid` on the existing element instead.

---

## Success Criteria

- All icon-only buttons have `aria-label` and are queryable via `getByRole('button', { name: '...' })`
- All toggle/mode buttons have `aria-pressed` or `aria-selected`
- All `role="button"` divs handle Space key
- Major panels/drawers have landmark roles with labels
- Dynamic display strings have `data-testid`
- Decorative icons have `aria-hidden="true"`
- No test uses a fragile `getByText` on a composite/interpolated string
