# Output Pane Event-Type and Subagent Filter Plan

**Status:** Not started (2026-10-23).

Builds on `dev/implemented/OUTPUT_STEP_FILTER_PLAN.md` (step hide/solo, shipped)
and `dev/implemented/SUBAGENT_OUTPUT_ATTRIBUTION_PLAN.md` (subagent attribution
and indented rows, shipped). Replaces the rejected
`dev/rejected/SUBAGENT_COLLAPSIBLE_GROUPS_PLAN.md`.

## Goal

Let a user narrow the Output pane of one run along two more dimensions besides
step:

- **Event type**: for example, only file edits across the whole run, or
  everything except thinking.
- **Subagent**: main agent only, subagents only, or hide or keep particular
  subagents.

All three dimensions are set from one new **Filter** drawer opened from the
output header. The existing step controls (minimap eye, step context menu,
parallel-group chips) keep working and write the same state.

## Why filtering, not collapsible groups

The rejected plan tried to fold a subagent's rows under its spawn card. That
needed a new virtual row kind, a grouping pass ahead of virtualization, and a
choice between reordering interleaved rows (which changes what timestamps and
the minimap mean) or folding each contiguous run separately. A filter keeps time
order, works through the existing projection in `buildOutputRows`, and is the
same mechanism the step filter already uses. The spawn card already summarizes
a child: description, live status line, state and result.

## What already exists

- **Step filter state.** `uiStore.hiddenOutputTargets`, keyed by
  `workflowViewAddressKey()`, holding `{ keys, hiddenAtMs }`, with
  `toggleHiddenOutputTarget`, `soloOutputTargets`, `clearHiddenOutputTargets`
  and `pruneHiddenOutputTargets`. Every change bumps `outputStepFilterVersion`,
  which `OutputSection` folds into `rowRenderIdentity` to force a bulk remeasure.
  Not persisted.
- **Step filtering in the row builder.** `buildOutputRows` keeps a hidden step's
  `STEP_ANCHOR` row, emits one `STEP_HIDDEN` placeholder and skips the rest
  (`src/ui/webview-react/utils/outputRows.ts`, the `hiddenTargetKeys` checks).
- **Event-type taxonomy.** `HISTORY_EVENT_KINDS` in `src/types/DashboardConstants.ts`
  (prompt, response, thinking, bash, fileRead/Write/Edit/Delete, tool, mcpTool,
  webSearch, compaction, cliCommand, status, script, preCondition,
  endCondition). `historyEventKindForCliEventType` and
  `SCRIPT_EVENT_KIND_BY_SOURCE` in `src/core/orchestration/HistoryCandidateExtractor.ts`
  map CLI event types and script sources onto it, and both history search and
  `ctrlyoke history show --kind` already read that one map.
- **Event-kind UI vocabulary.** `HistorySearchDrawer.tsx` holds
  `EVENT_KIND_LABELS`, `EVENT_KIND_BADGES` and the grouped `EVENT_KIND_OPTIONS`
  (File / Execution / Conversation / Script / Run), rendered with
  `MultiCheckboxDropdown`.
- **Subagent identity.** `subagentGroupKey(attribution)` in
  `src/utils/SubagentAttribution.ts`, and the row builder's
  `resolveSubagentMetadata`, which computes `depth`, `label` and `showLabel` per
  structured-event row by walking `spawnEvents` up the parent chain.

## Decisions

### 1. Event types reuse the history taxonomy

Classify every output row into a `HistoryEventKind`. Do not invent a second
taxonomy: users then see the same names in history search, `history show
--kind` and the output filter, and a new CLI event type gets a kind in one place.

- Move `historyEventKindForCliEventType` and `SCRIPT_EVENT_KIND_BY_SOURCE` out of
  `src/core/orchestration/HistoryCandidateExtractor.ts` into
  `src/utils/HistoryEventKinds.ts`, so the webview can import them without
  reaching into `src/core`. `HistoryCandidateExtractor` and
  `HistoryInspectionCommands` import from the new home.
