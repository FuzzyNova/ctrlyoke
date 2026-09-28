# Settings Search Plan

**Status: ready to implement.** Revised 2026-09-28 against the code as it stands
after `dev/implemented/SCHEMA_UI_NAME_ALIGNMENT_PLAN.md` landed.

## Progress

Phase 1 is complete. Phase 1A added the shared tab list, typed settings
catalog/search, row `settingKey` support, search unit coverage, and catalog-backed
copy for the first sections. Phase 1B migrated every remaining settings row,
added the six bespoke-editor landmarks, and added catalog drift guards for
schema paths, key validity, source coverage, and section row ordering. The
terminal shell row needs three catalog IDs for one setting path because its
visible label changes by platform. Runtime-only descriptions for profiler
threshold, multi-root paths, diagnostics, and inject mode remain overrides so
their displayed text stays byte-identical. The named and managed worktree modes
also use different help text for the same base/setup paths, so both descriptions
are held in the catalog and selected by mode.

The integration schema parity scan now excludes `settingsCatalog.ts`, ensuring
it proves that section source carries each real setting path through
`settingKey`. `statusLine.byHarness.*` was added to `DYNAMIC_TEMPLATE_PARENTS`;
after excluding the catalog, the per-harness rows expose that family through
template keys just like the other map-valued settings. Search UI and navigation
remain for Phases 2 and 3.

## Goal

Make the global settings drawer searchable by plain string query. The drawer
has 18 tabs (`ALL_TABS` in `GlobalSettingsDrawer.tsx`) and roughly 125
`SettingInputRow`/`SettingToggleRow` controls, plus bespoke editors. Today the
only way to find a setting is to remember which tab it lives on. A user who knows
the word "worktree" or "toast" has no path to the control.

v1 scope: **case-insensitive substring search over each setting's visible label,
visible hint text, dotted path, and a small keyword list.** Fuzzy matching, value
search and settings-file grep are out of scope. Value search in particular stays
out: it would need `fullSettings` loaded, and it changes what a match count
means.

## UX

The model is the output pane's find bar (`OutputFindBar` + `useOutputFind`):
a toggle button opens a find row, `Enter` walks the matches, and `Escape` closes
the row. Two things differ from the output find. Matches can live on tabs that
aren't mounted, so cycling switches tabs. There is also no case-sensitivity toggle.

### Header toggle

- Add a search toggle to the title bar's right-hand group, before "Open settings
  file". Use the existing `IconToggleButton` (`components/shared/IconToggleButton.tsx`)
  with `activeIcon = inactiveIcon = "search"`. Its active state already renders
  `text-widget-highlight-fg`, which is the same highlight the output pane's find
  toggle uses (`OutputSectionHeader.tsx`), and it sets `aria-pressed`.
  Tooltip: "Search settings (Ctrl+F)" / "Close search".
- The search row is **not rendered** while the toggle is off. There is no
  persistent input and no reserved space.

### Search row

A ~34px row between the title bar and the tab bar/content split. It is its own
row, not part of the 30px title bar, because the title bar already holds the
scope toggle, which collapses to icons at 580px.

```
[🔍 Search settings________________]  3 of 12  [↑] [↓]  [×]
```

- The input reuses the `OutputFindBar` chrome: `h-7 rounded border
border-input-border bg-input-bg px-2 text-sm text-input-fg outline-none
focus:border-focus-border`. Placeholder and aria-label: "Search settings".
  The row uses `role="search"`.
- Counter: `3 of 12`, or `3/12` when the drawer is narrow (the drawer already
  has `useElementNarrow(580)`). Show `0` for no matches, and nothing for an
  empty query.
- ↑ / ↓ buttons ("Previous match" / "Next match") and an `ExitButton` ("Close
  search"), matching `OutputFindBar`.
- Opening the row focuses the input and selects its text. Closing the row clears
  the query and returns focus to the header toggle.
- The row does not animate in v1. `animate-output-find-*` is built for a
  floating overlay, not an in-flow row.

### Tab bar badges

- `GlobalSettingsVerticalTabBar`'s `Tab` gains `matchCount?: number` (undefined
  when no query is active).
- In wide mode the tab shows a right-aligned count pill. In icon-only mode it
  shows a count bubble at the icon's top-right, which takes priority over the
  server `indicator` dot.
