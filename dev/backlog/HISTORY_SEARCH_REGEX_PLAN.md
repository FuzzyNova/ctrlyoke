# History Search — regex mode

> **Status: Step 5 implemented; drawer exposure remains.** This is the
> architectural decision for the regex-search follow-up to
> `dev/implemented/CLI_HISTORY_SEARCH_PLAN.md`.
> Step 1 added the end-to-end `--deep` test; this document began as step 2 of 6
> and now records the step 4 regex implementation.
>
> **Re-verified:** 2026-09-20 against the current source. The remaining line
> references below are implementation anchors for steps 4–6.

## Decision

Choose **(a) a terminatable worker thread** for regex matching.

JavaScript `RegExp` has no timeout. A static rejection list cannot prove that
the remaining patterns are safe, and a deadline checked between documents
cannot interrupt one `RegExp.prototype.exec` call. The deep scanner is the
important failure mode: it evaluates candidate text before the bounded
projection is created (`src/core/orchestration/HistoryRunDeepScanner.ts:99-117`),
so a pathological pattern can hold the extension host in one call over a
multi-megabyte event field. That is unacceptable in a product whose documented
failure modes include extension-host hangs and V8 heap OOMs
(`.github/copilot-instructions.md:39-47`, especially line 41).

The matcher worker owns regex evaluation and is disposable. The main thread
streams candidate text to it, receives `{ index, length }` matches, and applies
the existing filtering, deduplication, ordering, and projection rules. A
parent-side watchdog terminates the worker when a request exceeds its budget;
the search returns a typed regex-timeout error rather than leaving the host
blocked. A stuck match is therefore the specific case the design can stop,
not merely a case the caller notices after the scan reaches another document.

There is already a worker precedent: the rebuild worker is built as a separate
Node bundle (`esbuild.js:396-409`), spawned with a resource limit
(`src/core/orchestration/HistorySearchIndexService.ts:1008-1012`), and located
through compiled-path candidates (`src/core/orchestration/HistorySearchIndexService.ts:1062-1070`).
Add a separate `historySearchMatcherWorker.ts` rather than coupling matching to
the index rebuild worker. Build it beside the existing worker as
`out/historySearchMatcherWorker.js` and resolve it with the same two-location
pattern.

### Why not the other two options?

- **(b) Static rejection plus a deadline** is a useful secondary defense, but
  not the primary guarantee. Rejecting nested unbounded quantifiers would miss
  other expensive expressions, and a deadline between documents leaves one
  pathological document uncancellable. It would still be worth rejecting
  obviously dangerous shapes and limiting ordinary work once the worker exists;
  those measures must be described as resource controls, never as a hard
  regex-time bound.
- **(c) `re2` or another linear-time engine** would remove the backtracking
  class of risk, but it is a native addon. The VSIX already has explicit native
  packaging for `node-pty` and `node-addon-api` (`.vscodeignore:55-59`), while
  esbuild copies isolated runtime package trees separately
  (`esbuild.js:284-306`). A regex engine would require its own package-lock,
  VSIX inclusion, Node/Electron ABI handling, and prebuild or build-toolchain
  coverage for every supported Windows, macOS, and Linux architecture. It
  would also need a separate CLI/runtime packaging decision. That is a larger
  distribution commitment than this feature warrants; revisit it only if the
  worker's measured overhead or operational complexity proves unacceptable.

## Measurements

The throwaway prototype was run inline with `node -e`; it created no repository
file. Environment: Node `v22.17.0` on the development Windows host. The
representative document was a synthetic 1,000,000-character string, matching
the relevant shape of an uncapped deep-scan candidate rather than the 2,000
character indexed cap (`src/core/orchestration/historySearchRebuildWorker.ts:30-35`).

| Test                                                                |                          Result |
| ------------------------------------------------------------------- | ------------------------------: |
| Current deep-style `textLower.includes("needle")`, 1,000 iterations | 47.512 ms total, 47.5 µs/search |
| Literal `/needle/` regex, 1,000 iterations                          | 47.219 ms total, 47.2 µs/search |
| `/(a+)+$/` against 20 `a` characters plus `!`                       | 131 ms inside the child process |
| Same pathological pattern against 25 characters                     |    exceeded a 1,000 ms watchdog |
| Same pathological pattern against 1,000,000 characters              |    exceeded a 1,000 ms watchdog |

The normal literal-regex cost was indistinguishable from the current matcher in
this run. The pathological case is not: five additional input characters
crossed the watchdog, and the deep-sized input did not complete within it. The
worker is consequently selected for safety, not for expected throughput.

The shipped worker uses a 1,000 ms parent-side watchdog for each candidate
evaluation. The focused catastrophic-pattern test used 30 `a` characters plus
`!` and rejected the match in 1,035 ms on the same Windows/Node 22 host. A
normal indexed regex search in the focused suite completed in 30 ms after the
worker was started. The watchdog bounds one regex evaluation and terminates its
worker; it does not make a sequence of many expensive-but-under-budget
evaluations fast, and it does not prevent the memory or scheduling pressure of
large candidate strings being copied to the worker.

