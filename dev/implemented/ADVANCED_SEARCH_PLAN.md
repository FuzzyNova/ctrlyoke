# Advanced Search Plan

## Overview

Two complementary search features:

1. **Global History Search** — search across all workflow runs stored in `.flightpath/.history/`.
   Opens as a dedicated modal triggered from the header. Surfaces results by
   workflow → run number → step with output snippets, and lets the user jump directly
   to the matching run with the in-output find bar pre-populated.

2. **In-Output Find Bar** — a Ctrl+F-style text search within the currently displayed
   `OutputSection`, with highlighted matches and prev/next navigation. Used
   standalone and as the landing target for global history search.

**Design principle:** The workflow dropdown remains a navigator. History search is
forensic and deserves its own surface.

**Current codebase reality:** Output virtualization has shipped
(`dev/implemented/OUTPUT_VIRTUALIZATION_PLAN.md`). The output panel virtualizes output
into **flattened render rows**:

- `OutputSection.tsx` builds `rows` via `useOutputRowsModel()` and virtualizes them
  via `useOutputVirtualization()` (TanStack Virtual under the hood)
- Those rows render through `OutputRow.tsx`
- `@tanstack/react-virtual` mounts only the visible subset

Search must target the **row model** and the virtualizer, not arbitrary text nodes
under `#output-content`.

**Codebase notes for implementors:**

- Stores live in `src/ui/webview-react/store/` (singular), not `stores/`
- `WorkflowRunManifest` (in `src/types/WorkflowTimelineTypes.ts`) has: `workflowId`,
  `runId`, `startedAt`, `completedAt?`, `executionState`, `runStepCount`, `eventCount`,
  `nextSequence`, `lastUpdatedAt` — it does **not** have `workflowName` or
  `workflowFilePath`
- `workflowName` and `workflowFilePath` must be resolved by reading the queue file at
  `.flightpath/.queue/<workflowId>.flightpath.json` (`WorkingFile.workflowName` +
  `WorkingFile.originalFile`). See resolution section below.
- Virtualizer scroll: `rowVirtualizer.scrollToIndex(rowIndex, { align: "center" })`
  where `rowVirtualizer` is returned by `useOutputVirtualization()`

---

## Feature 1: Global History Search

### What can be searched

The history timeline stores rich, structured data per run. Each `events.jsonl` file is
JSONL, one `WorkflowTimelineEvent` per line. The searchable fields are:

| Event type              | Searchable content                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `cliOutputRecorded`     | `payload.cliOutput.prompt`                                                         |
| `cliOutputRecorded`     | `payload.cliOutput.response`                                                       |
| `cliOutputRecorded`     | `payload.cliOutput.cliCommand`                                                     |
| `cliOutputRecorded`     | File paths in `payload.cliOutput.structured.events[]`                              |
| `cliOutputRecorded`     | Bash command strings in structured events                                          |
| `cliOutputRecorded`     | Tool names / server names / tool-result text / thinking text / generic text events |
| `cliOutputRecorded`     | Diff hunk lines from `structuredPatch.lines` when present                          |
| `statusMessageRecorded` | `payload.statusMessage.message`                                                    |

Everything searchable lives in the history files. No working-file reads are needed
for match extraction.

The `manifest.json` for each run contains `workflowId`, `runId`, `startedAt`,
`completedAt`, and `executionState`, all useful for labeling results.

### Extension-side: `HistorySearchService`

New file: `src/flightpath/orchestration/HistorySearchService.ts`

**Responsibility:** Stream-search `events.jsonl` files across all workflow runs and
return ranked `HistorySearchResult[]`.

```typescript
export interface HistorySearchResult {
  workflowId: string;
  workflowName: string; // from WorkingFile.workflowName in queue file
  runId: number;
  runIndex: number; // 0 = most recent, for LOAD_RUN_HISTORY
  startedAt: number;
  executionState: string;
  target: OutputExecutionTarget;
  matchType:
    "response" | "file" | "bash" | "status" | "prompt" | "tool" | "diff";
  matchSnippet: string;
  matchContext: string; // "Prompt 2", "Final Step Loop 1", etc.
  filePath?: string;
  workflowFilePath: string; // resolved from WorkingFile.originalFile
}
```

