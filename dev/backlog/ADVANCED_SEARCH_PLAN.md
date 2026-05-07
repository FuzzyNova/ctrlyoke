# Advanced Search Plan

## Overview

Two complementary search features:

1. **Global History Search** — search across all workflow runs stored in `.flightpath/.history/`.
   Surfaces results by workflow → run number → step, lets the user jump directly to the
   matching output and pre-populates the in-output find bar with the search term.

2. **In-Output Find Bar** — a Ctrl+F-style text search within the currently-displayed
   `OutputSection`, with highlighted matches and prev/next navigation. Used standalone
   and as the landing target for global history search.

---

## Feature 1: Global History Search

### What can be searched

The history timeline stores rich, structured data per run. Each `events.jsonl` file is
JSONL — one `WorkflowTimelineEvent` per line. The searchable fields are:

| Event type                | Searchable content                                                  |
|---------------------------|---------------------------------------------------------------------|
| `cliOutputRecorded`       | `payload.cliOutput.prompt` (prompt text sent to the AI)             |
| `cliOutputRecorded`       | `payload.cliOutput.response` (full AI response text)                |
| `cliOutputRecorded`       | `payload.cliOutput.cliCommand` (CLI command string)                 |
| `cliOutputRecorded`       | File paths in `payload.cliOutput.structured.events[]` (FILE_EDIT, FILE_WRITE, FILE_READ, FILE_DELETE data.path) |
| `cliOutputRecorded`       | Bash command strings (`data.command` in BASH events)                |
| `statusMessageRecorded`   | `payload.statusMessage.message`                                     |

Everything searchable lives in the history files — no need to read working files for search.

The `manifest.json` for each run contains `workflowId`, `runId`, `startedAt`,
`completedAt`, and `executionState` — all useful for labeling results.

### Extension-side: HistorySearchService

New file: `src/flightpath/orchestration/HistorySearchService.ts`

**Responsibility:** Stream-search `events.jsonl` files across all workflow runs, return
ranked `HistorySearchResult[]`.

```typescript
export interface HistorySearchResult {
  workflowId: string;           // directory name under .history/
  workflowName: string;         // extracted from workflowId (strip timestamp suffix)
  runId: number;                // 1-based run number from manifest
  runIndex: number;             // 0 = most recent, for LOAD_RUN_HISTORY message
  startedAt: number;            // run timestamp, for display
  executionState: string;       // completed / running / error / cancelled
  target: OutputExecutionTarget; // { kind, stepIndex } or { kind, loopIndex }
  matchType: "response" | "file" | "bash" | "status" | "prompt";
  matchSnippet: string;         // ~100-char excerpt with the match centered
  matchContext: string;         // display label: "Prompt 2" / "Final Step Loop 1"
  filePath?: string;            // populated for matchType === "file"
  workflowFilePath: string;     // absolute path for LOAD_WORKFLOW message
}
```

**Algorithm (streaming, avoids loading whole files):**

```
For each workflow-id directory in historyBaseDir:
  Get manifest.json — skip if unreadable
  Read events.jsonl line by line (readline interface)
    For each line:
      JSON.parse → WorkflowTimelineEvent
      If CLI_OUTPUT_RECORDED:
        Search prompt, response, cliCommand
        Search each structured event for file paths and bash commands
      If STATUS_MESSAGE_RECORDED:
        Search message text
      Collect matches with target (kind + index) and snippet
  Map run directories → run indices (newest = 0) for LOAD_RUN_HISTORY
```

**Performance considerations:**
- Search is initiated on demand (not indexed), so debounce to 400ms before firing.
- Cap results at 50 total. Stop scanning events.jsonl files once cap is reached.
- Scan runs newest-first within each workflow; scan workflows alphabetically.
- Minimum query length: 2 characters.
- No persistent index needed for MVP — history directories are small enough that
  line-by-line JSONL streaming is fast (sub-second for typical history sizes).
- If performance becomes a concern, a background index (inverted index written to
  `.flightpath/.history/_search-index.json`) can be added as a separate phase.

### Message types

Add to `src/types/DashboardConstants.ts`:

```typescript
MESSAGE_TYPES.SEARCH_HISTORY          // webview → extension: { query: string }
MESSAGE_TYPES.SEARCH_HISTORY_RESULTS  // extension → webview: { query: string, results: HistorySearchResult[], hasMore: boolean }
```

The extension side handles `SEARCH_HISTORY` in `FlightPathWebviewProvider` (or its
message handler delegation class), constructs `HistorySearchService`, runs the search,
and replies with `SEARCH_HISTORY_RESULTS`.

