# Settings Search Plan

## Goal

Make the global settings drawer searchable by plain string query. The drawer now
carries 18 tabs and roughly 180 individual controls (~140 of them rendered
through `SettingInputRow`/`SettingToggleRow`, the rest inside bespoke editors),
and the only way to find a setting is to remember which tab it lives on. A user
who knows the word "worktree" or "toast" has no path to the control.

Scope for v1 is deliberately narrow: **substring search over setting labels,
descriptions, dotted paths, and a small keyword list — no fuzzy matching, no
value search, no settings-file grep.**

## UX Position

The instinct to badge the vertical tab bar with per-tab match counts and
highlight matches in place is the right one, and this plan adopts it. The
reasoning is worth writing down because the obvious alternative looks more
"normal" and is much worse here.

### Rejected: a unified search-results page

The conventional design — type a query, replace the content pane with a flat
list of matching settings drawn from every tab — requires every section to be
decomposable into individually renderable rows that carry their own
`settings`/`onUpdate`/`onReset`/scope context. Today a section is one function
that reads `settings.settings.queue` once and renders a hand-laid-out block.
Several tabs are not row lists at all: `McpManagerSection`,
`AgentSkillsManagerSection`, `LicenseSection`, `StatsUsageSection`,
`StatusLineFormatEditor`, `PermissionListEditor`, `ModelPricingEditor`. Those
have no meaningful "row" to project. Rebuilding all of it to support search is a
large refactor whose payoff is a page that still can't show a third of the
settings surface.

In-place highlighting also keeps each control next to the surrounding copy and
sibling controls that explain it, which a flat list destroys.

### Rejected (for v1): filter mode

Hiding non-matching rows sounds tidier than dimming them, but it strands section
headings with no children, breaks the grid/card layouts in `DefaultsHarnessPage`
and `StatsUsageSection`, and makes every un-indexed bespoke editor either vanish
(wrong — it may be exactly what the user wants) or linger conspicuously (also
wrong). Revisit behind a toggle once the catalog covers the bespoke editors.

### Accepted: badge + highlight-in-place

- A persistent search input directly under the drawer title bar.
- Per-tab match-count badges in `GlobalSettingsVerticalTabBar`; zero-match tabs
  dim but stay clickable.
- Inside a tab, matching rows get a highlighted label/description and a subtle
  row tint; non-matching rows dim to ~45% opacity. Nothing moves.
- `Enter`/`Shift+Enter` walk matches across tabs, switching tabs as needed.

No layout changes, no section refactors.

## The Catalog

The hard part of this feature is not the search box, it is knowing what exists
without mounting every tab. Only the active tab is rendered, so a
register-on-mount scheme can never produce a badge count for an unopened tab.
The index has to be static.

### Shape

Add `src/ui/webview-react/components/settings/settingsCatalog.ts`:

```ts
export interface SettingsCatalogEntry {
  /** Stable id. Equals `path` for real settings; synthetic for landmarks. */
  id: string;
  /** Dotted settings path. Absent for landmark entries. */
  path?: string;
  tab: GlobalSettingsTab;
  /** Sub-page, for the six Workflow Defaults pages. */
  page?: DrawerPage;
  /** Display copy for pathless landmarks only. */
  landmarkLabel?: string;
  landmarkDescription?: string;
  /** Synonyms the label/description don't contain. */
  keywords?: readonly string[];
  devOnly?: boolean;
}
```

Do not store schema-backed labels or descriptions in this catalog. Resolve a
real setting's label from `SchemaUiMetadata` (`SCHEMA_FIELD_META`, with the
shared path humanizer for fields without an explicit alias) and its description
from generated `SCHEMA_DESCRIPTIONS[path]`. Keep explicit `landmarkLabel` and
`landmarkDescription` copy with pathless landmark entries. This makes catalog search
text follow the same label metadata and schema prose as the rendered setting
rows without maintaining another copy.

### Make the catalog the source, not a copy

A parallel table of labels is exactly the "hardcoded string duplication across
files" the project principles forbid, and it will drift on the first PR that
renames a label. Avoid that structurally: give `SettingInputRow` and
`SettingToggleRow` an optional `settingKey` prop that resolves `path`, `label`,
and `description` from the catalog, so the call site becomes

