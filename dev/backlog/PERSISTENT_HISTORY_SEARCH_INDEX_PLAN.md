# Persistent History Search Index Plan

> **Status:** Design draft - not implemented. Scope should be reviewed before coding.

---

## Summary

History search currently scans `.flightpath/.history/**/events.jsonl` on every query and
returns at most 50 matches. That keeps the write path simple, but it makes larger
workspaces slow and prevents true result counts, paging, and infinite scroll. Build a
persistent, machine-local search index under `.flightpath/.search-index/` so the UI can
query indexed records instead of reparsing history files for every keystroke.

The index is runtime data and must remain gitignored, just like `.history/`, `.queue/`,
`logs/`, and `temp/`.

---

## Goals

- Fast substring search across persisted history without scanning all timeline files per
  query.
- Accurate `totalCount`, `hasMore`, and cursor/page support for the search drawer.
- Incremental updates as timeline events are recorded.
- Rebuild support when the index is missing, stale, corrupt, or schema-incompatible.
- Preserve current result semantics: queue working-file path in `workflowFilePath`,
  newest runs first, match types, snippets, contexts, and result navigation targets.

## Non-Goals

- Cloud/shared index sync.
- Searching live in-memory output before it is persisted to timeline storage.
- Fuzzy ranking as the first implementation.
- Indexing arbitrary workspace files outside FlightPath history.
- Making `.flightpath/.history/` itself tracked or portable.

---

## Storage Layout

Use a dedicated runtime directory:

```text
.flightpath/.search-index/
├── manifest.json
├── documents.jsonl
└── terms.jsonl              optional phase 2
```

MVP can start with `documents.jsonl` plus an in-memory index loaded from it. Persisting
precomputed term/posting data can follow if load time becomes the bottleneck.

`manifest.json`:

```ts
interface HistorySearchIndexManifest {
  schemaVersion: "1.0.0";
  builtAt: number;
  workspaceRootHash: string;
  historyRootMtimeMs?: number;
  indexedRuns: Record<
    string,
    {
      manifestPath: string;
      eventsPath: string;
      workflowId: string;
      runId: number;
      startedAt: number;
      eventCount: number;
      lastUpdatedAt: number;
      sourceManifestMtimeMs: number;
      sourceEventsMtimeMs: number;
    }
  >;
}
```

`documents.jsonl` stores one searchable match candidate per line:

```ts
interface HistorySearchDocument {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowFilePath: string;
  runId: number;
  runIndex: number;
  startedAt: number;
  executionState: string;
  target: OutputExecutionTarget;
  attemptIndex: number;
  sequence: number;
  timestampMs: number;
  matchType: HistorySearchResult["matchType"];
  text: string;
  normalizedText: string;
  filePath?: string;
}
```

Keep `text` in the index for snippet extraction. If index size becomes a problem, store a
bounded excerpt plus a pointer back to the source event, but that would make snippets and
rebuild validation more expensive.

---

## Service Design

Add `HistorySearchIndexService` in `src/flightpath/orchestration/`.

Responsibilities:

- Own index directory paths via `PATH_CONSTANTS.SEARCH_INDEX_DIR`.
- Build/rebuild the document index from `.flightpath/.history`.
- Incrementally index a run when its manifest/event file changes.
- Load the persisted index into memory once per extension process.
- Serve search queries with paging and true counts.
- Detect stale/corrupt index state and schedule rebuilds.

Keep `HistorySearchService` as the public query facade used by `WebviewMessageRouter`.
Internally it can delegate to `HistorySearchIndexService`, falling back to the existing
disk scan only when the index is unavailable or rebuilding.

Suggested query shape:

```ts
interface HistorySearchQuery {
  query: string;
  limit: number;
  cursor?: string;
  filters?: {
    matchTypes?: HistorySearchResult["matchType"][];
    workflowIds?: string[];
    since?: number;
    until?: number;
  };
}

interface HistorySearchResponse {
  query: string;
  results: HistorySearchResult[];
  totalCount: number;
  nextCursor?: string;
  hasMore: boolean;
  indexState: "ready" | "building" | "fallback";
}
```

Cursor can be an opaque base64url JSON payload containing `{ offset, queryHash,
sortVersion }`. Offset paging is acceptable while all matches are computed in memory.

---

## Indexing Strategy

### MVP

Use a persisted document list and in-memory substring matching:

1. Load `documents.jsonl` into memory on first search.
2. Normalize query with `trim().toLowerCase()`.
3. Filter documents using `normalizedText.includes(normalizedQuery)`.
4. Sort by `startedAt desc`, then `timestampMs desc`, then `sequence desc`.
5. `totalCount = matches.length`.
6. Return `matches.slice(offset, offset + limit)`.

This already fixes the largest cost: repeated JSONL disk reads and event extraction on
every keystroke.

### Phase 2

If document filtering is still too slow, add a substring-friendly index:

- Generate trigrams from `normalizedText`.
- Store `term -> document ids` postings in memory.
- For queries with length >= 3, intersect trigram postings before validating with
  `includes`.
- For 2-character queries, either scan the document list or maintain bigram postings.

Avoid generic full-text token indexes for the first pass because FlightPath needs
substring matches across paths, commands, snippets, tool names, and diffs.

---

## Write Path

Index updates should stay aligned with timeline persistence:

- `TimelineRecorder` remains the source of truth for `manifest.json` and `events.jsonl`.
- Do not make the index part of the critical path for successful run history writes.
- After events are appended or a manifest is updated, enqueue an async index update for
  that run.
- Serialize index writes with `FileLockUtils` or a dedicated index write queue to avoid
  corrupting `documents.jsonl`.
- If an index update fails, log a warning and mark the index stale; future searches can
  fall back or trigger rebuild.

Practical integration points:

- `OutputHistoryManager` can notify the index service after timeline updates because it
  already owns history persistence at the orchestration boundary.
- CLI/headless paths that write history through the same manager get indexing for free.
- If any code writes through `TimelineRecorder` directly, add a narrow notification hook
  rather than duplicating index calls.

---

## Rebuild And Staleness

Rebuild when:

- `.flightpath/.search-index/manifest.json` is missing.
- `schemaVersion` differs.
- `documents.jsonl` is unreadable or contains invalid JSONL.
- A source run manifest has a newer `lastUpdatedAt`, `eventCount`, or file mtime than
  the indexed run entry.
- A run exists in index manifest but no longer exists on disk.

Rebuild behavior:

- Write into `.flightpath/.search-index/rebuild-<timestamp>/`.
- Validate record count and manifest.
- Atomically swap files into place where possible.
- Remove old rebuild directories opportunistically.
- Expose `indexState: "building"` so the UI can show partial/fallback state without
  blocking typing.

---

## API And UI Changes

Update message contracts:

- `SEARCH_HISTORY` accepts `limit`, `cursor`, and optional filters.
- `SEARCH_HISTORY_RESULTS` returns `totalCount`, `nextCursor`, `hasMore`, and
  `indexState`.

Search drawer behavior:

- Show true count: `137 results`.
- Show a loading row while requesting the next page.
- Use infinite scroll or a "Load more" footer. Prefer "Load more" first because it is
  deterministic and easier to test; infinite scroll can wrap the same action later.
- Reset cursor/results when query or filters change.
- Keep current result navigation unchanged.

---

## Testing

Add unit tests for:

- Index build from multiple workflows and runs.
- Rebuild on missing/corrupt/stale manifest.
- Incremental update after a run gains new events.
- True `totalCount`, `nextCursor`, and stable page ordering.
- Existing search classifications: response, file, bash, status, prompt, tool, diff.
- Queue working-file path remains the returned `workflowFilePath`.

Add webview tests for:

- Result count display.
- Load-more appends without replacing previous results.
- Query changes clear cursor/results and start a fresh search.
- Stale responses for an old query are ignored.

---

## Migration Plan

1. Add path constant and gitignore entry for `.flightpath/.search-index/`.
2. Add `HistorySearchIndexService` with full rebuild and in-memory query support.
3. Extend message/result types for paging and counts.
4. Update `HistorySearchService` to delegate to the index with fallback.
5. Wire index update notifications from history persistence.
6. Update search drawer UI for count and load-more.
7. Add corruption/staleness handling and telemetry/logging around rebuild duration.

---

## Open Questions

- Should the first query block until the initial index build completes, or should it use
  fallback scan and build in the background?
- How large can `documents.jsonl` reasonably get in active workspaces, and when do we
  need trigram postings?
- Should `text` be stored verbatim in the index, or should we cap indexed text and accept
  source-event reads for long snippets?
- Do we need explicit commands such as "Rebuild FlightPath Search Index" and "Clear
  FlightPath Search Index"?