- While a query is active, tabs with zero matches dim to `opacity-40` but stay
  clickable. The badge also goes into the tab's `aria-label`
  ("Queue, 2 matches").
- `DrawerTabBar` (the Workflow Defaults sub-page bar) gets the same per-page
  counts. `SegmentedTabBar` needs a `matchCount` slot, next to the existing
  `tabOverrides`.

### In-place highlighting

- Matching rows get a subtle tint. The **active** match also gets a
  `focus-border` outline, like the active match in the output find.
- Tokens that match in the row's visible label or hint text are wrapped in `<mark>`
  by `HighlightedText`. A match that comes only from the path or a keyword
  tints the row without marking any text.
- **Non-matching rows are not dimmed.** (This changes the earlier plan.) Only
  rows can dim, so the section headings, prose, cards and bespoke editors around
  them would stay at full opacity, and the page would look randomly faded. Tint
  plus the active outline is enough, and it is how find-in-page already behaves.

### Rejected designs (unchanged reasoning)

- **Unified search-results page.** It would need every section split into rows
  that can render on their own with their own `settings`/`onUpdate`/scope
  context, and several tabs (`McpManagerSection`, `AgentSkillsManagerSection`,
  `LicenseSection`, `StatusLineFormatEditor`, `ModelPricingEditor`, …) have no
  rows to project. In-place results also keep each control next to the copy
  that explains it.
- **Filter mode** (hiding non-matching rows). It leaves section headings with
  nothing under them, breaks the grid/card layouts, and bespoke editors either
  vanish or stay put, and both are wrong.

## The Catalog

Only the active tab is mounted, so a scheme where rows register when they mount
can never give a badge count for an unopened tab. The index has to be static.

### Correction to the earlier draft

The earlier draft said to resolve row labels from `SCHEMA_FIELD_META` plus "the
shared path humanizer", and descriptions from `SCHEMA_DESCRIPTIONS`. Neither
fits the current code:

- `SCHEMA_FIELD_META` (`src/types/SchemaUiMetadata.ts`) has two entries, both
  workflow fields (`color`, `failFast`). No path humanizer exists. Every settings
  row label is still a literal at the call site (`label="Max steps"`), and some
  are repeated in the same file for the inner control (`LimitSelect
label="Max steps"` in `QueueSection.tsx`). §5 of the alignment plan marks the
  merge "handled", but it wasn't done.
- Visible hint text (`description="…"`, on ~83 rows) is short, hand-written UI
  copy, not schema text. Compare `ui.showCliCommand`: the row says "Show the CLI
  command used to start the AI harness."; the schema says "Show the CLI command
  being executed." `SCHEMA_DESCRIPTIONS` already feeds the row tooltip through
  `schemaTitle(path)`.

### Decision: the catalog owns the row copy

**`src/ui/webview-react/components/settings/settingsCatalog.ts` becomes the
single home for each settings row's label and hint text.** Rows read that copy
through a `settingKey` prop, so the text that renders and the text that gets
searched are the same string by construction. Strings are **moved** into the
catalog in the same change that creates it, not copied. The earlier draft's
"catalogue with copied labels first, dedupe in phase 4" would have left ~200
strings duplicated between phases, which is exactly the drift the project rules
forbid.

`SCHEMA_DESCRIPTIONS` is **not** part of the search haystack. It is long prose,
AND-ed tokens would match broadly across it (almost every entry mentions
"workflow", "step" or "harness"), and the text isn't visible in the row, so the
tint would look unexplained. `keywords` cover synonyms.

### Shape

```ts
export interface SettingsCatalogEntry {
  /** Settings dot-path for real settings; `landmark:<tab>:<slug>` otherwise. */
  id: string;
  /** Present for schema-backed rows; drives sources/reset/tooltip. */
  path?: string;
  tab: GlobalSettingsTab;
  /** Required iff tab === GLOBAL_SETTINGS_TABS.WORKFLOW. */
  page?: DrawerPage;
  /** Rendered row label — the only copy. */
  label: string;
  /** Rendered hint text under the control — the only copy. */
  description?: string;
  /** Heading words the label leans on (alignment-plan §1 rule 1). Searched,
   *  not rendered. E.g. "Codex" for "Sandbox mode", "Claude Code" for a
   *  per-harness "Model" row. */
  context?: string;
  /** Synonyms the label/description/context don't contain. */
  keywords?: readonly string[];
  /** Path of the row whose value reveals this one, for conditionally
   *  rendered rows (TLS fields behind `server.tls.enabled`, per-harness
   *  status-line formats behind `useDifferentFormatPerHarness`, …). */
  revealedBy?: string;
  devOnly?: boolean;
}
```

