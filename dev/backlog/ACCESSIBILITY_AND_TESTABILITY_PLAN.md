# Accessibility & Testability Improvement Plan

## Background

A header refactor broke a test because `getByText("ctrlyoke Workspace")` stopped matching when
the label became `"Workspace: {name}"`. The fix exposed two problems that share one root cause —
elements that don't communicate their purpose:

1. **Test query strategy** — `getByText` on composite/interpolated strings is fragile.
2. **Missing ARIA attributes** — interactive and landmark elements are incomplete for screen
   readers, which also makes them harder to query.

A second pass added a **third audience, which turned out to be the decisive one**: the Playwright
MCP agent. ctrlyoke is routinely driven headlessly through the hosted dashboard (see
`dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md`), and `browser_snapshot` renders **the
accessibility tree and nothing else**. Every control without an accessible name is, to that agent,
invisible and unclickable.

That pass also produced a measurement that reorders the whole plan — see **Root cause** below.
The original phase order treated `aria-hidden` on decorative icons as last-place polish. It is
actually the precondition for everything else.

---

## Ground truth (measured 2026-09-07)

Taken from a live hosted dashboard (dev host + Playwright MCP `browser_snapshot` /
`browser_evaluate`), workflow running, properties drawer and workflow-properties panel open:

| Measurement                                                      | Value                       |
| ---------------------------------------------------------------- | --------------------------- |
| Visible interactive elements                                     | 208                         |
| Codicon `<i>` elements in the live DOM                           | 171                         |
| …of those carrying `aria-hidden="true"`                          | **5**                       |
| Visible buttons whose Playwright accessible name is a bare glyph | **21**                      |
| `.fp-tab-hc` pseudo-tabs with no `role`/`aria-selected`          | **14** (2 duplicate sets)   |
| Raw `<i className="codicon …">` in source (excl. tests)          | **357**                     |
| Shared `<Icon>`/`<Codicon>` component                            | **none — all hand-written** |

Representative snapshot fragments, verbatim:

```yaml
- button "" [ref=e548] # Toggle prompt properties
- button "" [disabled] [ref=e554] # Model override
- button "" [disabled] [ref=e556] # Agent override
- button " New" [ref=e9] # leading char is a codicon glyph, not a space
- button " Output" [ref=e130]
- button "disabled Final Step disabled"
- button "running  I want to update @dev/backlog/ACCESSIBILITY…" # whole prompt is the name
- textbox [ref=e483] # the main prompt editor — no name at all
```

Duplicate accessible names among **visible** controls (each one a Playwright strict-mode
violation, and an ambiguous target for a human using a screen reader):

| Name                                                                   | Count  |
| ---------------------------------------------------------------------- | ------ |
| `Remove from history`                                                  | 31     |
| `Add to favorites`                                                     | 26     |
| `Remove from favorites`                                                | 5      |
| `Show full command`                                                    | 5      |
| `Inherit (None)`                                                       | 3      |
| `Harness` / `Context` / `Validation` / `MCP` / `Hooks` / `Permissions` | 2 each |
| `Undo`, `None`                                                         | 2 each |

---

## Root cause: codicon glyphs pre-empt the `title` fallback

This is the finding that reorders the plan, and it is not guessable from reading the code.

The accessible-name algorithm tries, in order: `aria-labelledby` → `aria-label` → **name from
content** → `title`. Name-from-content **includes CSS `::before` content**. A codicon renders its
glyph as `::before { content: "\eb1e" }`, so an icon-only button's content step returns a
non-empty string — one private-use-area character — and the algorithm **stops there and never
reaches `title`**.

So `<button title="Model override"><i className="codicon codicon-robot" /></button>` computes to
an accessible name of a single unprintable glyph. Playwright prints it as `button ""`.

**Verified, not assumed.** Setting `aria-hidden="true"` on that one `<i>` in the live DOM and
re-snapshotting the same element:

```yaml
# before
- button "" [ref=e548]
# after aria-hidden="true" on the child <i>
- button "Read-only — workflow is running via another ctrlyoke window" [disabled] [ref=e601]
```

Three consequences:

1. **`aria-hidden` on decorative codicons is load-bearing, not cosmetic.** It is what lets any
   name — `title` today, `aria-label` after this plan — reach the accessibility tree. It moves
   from the last phase to the first.
2. **Buttons that already have text are affected too.** `button " New"` is glyph + `"New"`, so
   `getByRole('button', { name: 'New', exact: true })` fails in a browser and only a substring or
   regex match works. Hiding the icon makes exact matching work everywhere.
3. **The Vitest suite structurally cannot catch any of this.** jsdom does not implement
   pseudo-elements — `getComputedStyle(el, '::before')` logs `Not implemented` and returns
   `content: "normal"` — so `dom-accessibility-api` skips the content step and falls through to
   `title`. Confirmed directly:

   | Environment             | Accessible name of the same button |
   | ----------------------- | ---------------------------------- |
   | jsdom + Testing Library | `"Send prompt"` ✅ test passes     |
   | Chromium + Playwright   | `""` ❌ agent sees `button ""`    |

   The unit suite is **green precisely because it is blind to the defect**. Do not treat
   `npm run test:ui` passing as evidence that a control is reachable. Verification has to happen
   in a real browser — see **Verification recipe**.

---

## Query strategy

Two consumers, two different rules. The important asymmetry: **`data-testid` does not appear in
Playwright's `browser_snapshot` output at all.** A testid helps Vitest and does nothing for the
agent driving the live dashboard, so it can never substitute for a role and a name.

### For Vitest (`src/ui/webview-react/test/**`)

| Element type                    | Preferred query                      | When `data-testid` is right             |
| ------------------------------- | ------------------------------------ | --------------------------------------- |
| Buttons, links, inputs, selects | `getByRole` + `{ name: '…' }`        | Almost never — add `aria-label` instead |
| Dialogs, regions, navigation    | `getByRole('dialog', { name: '…' })` | Almost never                            |
| Decorative/status display text  | `getByTestId`                        | Yes — composite strings, dynamic values |
| Form fields                     | `getByLabelText`                     | Fallback if no `<label>` association    |

`data-testid` is not a smell by itself — it is the correct tool for display-only elements with no
semantic role. The smell is using it for something that _should_ have a role.

### For the Playwright MCP agent

| Need                      | Rule                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Click a control           | It must have a **role** and a **non-empty, stable accessible name**                                     |
| Click _the right_ control | That name must be **unique among visible elements**, or scoped inside a named `group`/`region`/`dialog` |
| Read a value              | Give the value element a role (`status`, `heading`) or a name — a bare `generic` is unaddressable       |
| Assert state              | Expose it as ARIA state (`aria-pressed`, `aria-selected`, `aria-expanded`, `disabled`), not a CSS class |

A name that changes with the value ("Inherit (Sonnet)") is not stable. A name that contains the
entire prompt text is not usable. Both appear in the ground-truth snapshot above.

---

## Phase 1 — Hide decorative icons (precondition for every later phase)

357 raw `<i className="codicon …">` in source; 5 of 171 live ones are hidden. Until these are
hidden, adding `aria-label` still works but every un-migrated `title` stays invisible, and no
exact-name match is reliable.

**Do it once, structurally.** There is no shared icon component today — that is why the attribute
is missing in 350+ places, and why a one-time sweep would rot immediately. Introduce a primitive:

```tsx
// components/shared/Icon.tsx
export const Icon: React.FC<{ name: string; className?: string }> = ({
  name,
  className = "",
}) => (
  <i className={`codicon codicon-${name} ${className}`} aria-hidden="true" />
);
```

Then codemod the raw `<i className="codicon codicon-x" />` usages onto it. This matches the
project's DRY/single-source principle and makes the guarantee enforceable rather than a
sweep-and-hope. Icons that are _not_ decorative — the rare case where the icon is the only
content and carries meaning — keep an `aria-label` on the **parent control**, never on the icon.