- Move `EVENT_KIND_LABELS`, `EVENT_KIND_BADGES` and `EVENT_KIND_OPTIONS` out of
  `HistorySearchDrawer.tsx` into `src/ui/webview-react/utils/historyEventKindOptions.ts`,
  shared by both drawers.
- Add `outputRowEventKind(row): HistoryEventKind | undefined` in
  `utils/outputRows.ts` (or a sibling module):

  | Row kind                                                                                                            | Kind                                              |
  | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
  | `STRUCTURED_EVENT`                                                                                                  | `historyEventKindForCliEventType(row.event.type)` |
  | `PLAIN_RESPONSE`                                                                                                    | `RESPONSE`                                        |
  | `PROMPT`                                                                                                            | `PROMPT`                                          |
  | `CLI_COMMAND`                                                                                                       | `CLI_COMMAND`                                     |
  | `SCRIPT_COMMAND`, `SCRIPT_OUTPUT`, `SCRIPT_VERDICT`                                                                 | `SCRIPT_EVENT_KIND_BY_SOURCE[source]`             |
  | `STATUS`                                                                                                            | `STATUS`                                          |
  | structural rows (anchor, hidden placeholder, final-step label, parallel header, CLI header, attempt summary, stats) | `undefined`: never filtered by kind               |
  | `ERROR`                                                                                                             | `undefined`: errors are never filtered out        |

  Errors stay visible because a filter that hides the reason a run failed is
  worse than a noisy view. The CLI header stays so each surviving row still
  shows which attempt and harness produced it.

- Structured events the taxonomy does not index (`historyEventKindForCliEventType`
  returns undefined) are treated as "Other": visible unless the user unticks an
  **Other** option. This is output-filter-only and needs no new history kind.
- **Tool results.** `TOOL_RESULT` maps to `TOOL` today, but a result that belongs
  to a file-edit or bash call should follow its call. Check while implementing
  whether results are merged into the call row by id (`CliEventNormalizer`); if
  any render as their own row, classify them by their call's kind.

### 2. Subagents: a scope plus per-subagent hiding

Two controls, both stored per view address:

- **Scope** (`OUTPUT_SUBAGENT_SCOPES` in `DashboardConstants.ts`): `all`
  (default), `main` (hide every attributed row), `subagents` (hide every
  unattributed content row; structural rows stay). Scope covers subagents that
  have not been spawned yet, which per-subagent keys cannot.
- **Hidden subagents**: a set of `subagentGroupKey` strings. Hiding a subagent
  also hides its descendants. The row builder already walks the parent chain in
  `resolveSubagentMetadata`; extend that walk to return the ancestor group keys
  and test each against the set.

**Spawn cards follow the parent.** A spawn card is the parent's tool call, so it
carries the parent's attribution (or none). Under `subagents` scope, keep spawn
cards visible anyway: they are the headers that say what each child was asked to
do. Hiding a subagent leaves its spawn card visible with a `hidden` marker and a
**Show** button, the subagent equivalent of `STEP_HIDDEN`, rendered on the card
instead of as a new row.

### 3. Naming subagents

The group key is a JSON pair of tool-call ids. It stays internal and is never
shown. What the user sees:

- **Name**: the harness's own label, already resolved by
  `resolveSubagentMetadata`: child label (Copilot `agentDisplayName`, Codex
  `agent_nickname`, Antigravity `Role`), else the spawn's `description`
  (Claude's `Agent` description, Copilot's `agentDescription`), else its
  `agentType`, else a short id. People recognize this name in the output.
- **Handle**: a stable ordinal per step, written `Step 2 · #3` (`Pass 1 · #3` for
  a final-step pass, built with `formatFinalPassLabel`). Ordinals count spawns in
  message order within the step target. A nested child gets a dotted ordinal,
  `#3.1`. The handle separates subagents that share a description (two
  `general-purpose` children with no description) and gives a short reference to
  use in conversation.