**Algorithm:**

```text
For each workflow history directory under .flightpath/.history/:
  workflowId = directory name
  Read manifest.json
  Resolve workflowName + workflowFilePath from queue file (see below)
  Read events.jsonl line by line
    JSON.parse each line
    If cliOutputRecorded:
      search prompt / response / cliCommand
      search structured events:
        text / thinking / tool-result
        bash command / output / error
        file paths
        tool names and server names
        structuredPatch.lines
    If statusMessageRecorded:
      search message text
  map run directories to runIndex (newest = 0)
```

**Performance constraints:**

- Search on demand, no persistent index for MVP
- Debounce webview requests by ~400 ms
- Minimum query length: 2
- Cap results at 50
- Scan runs newest-first within each workflow
- Stop scanning once result cap is reached

### Workflow ID to file path resolution

`HistorySearchService` must resolve `workflowId` back to the workflow file so the
result can be opened. **The manifest does not store this** — resolve it from the queue
file instead.

**Resolution order:**

1. Read `.flightpath/.queue/<workflowId>.flightpath.json` (a `WorkingFile`)
   - `workingFile.workflowName` → display name for results
   - `workingFile.originalFile` → source workflow path for `LOAD_WORKFLOW`
2. If the queue file does not exist (workflow deleted or ephemeral), fall back to
   deriving a display name from `workflowId` (strip timestamp suffix) and set
   `workflowFilePath` to an empty string; the result will still open correctly if
   the webview falls back to loading by workflowId rather than file path.

Do not reconstruct `.yaml` or `.json` filenames from `workflowId` by guessing — use
the queue file as the authoritative source.

### Message types

Add to `src/types/DashboardConstants.ts`:

```typescript
MESSAGE_TYPES.SEARCH_HISTORY; // webview -> extension
MESSAGE_TYPES.SEARCH_HISTORY_RESULTS; // extension -> webview
MESSAGE_TYPES.OPEN_HISTORY_SEARCH; // extension -> webview
```

Suggested payloads:

```typescript
// SEARCH_HISTORY
{ query: string }

// SEARCH_HISTORY_RESULTS
{
  query: string;
  results: HistorySearchResult[];
  hasMore: boolean;
}
```

### UI: Dedicated History Search Modal

History search remains a standalone modal, separate from the workflow dropdown.

**Trigger:**

- Add a `codicon-search` button to the left tool group in `Header.tsx`
- Place it between the standalone-only Files button and the Settings button
- Register `flightpath.searchHistory` so it can be keybound and opened from the
  command palette

Current header slot (confirmed against current `Header.tsx`):

```text
[WorkflowControls] | Save | Undo/Redo | [Files*] | Search | Settings
```

### Modal component

New file: `src/ui/webview-react/components/search/HistorySearchModal.tsx`

Layout:

- full-screen backdrop
- centered panel
- auto-focused search input
- results list with snippets
- loading row while searching
- footer showing `Showing N of 50` when capped

### Result click flow

Use staged navigation state in the webview to avoid a race between workflow load and
history load.

Add to `uiStore` (in `src/ui/webview-react/store/uiStore.ts`):

```typescript
pendingHistorySearchNavigation: {
  runIndex: number;
  findQuery: string;
} | null;
```

**Click action:**

1. Send `LOAD_WORKFLOW` with `workflowFilePath`
2. Store `pendingHistorySearchNavigation = { runIndex, findQuery: query }`
3. Close the modal
4. When `FILE_SELECTED` or `SESSION_RESTORED` completes for the requested workflow,
   the webview sends `LOAD_RUN_HISTORY` using the pending `runIndex`
5. When `OUTPUT_HISTORY_LOADED` arrives, the webview opens the in-output find bar
   with `findQuery`
6. Clear the pending navigation state

This removes a race between workflow load and history load.

### UI state additions

Add to `uiStore` (in `src/ui/webview-react/store/uiStore.ts`):