**Highest-leverage single files** (each fixes many live controls at once):

- `components/shared/SegmentedTabBar.tsx` — the sole source of all 14 `.fp-tab-hc` pseudo-tabs
  (`DrawerTabBar` delegates to it). Its badge `<i>` is already `aria-hidden`; the main tab icon
  is not.
- `components/editor/FooterQuickPicker.tsx` — the shared trigger shell behind the Model/Agent/
  Skills/Permissions/Context override buttons that render as `button ""`. Its props already
  document a "Accessible label for the trigger button", but the component only spreads it to
  `title=` (`:122`). Adding `aria-label` there fixes the whole footer rail in one edit.

---

## Phase 2 — Name every control

**Rule: add `aria-label`; keep `title`.** Do not swap one for the other. 117 existing
`*ByTitle` queries depend on the `title` attribute, and `title` is still the hover tooltip users
rely on. Adding `aria-label` alongside is non-breaking in both directions.

**Rule: `aria-label` names the control; `title` may explain transient state.** The Run button
currently reads `title="Read-only — workflow is running via another ctrlyoke window"`, so after
Phase 1 its accessible name becomes a status message that changes as the workflow does. A control
named "Run" must stay named "Run" whether it is enabled or not; put the "why disabled" text in
`title` (or better, `aria-describedby`) and the identity in `aria-label`.

**Priority targets** (all confirmed unnamed or misnamed in the live tree):

- `components/editor/EditorFooter.tsx` — `.btn-editor-run` (`:275`), `.btn-editor-queue`
  (`:261`), `.btn-properties` (`:108`). These are the primary actions of the whole dashboard.
- `components/editor/FooterQuickPicker.tsx` (`:117-146`) — see Phase 1.
- `components/editor/CodeMirrorEditor.tsx` — the prompt editor is `role="textbox"` with no name.
  Add one via the existing `EditorView.contentAttributes.of({ … })` block (`:1540`), alongside
  `autocorrect`/`autocapitalize`. This is the single most important input in the app and today
  `getByRole('textbox')` cannot disambiguate it.
- `AgentQuickPicker`, `ModelQuickPicker`, `SkillsQuickPicker`, `PermissionsQuickPicker`,
  `ContextQuickPicker`, `ExecutionModeQuickPicker`, `StepColorQuickPicker` — inherit the fix from
  `FooterQuickPicker` where they use it; audit the ones that roll their own trigger.
- `components/workspace-viewer/WorkspaceViewerHeader.tsx` — close button already has
  `aria-label`. Good pattern; copy it.

---

## Phase 3 — Make names unique (Playwright strict mode)

A duplicated name is not a cosmetic issue: `getByRole('button', { name: 'Add to favorites' })`
**throws** rather than picking one, so an agent cannot act at all. 31 × `Remove from history` and
26 × `Add to favorites` are the worst offenders.

Two acceptable fixes, in order of preference:

1. **Scope, don't rename.** Put the repeated control inside a container with a unique accessible
   name — an `option`/`listitem` named for its row, or a `group`/`region` — so
   `getByRole('listitem', { name: /My Workflow/ }).getByRole('button', { name: 'Add to favorites' })`
   resolves. This is what `composeRowAccessibleName` already does for workflow rows
   (see `webview-react-components.instructions.md`); extend the same idea to the row's action rail.
2. **Qualify the name** where there is no natural container: `aria-label={`Add ${name} to favorites`}`.

The `Harness`/`Context`/`Validation`/`MCP`/`Hooks`/`Permissions` ×2 duplication is a different
shape — two tab bars (properties drawer and workflow-properties panel) are mounted at once. Give
each `tablist` an `aria-label` ("Prompt properties" / "Workflow properties") so the tabs are
distinguishable by container rather than renaming them.

---

## Phase 4 — Real semantics for custom widgets

Custom widgets built from `<button>` + CSS classes are invisible as widgets. Selection state
carried only by a class name cannot be asserted by any test or read by any user.