- Declare it `as const satisfies Record<string, SettingsCatalogEntry>`, keyed by
  `id`, and export `type SettingsCatalogKey = keyof typeof SETTINGS_CATALOG`.
  An unknown `settingKey` then fails `tsc`, so no dev-mode runtime warning is
  needed.
- **Entries are authored in render order** within each tab/page. This order is
  the find-next order.
- **Map-valued families** (`defaults.models.<h>`, `defaults.additionalArgs.<h>`,
  `ui.harnessColors.byHarness.<h>`, `statusLine.byHarness.<h>.*`,
  `notifications.events.hookEvents.<event>`) are produced by small typed
  builders over `HARNESS_IDS` / `STATUS_LINE_HARNESS_IDS` / `HOOK_EVENT_NAMES`.
  Their key types are template literals (`` `defaults.models.${HarnessId}` ``).
  Each generated entry takes its `context` from `HARNESS_INFO` /
  `HOOK_EVENT_OPTIONS_META`, so "claude model" finds the Claude Code model row.
- Export `settingLabel(key)` for inner controls that need the same label
  (`LimitSelect label=…`, ARIA on custom inputs).
- **Tab and page labels move out of the drawer.** `ALL_TABS` (id, label, icon)
  moves from `GlobalSettingsDrawer.tsx` to
  `components/settings/settingsTabs.ts`, adding `devOnly: true` on Developer.
  The drawer, the tab bar and the search haystack all read it. Page labels come
  from `DRAWER_TABS` (`types/drawerPages.ts`).

### Rows consume the catalog

`SettingInputRow` and `SettingToggleRow` gain `settingKey?: SettingsCatalogKey`.
When it is set, the row takes `path`, `label` and `description` from the entry.
The explicit `label`/`description`/`path` props remain for uses outside the
drawer (`NumberField`, `SecretGrantsEditor`, `SaveWorkflowDialog`).

```tsx
<SettingInputRow settingKey="queue.maxSteps" id="queue-max-steps" {...rowProps}>
  <LimitSelect
    id="queue-max-steps"
    label={settingLabel("queue.maxSteps")}
    path="queue.maxSteps"
    value={queue.maxSteps}
    onChange={(v) => onUpdate("queue.maxSteps", v)}
    customFallback={100}
  />
</SettingInputRow>
```