Not `Step2Subagent3`: a handle with no spaces reads like an identifier the user
could type somewhere, and nothing accepts one. If a CLI flag or MCP argument for
filtering a subagent is ever added, it takes the spawn's tool-call id.

Move name and ordinal resolution out of `buildOutputRows` into
`src/utils/SubagentAttribution.ts` (`resolveSubagentLabel`,
`assignSubagentOrdinals`) so `CliTerminalFormatter`'s `subagentPrefix` and the
dashboard name children the same way. Ordinals may shift when a rewind deletes
an earlier spawn. That is acceptable, because the filter state uses group keys,
not ordinals.

### 4. One filter state per view address

Generalize the step filter's entry instead of adding a parallel record:

```ts
// uiStore — keyed by workflowViewAddressKey(), as hiddenOutputTargets is today.
outputFilters: Record<string, OutputFilterEntry>;
interface OutputFilterEntry {
  hiddenTargetKeys: readonly string[];
  hiddenAtMs: Readonly<Record<string, number>>;
  /** Kinds the user unticked. Empty = no kind filter; a new kind shows by default. */
  hiddenEventKinds: readonly OutputFilterEventKind[];
  subagentScope: OutputSubagentScope;
  hiddenSubagentKeys: readonly string[];
}
```

- Rename `hiddenOutputTargets` → `outputFilters` and `outputStepFilterVersion` →
  `outputFilterVersion`. These are internal and not persisted, so the rename
  costs nothing. The existing step actions keep their names and touch only
  `hiddenTargetKeys`.
- Kinds are stored as a **hidden** set, not a shown set, so "empty means
  unfiltered" holds and a kind added in a later release shows by default.
  "Only file edits" is a solo: hide every other kind.
- New actions: `setHiddenEventKinds`, `soloEventKind`, `setSubagentScope`,
  `toggleHiddenSubagent`, `soloSubagent`, `clearOutputFilters` (all dimensions).
  Each bumps `outputFilterVersion`.
- `pruneHiddenOutputTargets` prunes `hiddenSubagentKeys` against the group keys
  present too, with the same "skip while nothing is rendered" guard.
- Still not persisted, still cleared by address change, as the step plan
  decided.

`OutputFilterEventKind` is `HistoryEventKind | typeof OUTPUT_FILTER_OTHER_KIND`.

### 5. Row building

Inside the existing `buildOutputRows` loop, after the step check, for each
content row:

1. Skip it when its kind is in `hiddenEventKinds`.
2. Skip it when the subagent scope or `hiddenSubagentKeys` (with ancestors)
   excludes it, except for spawn cards (Decision 2).
3. **Compute `showLabel` from the previous visible row, not the previous built
   row.** Today `previousSubagentGroup` is updated as rows are built. With
   filtering, a subagent's first surviving row must show its label even when
   the row that used to show it was filtered out.
4. Keep the step's anchor and CLI header rows. When every content row of a step
   attempt is filtered out, emit one fixed-height `OUTPUT_ROW_KINDS.FILTERED_EMPTY`
   row ("No matching output") instead of an empty header, so a run filtered to
   file edits reads as a list of steps with their edits and a clear line for
   steps without any. This is the only new row kind, and it is a fixed-height
   leaf row like `STEP_HIDDEN`: add it to `estimateOutputRowHeight`,
   `getRowHeightBucket` and `outputFind`'s no-segment list.

Visible-row keys must stay identical before and after a filter change so the
virtualizer's `measurementCacheRef` restores heights on unfilter, as it does for
steps today.

Attempt groups: a collapsed retry group (`collapsedAttemptGroupKeys`) still
collapses. The filter applies inside whichever attempt is rendered.

### 6. Facet counts

A `useOutputFilterFacets(allMessages)` hook makes one pass over messages and
returns, for the drawer:

- per kind: the count of rows of that kind, overall and per step;
- per subagent: name, handle, depth, state (`subagentSpawn.state`), row count,
  and the step it belongs to.