- **`components/shared/SegmentedTabBar.tsx`** — 14 live pseudo-tabs, all `role: null`,
  `aria-selected: null`, none inside a `tablist`; the active tab is marked _only_ by the
  `fp-tab-hc-selected` class. Add `role="tablist"` on the container and `role="tab"` +
  `aria-selected={isActive}` on each button. One file, and it fixes both drawers plus
  `OutputSectionHeader`. `WorkspaceViewerHeader.tsx` (`:81-102`) already does exactly this — copy
  that pattern.
- **Dropdown triggers (`.fp-select-trigger`)** — mostly good: `aria-haspopup="listbox"` and
  `aria-expanded` are present. Gaps: no `aria-controls` linking the trigger to its listbox, and
  `SkillsSelect` is missing `aria-haspopup`/`aria-expanded` entirely. More importantly several
  triggers are named by their _current value_ ("Inherit (None)" ×3, "None" ×2) rather than by
  what they select, which is both unstable and duplicated — give each an `aria-label` naming the
  field, and let the value stay as the visible text.
- **Nested interactive elements** — `Reset all to defaults` is rendered _inside_ the
  `Collapse workflow properties` button. That is invalid HTML, and both the inner and outer
  control become unreliable targets. Make them siblings.
- **Toggle buttons** — `EditorSection.tsx` (Prompt/Script mode) and `GlobalSettingsDrawer.tsx`
  (User/Workspace scope) have `role="group"` but no `aria-pressed`. Add `aria-pressed={isActive}`,
  or promote to the tablist pattern above where they are really tabs.

---

## Phase 5 — Keyboard parity for `role="button"` divs

17 elements carry `role="button"` on a `<div>`/`<span>`. A real `<button>` responds to both Enter
and Space; these must replicate that or assistive-tech users cannot activate them.

**Affected:** `App.tsx:690`, `layout/EditorSection.tsx:202,306`,
`layout/output-section/OutputSectionHeader.tsx:105`, `layout/OutputSection.tsx:1527`,
`prompts/FinalStepFooter.tsx:113,185`, `prompts/PromptChipRail.tsx:113,217,479`,
`prompts/WorkflowStep.tsx:234`, `settings/AgentSkillsManagerSection.tsx:785,843`,
`settings/McpManagerSection.tsx:1515,1576`, `shared/PanelBar.tsx:29,45`.

```tsx
// Before
if (e.key === "Enter") handleToggle();

// After
if (e.key === "Enter" || e.key === " ") {
  e.preventDefault();
  handleToggle();
}
```

Prefer converting to a real `<button>` with `appearance: none` where practical — it gets Enter,
Space, focus, and `disabled` handling for free. **Exception:** do not convert list rows that
contain sibling action buttons; `webview-react-components.instructions.md` documents why nested
real buttons inside a focusable row cause sticky mobile-Safari layout drift there.

---

## Phase 6 — Landmark regions

The live page exposes a `<header>` and two **unlabelled** `<section>` elements — and an unlabelled
`<section>` is not exposed as a `region` landmark at all, so it contributes nothing to navigation
or to snapshot scoping. There is no `<main>` and no `<nav>`.

- `OutputSection.tsx` — the main `<section>` has an `id` but no label; add `aria-label="Output"`.
- `PropertiesDrawer.tsx` — add `role="region"` + `aria-labelledby` pointing at its existing `<h3>`.
- Modal/dialog wrappers — confirm `role="dialog"` + an accessible name. `shared/Modal.tsx:105`
  already sets `role="dialog"`; verify every instance passes a name.

Labelled landmarks pay off twice: they give screen-reader users structure, and they give the
Playwright agent containers to scope duplicate names against (Phase 3).

---

## Phase 7 — `data-testid` for display-only dynamic values

Deliberately last, and deliberately narrow. A testid is **invisible to `browser_snapshot`**, so it
buys nothing for agent-driven testing — it is purely a Vitest convenience for elements that have
no semantic role and whose text is composite or dynamic.