```typescript
isHistorySearchOpen: boolean;
historySearchResults: HistorySearchResult[];
historySearchQuery: string;
historySearchLoading: boolean;
pendingFindQuery: string | null;
pendingHistorySearchNavigation: {
  runIndex: number;
  findQuery: string;
} | null;
```

`pendingFindQuery` is still useful for directly opening output find from other flows.
`pendingHistorySearchNavigation` is specifically for cross-workflow history jumps.

---

## Feature 2: In-Output Find Bar

### The implementation change

The old design relied on:

- scanning the output DOM with `TreeWalker`
- creating `Range`s
- applying `CSS.highlights`

That no longer fits the current codebase because the output is virtualized. DOM search
would only see mounted rows, so:

- match counts would be wrong
- off-screen matches would be invisible to the searcher
- navigation would break once output exceeds the viewport

The new design must be **row-indexed and virtualizer-aware**.

### Component: `OutputFindBar`

New file: `src/ui/webview-react/components/output/OutputFindBar.tsx`

Same visible behavior:

- text input
- `N of M` counter
- prev / next
- case-sensitive toggle
- close button

**Keyboard:**

- `Ctrl+F` / `Cmd+F` opens
- `Enter` / `F3` goes next
- `Shift+Enter` / `Shift+F3` goes previous
- `Escape` closes

### Row-model search

New utility: `src/ui/webview-react/utils/outputFind.ts`

```typescript
export interface OutputFindMatch {
  matchId: string;
  rowKey: string;
  rowIndex: number;
  rowKind: OutputRenderRow["rowKind"];
  target?: OutputMessageTarget;
  field:
    | "header"
    | "prompt"
    | "command"
    | "error"
    | "response"
    | "status"
    | "filePath"
    | "toolLabel"
    | "toolContent"
    | "diff";
  start: number;
  end: number;
  preview: string;
}
```

The search index is built from `rows: OutputRenderRow[]`, not from the DOM.

**Searchable row content by row kind** (all 11 types confirmed against current
`outputRows.ts`):

- `cli-header`
  - step label
  - step name
  - harness/model label text
- `prompt`
  - prompt text
- `cli-command`
  - working directory + command
- `error`
  - error text
- `plain-response`
  - response text
- `status`
  - status message text
- `structured-event`
  - text / thinking text
  - bash command / output / error
  - file paths
  - tool names / server names
  - generic tool parameters serialized to display text
  - tool-result output / error summaries
  - diff hunk lines from `structuredPatch.lines`
- `stats`
  - skip in MVP to avoid noisy matches on token counts and session IDs
- `history-banner`, `step-anchor`, `final-step-label`
  - skip (navigation-only rows, not content)

### Highlight strategy

Do not mutate the live DOM outside React. Highlighting should be component-driven.

Add a small decoration model:

```typescript
export interface RowFindDecoration {
  matches: Array<{
    start: number;
    end: number;
    active: boolean;
  }>;
}
```

And a helper:

```typescript
export function highlightText(
  text: string,
  decorations: RowFindDecoration["matches"]
): React.ReactNode;
```

Implementation pattern:

1. `useOutputFind` computes all `OutputFindMatch[]`
2. It derives `Map<string, RowFindDecoration>` keyed by `row.key`
3. `OutputSection` passes row-level decorations into `OutputRow`
4. `OutputRow` and leaf output components wrap matching substrings in `<mark>`

### Highlighting scope

**MVP highlighting:**

- prompt rows
- command rows
- error rows
- status rows
- header labels
- file path labels
- bash/tool summary strings
- plain response rows

**MVP diff behavior:**

- diff text is searchable
- navigation scrolls to the matching diff row
- the active diff row is visually emphasized
- exact inline diff-hunk highlighting inside `DiffView` is optional follow-up

This is the right tradeoff for the current architecture. Searching diff text is useful;
threading exact highlighted spans through `react-diff-view` can come later.

### `useOutputFind` hook

New file: `src/ui/webview-react/hooks/useOutputFind.ts`