### Workflow ID → file path resolution

`HistorySearchService` needs to resolve the workflowId back to an absolute working file
path so the webview can open the workflow. The working file lives in
`.flightpath/.queue/<workflowId>.flightpath.json`. The service should check for
`.flightpath.json`, `.flightpath.yaml`, `.flightpath.yml` suffixes.

### UI: WorkflowStatus dropdown integration

`WorkflowStatus.tsx` already has a `workflowSearch` state driving local filtering. The
enhancement adds a global-history search mode that activates when:
- The workflow title search input gains focus AND the query length ≥ 2 characters, OR
- A toggle/icon button explicitly switches to "history search" mode.

**Option A — Unified search with automatic mode detection (recommended):**

The existing search input searches workflow titles immediately (as it does now).
Simultaneously, after a 400ms debounce, it sends `SEARCH_HISTORY`. Results arrive
asynchronously and are shown in a new "History Matches" section below the existing
recent-workflows list. This keeps the fast title search while adding the slower
history search as an overlay. No mode toggle needed.

**Option B — Explicit toggle:**

A small `history` icon button next to the search input switches to dedicated history
search mode. Simpler to implement, but slightly worse UX because the user has to know
to toggle it.

Proceed with **Option A**.

**Result row design:**

```
┌──────────────────────────────────────────────────────────┐
│ 🕐 my-feature-workflow        Run 3 · Prompt 2           │
│    response: "...the `src/auth/login.ts` file needs..."  │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ 🕐 refactor-api               Run 1 · Prompt 4           │
│    file: src/api/routes.ts                               │
└──────────────────────────────────────────────────────────┘
```

- Left icon: a small clock/history codicon
- Top line: workflow name (bold), run number and step label (muted)
- Bottom line: matchType label + snippet or file path
- Hover state: `bg-list-hover-bg`

**Click action:**

1. Send `LOAD_WORKFLOW` with `workflowFilePath`
2. After the workflow loads, send `LOAD_RUN_HISTORY` with `runIndex`
3. Store `{ pendingFindQuery: query }` in `uiStore`
4. Close the dropdown

When `OutputSection` detects `uiStore.pendingFindQuery` is non-null after a history
load completes (watch `isViewingHistory` + `historyOutputs`), it opens the find bar
pre-populated with that query and clears `pendingFindQuery`.

### State additions

**`uiStore`:**
```typescript
historySearchResults: HistorySearchResult[];
historySearchQuery: string;
historySearchLoading: boolean;
pendingFindQuery: string | null;   // populated when jumping from global search
```

---

## Feature 2: In-Output Find Bar

### Component: `OutputFindBar`

New file: `src/ui/webview-react/components/output/OutputFindBar.tsx`