Counts are computed from messages, not rendered rows, so they do not change as
the filter changes ("File Edit 12" still reads 12 while it is unticked). The
hook is memoized on the message list and must not rebuild rows. During a live
run it recomputes on each appended entry, so keep it linear and allocation-light.
Measure with `measurePhase` as `buildOutputRows` does.

### 7. UI: a Filter button and a Filter drawer

**Header (`OutputSectionHeader.tsx`).** Add a **Filter** icon button (`filter`
codicon, `filter-filled` when active) beside **Find in output**, with a count
badge giving the number of active dimensions, the same pattern as
`HistorySearchDrawer`'s filter badge. `aria-pressed` reflects whether the drawer
is open. Replace the `N hidden · Show all` pill with a generalized pill:
`N hidden · Show all` when only steps are filtered (the current text, so the
docs and muscle memory hold), otherwise `Filtered · Clear`. The pill calls
`clearOutputFilters`.

**Drawer (`components/output/OutputFilterDrawer.tsx`).** Styled like
`HistorySearchDrawer` (same section headings, `ExitButton`, checkbox rows,
badges, `Reset` link) but scoped to the output pane, not the whole app:

- It docks to the right edge **inside** the output section, over the output
  list, around 280 px wide, so the user can watch rows appear and disappear as
  they tick boxes. On a narrow output section (`isHeaderNarrow`) it takes the
  full width of the pane. In full-screen output it docks the same way.
- `Esc` and the **Filter** button close it. Closing keeps the filter.
- The drawer's open state is local to `OutputSection`, not stored, like the find
  bar.

Sections, top to bottom:

1. **Event types.** Grouped checkboxes from the shared `EVENT_KIND_OPTIONS`,
   each with its badge colour and facet count. Zero-count kinds are shown dimmed,
   so the layout stays put while a run streams. Group headers toggle their whole
   group. Each row gets an **Only** button on hover/focus (solo). Plus **Other**
   for unclassified events.
2. **Subagents.** Shown only when the run has at least one spawn. A segmented
   control for scope (**All · Main agent · Subagents**), then a tree of
   subagents grouped under step headings: checkbox, name, handle, state dot
   (running / completed / failed), row count, **Only** on hover. Clicking a name
   scrolls to its spawn card through the existing scroll-target path.
3. **Steps.** The present step targets as checkboxes, writing
   `hiddenTargetKeys` through the existing actions. This gives the drawer one
   place for every filter. The minimap and context-menu controls stay.

Footer: `Showing N of M rows` (from the row builder) and **Clear all**.

### 8. Interactions with existing behavior

The step plan's rules carry over unchanged, applied to the new dimensions:

- **Find** searches rendered rows, so it respects the filter. When a filter is
  active and find has no matches, the find bar shows "Filtered: matches may be
  hidden" with a **Clear filters** link.
- **Status and progress** read entries, not rows, so they are unaffected.
- **History search navigation** to a hit that is filtered out clears the
  dimension that hides it (unhides the step, the kind or the subagent) before it
  scrolls. Explicit navigation still beats the filter.
- **Scroll anchoring**: a filter change bumps `outputFilterVersion` and goes
  through the existing `rowRenderIdentity` remeasure and anchor path. If the
  anchor row was filtered out, re-anchor to the nearest earlier visible row in
  the same step, else that step's anchor.
- **Copy All and export**: `Copy All` copies only rows that pass every
  dimension; its label becomes `Copy All (filtered)`. Export keeps its step-range
  pre-fill and adds an **Apply output filters** checkbox, ticked by default when
  a kind or subagent filter is active. Check `generateMarkdownExport`'s input
  while implementing; if it only takes messages, filter structured events out of
  a copy of each message rather than teaching the exporter about rows.
- **Minimap**: unchanged. It stays step-level. File-edit marks for filtered-out
  edits are dimmed, not removed, so the minimap still maps the whole run.