```tsx
<SettingToggleRow
  settingKey="queue.unlimitedMode"
  checked={queue.unlimitedMode}
  onChange={(v) => onUpdate("queue.unlimitedMode", v)}
  {...rowProps}
/>
```

Three props collapse into one, and the rendered text and the indexed text are
the same string by construction. The migration is mechanical and can proceed
tab by tab — both rows keep accepting explicit `label`/`description`/`path`, and
must, because they are also used outside the drawer (`NumberField`,
`SecretGrantsEditor`, `SaveWorkflowDialog`).

### Landmark entries

Tabs that aren't lists of setting rows still need to be reachable. Give each a
handful of `path`-less entries so a query lands somewhere sensible:

| Tab            | Landmarks                                                 |
| -------------- | --------------------------------------------------------- |
| MCP Manager    | "MCP server", "stdio", "http transport", "server catalog" |
| Agent & Skills | "agent", "skill", "subagent"                              |
| License        | "license key", "activation", "pro", "subscription"        |
| Stats & Usage  | "token usage", "cost", "spend", "model pricing"           |
| Secrets        | "secret", "API key", "environment variable grant"         |
| Status Line    | "status line format", "segment"                           |

These match on `label` + `keywords` only, contribute to the tab badge count, and
navigate to the tab without a row to scroll to.

### Drift guard

Add `src/ui/webview-react/test/components/settings/settingsCatalog.test.ts`
asserting:

1. Every `path="…"` / `settingKey="…"` literal appearing in a file under
   `components/settings/**` has a catalog entry. Read the sources with
   `import.meta.glob(..., { query: "?raw" })` and regex them — a real parse is
   not worth it, and a false positive here is a one-line catalog addition.
2. Every catalog `path` exists in `schemas/settings-schema.json`. This catches
   typos and settings removed without their entry.
3. Catalog ids are unique and every `tab` is a `GLOBAL_SETTINGS_TABS` value.

This test is what keeps the feature true a year from now; without it the
catalog silently rots and the badges start lying. In dev builds, also
`WebviewLog.warn` from the row components when a `path` has no catalog entry, so
the gap shows up while the author is still looking at the screen.

### Coverage note

`HarnessesSection` renders inside `DefaultsHarnessPage`, and `RunHistorySection`
inside `GeneralSection`. Their rows are catalogued under the **parent** tab/page
(`workflow`+`harness`, and `general`), not as tabs of their own — neither is
reachable from `ALL_TABS`.

## Search

Pure function, no store dependency, unit-testable on its own:

```ts
searchSettingsCatalog(query, { devEnabled }): SettingsSearchResult
```

- Normalize both query and haystack: lowercase, collapse punctuation to spaces.
- Haystack per entry: `label + description + path + keywords + tab label + page label`.
- Split the query on whitespace; **all** tokens must appear as substrings (AND).
  No fuzzy, no ranking heuristics.
- Skip `devOnly` entries when `dev.enabled` is false, or the badge counts will
  promise settings the user cannot reach.
- Result carries an ordered match list (sidebar tab order, then catalog order
  within a tab) plus `Map<tab, count>`. Positional stability beats relevance
  ordering for a find-next control.

Because the catalog is static, counts are correct before `fullSettings` arrives
— relevant given that `settingsStore.fullGlobalSettings` is null until the
drawer's own load request returns.

## Wiring

### Store

Add to `uiStore`, and **do not** add either to the persist list — a stale query
resurrecting three days later is a bug, and `historySearchQuery` sets the
precedent for a transient query field living in `uiStore`:

- `settingsSearchQuery: string` + `setSettingsSearchQuery`
- `settingsSearchActiveMatchId: string | null` + setter (drives find-next and
  scroll-into-view)
- `globalSettingsActivePage: DrawerPage` + setter — **required**, because
  `WorkflowDefaultsSection` currently holds `activePage` in local `useState` and
  a cross-tab jump to a Workflow Defaults sub-page cannot reach it. Lift it.

Compute match results in a `useMemo` over the selected query string, never
inside a selector — `ctrlyoke/stable-store-selector` will reject an allocating
selector, and it would re-render the drawer on every store write besides.