A floating bar that appears inside `OutputSection`, overlaid at the top-right of the
output scroll area (matching VS Code's native find widget position).

**State (managed in OutputSection or a `useOutputFind` hook):**
```typescript
interface OutputFindState {
  isOpen: boolean;
  query: string;
  matchCount: number;
  currentMatch: number;   // 1-based, 0 if no matches
  caseSensitive: boolean;
}
```

**Controls:**
- Text input
- `N of M` match counter
- Up/Down arrows (prev/next match)
- Case-sensitive toggle button (Aa icon)
- Close button (×)

**Keyboard:**
- `Ctrl+F` / `Cmd+F` → open (key handler added to OutputSection)
- `Enter` / `F3` → next match
- `Shift+Enter` / `Shift+F3` → prev match
- `Escape` → close and remove highlights

### DOM highlight strategy

The output area (`#output-content`) renders complex React-managed HTML. To avoid
fighting React's reconciliation, we use **CSS custom highlight API** (`CSS.highlights`)
where supported, with a `TreeWalker` + `Range` fallback for older browsers.

**Recommended approach (CSS Custom Highlight API — supported in Chrome 105+, Edge 105+, Safari 17.2+):**

```typescript
function applyHighlights(container: HTMLElement, query: string, caseSensitive: boolean): Range[] {
  CSS.highlights.delete("fp-find");
  if (!query) return [];

  const matches: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const normalQuery = caseSensitive ? query : query.toLowerCase();

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = caseSensitive ? node.textContent ?? "" : (node.textContent ?? "").toLowerCase();
    let idx = 0;
    while ((idx = text.indexOf(normalQuery, idx)) !== -1) {
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      matches.push(range);
      idx += query.length;
    }
  }

  if (matches.length > 0) {
    CSS.highlights.set("fp-find", new Highlight(...matches));
  }
  return matches;
}
```

In `globals.css`:
```css
::highlight(fp-find) {
  background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.3));
  color: inherit;
}
::highlight(fp-find-current) {
  background-color: var(--vscode-editor-findMatchBackground, rgba(255,150,0,0.6));
  color: inherit;
}
```

A second `Highlight` named `fp-find-current` tracks the active match and is updated
as the user navigates with arrow keys / Enter.

**Fallback (mark element wrapping):** For environments where `CSS.highlights` is not
available, insert `<mark data-fp-find>` elements via DOM manipulation.
The marks are inserted with `range.surroundContents()`. On close or query change, they
are removed with `unwrap()`. This is simple but can break React-rendered content if
React tries to reconcile on those nodes — mitigate by only removing marks right before
React would re-render (on close), and rebuilding them after each render cycle.

Given the VS Code webview engine (Chromium), CSS Custom Highlight API is the primary
path. Implement fallback only if testing reveals it's needed.

### `useOutputFind` hook

New file: `src/ui/webview-react/hooks/useOutputFind.ts`

```typescript
export function useOutputFind(containerRef: RefObject<HTMLElement | null>, externalQuery?: string | null) {
  const [state, setState] = useState<OutputFindState>({
    isOpen: false, query: "", matchCount: 0, currentMatch: 0, caseSensitive: false,
  });

  const matchesRef = useRef<Range[]>([]);

  const open = useCallback((initialQuery?: string) => {
    setState(prev => ({ ...prev, isOpen: true, query: initialQuery ?? prev.query }));
  }, []);

  const close = useCallback(() => {
    CSS.highlights?.delete("fp-find");
    CSS.highlights?.delete("fp-find-current");
    setState(prev => ({ ...prev, isOpen: false, query: "", matchCount: 0, currentMatch: 0 }));
  }, []);

  // Re-run search when query, caseSensitive, or rendered content changes
  // (OutputSection passes allMessages.length as a dep to trigger re-search)
  const search = useCallback((query: string, caseSensitive: boolean) => {
    if (!containerRef.current || !query) {
      CSS.highlights?.delete("fp-find");
      CSS.highlights?.delete("fp-find-current");
      matchesRef.current = [];
      setState(prev => ({ ...prev, matchCount: 0, currentMatch: 0 }));
      return;
    }
    const matches = applyHighlights(containerRef.current, query, caseSensitive);
    matchesRef.current = matches;
    setState(prev => ({ ...prev, matchCount: matches.length, currentMatch: matches.length > 0 ? 1 : 0 }));
    if (matches[0]) scrollToRange(matches[0]);
    setCurrentHighlight(0);
  }, [containerRef]);

  const navigate = useCallback((direction: 1 | -1) => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    setState(prev => {
      const next = ((prev.currentMatch - 1 + direction + matches.length) % matches.length);
      scrollToRange(matches[next]);
      setCurrentHighlight(next);
      return { ...prev, currentMatch: next + 1 };
    });
  }, []);

  // Ctrl+F / Cmd+F keyboard handler (attached to the output section element)
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      open();
    }
  }, [open]);

  // When externalQuery arrives (from global history search jump), open with it
  useEffect(() => {
    if (externalQuery) open(externalQuery);
  }, [externalQuery, open]);

  return { state, setState, open, close, search, navigate, handleKeyDown };
}
```

`scrollToRange` scrolls the container so the range is visible:
```typescript
function scrollToRange(range: Range) {
  range.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
}
```

`setCurrentHighlight` updates the `fp-find-current` Highlight:
```typescript
function setCurrentHighlight(index: number) {
  CSS.highlights?.delete("fp-find-current");
  const range = matchesRef.current[index];
  if (range) CSS.highlights?.set("fp-find-current", new Highlight(range));
}
```

### Integration in OutputSection

`OutputSection` gets a `useOutputFind` call using `outputRef` as the container:

```tsx
const pendingFindQuery = useUiStore(s => s.pendingFindQuery);
const clearPendingFindQuery = useUiStore(s => s.clearPendingFindQuery);

const { state: findState, setState: setFindState, open: openFind,
        close: closeFind, search: runSearch, navigate: navigateFind,
        handleKeyDown: handleFindKeyDown } = useOutputFind(outputRef, pendingFindQuery);

// Clear the pending query after opening
useEffect(() => {
  if (pendingFindQuery) clearPendingFindQuery();
}, [pendingFindQuery, clearPendingFindQuery]);

// Re-search when content changes and bar is open
useEffect(() => {
  if (findState.isOpen && findState.query) {
    runSearch(findState.query, findState.caseSensitive);
  }
}, [allMessages.length, findState.isOpen, findState.query, findState.caseSensitive]);

// Attach keyboard listener to output container
useEffect(() => {
  const el = outputRef.current;
  if (!el) return;
  el.addEventListener("keydown", handleFindKeyDown);
  return () => el.removeEventListener("keydown", handleFindKeyDown);
}, [handleFindKeyDown]);
```

The find bar renders inside the `OutputSection` return, positioned absolutely over
the scroll container:

```tsx
{activeOutputTab === "output" && (
  <div className="relative flex flex-row min-h-0 flex-1">
    <div ref={outputRef} id="output-content" className="..." onScroll={handleScroll}>
      {/* existing content */}
    </div>

    {findState.isOpen && (
      <OutputFindBar
        query={findState.query}
        matchCount={findState.matchCount}
        currentMatch={findState.currentMatch}
        caseSensitive={findState.caseSensitive}
        onQueryChange={(q) => { setFindState(p => ({...p, query: q})); runSearch(q, findState.caseSensitive); }}
        onToggleCase={() => setFindState(p => ({...p, caseSensitive: !p.caseSensitive}))}
        onNext={() => navigateFind(1)}
        onPrev={() => navigateFind(-1)}
        onClose={closeFind}
      />
    )}

    {hasOutput && <OutputMinimap ... />}
  </div>
)}
```

`OutputFindBar` is positioned with `absolute top-1 right-2 z-50` (above scroll content,
right of the output area, left of the minimap).

---

## Implementation Phases

### Phase 1: In-Output Find Bar (self-contained, no backend needed)

1. Add `pendingFindQuery` to `uiStore`
2. Create `useOutputFind` hook
3. Create `OutputFindBar` component  
4. Integrate into `OutputSection`
5. Add CSS highlight rules to `globals.css`

Deliverable: Ctrl+F opens a find bar that highlights matches in the current output view.

### Phase 2: Global History Search — Extension Side

1. Add `HistorySearchResult` type to `src/types/`
2. Add `SEARCH_HISTORY` / `SEARCH_HISTORY_RESULTS` to `DashboardConstants.ts`
3. Implement `HistorySearchService`
4. Wire message handler in `FlightPathWebviewProvider`

Deliverable: Extension can respond to a search query with ranked results from history.

### Phase 3: Global History Search — Webview UI

1. Add `historySearchResults`, `historySearchQuery`, `historySearchLoading` to `uiStore`
2. Handle `SEARCH_HISTORY_RESULTS` in `useMessageHandler`
3. Add debounced search dispatch to `WorkflowStatus` search input
4. Add "History Matches" section to the workflow dropdown
5. Implement click → load workflow + run → open find bar with query

Deliverable: Searching in the workflow dropdown returns history results; clicking jumps
to the matching run and highlights the term.

---

## Open Questions / Tradeoffs

**Q: Should global search be synchronous (blocking) or streamed?**  
Streaming results would show partial results as they arrive (good for large history sets).
An initial MVP can be a single response after full scan; add streaming via an
`SEARCH_HISTORY_PROGRESS` message type if needed.

**Q: Should file-path matches do any special path normalization?**  
No. The search input is a plain string and all fields are matched as substrings. File
paths are no different from any other text — if the user types the wrong slashes and
it doesn't match, that's on them.

**Q: What about searching prompt text and CLI commands?**  
Both are stored directly on `CliOutput` (`prompt: string` and `cliCommand?: string`) and
are therefore present in every `cliOutputRecorded` event in `events.jsonl`. Include them
in the initial implementation — no per-harness availability concerns.

**Q: CSS Custom Highlight API availability?**  
The VS Code webview runs on Electron's bundled Chromium. Electron 28+ (VS Code 1.87+)
ships Chromium 120+, which fully supports `CSS.highlights`. A `"CSS" in window &&
"highlights" in CSS` feature check is all that's needed to guard the fallback path.

**Q: Find bar and re-renders — will React's reconciliation break the DOM highlights?**  
CSS Custom Highlights operate on `Range` objects tied to live DOM nodes. React's
reconciliation only replaces DOM nodes that actually change. For streaming output (new
chunks arrive), only the last `CliOutput` re-renders; existing matches in earlier nodes
remain valid. The `useEffect` that re-runs `runSearch` when `allMessages.length` changes
handles new content appearing below the current search position.

**Q: What if the working file for a history result no longer exists?**  
`HistorySearchService` should check for working file existence before including a result.
If the file is missing, either omit the result or show it as "archived" with the
LOAD_WORKFLOW sending a restore-from-history path.
