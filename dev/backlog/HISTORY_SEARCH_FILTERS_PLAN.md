# History Search Filters Plan

## Goal

Make `HistorySearchDrawer` a real investigative tool rather than a global substring
box. The target questions a user should be able to answer in one query:

- "Which workflows **edited** `CodeMirrorEditor.tsx`?"
- "Which workflow **created** `HistorySearchIndexService.ts`?"
- "Show me every `npm test` invocation from **last week** that **failed**."
- "Find that response about virtualization, but only from **claude-cli** runs."

All four need the same two things: a **granular event-type filter** and a
**date-range filter**, plus a couple of secondary axes (harness, run outcome, file
path).

## Current State

Filter plumbing already exists end to end and is simply never exercised:

- `HistorySearchQuery.filters` supports `matchTypes`, `workflowKeys`, `since`,
  `until` (`src/types/WorkflowTimelineTypes.ts:146-155`).
- `HistorySearchIndexService.search` applies all four against the in-memory
  document list (`src/core/orchestration/HistorySearchIndexService.ts:119-141`).
- `WebviewMessageRouter` forwards `message.filters` verbatim
  (`src/ui/WebviewMessageRouter.ts:850`), and `SearchHistoryMessage extends
Partial<HistorySearchQuery>` (`src/types/WebviewMessageTypes.ts:1136`).
- `HistorySearchDrawer` sends **no** `filters` on either the initial search or
  the "Load more" page.

So the backend work is mostly about making the taxonomy worth filtering on, and
the frontend work is net-new UI.

### The taxonomy problem

`matchType` is a single seven-value union (`response | file | bash | status |
prompt | tool | diff`) that conflates two independent axes:

| Reality                                                | Current encoding                         |
| ------------------------------------------------------ | ---------------------------------------- |
| `fileRead` / `fileWrite` / `fileEdit` / `fileDelete`   | all collapse to `file`                   |
| matched the file **path** vs matched the **diff body** | `file` vs `diff` (a _field_, not a kind) |
| `thinking` block                                       | `response`                               |
| web-search result title/snippet/url                    | `response`                               |
| MCP tool call                                          | `tool`                                   |
| the harness command line (`cliOutput.cliCommand`)      | `bash` — it is not a bash tool call      |

Because of the first row, "who edited this file" is unanswerable today: a
`fileRead` and a `fileEdit` produce identical `file` documents whose text is just
the path.

### The duplication problem

Candidate extraction is implemented **twice** with the same switch statement:
`HistoryCandidateExtractor.collectStructuredEventCandidates` (line 80) is now the
single implementation consumed by both services; the fallback remains the
disk-scan path used when the index throws. Any taxonomy change should land in the
extractor once, or the fallback silently produces documents the filters cannot
match.

## Decisions

### 1. Split `matchType` into `eventKind` + `matchField`

Replace the single union with two orthogonal fields on both
`HistorySearchDocument` and `HistorySearchResult`:

```ts
export const HISTORY_EVENT_KINDS = {
  PROMPT: "prompt",
  RESPONSE: "response",
  THINKING: "thinking",
  BASH: "bash",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  TOOL: "tool",
  MCP_TOOL: "mcpTool",
  WEB_SEARCH: "webSearch",
  COMPACTION: "compaction",
  CLI_COMMAND: "cliCommand",
  STATUS: "status",
  SCRIPT: "script",
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
} as const;

export const HISTORY_MATCH_FIELDS = {
  PATH: "path",
  CONTENT: "content",
  DIFF: "diff",
  COMMAND: "command",
  OUTPUT: "output",
  ERROR: "error",
} as const;
```