### Components

- **`SettingsSearchBar`** (new, `components/layout/`): a ~34px row under the
  title bar. Leading `search` codicon, clear button, and a right-aligned match
  summary (`3 of 12`). Reuse the input chrome from `HistorySearchDrawer` —
  `border-input-border bg-input-bg text-input-fg focus:border-focus-border`.
  Its own row rather than inside the 30px title bar, which already holds the
  scope toggle that collapses to icons at 580px.
- **`GlobalSettingsVerticalTabBar`**: `Tab` gains `matchCount?: number`. Wide
  mode renders a right-aligned count pill; icon-only mode renders a count bubble
  at the icon's top-right, taking priority over the existing server `indicator`
  dot. Zero-match tabs get `opacity-40` while a query is active.
- **`HighlightedText`** (new, `components/shared/`): splits text on matched token
  runs and wraps them in `<mark>`. Used by both setting rows for label and
  description.
- **`SettingInputRow` / `SettingToggleRow`**: read the query and their own match
  state from a `useSettingMatch(path)` hook rather than accepting new props —
  prop-drilling a query through 20 sections and 6 sub-pages is 26 files of churn
  for nothing, and these are leaf components where a store read is cheap. Add a
  `data-setting-path` attribute for scroll targeting, plus the match tint /
  non-match dim.

### Navigation and keys

- Typing a query when the active tab has zero matches auto-switches to the first
  tab that has some. Do this once per query transition, not on every keystroke,
  and never while the current tab still has matches — otherwise the tab yanks
  out from under someone mid-word.
- `Enter` / `Shift+Enter` advance/retreat through the ordered match list,
  switching tab and sub-page as required, then scrolling
  `[data-setting-path="…"]` into view with `block: "nearest"`.
- `Ctrl/Cmd+F` while the drawer is open focuses and selects the search input.
- `Escape` becomes two-stage: a non-empty query clears and keeps focus; an empty
  query closes the drawer. This changes the existing handler in
  `GlobalSettingsDrawer.tsx` — it currently closes unconditionally.
- Empty result: show "No settings match _query_" in the content pane above the
  section, with a clear action. Do not blank the section.

## Phases

1. **Catalog + search** — `settingsCatalog.ts`, `searchSettingsCatalog`, the
   drift-guard test, landmark entries. No UI. Catalogue with explicit `label`
   strings initially; correctness of the text is enforced by phase 4.
2. **Search bar + badges** — store fields, `SettingsSearchBar`, tab-bar counts,
   `HighlightedText`, row match/dim. Feature is usable at the end of this phase.
3. **Navigation** — find-next/prev, auto-jump, `Ctrl+F`, two-stage `Escape`,
   scroll-into-view, lifted `globalSettingsActivePage` and sub-page badge counts
   on `DrawerTabBar`.
4. **`settingKey` migration** — convert the ~140 catalogued rows to
   `settingKey`, deleting the duplicated label strings from the section files.
   Tighten the drift test to require `settingKey` for any catalogued path.

Phases 1–3 ship a working feature; phase 4 is the DRY payoff and can land
incrementally per tab.

## Tests

- `settingsCatalog.test.ts` — the drift guard above.
- `settingsSearch.test.ts` — tokenization, AND semantics, `devOnly` exclusion,
  path and keyword hits, per-tab counts.
- `GlobalSettingsDrawer.test.tsx` (extend) — query produces badge counts on the
  right tabs; zero-match tab dims; auto-jump switches tabs; `Escape` clears
  before closing; a Workflow Defaults match navigates to tab _and_ sub-page.
- Row-level: `HighlightedText` marks the matched run only; a path-only match
  tints the row without marking any text.

## Open Questions

- Should the query survive closing and reopening the drawer within a session?
  Leaning no — reopening with a stale filter reads as a broken drawer.
- Is `Ctrl+F` safe in the hosted browser client, where it shadows the browser's
  own find? The drawer is a focused overlay so it probably is, but confirm
  against the standalone host before wiring it unconditionally.
- Worth searching _values_ later (e.g. finding which setting holds `"claude"`)?
  Out of scope here; it would need `fullSettings` loaded and changes the meaning
  of a match count.