```typescript
export interface OutputFindState {
  isOpen: boolean;
  query: string;
  matchCount: number;
  currentMatch: number; // 1-based
  caseSensitive: boolean;
}

export function useOutputFind(
  rows: OutputRenderRow[],
  onRevealRow: (rowIndex: number) => void,
  externalQuery?: string | null
) {
  const [state, setState] = useState<OutputFindState>({
    isOpen: false,
    query: "",
    matchCount: 0,
    currentMatch: 0,
    caseSensitive: false,
  });

  const matchesRef = useRef<OutputFindMatch[]>([]);

  const search = useCallback(
    (query: string, caseSensitive: boolean) => {
      if (!query) {
        matchesRef.current = [];
        setState((prev) => ({ ...prev, matchCount: 0, currentMatch: 0 }));
        return;
      }

      const matches = findOutputMatches(rows, query, caseSensitive);
      matchesRef.current = matches;

      setState((prev) => ({
        ...prev,
        matchCount: matches.length,
        currentMatch: matches.length > 0 ? 1 : 0,
      }));

      if (matches[0]) {
        onRevealRow(matches[0].rowIndex);
      }
    },
    [rows, onRevealRow]
  );

  const navigate = useCallback(
    (direction: 1 | -1) => {
      const matches = matchesRef.current;
      if (matches.length === 0) return;

      setState((prev) => {
        const nextIndex =
          (prev.currentMatch - 1 + direction + matches.length) % matches.length;
        onRevealRow(matches[nextIndex].rowIndex);
        return { ...prev, currentMatch: nextIndex + 1 };
      });
    },
    [onRevealRow]
  );

  return {
    state,
    setState,
    search,
    navigate,
    rowDecorations,
    activeMatch,
    open,
    close,
    handleKeyDown,
  };
}
```

### Virtualizer-aware navigation

`OutputSection` already owns the row virtualizer via `useOutputVirtualization()`, so
it should reveal matches by row index:

```typescript
rowVirtualizer.scrollToIndex(match.rowIndex, { align: "center" });
```

If the row needs one paint to mount before an active decoration becomes visible, queue
the active highlight update with `requestAnimationFrame`.

### Integration in `OutputSection`

`OutputSection` already computes `rows` (via `useOutputRowsModel()`) and
`rowVirtualizer` (via `useOutputVirtualization()`), and handles history/live mode
transitions. That is the correct integration point.

Hook usage:

```tsx
const {
  state: findState,
  setState: setFindState,
  open: openFind,
  close: closeFind,
  search: runSearch,
  navigate: navigateFind,
  handleKeyDown: handleFindKeyDown,
  rowDecorations,
  activeMatch,
} = useOutputFind(
  rows,
  (rowIndex) => rowVirtualizer.scrollToIndex(rowIndex, { align: "center" }),
  pendingFindQuery
);
```

Re-run search when `rows` changes, not when raw DOM changes:

```tsx
useEffect(() => {
  if (findState.isOpen && findState.query) {
    runSearch(findState.query, findState.caseSensitive);
  }
}, [
  rows,
  findState.isOpen,
  findState.query,
  findState.caseSensitive,
  runSearch,
]);
```

Pass decorations into `OutputRow`:

```tsx
<OutputRow
  row={row}
  isExecutionActive={isExecutionActive}
  findDecorations={rowDecorations.get(row.key)}
  activeFindMatch={activeMatch?.rowKey === row.key ? activeMatch : null}
  ...
/>
```

### Changes in `OutputRow` and leaf output components

`OutputRow.tsx` needs new props:

```typescript
findDecorations?: RowFindDecoration;
activeFindMatch?: OutputFindMatch | null;
```

Then thread them into the row-specific render paths:

- `prompt` row → highlight prompt text
- `cli-command` row → highlight command text
- `error` row → highlight error text
- `status` row → highlight message text
- `cli-header` → highlight step name / labels
- `structured-event`
  - file operation rows: path labels
  - bash/tool rows: summary text
  - text/thinking/tool-result rows: displayed text
- `plain-response`
  - highlight directly when the row is rendering raw / plain text
  - markdown-heavy highlighting can be a follow-up if needed

### Positioning

Render `OutputFindBar` inside the output view container with absolute positioning:

```text
top-right of the output pane, left of the minimap
```