Only 10 exist today (`workspace-name`, `parallel-group-status`, `workflow-token-usage`,
`generate-commit-message-btn`, `commit-*`, `file-browser-*`). Candidates worth adding:

- `EditorSection.tsx` — mode text like `"Editing: ${promptName}"`
- `Header.tsx` — execution state badge, pause-pending banner
- `OutputSection.tsx` — history run ID banner (`"Run {runId}"`)
- `SkillsQuickPicker.tsx` — inherited skills label (`"Inherit (${skills})"`)

Prefer `role="status"` over a testid where the element genuinely announces changing state — that
serves all three audiences instead of one. `HeaderStatusBanner.tsx` already uses `role="status"`
correctly.

**Naming convention:** kebab-case, describing the _content role_ rather than the component —
`workspace-name`, `execution-state-badge`, `pause-pending-banner`. Note
`generate-commit-message-btn` violates this (it names a button, which should use role + name
instead); don't copy it.

---

## Guardrails

`eslint-plugin-jsx-a11y` is already installed and wired in `eslint.config.mjs:120-165`, with the
recommended set mapped to `warn`. **It cannot catch the central defect**: to ESLint's static view,
`<button title="…"><i className="codicon" /></button>` has children and looks labeled, so
`control-has-associated-label` stays quiet. The glyph only exists at CSS runtime.

So add two things:

1. **A lint rule that encodes the icon convention.** Once `components/shared/Icon.tsx` exists,
   forbid raw `codicon` `<i>` elements (`no-restricted-syntax` on a JSX `<i>` whose `className`
   contains `codicon`) so the guarantee cannot regress. Consider promoting the jsx-a11y rules
   this plan actually satisfies from `warn` to `error` as each phase lands.
2. **A browser-based smoke check**, because Vitest structurally cannot cover this. Playwright is
   _not_ a repo dependency today (no `playwright.config`, no `.spec.ts`; `.playwright-mcp/` is
   gitignored agent scratch), and this plan does not require making it one. The cheap version is
   the assertion below, run against a dev host from an agent session and recorded in the
   Verification recipe; the durable version is a small `browser_evaluate` snippet checked into
   `scripts/` that fails when the unnamed-control count rises above an agreed baseline.

---

## Verification recipe

Reproducing the ground-truth numbers takes about a minute and should be redone after each phase:

1. `npm run dev:host:start` (or `:shared`) — see
   `dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md`.
2. Read the URL+token from `.ctrlyoke/dev/server-url.txt` and navigate Playwright to it.
3. `browser_snapshot` and scan for `button ""`, bare `generic` where a control should be, and
   repeated names.
4. Run the counter:

```js
// Unnamed and duplicate-named visible controls — the two numbers this plan drives to zero.
() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const els = [
    ...document.querySelectorAll(
      'button,[role="button"],a[href],input,select,textarea'
    ),
  ].filter(vis);
  const glyphOnly = els.filter((el) => {
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))
      return false;
    return ![...(el.textContent || "")].some(
      (c) => c.codePointAt(0) < 0xe000 && !/\s/.test(c)
    );
  });
  const icons = [...document.querySelectorAll("i.codicon")];
  return {
    unnamed: glyphOnly.length,
    codiconsUnhidden:
      icons.length -
      icons.filter((i) => i.getAttribute("aria-hidden") === "true").length,
  };
};
```

Baseline on 2026-09-07: `{ unnamed: 21, codiconsUnhidden: 166 }`. Target: `{ 0, 0 }`.

Note the dev host writes `server-url.txt` in the _workspace it opened_, and whichever instance
started most recently wins the file — check the path matches the checkout you meant to test.

---

## Test updates

Current suite composition (`src/ui/webview-react/test/**`):