- **Hosted dashboard**: all of this is webview-local state and reads, so the
  hosted browser gets it with no server or message changes.

### 9. Out of scope

- A filter in the CLI terminal formatter or a `--subagent` flag on
  `history show`. `history show --kind` already covers event kinds there.
- Filtering by file path. `HistorySearchDrawer` has `pathContains`, and it would
  pair well with **File Edit** ("only edits under `src/core/`"). It is cheap to
  add to the drawer later, as one more `OutputFilterEntry` field and row check.
  Left out to keep this plan to the two dimensions asked for.
- Persisting filters across runs or reloads.
- Collapsible subagent groups (rejected).

## Implementation order

Each item is one session and leaves `npm run typecheck`, `npm run lint` and
`npm test` green.

- [ ] 1. **Shared taxonomy and naming.** Move the kind maps to
      `src/utils/HistoryEventKinds.ts` and the UI option lists to
      `utils/historyEventKindOptions.ts`; add `resolveSubagentLabel` /
      `assignSubagentOrdinals` to `SubagentAttribution.ts` and switch
      `buildOutputRows` and `CliTerminalFormatter` to them. No behavior change.
      Tests: existing history-search and `history show --kind` tests stay green;
      new unit tests for ordinals (siblings, nesting, final-step pass, a spawn
      seen after its child's rows).
- [ ] 2. **State.** `outputFilters` rename and new fields and actions,
      `OUTPUT_SUBAGENT_SCOPES`, `OUTPUT_FILTER_OTHER_KIND`, pruning. Tests in
      `test/store/uiStore.test.ts`: solo and clear per dimension, a different
      address sees an empty entry, pruning of subagent keys, not persisted.
- [ ] 3. **Row building.** `outputRowEventKind`, kind and subagent skips,
      ancestor hiding, spawn-card exception, `showLabel` over visible rows,
      `FILTERED_EMPTY` row plus height estimate, bucket and find entry. Tests in
      `test/utils/outputRows.test.ts`: file-edit-only keeps anchors, headers and
      errors; main-only and subagents-only; hiding a child hides a grandchild;
      label reappears on the first surviving row; visible row keys unchanged
      across a filter toggle.
- [ ] 4. **Facets and drawer.** `useOutputFilterFacets`, `OutputFilterDrawer`,
      header button and badge, generalized pill, docking and narrow layout.
      Tests: drawer render, tick and solo per section, counts stay fixed while
      filtered, accessible names, `Esc` closes.
- [ ] 5. **Interactions.** Find hint, history-search navigation clearing the
      hiding dimension, scroll re-anchoring, `Copy All (filtered)`, export
      checkbox, minimap dimming. Tests in the matching hook test files.
- [ ] 6. **Docs and changelog.** `docs/guide/output.md`: a "Filtering output"
      section beside "Hiding steps", the header table's **Filter** row and pill
      text. `CHANGELOG.md` **Changed**: the pill text and the new drawer.

## Manual test script

Run in the dev host against a run with at least three steps, one Claude step that
spawned two parallel subagents, and a script step.

1. Open **Filter**, click **Only** on File Edit. Expect every step's anchor and
   header, its file edits, any errors, and "No matching output" for steps with no
   edits. The header shows the filter badge and `Filtered · Clear`.
2. Tick Bash as well. Expect Bash rows to return in time order between the edits.
3. Under Subagents choose **Main agent**. Expect both children's rows gone and
   their spawn cards still present.
4. Choose **All**, untick one subagent. Expect its spawn card with a `hidden`
   marker and **Show**; the sibling's rows still show their label on their first
   row.
5. While a run streams, set File Edit only. Expect counts to tick up and new
   edits to appear with no scroll jump.
6. Search history for a hit inside a filtered-out kind. Expect that kind to be
   unhidden and the row scrolled into view.
7. Switch runs and back. Expect every filter cleared.
8. Narrow the dashboard. Expect the drawer at full pane width and the pill still
   visible.