No global CSS highlight rules are needed for the MVP because highlighting is done by
rendered `<mark>` elements and active-row styling.

---

## Implementation Phases

### Phase 1: In-Output Find Bar

1. Add `pendingFindQuery` to `uiStore` (`src/ui/webview-react/store/uiStore.ts`)
2. Add `outputFind.ts` row-search utilities
3. Create `useOutputFind`
4. Create `OutputFindBar`
5. Thread find decorations through `OutputSection` → `OutputRow`
6. Add highlighting to the row types that own searchable text
7. Add tests for row search and navigation behavior

**Deliverable:** `Ctrl+F` searches across the full virtualized output model,
shows correct match counts, scrolls between matches reliably, and highlights visible
matches in rendered rows.

### Phase 2: Global History Search, extension side

1. Add `HistorySearchResult` type to `src/types/WorkflowTimelineTypes.ts` (or a new
   `src/types/HistorySearchTypes.ts`)
2. Add `SEARCH_HISTORY`, `SEARCH_HISTORY_RESULTS`, `OPEN_HISTORY_SEARCH` to
   `DashboardConstants.ts`
3. Implement `HistorySearchService` (read queue file for workflowName/workflowFilePath)
4. Wire message handling in the extension router / webview provider

**Deliverable:** the extension can search history and return result sets with stable run
targets.

### Phase 3: Global History Search, webview side

1. Add search modal state to `uiStore` (`store/uiStore.ts`)
2. Handle `SEARCH_HISTORY_RESULTS` and `OPEN_HISTORY_SEARCH` in `useMessageHandler`
3. Create `HistorySearchModal`
4. Add the header search button
5. Register `flightpath.searchHistory`
6. Implement staged navigation: workflow load → run load → output find open

**Deliverable:** clicking a history result opens the correct workflow, loads the
correct historical run, and lands in the output pane with the find bar ready.

### Phase 4: Optional follow-up polish

1. Inline markdown highlighting in `MarkdownText`
2. Exact diff-hunk highlighting inside `DiffView`
3. Streaming history-search progress events if large histories need them
4. Optional persistent history index if search latency becomes noticeable

---

## Open Questions / Tradeoffs

**Q: Does the plan need updating because the output section now uses virtualized rows?**
The plan already accounts for this — DOM-wide highlight/search is explicitly rejected
in favor of row-indexed search. The concrete hook names (`useOutputRowsModel`,
`useOutputVirtualization`) are confirmed against the shipped implementation.

**Q: Why not keep CSS Custom Highlight API anyway?**
Because the browser can only highlight mounted DOM nodes. With virtualization, most rows
do not exist in the DOM at any given time, so counts and navigation would be wrong.

**Q: Should stats rows be searchable?**
Not in MVP. Matching on token counts and session IDs is noisy and low-value compared to
prompt/response/tool/file content.

**Q: Should diff hunks be searchable?**
Yes. Search the diff text in the row index. For MVP, scrolling to and emphasizing the
matching diff row is enough. Exact inline hunk highlighting can be added later.

**Q: Should markdown responses be fully inline-highlighted?**
Not required for MVP. Start with row-level navigation plus highlighting for plain text
and non-markdown labels. If users need exact inline markdown match paint, extend
`MarkdownText` in a follow-up.

**Q: Will this survive history switching and diff collapse changes?**
Yes, if the search re-runs against `rows` whenever `rows` changes. The row projection is
already the source of truth for virtualization, minimap layout, and history rendering.

**Q: Is result click sequencing fragile?**
It is if done naively. That is why the webview should stage pending navigation state and
wait for workflow-load completion before sending `LOAD_RUN_HISTORY`.

**Q: How does `HistorySearchService` get `workflowName` and `workflowFilePath`?**
The `WorkflowRunManifest` stored in `manifest.json` does not include these fields.
`HistorySearchService` reads `.flightpath/.queue/<workflowId>.flightpath.json`
(a `WorkingFile`) to get `workingFile.workflowName` and `workingFile.originalFile`.
If the queue file is missing (ephemeral/deleted workflow), the service falls back to
a name derived from `workflowId` and sets `workflowFilePath = ""`.