## Single matcher contract

Add `src/core/orchestration/HistorySearchMatcher.ts`. It is the only place that
knows whether a query is a substring or regex:

```ts
export interface HistorySearchMatch {
  index: number;
  length: number;
}

export interface HistorySearchMatcher {
  find(text: string): HistorySearchMatch | undefined;
  findAsync?(
    text: string,
    signal?: AbortSignal
  ): Promise<HistorySearchMatch | undefined>;
  /** A conservative literal required in every possible match, if one exists. */
  readonly requiredLiteral?: string;
  dispose?(): void;
}

export function createHistorySearchMatcher(
  query: string,
  regex: boolean
): HistorySearchMatcher;
```

`SubstringHistorySearchMatcher implements HistorySearchMatcher` lowercases the
query once and returns the first `indexOf` position plus `query.length`.
`RegexHistorySearchMatcher implements HistorySearchMatcher` compiles the raw
pattern once and returns `RegExpExecArray.index` plus `match[0].length`. It uses
the `i` flag so regex mode preserves today's unconditional case-insensitive
behavior; it does not accept a second user-controlled flags field. A zero-length
regex match is valid and returns `length: 0`.

The factory is selected from the typed query (`regex === true`), never by
string-keyed dispatch. It eagerly compiles regex mode and throws
`InvalidHistorySearchPatternError` with the source pattern and native parse
message when construction fails. The worker validates again after startup so
its protocol cannot receive an unparseable job.

All full-text matching uses this contract:

- indexed documents replace the boolean check at
  `HistorySearchIndexService.ts:677-684`;
- the legacy disk fallback replaces `matchesQuery` at
  `HistorySearchService.ts:361-363`;
- the deep scanner replaces its capped precheck and `indexOf` pair at
  `HistoryRunDeepScanner.ts:101-116`;
- `projectHistorySearchResult` and `extractSnippet` receive the actual
  `HistorySearchMatch`, so `HistorySearchResultUtils.ts:67-85` never derives the
  end from `query.length`;
- `createBoundedTextProjection` receives the match object, so
  `HistoryRunDeepScanner.ts:135-157` uses `match.index + match.length`.

The raw-line prefilter is a candidate optimization rather than a full decoded
text match. It consumes `matcher.requiredLiteral` from this same contract; it
must never call `find` on JSON-escaped serialized text.

## Regex prefilter

`createHistorySearchLinePrefilter` currently checks a JSON-stringified,
lowercased query against the raw JSONL line (`HistorySearchShardScanner.ts:179-206`),
and `streamHistorySearchDocuments` invokes it before parsing a document
(`HistorySearchShardScanner.ts:265-299`). Applying the regex to that raw line
would change the language being matched because quotes, backslashes, and
control characters are escaped.

For regex mode, the matcher factory must conservatively extract one **required
literal substring** from the pattern. Choose the longest literal proven to occur
in every successful match, including across alternatives; do not extract a run
from only one branch. Literal escaped characters such as `\\.` may qualify.
Character classes, captures without a guaranteed literal, wildcards, anchors,
quantifiers that make a run optional, and alternations with no common literal
produce no extraction. A false negative is worse than a missed optimization,
so any uncertainty returns `requiredLiteral: undefined`.

When a literal exists and is ASCII, the prefilter serializes its lowercased
form with `JSON.stringify(...).slice(1, -1)` and checks the same persisted
`textLower`/raw-line variants as today. When the literal is non-ASCII, or no
literal can be proven, return the existing no-prefilter function `() => true`.
The non-ASCII escape already exists at `HistorySearchShardScanner.ts:196-197`,
so this is an extension of an established path, not a new streaming mode.
The decoded document is always passed to the full matcher after the prefilter;
the literal only decides whether parsing can be skipped.

## Case, minimum length, and persisted lowercase text

Regex mode is case-insensitive (`i`), matching the existing `toLowerCase()`
behavior in the indexed and fallback paths. The persisted lowercase `textLower`
field from index schema `4.2.0` remains a prefilter/storage optimization, not
the regex input: the full matcher runs against original `document.text`. This
avoids changing regex semantics to fit the index and preserves the existing
schema.

`MIN_QUERY_LENGTH` remains **2** for the trimmed pattern. The service does not
scan a one-character pattern, and the drawer keeps its current two-character
debounce gate (`HistorySearchDrawer.tsx:247-265`, `:281-298`). Regex syntax is
validated before the service returns a result, so CLI callers still receive a
clean usage error for an invalid `--regex` pattern; the drawer should validate
only once its normal minimum-length gate permits a search, keeping intermediate
typing from turning into a blocking error state.