| Query style     | Occurrences | Verdict                                         |
| --------------- | ----------- | ----------------------------------------------- |
| `*ByRole(`      | 928         | ✅ already the majority — the suite is healthy  |
| `*ByText(`      | 611         | Mixed — fine for prose, fragile on controls     |
| `querySelector` | 345         | ❌ CSS-class coupling                           |
| `*ByTitle(`     | 117         | ⚠️ works today; keep working by keeping `title` |

This is a **convention-and-guardrail problem, not a 30-line cleanup** — the earlier draft of this
plan listed specific line numbers, all of which have since drifted (and one cited file,
`CliOutput.test.tsx`, no longer exists). Migrate opportunistically by pattern, not by line:

- **`getByText` on a control** → `getByRole('button', { name: … })`. Heaviest:
  `DryRunModal.test.tsx` (45), `WorkflowStatus.test.tsx` (38), `FileBrowserModal.test.tsx` (36),
  `BashOutput.test.tsx` (25), `ToolCallOutput.test.tsx` (22).
- **`querySelector` on a CSS class** → a role query, or `getByTestId` for display-only nodes.
  Heaviest: `WorkflowStatus.test.tsx` (36), `OutputRow.test.tsx` (29), `MarkdownText.test.tsx`
  (20), `PromptEditor.test.tsx` (12).
- **`*ByTitle`** → `getByRole(…, { name })` _after_ the element gains an `aria-label`. Heaviest:
  `WorkflowPropertiesPanel.test.tsx` (23), `DryRunModal.test.tsx` (18),
  `WorkflowStatus.test.tsx` (11), `SegmentedTabBar.test.tsx` (8).
- **`SegmentedTabBar.test.tsx`** should switch to `getByRole('tab', { name })` /
  `toHaveAttribute('aria-selected')` as part of Phase 4 — it currently asserts selection through
  class names, which is exactly the coupling that phase removes.

### Already correct — patterns to copy

- `Button.test.tsx`, `FileOperationOutput.test.tsx`, `WorkspaceCommitArea.test.tsx` —
  `getByRole('button', { name: … })` throughout
- `WorkspaceViewerModal.test.tsx` — `getByRole('tab', { name: /…/ })` plus `getByTestId` for
  display values
- `ScriptConditionEditor.test.tsx` — `getByLabelText('Retry Prompt')`
- `WorkflowFilePickerModal.test.tsx` — `getByPlaceholderText` + role queries

---

## What NOT to do

- **Don't swap `title` for `aria-label`.** Add the label; keep the title. 117 tests and every
  hover tooltip depend on `title` staying put.
- **Don't rely on `npm run test:ui` to prove a control is reachable.** jsdom cannot see the defect
  (see Root cause). Verify in a browser.
- **Don't reach for `data-testid` on anything interactive.** It is invisible to
  `browser_snapshot`, so it helps exactly one of three audiences. Use role + name.
- **Don't use `id` attributes for testing.** IDs are for CSS, `htmlFor`, and anchors; they pollute
  the page identifier namespace.
- **Don't warp DOM structure** (extra wrapper spans/divs) to make a string independently
  queryable — put `data-testid` on the existing element instead.
- **Don't add `aria-label` to a decorative icon.** Hide it and name the parent control; a labelled
  icon inside a labelled button produces a doubled announcement.

---

## Success criteria

Measured with the Verification recipe against a live dev host, not with the unit suite:

- `unnamed: 0` — every visible interactive element has a non-empty accessible name
- `codiconsUnhidden: 0` — every decorative codicon is `aria-hidden`, via the shared `Icon`
  component rather than 357 hand-written attributes
- No duplicate accessible name among visible controls that isn't scoped inside a uniquely named
  `group`/`region`/`listitem`/`dialog`
- Tab bars expose `tablist`/`tab`/`aria-selected`; toggles expose `aria-pressed`; dropdown
  triggers expose `aria-haspopup`/`aria-expanded` and are named by their field, not their value
- The prompt editor `textbox` has a stable accessible name
- All `role="button"` divs handle Space
- Major panels/drawers are labelled landmarks
- A lint rule prevents new raw `codicon` `<i>` elements from reappearing