Both live in `src/types/DashboardConstants.ts` (flow-control strings must be
single-sourced per the project's coding principles), with the derived unions
exported from `WorkflowTimelineTypes.ts`.

**The document id must include both fields.** It is currently
`[workflowKey, runRef, runId, sequence, candidate.eventKind:matchField, candidateIndex]`
(`buildRunDocuments:454-503`). `candidateIndex` already disambiguates, but the id
is meant to be readable, so swap `matchType` for `eventKind:matchField` — a
`fileEdit`+`path` and a `fileEdit`+`diff` document from the same event should be
distinguishable by id alone.

**Blast radius of the rename** (everything outside the two services that names
`matchType`): `WorkflowTimelineTypes.ts:129,151,179`;
`HistorySearchDrawer.tsx:24,329,347,349`;
`src/test/unit/HistorySearchService.test.ts:86,93,159,166,174,179`;
`src/ui/webview-react/test/hooks/useMessageHandler.test.ts:2040,2067`;
`src/ui/webview-react/test/store/uiStore.test.ts:137`. The last two build result
fixtures are updated with the two new fields.

Mapping from the existing extractor:

| CLI event                       | `eventKind`       | `matchField`       |
| ------------------------------- | ----------------- | ------------------ |
| `cliOutput.prompt`              | `prompt`          | `content`          |
| `cliOutput.response`            | `response`        | `content`          |
| `cliOutput.cliCommand`          | `cliCommand`      | `command`          |
| `text`                          | `response`        | `content`          |
| `thinking`                      | `thinking`        | `content`          |
| `bashCommand.command`           | `bash`            | `command`          |
| `bashCommand.output`            | `bash`            | `output`           |
| `bashCommand.error`             | `bash`            | `error`            |
| `fileRead.path`                 | `fileRead`        | `path`             |
| `fileWrite.path`                | `fileWrite`       | `path`             |
| `fileEdit.path`                 | `fileEdit`        | `path`             |
| `fileEdit.structuredPatch`      | `fileEdit`        | `diff`             |
| `fileDelete.path`               | `fileDelete`      | `path`             |
| `mcpToolCall.server` / `.tool`  | `mcpTool`         | `content`          |
| `toolCall.name` / `.parameters` | `tool`            | `content`          |
| `toolResult.output` / `.error`  | `tool`            | `output` / `error` |
| `webSearch.query`               | `webSearch`       | `command`          |
| `webSearch.results[]`           | `webSearch`       | `content`          |
| `compaction.summary`            | `compaction`      | `content`          |
| status message                  | `status`          | `content`          |
| script step stdout              | `script`          | `output`           |
| pre-condition stdout            | `preCondition`    | `output`           |
| end-condition stdout            | `endCondition`    | `output`           |
| any script's command line       | (its script kind) | `command`          |

**Script kinds are decided by `cliOutput.source`, at the `cliOutput` level — not
per structured event.** Script output has no `structured.events`; its stdout lands
in `cliOutput.response` and its command line in `cliOutput.cliCommand`. So when
`source` is set, _every_ `cliOutput`-level candidate takes that script kind:
`prompt` → `content`, `response` → `output`, `cliCommand` → `command`. The three
`SCRIPT_OUTPUT_SOURCES` values (`script` / `preCondition` / `endCondition`) are the
same strings as the three script `HISTORY_EVENT_KINDS` values, but map them through
an explicit typed `Record<ScriptOutputSource, HistoryEventKind>` rather than casting
one to the other — the equality is a convenience, not a contract.

**Script output needs its own kinds.** `cliOutput.source` discriminates script
output from AI output (`isScriptOutput` is literally `output.source != null`,
`src/ui/webview-react/utils/outputRenderUtils.ts:104`) and names which of the
three script roles produced it (`SCRIPT_OUTPUT_SOURCES`,
`src/types/DashboardConstants.ts:1233`). Today none of that reaches the index:
script stdout is indexed as `response` — indistinguishable from AI prose — and the
script command as `bash`. So "find the end-condition script that printed X" is
currently unanswerable, and every script's stdout dilutes any response search.
`source` sits on the same payload as `metadata`, so this is free at index time.
It is also the reason script documents have no harness, which is correct: they
never ran on one.

Two follow-on wins fall out of this for free:

- **`fileWrite` content should be indexed.** Today only the path is a candidate
  for writes, so "which workflow created a file containing X" cannot match. Add a
  `content` candidate from the write payload if the harness supplies it.
- **`matchField` drives a better result row.** The drawer currently renders one
  badge; it should render the kind as the badge and the field as a muted
  qualifier ("File Edit · diff"), which makes a path match visibly different from
  a diff match.

### 2. v1 filter set

| Filter        | Control                              | Backed by                                                                            |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Event type    | `MultiCheckboxDropdown`, grouped     | `filters.eventKinds` (renamed from `matchTypes`)                                     |
| Date range    | shared preset select + 2 date inputs | `filters.since` / `filters.until`                                                    |
| Harness       | `MultiCheckboxDropdown`              | new `filters.harnesses` (needs indexing, §4)                                         |
| Run outcome   | `MultiCheckboxDropdown`              | new `filters.executionStates` — already on the document                              |
| File path     | text input                           | new `filters.pathContains` — `document.filePath` already exists (matching rules: R2) |
| This workflow | checkbox, default off                | existing `filters.workflowKeys` (R3)                                                 |
| Clear all     | icon button                          | resets to defaults                                                                   |

**`matchField` is indexed but not filterable in v1.** It ships as a field on the
document and as the muted qualifier in the result row ("File Edit · diff"), which
is where its value is — telling a path match apart from a diff match at a glance.
A seventh control for it would be the least-used thing on the bar. `filters.matchFields`
is therefore _not_ part of the v1 payload; add it when a concrete need appears.

Rationale for `pathContains` as a _separate_ input rather than relying on the
main query: it composes. "Query `useMemo` AND path contains `webview-react`"
answers "where in the UI did we touch memoization", which a single text box
cannot express. It is a cheap `document.filePath.includes()` on a field that is
already indexed.

### 3. Deliberately deferred

- **Errors only.** Very useful ("show me the failed commands"), but there is no
  `isError` signal on documents today — it needs an extra boolean derived at
  index time from `bashCommand.error` / `toolResult.error` / non-zero exit. Fold
  into v2 alongside facet counts.
- **Model.** Same plumbing as harness, so it is nearly free once harness lands,
  but adds a fourth dropdown to a bar that is already full. Add behind the same
  index field, surface later.
- **Step target** (final step vs prompt N). Low value at global-search scope.
- **Relevance sort.** Results are recency-sorted (`compareDocuments`). Filters
  make recency-sort tolerable; a scoring pass is a separate concern.

### 4. Harness comes from the recorded event, not the working file

**The working file is the wrong source.** `run-<timestamp>/workflow.ctrlyoke.json`
is mutable: `Set start position` on an earlier step, change the harness, and
re-run rewrites that file **in place** rather than forking a new run. Its
`step.harness` therefore describes the step's _current_ configuration, not what
each recorded attempt actually executed on. Indexing from it would retroactively
relabel every historical event in the run — exactly wrong for a search index whose
whole value is telling you what happened.

**The right source is `cliOutput.structured.metadata`**, which is what the output
UI itself uses. `CliHeaderRowView` renders the step header's harness/model from
`output.structured?.metadata` (`src/ui/webview-react/components/output/OutputRow.tsx:901-911`),
and `StatsRowView` reads `sessionId` + `harness` from the same object (line 1032).
That metadata is `OutputMetadata` (`src/types/CliOutputTypes.ts:194-217`):

```ts
{ sessionId?, model?, usage?, cliVersion?, elapsed?, harness?, rawTextOutput? }
```

Every harness log parser stamps its own id there at parse time —
`harness: HARNESS_IDS.CLAUDE_CLI` (`src/core/harness/claude/ClaudeLogParser.ts:360`),
and the equivalent line in the codex/copilot/qwen/opencode/antigravity parsers.

This is strictly better than the working file on every axis:

- **Immutable.** It lives inside `CliOutputRecordedEvent.payload.cliOutput`, in an
  append-only `events.jsonl`. An attempt recorded under `claude-cli` stays
  `claude-cli` after the step is re-run under `codex-cli` — and the re-run appends
  its own event with its own harness, so both are searchable and correctly
  attributed.
- **Free.** The index service already destructures `event.payload.cliOutput` and
  walks `cliOutput.structured?.events`
  (`HistoryCandidateExtractor.collectCliOutputCandidates:39-69`). Reading
  `cliOutput.structured?.metadata` alongside it costs one property access — no
  extra file reads, no working-file parse, no `Map<stepIndex, …>`.
- **Correctly grained.** Per recorded attempt, which is finer than per-step and far
  finer than the run-level `primaryHarness` in `RunSummary`. Mixed-harness
  workflows are a first-class ctrlyoke use case, and a per-step or per-run value
  would mislabel every attempt after a switch.

`model`, `sessionId`, and `cliVersion` ride along in the same object, so they are
free to index at the same time. `model` becomes a filter as soon as it is wanted;
`sessionId` enables "show me everything from this session" without a new extraction
path.

**Implementation:** in `buildRunDocuments`, hoist
`const metadata = event.payload.cliOutput.structured?.metadata` for
`CLI_OUTPUT_RECORDED` events and stamp `harness` / `model` / `sessionId` onto every
document produced from that event.

These three go on `HistorySearchDocument` **only**, not on `HistorySearchResult`.
v1 filters on them but renders none of them, and the result payload is sent to the
webview on every search — don't widen it for a consumer that does not exist yet.
Add to the result at the moment a row actually displays a harness.

**Unattributed documents.** Three sources produce documents with no harness, and
all three are legitimate: `STATUS_MESSAGE_RECORDED` events have no `cliOutput` at
all; **script / pre-condition / end-condition output never ran on a harness**; and
`metadata.harness` is optional, so a parser that fails to populate it yields the
same. Treat `undefined` as "unattributed" and **include** it whenever the harness
filter is at its default all-selected state, so turning no filters on can never
hide rows. Only an explicitly narrowed harness selection excludes them.

### 5. Index schema bump → 3.0.0

`INDEX_SCHEMA_VERSION` goes `2.0.0` → `3.0.0`
(`src/core/orchestration/HistorySearchIndexService.ts:32`). `loadIfPossible`
already bails on a version mismatch and leaves `loadedManifest` undefined, so
`ensureReady` performs a full rebuild on first search after upgrade. No migration
code needed (pre-release, no back-compat constraints), but the first search after
the change will be slow on a large `.ctrlyoke/.runs` tree — acceptable, and the
`indexState: "building"` label already covers it in the UI.

**Freshness stays correct for free.** `isManifestFresh` stats only the manifest and
events files (`HistorySearchIndexService.ts:374-385`). Because harness now comes
from the events themselves rather than the working file, every index input is
already covered by that check — no new mtime tracking, and no risk of an in-place
working-file edit silently invalidating indexed harness data.

### 6. Cursor must hash the filters

`CursorPayload.queryHash` is `hashQuery(query)` — the **query text only**
(`HistorySearchIndexService.ts:675, 694`). Change a filter while a cursor is
outstanding and `decodeCursorOffset` accepts the old cursor, so "Load more"
resumes at an offset computed against a different result set — silently skipping
or duplicating rows.

Fix: hash the normalized `{ query, filters }` pair. The drawer must also drop
`historySearchNextCursor` whenever a filter changes, which it gets for free if
filter changes route through the same "new search" path as query changes.

## Shared Code Extraction

The date controls are the only genuinely overlapping filter, and they are worth
sharing exactly as the user proposed.

**Move out of `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`**
(currently lines 78-153):

- `WorkflowDatePreset` → `DateRangePreset` (`all | last7 | last30 | lastMonth | custom`)
- `WorkflowDateFilter` → `DateRangeFilter` (`{ preset, from, to }`)
- `DEFAULT_WORKFLOW_DATE_FILTER`, `DATE_INPUT_FORMATTER`, `formatDateInput`,
  `getDatePresetRange`, `getDateStartMs`, `getDateEndMs`
- `formatMultiFilterLabel` (line 155) — both filter bars need it

**Destination:**

- `src/ui/webview-react/utils/dateRangeFilter.ts` — types, presets, and the
  string↔epoch-ms conversions.
- `src/ui/webview-react/components/shared/DateRangeFilterControls.tsx` — the
  preset `<select>` plus the two conditional `<input type="date">` fields, taking
  `{ value, onChange }` and the existing `h-7 … text-xs` styling verbatim so both
  filter bars stay visually identical.
- `src/ui/webview-react/utils/filterLabels.ts` — `formatMultiFilterLabel`.

**Keep separate:** the _application_ of the range. `WorkflowStatus` filters an
already-loaded array client-side with `getDateStartMs`/`getDateEndMs`;
`HistorySearchDrawer` converts the same two strings to `since`/`until` and sends
them to the backend. Share the state shape and the ms conversion, not the
predicate.

Harness options (`WORKFLOW_HARNESS_OPTIONS`, built from `HARNESS_IDS` +
`HARNESS_INFO`) and state options (`WORKFLOW_STATE_OPTIONS`, from
`EXECUTION_STATES`) should also move to the shared utils module — they are pure
derivations of existing single sources and both bars need them.

## Drawer UI

Build on the layout landed in the centered-column pass. Everything stays inside
`CONTENT_COLUMN_CLASS`.

```
┌ SEARCH HISTORY ────────────────────────────────── [x] ┐
│                                                       │
│   ┌───────────────────────────────┐ ┌────┐            │  ← input + filter toggle
│   │ 🔍 codemirroreditor           │ │ ⚙ 3│            │    (badge = active count)
│   └───────────────────────────────┘ └────┘            │
│   ┌ All Events ┐┌ All Harnesses ┐┌ Any time ┐┌ path ┐ │  ← filter bar (collapsible)
│   Showing 50 of 2450              Index updating      │  ← summary row
├───────────────────────────────────────────────────────┤
│   results…                                            │
└───────────────────────────────────────────────────────┘
```

- The filter button occupies the slot already reserved next to the input in
  `HistorySearchDrawer.tsx`. It carries an active-filter count badge and
  `aria-expanded`.
- The filter bar reuses `workflowFilterControls`' structure verbatim
  (`WorkflowStatus.tsx:1370-1476`): a horizontally scrollable `flex` row of `h-7`
  controls with a trailing `codicon-clear-all` reset button disabled when no
  filter is active.
- Event types are grouped in the dropdown: **File** (read/write/edit/delete),
  **Execution** (bash, cliCommand, tool, mcpTool, webSearch), **Conversation**
  (prompt, response, thinking, compaction), **Script** (script, preCondition,
  endCondition), **Run** (status). See open question 5 — this needs a `group`
  field on `MultiCheckboxDropdown`'s option type.
- The summary row already exists and needs no move; when filters are active it
  should read `Showing 50 of 2450 (filtered)`.

### Narrow layouts

The drawer renders in the VS Code panel (which can be dragged narrow) and in the
hosted browser dashboard on mobile, so the filter bar cannot assume the width in
the sketch above. Reuse `workflowFilterControls`' proven approach verbatim: a
`flex` row with `overflow-x-auto pb-0.5` and `flex-shrink-0` on each control, so
the bar scrolls horizontally rather than wrapping into a two-line block that
shoves results off screen. Do **not** introduce a responsive tier here — if it
ever needs one, read the `useElementTier` note in
`.github/instructions/webview-react-components.instructions.md` first, because
measuring the wrong element is a documented trap in this codebase.

### State location

Filter state goes in `uiStore` alongside the existing `historySearch*` slice
(`src/ui/webview-react/store/uiStore.ts:298-305`), **not** component-local
`useState` as `WorkflowStatus` does. Reason: the drawer unmounts nothing but is
frequently closed and reopened, and losing a carefully built filter set on close
is the kind of small betrayal that stops people using filters at all. Reset
filters in the same place the search slice is reset (line 1538). Do **not**
persist to VS Code state — a filter silently surviving a window reload is worse
than re-picking it.

Filter changes re-issue the search through the existing debounced effect. Reuse
the 400ms debounce for the text inputs (`pathContains`), but fire immediately on
dropdown/date changes — those are discrete choices, not typing.

## Phases

**Phase 1 — De-duplicate the extractor.** Pull the candidate switch out of
`HistorySearchIndexService` and `HistorySearchService` into the single
`HistoryCandidateExtractor` (`src/core/orchestration/HistoryCandidateExtractor.ts`).
The module exports `HistoryCandidateExtractor`,
`HistoryCandidateExtractorOptions`, and `MatchCandidate`; its public extraction
API is `collectCliOutputCandidates(cliOutput)` and
`collectStatusCandidates(message)`, with the optional `maxTextLength` constructor
option reserved for the bounded index path. No behavior change; pure DRY prep.
Tests: existing `src/test/unit/HistorySearchService.test.ts` should pass
untouched.

**The two copies are not identical, and the differences are load-bearing.** A
straight merge silently regresses the fallback path:

- **Text cap.** The index caps every candidate at `MAX_INDEXED_TEXT_LENGTH`
  (`HistoryCandidateExtractor.ts:161-174`); the fallback's per-event filter in
  `HistorySearchService.collectCliOutputMatches` (`HistorySearchService.ts:292-303`)
  does **not** cap.
  Applying the cap to both would make the fallback miss matches past offset 2000 —
  the one path that can still find them. The extractor therefore takes an optional
  `maxTextLength`: the index passes `MAX_INDEXED_TEXT_LENGTH`, the fallback passes
  nothing.
- **Query filtering.** The index collects unconditionally and filters later; the
  fallback filters at collection time. The shared extractor collects
  unconditionally, and the fallback filters the returned
  array by `text.toLowerCase().includes(query)` afterwards. This is per-event, not
  per-run, so the transient array stays small.
- **`thinking` is folded into `TEXT`'s case in the index and split into its own
  case in the fallback** — same output today, but Phase 2 gives them different
  kinds, so the extractor must keep them as separate cases.

**Phase 2 — Taxonomy.** ✅ Done. Added `HISTORY_EVENT_KINDS` /
`HISTORY_MATCH_FIELDS`, replaced `matchType` with `eventKind` + `matchField` on
document and result, indexed `fileWrite` content, bumped
`INDEX_SCHEMA_VERSION` to `3.0.0`, updated the drawer's
`MATCH_TYPE_LABELS`/`MATCH_TYPE_BADGES` maps to the new kinds, and rendered the
field qualifier.

**Phase 3 — Harness/model indexing.** ✅ Done. Stamped `harness` / `model` /
`sessionId` from `cliOutput.structured.metadata` onto each document in
`buildRunDocuments`. This folded into Phase 2 because the schema bump was
happening anyway — both changes touch the same function and both require the same
rebuild.

**Phase 4 — Backend filters.** Rename `filters.matchTypes` → `eventKinds`; add
`harnesses`, `executionStates`, `pathContains` (not `matchFields` — see §2).
Include filters in the cursor hash. Apply them through one shared
`matchesFilters(document, filters)` used by both the index and fallback paths (R6).

**Phase 5 — Shared date controls.** Extract to `utils/dateRangeFilter.ts` +
`shared/DateRangeFilterControls.tsx` + `utils/filterLabels.ts`; rewire
`WorkflowStatus` to consume them (must be a pure refactor — its behavior is
covered by existing tests).

**Phase 6 — Drawer filter bar.** `group` support in `MultiCheckboxDropdown` (R5),
then the toggle button, filter bar, uiStore slice, re-issue-on-change, active
count badge, and `(filtered)` summary suffix. Land the dropdown change first and
on its own — it touches a component three other surfaces already use.

**Phase 7 (v2) — Facets and errors.** `isError` on documents; return per-kind
counts in `HistorySearchResponse` so the event-type dropdown can show
`File Edit (128)` and grey out kinds with zero matches. The index service already
materializes the full `matches` array before paging, so bucketing is nearly free
— compute counts _before_ applying the kind filter, after applying the others.

## Gotchas

- **`MAX_INDEXED_TEXT_LENGTH = 2000`** caps every candidate
  (`HistorySearchIndexService.ts:46`). Diff bodies are the most likely victim, so
  a `fileEdit`+`diff` filter has a real blind spot on large hunks. Do not raise
  the cap — it exists because the index once outgrew the history and OOM'd the
  extension host. Document the limit in the UI only if users hit it.
- **Documents without a `target` are skipped entirely** (`buildRunDocuments:464`).
  Run-level events can never be filtered because they are never indexed.
- **Two rebuild paths.** `retainDocuments: false` (refresh) must stay
  memory-neutral — do not accumulate the new per-run harness map across runs.
- **The fallback path returns `indexState: "fallback"`** and ignores filters
  entirely today (`HistorySearchService.searchLegacy` takes only query/limit).
  Either thread filters through it or make the UI show that filters are inactive
  in fallback mode. Silently ignoring them is the worst option.
- **Filter changes must reset the cursor and the accumulated result array**, not
  append. The existing `setHistorySearchResults(..., { append: true })` path is
  only for "Load more".
- **"Load more" must resend the active filters.** `loadMore` currently posts
  `{ query, limit, cursor }` (`HistorySearchDrawer.tsx:199-215`). Omitting filters
  on the paged request would page an unfiltered result set against a filtered
  offset — the same class of corruption as the cursor hash, from a different
  direction.
- **Escape will close the whole drawer while a filter dropdown is open.** The
  drawer registers a document-level `keydown` listener that unconditionally calls
  `closeHistorySearch` (`HistorySearchDrawer.tsx:170-179`), and neither
  `MultiCheckboxDropdown` nor `DropdownPortal` handles Escape at all — so the
  first Escape dismisses the drawer, the query, the results, and the half-built
  filter set together. Fix in the dropdown, not the drawer: give
  `MultiCheckboxDropdown` its own Escape handler that closes the popup and calls
  `stopPropagation`, so the drawer's listener never sees the event. This also
  fixes the same latent problem in `WorkflowStatus`.

## Testing

- `src/test/unit/HistorySearchService.test.ts` — extend with per-kind fixtures:
  a run that reads, writes, edits, and deletes the same path, asserting four
  distinct `eventKind`s and that a `fileEdit`-only filter returns exactly one.
- New `src/test/unit/HistorySearchIndexService.test.ts` (confirmed absent) — cursor hash
  must change when filters change; a stale cursor from a different filter set
  must reset to offset 0.
- **Harness attribution across a re-run** — the case that rules out the working
  file. Fixture: a run with two `CLI_OUTPUT_RECORDED` events for the _same_
  `target.stepIndex`, the first carrying `metadata.harness: "claude-cli"` and the
  second `"codex-cli"` (as a `Set start position` re-run produces). Assert both
  documents keep their own harness, and that a `harnesses: ["claude-cli"]` filter
  returns only the first. A working-file-derived implementation returns both or
  neither, so this test is what keeps the source honest.
- `src/ui/webview-react/test/components/search/HistorySearchDrawer.test.tsx`
  (new) — filter change re-issues `SEARCH_HISTORY` with the right payload and
  clears the cursor; active-count badge; clear-all resets.
- `src/ui/webview-react/test/components/shared/MultiCheckboxDropdown.test.tsx` —
  extend for R5: header click selects/clears exactly its section and touches no
  other value; header is indeterminate on a partial section; grouped values reach
  `onChange` as the same flat `string[]`; **and options with no `group` render
  identically to today** (the regression guard for the three existing callers).
- `WorkflowStatus` tests must pass unchanged through Phase 5, and its dropdowns
  must be visually unaffected by R5.

## Resolved Questions

All design questions are decided; nothing here blocks implementation. The
rationale is kept because each has a plausible-looking alternative that should not
be re-litigated by accident. R7 is the one marked for a second look during
testing.

### R1. Event-type filter default — **all kinds selected**

Mirror `WorkflowStatus`. Silent exclusion is the worst failure mode a search box
has: "I know it's in there" with no way to see why it isn't. Until facet counts
exist (Phase 7), the UI has no way to render _why_ a kind was skipped, and the
summary line can't say "3 kinds hidden".

If a kind is ever defaulted off, it should be **`thinking`, not `fileRead`** —
which inverts the leaning in the earlier draft. `fileRead` documents contain only
the _path_ (the extractor's file-path candidate), so despite being the
largest bucket by count they can only match path-ish queries — which is usually
exactly the file search the user wanted. `thinking` documents carry full prose and
compete directly with `response` for every natural-language query. Revisit once
facets make `Thinking (0)` legible in the dropdown.

### R2. `pathContains` matching — **case-insensitive substring, separator-normalized**

Glob adds a matching engine plus a syntax to learn, for a filter that is already
scoped by the event-kind selection. Substring is predictable and cheap.

The one refinement that is **not** optional: normalize `\` → `/` on both sides
before comparing. Indexed paths come from harness output, which mixes separators
on Windows (see the search screenshot's `...ebview-react\\test\\components\\...`
against `src/ui/webview-react/...` elsewhere in the same result list). A raw
`includes` would make `webview-react/test` silently miss half the matches. If
directory scoping later proves necessary, add a trailing-`/` convention before
reaching for full glob.

### R3. "This workflow only" toggle — **yes, defaulted off**

`workflowKeys` is already supported end to end, so the cost is a checkbox. Label
it with the actual workflow name rather than "current workflow" so it is obvious
what gets excluded, default it **off** (global search is the drawer's whole
purpose), and hide the control entirely when no lineage is active — a fresh
window or draft-only state has nothing to scope to.

### R4. Script-output kinds — **split into three, don't collapse to one `script`**

Raised by the observation that script output has no harness. The three
`SCRIPT_OUTPUT_SOURCES` roles answer genuinely different questions ("which
end-condition rejected this", "which pre-condition blocked the step", "what did my
script step print"), the discriminator already exists on the payload, and grouping
them under one dropdown heading keeps the UI cost at zero. Collapsing to a single
`script` kind would throw away information that is free to keep.

### R5. `MultiCheckboxDropdown` grouping — **add an optional `group` field**

17 flat event kinds is past what an ungrouped checkbox list can carry. The option
type is `Array<{ value, label, description? }>`
(`src/ui/webview-react/components/shared/MultiCheckboxDropdown.tsx:19`); adding
`group?: string` is a contained change, and the workflow state/harness dropdowns
will want it eventually. Ship grouping with this feature rather than shipping a
flat 17-row list and fixing it later.

#### What "grouped" means concretely

Not a tree, not collapsible sections, and not nested checkboxes. A **flat list
with section headers**, where each header is itself a tri-state toggle for its
section:

```
┌ Event types ──────────────────────── ▾ ┐
│ ▣ File                            4/4  │  ← header row: click = select/clear section
│    ☑ Read                              │
│    ☑ Write (create)                    │
│    ☑ Edit                              │
│    ☑ Delete                            │
│ ▤ Execution                       3/5  │  ← indeterminate: some of the section on
│    ☑ Bash                              │
│    ☐ Harness command                   │
│    ☑ Tool call                         │
│    ☑ MCP tool                          │
│    ☐ Web search                        │
│ ▣ Conversation                    4/4  │
│    ☑ Prompt                            │
│    ☑ Response                          │
│    ☑ Thinking                          │
│    ☑ Compaction                        │
│ ▣ Script                          3/3  │
│    ☑ Script step                       │
│    ☑ Pre-condition                     │
│    ☑ End-condition                     │
│ ▣ Run                             1/1  │
│    ☑ Status message                    │
└────────────────────────────────────────┘
```

Rules:

1. **Headers are sticky** (`position: sticky; top: 0`) inside the existing
   `overflow-y-auto` options area (`MultiCheckboxDropdown.tsx:177`), so the
   section a row belongs to stays visible while scrolling 17 rows.
2. **Header click = bulk toggle.** Section fully selected → clears it; otherwise →
   selects all of it. This is the entire reason to group rather than just insert
   dividers: "only file operations" becomes two clicks (clear all, then click
   File) instead of seventeen.
3. **Header checkbox is tri-state** — checked / indeterminate / unchecked, driven
   by how many of the section's values are in `selectedValues`. Use the DOM
   `indeterminate` property (it is not an attribute, so it needs a ref or
   `el.indeterminate = …`), plus `aria-checked="mixed"` on the header row.
4. **Headers are not values.** They never enter `selectedValues`, never reach the
   filter payload, and the `n/m` count is derived, never stored. Grouping is
   presentation over the same flat `string[]` the component already emits, so
   `formatMultiFilterLabel` and the `filters.eventKinds` payload are unchanged.
5. **Ungrouped options stay flat.** Options without a `group` render exactly as
   today, before any grouped sections. Every current caller (skills, workflow
   states, harnesses) passes no `group` and must render pixel-identically — this
   is a purely additive change.
6. **Group order is the order groups first appear** in the `options` array, not
   alphabetical. The caller controls sequence by ordering its option list.
7. **Hidden-options interaction:** `useHideableOptions` partitions into
   visible/hidden before grouping (`MultiCheckboxDropdown.tsx:61-65`). Group the
   _visible_ partition only; the hidden section at the bottom stays flat, since a
   handful of hidden rows do not need structure.

#### Trigger label

Unchanged — `formatMultiFilterLabel` already collapses to `All Events` /
`4 Events` / a single label. Groups do not appear in the trigger. A future
refinement could render `All File` when a selection is exactly one full group, but
that is a nicety, not a requirement.

### R6. Filters on the fallback path — **share one predicate, don't thread parameters**

`HistorySearchService.searchLegacy` takes only query and limit, so a search that
falls back to disk scanning would silently ignore every filter — worse than
failing, because the results look plausible. After Phase 1 both paths produce the
same candidate shape, so the answer is a single pure `matchesFilters(document,
filters)` applied in both, not a second filter implementation. Keep the
`indexState: "fallback"` badge visible in the UI regardless, since the fallback
also silently caps results differently.

### R7. Result flooding by a single run — **leave it, revisit during testing**

A run that edited 40 files produces 40 `fileEdit` documents. Apply an event-kind
filter and that is exactly what the first page becomes: 50 rows drawn from two
runs. Filters make this _more_ visible rather than less, because narrowing to one
kind strips out the variety that currently disguises it.

Ship v1 without mitigation. The result rows already name their run, so a repetitive
page is legible rather than confusing, and the alternatives — capping per-run rows
behind a "12 more in this run" expander, or grouping the list under collapsible
run headers — are guesses at a shape nobody has felt yet. Both remain available:
this is result presentation only, orthogonal to every decision above, so no phase
depends on which way it goes.

Revisit while testing Phase 6 against real queries. The signal to watch for is a
first page dominated by one or two runs on a _narrowed_ search — that is the case
filters create and the unfiltered drawer never showed.