## Cache and snapshot identity

Regex mode is part of every search identity:

1. Add `regex` to `HistorySearchQuery` beside `deep` and `exhaustive`
   (`src/types/WorkflowTimelineTypes.ts:174-189`).
2. Pass it into `HistorySearchIndexService.getSnapshotKey` and include the
   boolean in the hashed object alongside `deep` and `snippetChars`
   (`src/core/orchestration/HistorySearchIndexService.ts:1150-1168`). A
   substring snapshot must never answer a regex request or vice versa.
3. Add it to the drawer's `listingId`/query key, next to the existing
   `deep`/`shallow` suffix (`HistorySearchDrawer.tsx:431-436`). Use the same
   key for page reset and virtualized-list identity.
4. Add it to the router listing key too; the current shared key already
   separates `deep` at `src/ui/WebviewMessageRouter.ts:138-153`. This prevents
   cancellation and partial-result bookkeeping from crossing modes before the
   core snapshot is consulted.

## Errors and worker protocol

Invalid source is a usage error, not an operational crash. The factory throws a
typed `InvalidHistorySearchPatternError`; the CLI handler catches it, names the
pattern and parse failure, and exits with code 2. The drawer catches the same
typed error at the message boundary, keeps the input editable, clears only the
in-flight result state, and renders inline feedback under the input. It must not
turn the error into an empty successful result list or leave loading true.

The matcher worker protocol should be small and ordered: one search request
contains the pattern and matcher mode; candidate messages contain a document
identifier and text; result messages return that identifier plus
`index`/`length`; an end message closes the request. The parent owns filters,
dedupe, paging, and result projection so indexed, fallback, deep, drawer, and
CLI behavior cannot diverge. A watchdog covers the active request and calls
`worker.terminate()` on expiry; termination becomes a typed timeout response.
Abort/cancellation also terminates the worker and is not reported as a user
error.

## Execution plan for steps 3–6

### Step 3 — single-source the matcher — implemented 2026-09-20

`HistorySearchMatcher.ts` now exposes the planned `HistorySearchMatch` and
`HistorySearchMatcher` contracts, plus
`createHistorySearchMatcher(query: string, regex: boolean)` and the nominal
`SubstringHistorySearchMatcher implements HistorySearchMatcher` implementation.
The factory currently rejects `regex: true` until step 4; substring mode is the
only supported mode in this step. The indexed, fallback, deep, and raw-line
prefilter paths now share the matcher, and snippet/projection helpers consume
the match position and length. Focused matcher tests cover index 0, a middle
match, no match, case-insensitivity, and a query longer than the text. Existing
substring behavior and tests remain unchanged.

### Step 4 — implement regex in core

Implemented 2026-09-20. Added `regex?: boolean` to `HistorySearchQuery`, the
case-insensitive regex matcher, typed invalid-pattern and timeout errors,
conservative required-literal extraction, and the separately bundled,
terminatable matcher worker. Regex matching now reaches the indexed path, the
legacy disk fallback, and the deep scanner through the shared matcher; substring
mode keeps its synchronous implementation and existing behavior. Snapshot
identity includes regex mode, and the raw JSONL prefilter either uses a proven
serialized literal or the existing permissive `() => true` path. Focused tests
cover the watchdog, literal/no-literal correctness, indexed/deep matching,
invalid patterns, cache separation, and variable-length match projection.

### Step 5 — expose `--regex` on the CLI — implemented 2026-09-21

Added `--regex` through the existing handlers-interface path in
`src/cli/HistoryCommandDefinitions.ts` and
`src/cli/HistoryInspectionCommands.ts`. The query carries `regex: true`, and
invalid patterns retain the typed `InvalidHistorySearchPatternError` so the
existing `handleHistoryCommand` reports the named pattern and parse failure
with exit code 2. Text and JSON output disclose regex mode, and help/docs cover
case-insensitivity plus the possible prefilter/performance cost. Successful
zero-match searches still exit 0.

### Step 6 — expose regex in the drawer

Mirror the deep toggle through the UI store, request payload, router, and
listing key. Add inline invalid-pattern feedback, retain the debounce and
two-character gate, and keep the existing result prose accurate. Cover the
toggle round trip, payload, cache-key change, and non-wedging invalid-pattern
rendering in the Vitest suite.

## Non-goals

- No production regex implementation, CLI flag, drawer control, or schema change
  is part of this design step.
- No user-supplied regex flags, multiline/dotall mode controls, replacement
  operation, or regex highlighting is proposed.
- No change to substring matching, case behavior, result ordering, dedupe, or
  the index schema is intended.
- No `excludeRunRefs` / `--include-current-run` work is bundled here.
- No promise is made that regex search has the same cost as substring search;
  the worker protects the host from a stuck match, but it does not make arbitrary
  patterns fast or eliminate CPU/memory pressure from a large search.