Pathless UI-only rows (the Developer section's toggles) get pathless catalog
entries too, so **every** row under `components/settings/**` uses `settingKey`.
That makes the enforcement rule a single rule with no exceptions (see Tests).

### Landmarks

Tabs that are not lists of rows still need to be reachable. Each gets a few
pathless entries (`label` + `keywords`) that count toward the badge. Navigating to
one switches to the tab and scrolls to its anchor. The section marks that anchor
with `data-settings-search-id="<landmark id>"` on the relevant heading, or the
view scrolls to the top when no anchor exists.

| Tab            | Landmarks                                                 |
| -------------- | --------------------------------------------------------- |
| MCP Manager    | "MCP server", "stdio", "http transport", "server catalog" |
| Agent & Skills | "agent", "skill", "subagent"                              |
| License        | "license key", "activation", "pro", "subscription"        |
| Stats & Usage  | "token usage", "cost", "spend", "model pricing"           |
| Secrets        | "secret", "API key", "environment variable grant"         |
| Status Line    | "status line format", "segment"                           |

Stats & Usage, Secrets and Status Line also have real rows, which are catalogued
normally. Their landmarks cover only the bespoke editors (`ModelPricingEditor`,
`SecretGrantsEditor` list, `StatusLineFormatEditor`).

### Placement notes

Nested sections are catalogued under the tab/page that mounts them, because
none of them is in `ALL_TABS`:

| Section                      | Mounted by            | Catalogued as          |
| ---------------------------- | --------------------- | ---------------------- |
| `HarnessesSection`           | `DefaultsHarnessPage` | `workflow` + `harness` |
| `RunHistorySection`          | `GeneralSection`      | `general`              |
| `StatusLineTrackingControls` | `StatusLineSection`   | `statusline`           |

## Search

A pure function with no store dependency, so it can be unit-tested on its own.
It lives in `components/settings/settingsSearch.ts`:

```ts
searchSettingsCatalog(query: string, opts: { devEnabled: boolean }): SettingsSearchResult

interface SettingsSearchResult {
  tokens: readonly string[];             // normalized, for HighlightedText
  matches: readonly SettingsCatalogEntry[]; // ordered, see below
  matchIds: ReadonlySet<string>;
  countsByTab: ReadonlyMap<GlobalSettingsTab, number>;
  countsByPage: ReadonlyMap<DrawerPage, number>;
}
```

- Normalize the query and the haystack the same way: lowercase, and collapse
  punctuation (`.`, `-`, `_`, `/`) to spaces. `queue.maxSteps` then becomes
  `queue maxsteps`, and a query of "max steps" still matches it through the
  label.
- Haystack per entry: `label + description + context + path + keywords + tab
label + page label`.
- Split the query on whitespace. **All** tokens must appear as substrings (AND).
  There is no fuzzy matching and no ranking.
- Skip `devOnly` entries when `dev.enabled` is false, or the badges will promise
  settings the user cannot reach.
- Match order: `settingsTabs` order, then `DRAWER_TABS` page order, then catalog
  order. A find-next control needs a stable position, and ranking by relevance
  would break that.
- An empty or whitespace-only query returns no tokens and no matches, which means
  "search inactive".

The catalog is static, so counts are correct before `fullSettings` arrives
(`settingsStore.fullGlobalSettings` is null until the drawer's own load request
returns).

## Wiring

### `useSettingsSearch` hook (mirrors `useOutputFind`)

`hooks/useSettingsSearch.ts` owns `{ isOpen, query, activeMatchId }` as
component state inside `GlobalSettingsDrawer`. It derives the result with
`useMemo(() => searchSettingsCatalog(query, { devEnabled }), [query, devEnabled])`
and exposes `open`, `close`, `toggle`, `setQuery`, `navigate(±1)` and
`handleKeyDown`.

**None of this goes in `uiStore`.** It is transient drawer state that must not
survive reopening. Local state keeps it off the persist list and away from the
`ctrlyoke/stable-store-selector` rule. The drawer resets it (`close()`) whenever
`globalSettingsOpen` goes false. `GlobalSettingsDrawer` itself stays mounted
while hidden, so unmounting does not reset it.

### `SettingsSearchContext`

The drawer provides `{ tokens, matchIds, activeMatchId }` through a small React
context (`components/settings/SettingsSearchContext.ts`).
`useSettingMatch(settingKey)` returns `{ isMatch, isActive, tokens }`.
The default context value is inactive, so rows rendered outside the drawer
(`SaveWorkflowDialog`, `NumberField`) never highlight and don't need to be
guarded. This context replaces the earlier plan's store fields.

### Lifted sub-page

`WorkflowDefaultsSection` currently holds `activePage` in local `useState`, so a
cross-tab jump to a Workflow Defaults sub-page cannot reach it. Make it
controlled: the drawer owns `activePage` (plain `useState<DrawerPage>`, not
persisted, initial `DRAWER_PAGES.HARNESS`) and passes `activePage` /
`onPageChange` down. As a side effect, the sub-page now survives switching away
from the Workflow Defaults tab and back within one drawer session.

### Components

- **`SettingsSearchBar`** (new, `components/layout/`): the row described above,
  driven by the hook's state and callbacks, in the same shape as
  `OutputFindBarProps`.
- **`HighlightedText`** (new, `components/shared/`): takes `text` and `tokens`,
  and wraps the matched runs in `<mark>`. Overlapping or adjacent runs merge.
  Only matching rows pass tokens.
- **`SettingInputRow` / `SettingToggleRow`**: `settingKey` support, the
  `useSettingMatch` read, `data-settings-search-id={entry.id}` on the row root,
  tint/outline classes, and `HighlightedText` for label and description.
  `schemaAriaLabel(label, path)` keeps getting the raw label string.
- **`GlobalSettingsVerticalTabBar`**, **`SegmentedTabBar`/`DrawerTabBar`**:
  match counts and dimming, as described above.
- **Empty result**: while the query is non-empty and has no matches, show
  "No settings match “_query_”" above the section content. The section is not
  blanked.

## Navigation and keys

### Cycling

- `navigate(±1)` moves `activeMatchId` through `result.matches` and wraps at
  both ends. If the target is on another tab, it calls `setGlobalSettingsTab`.
  If it is on another Workflow Defaults page, it also sets `activePage`. Then it
  reveals the target.
- **Reveal**: after the target tab/page has committed, and after `fullSettings`
  is loaded (the effect depends on `[activeMatchId, effectiveActiveTab,
activePage, fullSettings]`), look up
  `[data-settings-search-id="<id>"]` inside the drawer and call
  `scrollIntoView({ block: "nearest" })` in a `requestAnimationFrame`. If the
  element is absent (a conditional row), fall back to `revealedBy`'s element,
  then to the top of the content scroller. This works for
  `WorkflowDefaultsSection`'s own inner scroller as well.
- Focus stays in the search input across tab switches. Repeated `Enter` must keep
  working.

### Choosing the active match as you type

On every query change:

1. If the current `activeMatchId` still matches, keep it.
2. Else, if the current tab (and, on Workflow Defaults, the current page) has
   matches, use its first match. **The tab never switches away from a tab that
   still has matches.**
3. Else, jump to the first match after the current tab in tab order, wrapping.
   This switches tabs, the same way browser find jumps as you type.
4. With no matches, stay put and clear `activeMatchId`.

This replaces the earlier "auto-switch once per query transition" rule with a
concrete one that yields the same behaviour.

### Keys

| Key                        | Where                             | Action                                                                                                                                                                                    |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter` / `F3`             | search input                      | Next match                                                                                                                                                                                |
| `Shift+Enter` / `Shift+F3` | search input                      | Previous match                                                                                                                                                                            |
| `Escape`                   | search input                      | Close the search row (clears the query, focus returns to the toggle). `preventDefault()` + `stopPropagation()` so the drawer's handler doesn't also close the drawer                      |
| `Escape`                   | elsewhere in the drawer           | If the search row is open, close it. Otherwise close the drawer (current behaviour). The drawer handler ignores `defaultPrevented` events so dropdowns that consume `Escape` keep working |
| `Ctrl+F` / `Cmd+F`         | anywhere while the drawer is open | Open the search row, or focus and select the input if it is already open. Skipped while focus is inside `.cm-editor`, matching the output-pane rule                                       |

**`Ctrl+F` conflict (must fix).** `OutputSection.tsx` registers a
window-level **capture** `keydown` handler for `Ctrl/Cmd+F` that calls
`stopImmediatePropagation()` and opens the output find bar. That listener
registers when `OutputSection` mounts, which is earlier than any drawer listener,
so the drawer would never see the key. The output pane is also behind the
drawer. Fix: the `OutputSection` handler returns early when
`useUiStore.getState().globalSettingsOpen` is true. The drawer then registers its
own window-capture handler while open. Use one shared predicate
(`isFindShortcut(event)`) for both handlers instead of copying the modifier
check.

`Ctrl+F` in the hosted browser client is confirmed acceptable: the drawer is a
focused overlay, and shadowing the browser's own find there is intended.

Update `dev/reference/KEYBOARD_SHORTCUTS.md`'s inventory. `Ctrl+F` routes to the
drawer while it is open, and the `GlobalSettingsDrawer` `Escape` row becomes the
two cases above.

## Phases

1. **Catalog + migration.** Build `settingsTabs.ts` (moved from the drawer),
   `settingsCatalog.ts`, `settingsSearch.ts`, `settingKey` on both rows, and
   `settingLabel`. Convert every row under `components/settings/**` to
   `settingKey` tab by tab, **deleting** the label and description literals from
   the section files. Add the landmark entries and the catalog/search tests.
   Nothing visible changes yet. The rendered text must be byte-identical
   (existing section tests act as the regression net).
2. **Search UI.** Build `useSettingsSearch`, `SettingsSearchContext`, the header
   toggle, `SettingsSearchBar`, `HighlightedText`, row tint/outline, tab-bar and
   sub-page badges, and the empty-result notice.
3. **Navigation.** Add find-next/previous across tabs and pages, the lifted
   `activePage`, reveal and scroll with the `revealedBy` fallback, active-match
   selection while typing, the key table, the `OutputSection` `Ctrl+F` fix, and
   the `KEYBOARD_SHORTCUTS.md` update.

Each phase leaves `npm test` green. Phases 2 and 3 can land together if that is
simpler. The feature is only really usable once cycling works.

## Tests

**Vitest, `test/components/settings/settingsCatalog.test.ts`** (the drift
guard, which is what keeps the badges honest):

1. Every catalog `path` is a key in `SCHEMA_DESCRIPTIONS`. For map-valued
   families (`defaults.models`, `defaults.additionalArgs`,
   `ui.harnessColors.byHarness`), the parent key must exist instead. This
   catches typos and settings that were removed while their entry stayed.
2. Ids are unique. Every `tab` is in `settingsTabs`. `page` is present exactly
   when `tab` is Workflow Defaults. Every `revealedBy` is a catalog path.
3. Scan `components/settings/**` sources with
   `import.meta.glob(..., { query: "?raw", eager: true })`. **Every
   `<SettingInputRow`/`<SettingToggleRow` passes `settingKey`, and none passes
   `label=`/`description=`/`path=`.** Every non-landmark catalog id is
   referenced by some `settingKey` (an orphan entry would produce a match that
   navigates nowhere). Every landmark id appears as a `data-settings-search-id`
   literal, or the landmark is marked as scrolling to the top.
4. Tab placement: for each tab (and each Workflow Defaults page), render the
   section with a full settings fixture, collect `[data-settings-search-id]` in
   DOM order, and assert that (a) each rendered id's catalog entry names this
   tab/page, and (b) the rendered ids follow catalog order. Conditionally hidden
   rows just don't appear, which is fine. This catches a row catalogued under the
   wrong tab, which types and source scans cannot.

**Vitest, `settingsSearch.test.ts`**: normalization (a dotted path, a hyphenated
harness id), AND semantics, `devOnly` exclusion, `context` and `keyword` hits,
per-tab and per-page counts, match ordering, and an empty query.

**Vitest, `GlobalSettingsDrawer.test.tsx`** (extend):

- The toggle shows and hides the row, `aria-pressed` follows, and closing
  clears the query.
- A query produces badge counts on the right tabs, and a zero-match tab dims.
- `Enter` on the last match of one tab switches to the next tab that has matches.
  A Workflow Defaults match navigates to the tab **and** the sub-page.
- `Shift+Enter` wraps from the first match to the last.
- Typing never leaves a tab that still has matches, and jumps when it has none.
- `Escape` in the input closes the row, not the drawer. A second `Escape`
  closes the drawer.
- `Ctrl+F` opens the row while the drawer is open. With the drawer closed, the
  output find still gets it (extend the `OutputSection` test).
- Reopening the drawer starts with the search closed and empty.

**Row level**: `HighlightedText` marks only the matched runs and merges adjacent
ones. A path-only match tints the row with no `<mark>`. Rows outside a
`SettingsSearchContext` render exactly as before.

**Mocha, `settingsSchemaUiParity.integration.test.ts`**: exclude
`settingsCatalog.ts` from `webviewSource()`. Otherwise every schema path passes
the "has a live dashboard control" check just because the catalog names it. With
the catalog excluded, the check matches on the `settingKey="…"` literal in the
section. Dynamic families keep working unchanged, because the section still
writes the template literal (``settingKey={`defaults.models.${harnessId}`}``)
that the `DYNAMIC_TEMPLATE_PARENTS` prefix search looks for.

## Resolved questions

- **Does the query survive closing the drawer?** No. Closing the drawer (or the
  search row) clears it.
- **Is `Ctrl+F` safe in the hosted browser?** Yes, wire it unconditionally. The
  `OutputSection` handler still has to yield, as described above.
- **Value search?** Out of scope.
- **Search schema descriptions?** No, for the reasons given under "The
  Catalog". Revisit only if users report missing hits that keywords can't
  cover.
