# CLI History Search — expose global run-history search to agents

> **Status:** Not implemented. Research/design only — no code changed yet.
>
> **Sibling:** [`CLI_HISTORY_INSPECTION_PLAN.md`](./CLI_HISTORY_INSPECTION_PLAN.md) adds
> `history list` / `history runs` / `history show` under the same command group. This doc adds
> `history search` and assumes that vocabulary. The two are independently shippable, but search is
> materially more useful once `history show` exists — see "Sequencing" below.
>
> **Related:** `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` and
> `dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md` — **both landed since this plan was
> written**, and between them they removed most of what this doc called "the hard part". The
> streaming reader this plan proposed building now exists; see "What the search engine looks like
> now" below before reading anything here about residency.
> `dev/implemented/HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md` (the silent-miss gap this command must
> disclose rather than inherit quietly), `dev/backlog/HISTORY_SEARCH_BACKGROUND_SCAN_PLAN.md`
> (why a count can come back provisional, which this command has to report honestly).

## Problem

ctrlyoke has a good global history search, and it is reachable from exactly one place: the React
dashboard's `HistorySearchDrawer` (`src/ui/webview-react/components/search/HistorySearchDrawer.tsx`),
routed through `MESSAGE_TYPES.SEARCH_HISTORY` to `HistorySearchService`
(`src/ui/WebviewMessageRouter.ts`). It is a human-only surface: a webview message, a debounce,
a virtualized list.

Agents have no equivalent. An agent that wants to answer "have we hit this error before, and what
did we do about it?" across a project's whole run history has nothing to call. What it has today:

- **`read_output` (MCP)** — its own run only, addressed by `CTRLYOKE_WORKING_FILE`. An agent can
  page a step's response text and grep it itself. That genuinely covers "search inside my own run"
  and is why this plan does **not** propose an MCP search tool.
- **Reading `.runs/**/events.jsonl` by hand** — works, is slow, is unbounded (a single run's events
  file can be megabytes), and reimplements candidate extraction badly. Nothing stops an agent doing
  this today; the point of this command is that it should not have to.

## Why the CLI and not an MCP tool

Endorsing the framing in the request, with the specific reasons:

1. **Every MCP workflow tool answers for exactly one run, by construction.** `requireRunAddress`
   (`src/mcp-server.ts`) refuses to serve any workflow tool without a `CTRLYOKE_WORKING_FILE`,
   and its error message already says the words: _"to drive ctrlyoke from outside a workflow, use the
   ctrlyoke CLI."_ Cross-workflow history search has no run to answer for. The one existing
   cross-workflow tool, `global_status`, is deliberately narrow and read-only, and even it is
   documented as "the only tool that reports on workflows other than this server's own"
   (`mcp-server.ts`). A general search tool with seven filter dimensions and paging is not
   a second exception of the same size.
2. **MCP tool schemas are context the model pays for on every turn.** `MCP_TOOL_DEFINITIONS` is
   listed to the harness whenever the ctrlyoke server is attached (`spec-driven-loop` attaches it on
   both steps). A search tool with `query`/`eventKinds`/`harnesses`/`executionStates`/`since`/
   `until`/`pathContains`/`limit`/`offset` is a large schema, permanently resident, for a capability
   most steps never use. A CLI command costs nothing until invoked.
3. **In-workflow agents can already call the CLI.** They have a shell. `ctrlyoke history search` is
   read-only, so nothing about the attestation boundary in `resolveCallingContext`
   (`mcp-server.ts`) is bypassed by using it — there is no privileged state to reach. The CLI is
   the supported escape hatch for everything else that isn't run-scoped; search belongs with it.
4. **It composes.** `... | grep`, `| jq`, `> notes.md`, `--limit 5` for a cheap probe. An MCP tool
   returns one JSON blob into the model's context whether or not the model wanted all of it.

If in-workflow ergonomics ever demand a tool anyway, note there is already a bridge:
`ctrlyoke-mcp --tool <name> --args <json>` (`runMcpToolCli`, `mcp-server.ts`). That is the
cheaper escalation than a new resident tool definition, and it should be considered before
`MCP_TOOL_DEFINITIONS` grows.

## Proposed command

### `ctrlyoke history search <query>`

```
$ ctrlyoke history search "EPERM" --kind bash --kind response --limit 3
3 of 41+ results · index ready

1. Refactor auth middleware · run 4 · Prompt 3 · bash/output · 2026-09-12 14:03
   --workflow a1b2c3d4 --run 4 --step 2
   …rename over an existing path raised EPERM while another handle disallowed the delete…

2. Nightly smoke test · run 1 · Final Step · response/response · 2026-09-10 02:00
   --workflow e5f6a7b8 --run 1 --step final
   …retried the write after the EPERM and it succeeded on the second attempt…

3. Refactor auth middleware · run 2 · Prompt 1 · fileEdit/path · 2026-09-09 08:15
   --workflow a1b2c3d4 --run 2 --step 0
   src/utils/AtomicFileUtils.ts
   …transient codes only; EEXIST/ENOTEMPTY/ENOENT are real answers callers act on…

41+ is a lower bound: the scan stopped once --limit was satisfied. Use --exact-count for a
real total. Matches are per indexed event/field, not per occurrence. Indexed text is capped at
2000 characters per event, so a term appearing only later in a long output is not findable
here — use `ctrlyoke history show` on a known run for an exhaustive read.
```

The second line of each result is the payoff: it is a **copy-pasteable selector** for
`history show`/`rerun`/`step edit`. Search becomes the discovery half of the inspection plan's
commands rather than a dead end. Mapping comes straight off `HistorySearchResult.target`:
`{kind: "queue", stepIndex}` → `--step <stepIndex>`; `{kind: "finalStep", loopIndex}` → `--step final`.
If the inspection plan ships `history show` without `--step` (it flags that mapping as deferrable),
emit the line without `--step` rather than inventing a flag that does not exist yet.

### Options

| Option                              | Maps to                               | Notes                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<query>` (positional)              | `HistorySearchQuery.query`            | Required, min 2 chars (`MIN_QUERY_LENGTH`, `HistorySearchIndexService.ts`). Substring, case-insensitive — same matcher as the drawer, no regex.                                                                                                                  |
| `-d, --cwd <path>`                  | workspace root                        | Matches every other command.                                                                                                                                                                                                                                     |
| `--workflow <key...>`               | `filters.workflowKeys`                | Repeatable. Values come from `history list`.                                                                                                                                                                                                                     |
| `--this-workflow`                   | `filters.workflowKeys`                | Derives the key from `CTRLYOKE_WORKING_FILE` via `WorkflowPaths.parseWorkingFileAddressFromPath` — the in-workflow agent's equivalent of the drawer's "Only &lt;workflow&gt;" checkbox. Errors if the env var is unset.                                          |
| `--kind <kind...>`                  | `filters.eventKinds`                  | Validated against `HISTORY_EVENT_KINDS` values (`DashboardConstants.ts`). Invalid value → exit 2 listing the valid set.                                                                                                                                          |
| `--harness <id...>`                 | `filters.harnesses`                   | Validated against `HARNESS_IDS`.                                                                                                                                                                                                                                 |
| `--state <state...>`                | `filters.executionStates`             | Run outcome, per `EXECUTION_STATES`.                                                                                                                                                                                                                             |
| `--path <substring>`                | `filters.pathContains`                | Same `\\`→`/` + lowercase normalization `HistorySearchFilters.ts` already applies.                                                                                                                                                                               |
| `--since <when>` / `--until <when>` | `filters.since` / `.until` (epoch ms) | Accept ISO-8601 and a short relative form (`7d`, `24h`, `30m`). Resolve through one shared parser and reuse it if `history runs` later grows the same flags.                                                                                                     |
| `--limit <n>`                       | `HistorySearchQuery.limit`            | Default **20** (agents want a probe, not a page); hard-capped at 100, mirroring the router's `Math.min(message.limit, 100)`. Now also a cost lever: the scan stops as soon as the page is filled, so a smaller limit is genuinely cheaper, not just less output. |
| `--offset <n>`                      | `HistorySearchQuery.offset`           | Random-access, same as the drawer's virtualized paging.                                                                                                                                                                                                          |
| `--snippet <chars>`                 | see below                             | Context width around the match. Default 100.                                                                                                                                                                                                                     |
| `--json`                            | output format                         | One versioned JSON result line.                                                                                                                                                                                                                                  |
| `--exact-count`                     | forces a complete scan                | Off by default. Without it the scan stops as soon as `--limit` is satisfied and `countState` comes back `"atLeast"` — see "Counting is now opt-in" below.                                                                                                        |
| `--no-rebuild`                      | index policy                          | See "Rebuild policy".                                                                                                                                                                                                                                            |
| `--no-color`                        | output format                         | Matches other commands.                                                                                                                                                                                                                                          |

`--snippet` requires a small core change: `projectHistorySearchResult`'s window is still hardcoded
at 40 characters before / 60 after, with a 100-character head fallback
(`HistorySearchResultUtils.ts`). Parameterize it with those values as defaults so the drawer
is unchanged. This matters more for agents than for humans: 100 characters is often too little
context to decide whether a hit is the one you wanted, and the alternative — a second `history show`
call per candidate — is far more expensive than widening the snippet.

### JSON output

`--json` emits **one** versioned result line, matching `validate --json`'s convention
(`buildCliValidationJsonResult`, `CliJsonResultBuilder.ts:86`), not the NDJSON stream the inspection
plan proposes for `history show`. The difference is deliberate and worth stating in both `--help`
texts: a search response is bounded by `--limit` (≤ 100 results), so a single blob is fine and is
the easier `jq` target; `history show` can emit thousands of events for one run, which is why it
streams. Same CLI, two contracts, one reason.

```json
{
  "schemaVersion": 1,
  "query": "EPERM",
  "offset": 0,
  "limit": 20,
  "totalCount": 41,
  "countState": "atLeast",
  "hasMore": true,
  "indexState": "ready",
  "results": [/* HistorySearchResult[], the existing contract, unchanged */]
}
```

`results` is `HistorySearchResult[]` verbatim — it is already a stable client-facing projection, so
serialize it as-is rather than inventing a CLI-specific shape. Run it through
`secretRedactionService.redactValue` at the serialization boundary anyway, exactly as
`buildCliPreviewJsonResult` does (`CliJsonResultBuilder.ts:46-50`): `events.jsonl` is redacted at
rest by `TimelineRecorder`, and redacting again at the boundary is the established belt-and-braces
convention, not a statement that the first pass is untrusted.

`countState` was a CLI-only invention in the original draft (`totalCountExact`). It is now part of
the core contract — `HistorySearchResponse.countState`, backed by `HISTORY_SEARCH_COUNT_STATES` in
`DashboardConstants.ts` — so emit it verbatim rather than deriving a second spelling of the same
fact. Its meaning has also widened, which is the subject of "Counting is now opt-in" below.

## What the search engine looks like now

**This section replaces the original "The hard part: a resident index in a one-shot process".**
That section proposed building a streaming query path so a CLI invocation would not pay a 31-second,
1.8 GB index load on every run. It was right, and it has been built — by
`dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md`, exactly as this plan asked (build it once,
in core, so the dashboard and the CLI cannot drift into two matchers). Nothing in that area is left
to design; what remains is to know the shape well enough not to misuse it.

### 1. The streaming reader exists — use it, do not rebuild it

`src/core/orchestration/HistorySearchShardScanner.ts` is the primitive:
`listDocumentShardEntries` resolves the shard visit order, `streamHistorySearchDocuments` streams and
parses only candidate documents, and `createHistorySearchLinePrefilter` is the raw-line candidate
check. `HistorySearchIndexService` retains no documents — `loadIfPossible` reads the manifest and
nothing else. The CLI inherits all of this for free by calling `HistorySearchService.search`; there
is no CLI-specific reader to write.

The prefilter has one coupling worth knowing before writing a second caller: it matches against a
serialized `textLower` key that only exists from index schema 4.2.0, so
`streamHistorySearchDocuments` takes `hasPersistedLowercaseKey` and must be told the truth about
whether a manifest at the current schema was actually read. Passing `true` optimistically silently
drops every document whose stored text is not already lowercase. Going through
`HistorySearchService.search` avoids the question entirely; reaching past it does not.

### 2. Counting is now opt-in, and this is the real new design question

`dev/implemented/HISTORY_SEARCH_RESPONSIVE_QUERY_PLAN.md` made the scan recency-ordered and
early-terminating: it visits shards newest-first and **stops as soon as `offset + limit` results
have been collected**. `HistorySearchResponse.countState` reports which kind of total came back —
`"exact"` when the scan reached the true end of the index, `"atLeast"` when it stopped early.

For the drawer this is invisible: the user scrolls, the count climbs, and it becomes exact if they
reach the end. **A one-shot CLI has no scrolling**, so with the proposed `--limit 20` default the
answer would essentially always be `"atLeast": 20` — a number that tells an agent nothing. And
"have we hit this error before, and how often?" is one of the two questions this command exists to
answer.

So the count is now a deliberate choice rather than a free by-product:

- **Default to the fast, early-terminated scan**, and print the total with a `+` (text) and
  `countState: "atLeast"` (JSON). This is the cheap probe agents want, and on a recent term it is
  milliseconds rather than the ~10 s of a full pass.
- **`--exact-count` forces a complete scan.** Implement it by asking for a target the index cannot
  satisfy early rather than by adding a second code path — the scan already reports `"exact"`
  whenever it reaches the end.
- **Say which one you got, in both output modes.** An agent that reads `20` and reports "20
  occurrences" when the truth is 1,827 is worse than one that reports nothing.
- **A zero-result query is always exact and always slow.** It cannot stop early, so it reads the
  whole index (~12 s on the measured workspace). That is the honest cost of a trustworthy "no",
  and it is worth stating in `--help`: the fast path is finding things, not failing to.

### 3. Turn the document cache off for a one-shot process

`HistorySearchIndexService` holds a `HistorySearchDocumentCache` sized from
`ConfigurationUtils.getHistorySearchCacheBudgetBytes()` (the `runs.historySearchCacheMb` setting,
default 320 MB). It exists to make the _second_ query in a session fast. A CLI process answers one
query and exits, so every byte it populates is pure waste — and it is worse than neutral: the
responsive-query plan measured that a shard the cache accepts is read with a **full, unfiltered
parse** so every document can be retained, which is more work than the prefiltered streaming path it
replaces. One query with a cold 320 MB budget therefore pays extra parse cost for a cache nobody
will read.

The CLI should run with the budget at 0. `HistorySearchIndexService.search` re-reads the setting on
every call, so this needs a real seam — either the options argument proposed below or a CLI-scoped
config override. Do not leave it at the default and hope; measure the difference, because the same
plan records that this knob "is not a straightforward speed lever in either direction."

### 4. Per-query snapshots and scan cursors are session state, and a CLI has no session

`matchSnapshots` (the per-listing result cache and its resumption cursor) and the LRU that bounds it
are what make the drawer's paging cheap across requests. In a one-shot process they are populated
once and discarded. Nothing breaks — but do not reach for `--offset` expecting it to be cheap the
way it is in the drawer: from a cold process, `--offset 1000` re-derives the first 1,000 results
before slicing, because there is no retained prefix to resume from. That is a correctness-neutral
cost worth one sentence in `--help`.

## Rebuild policy: decide it explicitly, and never block silently

`search()` calls `ensureReady()` (`HistorySearchIndexService.ts`), which triggers a
**synchronous full rebuild** when the on-disk index is missing or stale. A CLI user is more likely
to hit that than a dashboard user — the index is refreshed by running workflows and by the extension
host, so a project whose last activity was days ago, or whose runs were all produced by `ctrlyoke
run` in CI, may have no usable index at all. An unbounded, silent multi-minute block is the worst
possible first experience of this command, particularly for an agent that will simply time out and
report the tool as broken.

Proposed policy:

- **Default: rebuild if stale, with progress on stderr.** `HistorySearchService.search` already
  accepts an `IndexRebuildProgressCallback` (the drawer draws a progress bar from it). The CLI
  renders `Rebuilding search index (312/1430 runs)…` to **stderr** — never stdout, or it
  contaminates `--json` and pipes.
- **`--no-rebuild`**: search whatever is on disk and report `indexState` honestly. For an agent
  doing a cheap probe, a fast answer over a slightly stale index is usually the right trade; make
  that choice available rather than assuming it.
- **Always surface `indexState`** in both the text footer and the JSON, so "no results" from a
  `fallback`/`building` index is distinguishable from "no results" from a ready one.
- **Do not silently take the legacy disk scan.** `HistorySearchService.search`'s `catch` falls back
  to `searchLegacy`, which scans only as far as `offset + limit` and reports
  `totalCount = scanned.length` — a number that is _not_ the match count. The original draft asked
  the CLI to invent a disclosure for this; it no longer has to, because that path now already
  returns `countState: "atLeast"` and `indexState: "fallback"`. Report both verbatim, and consider
  `--no-fallback` for an agent that would rather get an error than a number it has to interpret.
  The realistic trigger is not exotic: a concurrent VS Code window holding the index manifest lock
  past `REBUILD_LOCK_TIMEOUT_MS` (60 s, `historySearchRebuildWorker.ts`) throws straight into this
  path.
- **Cancellation is not a failure, if it is ever wired up.** `HistorySearchService.search` takes an
  `AbortSignal` and throws `HistorySearchCancelledError` when it fires. The CLI passes no signal
  today, so this cannot happen — but if Ctrl+C handling is ever added, that error must exit cleanly
  rather than falling into the disk-scan fallback, which would spend the exact full-history read
  the cancellation was asking to avoid.

Keep all of this behind **one** entry point. Extend `HistorySearchService.search` with an options
argument (`{ allowRebuild, allowLegacyFallback, snippetChars, documentCacheBytes }`) rather than
forking a second search service for the CLI — the drawer and the CLI must not drift into two
matchers. The options argument has become more clearly the right shape since this was written:
`search` has meanwhile grown `signal` and `onPartialResults` as _positional_ parameters, so it is
now five positional arguments deep and the next one should not be a sixth.

### Rebuilding from the CLI writes the shared index

Worth knowing rather than worth preventing: a CLI rebuild writes `.search-index/` under the same
`projectStateRoot` the extension host uses (`getIndexDir`, `HistorySearchIndexService.ts`), so
the work benefits a later dashboard search too. The worker resolves fine from the CLI bundle —
`getWorkerScriptPath`'s second candidate is `path.join(__dirname, "historySearchRebuildWorker.js")`,
and esbuild emits `out/historySearchRebuildWorker.js` next to `out/cli.js` (`esbuild.js`),
which is also what `.vscodeignore` ships. No new build wiring is needed; a test asserting the CLI
can locate the worker is cheap insurance against that layout changing.

## Honesty about what search cannot find

Three known behaviours will bite agents harder than they bite humans, because an agent treats "no
results" as an answer and moves on. All three must appear in the command's own output, not only in
docs:

1. **A result is one matching event/field, not one occurrence.** A response mentioning a term 40
   times is one result. Already documented in `orchestration.instructions.md`; an agent comparing
   `totalCount` against a `grep -c` will otherwise conclude something is broken. The drawer now
   states this in prose above its result list ("Each result is one matching event, not one
   occurrence…"); the CLI needs its own wording because it has no such sticky header, and its users
   are the ones most likely to do the arithmetic.
2. **Indexed text is truncated at `MAX_INDEXED_TEXT_LENGTH` (2000 chars,
   `historySearchRebuildWorker.ts`) before matching**, so a term that appears only later in a
   long output is invisible — on one real workspace this silently dropped >100 otherwise-matching
   documents in a single run (`HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md`). This cap is a
   deliberate OOM defence, not a bug to patch here.
3. **A total is a lower bound unless `countState` says otherwise.** New since this plan was
   written, and the most dangerous of the three for an agent, because unlike the other two it makes
   a _number_ wrong rather than a result absent. See "Counting is now opt-in" above.

So: **never print a bare "No results."** Print the footer shown in the example above, pointing at
`history show` (or `read_output`, in-workflow) for an exhaustive read of a known run. This is the
cheapest possible mitigation of a gap this command would otherwise inherit silently.

## Implementation sketch

Handler in `src/cli/HistoryInspectionCommands.ts` — the same new file the inspection plan proposes,
since the two share the bootstrap — following the existing `(options, io) => Promise<void>` shape of
`pruneHistoryCommand`/`relinkHistoryCommand` in `src/cli/HistoryCommands.ts`, with no
`confirmMutation` (nothing mutates).

Registration in `src/cli/HistoryCommandDefinitions.ts` alongside `prune`/`relink`:

```ts
history
  .command("search <query>")
  .description("Search recorded output across this workspace's run history")
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option("--workflow <key...>", "Restrict to one or more workflow lineage keys")
  .option("--this-workflow", "Restrict to the workflow run attached to this process")
  .option("--kind <kind...>", "Restrict to event kinds (bash, response, fileEdit, …)")
  .option("--harness <id...>", "Restrict to harnesses")
  .option("--state <state...>", "Restrict to run outcomes")
  .option("--path <substring>", "Restrict to events touching a file path")
  .option("--since <when>", "Only runs started at or after this time (ISO-8601 or 7d/24h/30m)")
  .option("--until <when>", "Only runs started at or before this time")
  .option("--limit <n>", "Maximum results to print (default 20, max 100)")
  .option("--offset <n>", "Absolute index of the first result")
  .option("--snippet <chars>", "Context characters around each match (default 100)")
  .option("--exact-count", "Scan the whole history so the reported total is exact, not a lower bound")
  .option("--no-rebuild", "Search the existing index without rebuilding a stale one")
  .option("--json", "Emit one versioned JSON result line")
  .option("--no-color")
  .action(...)
```

Bootstrap is the same sequence `prepareStepCommand` already performs (`cli.ts`) —
`Log.initializeCli`, config backends, `initializeRunHistoryLocation`, `ProjectStateRegistry`
initialize — and that sequence is now used by three command families, so lift it into one shared
helper rather than pasting a third copy. `initializeRunHistoryLocation` is non-optional here:
`getIndexDir` resolves through `getFrozenRunHistoryLocation()`, so skipping it points the search at
the wrong state root.

Reused building blocks — **no new core primitives at all now that the streaming reader has landed**:

- `HistorySearchService.search` — the single search entry point, extended with the options argument
- `HistorySearchShardScanner` — the streaming reader, reached through the service, not directly
- `HISTORY_EVENT_KINDS` / `HARNESS_IDS` / `EXECUTION_STATES` — flag validation, no new string tables
- `WorkflowPaths.parseWorkingFileAddressFromPath` — `--this-workflow`
- `secretRedactionService.redactValue` — the `--json` boundary
- `CliTerminalFormatter` conventions for colour; the result rows are simple enough not to need new
  formatter methods, but `--no-color` must be honoured the same way

### Exit codes

`0` for any successful search, **including zero matches**. Grep's exit-1-on-no-match is tempting and
is wrong here: `1` is reserved for workflow failure across the whole CLI
(`cli-binary.instructions.md`), and overloading it would make `ctrlyoke history search ... || echo
failed` lie. Usage and parse errors exit `2`, matching `handleHistoryCommand` (`cli.ts:1187-1193`).
Scripts that need a match/no-match signal read `totalCount` from `--json`.

### Tests

`src/test/**` (per the routing table): flag parsing and validation, `--this-workflow` derivation,
the text/JSON renderers, and the `indexState`/`countState` disclosure paths. The
streaming-reader-vs-`collectMatches` equivalence test this plan used to call for is no longer
needed — there is only one reader now, and `HistorySearchIndexService.test.ts` already covers its
ordering and dedupe. The test worth the most here instead is **`--exact-count` against a fixture
index large enough to early-terminate without it**, asserting the same command returns `"atLeast"`
with a short total and `"exact"` with the real one. That is the behaviour an agent will build on
and the one nothing else exercises.

### Docs

Add `## ctrlyoke history search` to `docs/cli/ctrlyoke.md`, next to the inspection plan's new
sections, including the NDJSON-vs-single-blob note and the truncation caveat.

## Sequencing

Independently shippable, but the selector lines in its output point at `history show`, so the
natural order is: `history list`/`runs`/`show` first, then `search`. If search ships first, its
selector lines still work for `rerun`/`append`/`step edit`, which already take `--workflow`/`--run`
today — so shipping first is not blocked, only slightly less useful.

**The streaming reader is no longer a cross-plan dependency — it landed with
`HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md`.** This command has no blocking core work left; what it
needs from core is an options seam on `HistorySearchService.search` (rebuild policy, fallback
policy, snippet width, document-cache budget), which is small and local.

## Risks / open questions

- **An agent searching while its own run is live will match its own in-progress output**, including
  the prompt it was just given — search for a distinctive phrase from your own task and the top hit
  is you. This is a real footgun for the `spec-driven-loop` orchestrator pattern specifically.
  Suggested fix, if it proves annoying in practice: add `excludeRunRefs?: RunRef[]` to
  `HistorySearchFilters` and apply it in `matchesFilters` (single source, indexed and fallback paths
  alike), with the CLI defaulting to excluding the run named by `CTRLYOKE_WORKING_FILE` unless
  `--include-current-run` is passed. Do **not** post-filter in the CLI — that would desynchronize
  `totalCount` and `offset` from what was actually returned.
- **Substring only, no regex.** The matcher is `text.toLowerCase().includes(query.toLowerCase())` in
  both paths. Agents will ask for regex. Adding it means changing the matcher for the drawer too
  (fine) and accepting unbounded backtracking risk over ~1M documents (not fine without a timeout).
  Deliberately out of scope for a first pass; if it is added later it belongs in core behind an
  explicit `--regex` flag with a match timeout, not as a CLI-only variant.
- **`--limit` default of 20 vs the drawer's 50.** Chosen for the probe-then-drill workflow an agent
  actually runs, and because every result costs context. It now also decides how much of the index
  gets read, since the scan stops at `offset + limit` — which makes 20 a better default than it
  was, and makes `--exact-count` the escape hatch rather than a larger `--limit`. Revisit if it
  turns out agents mostly want a wide first page.
- **Whether `--exact-count` should be the default after all.** The argument for: an agent asking
  "how many times have we hit this?" gets a useless answer without it, and unlike a human it will
  not notice the `+`. The argument against: ~10 s per invocation on a large workspace, paid by every
  caller including the ones that only wanted the top 3 hits. Left off by default here because the
  disclosure is cheap and the latency is not, but this is a judgement call worth re-making once
  there is a real agent using the command.
- **Relative time parsing (`7d`) is new vocabulary for the CLI.** Keep the parser small and shared;
  if `history runs` later wants `--since`, it must not grow a second dialect.
- **Where the shared bootstrap helper lives.** `prepareStepCommand` is currently private to
  `cli.ts`. Lifting it (to `src/cli/CliWorkspaceBootstrap.ts` or similar) touches the step commands,
  so it is a small refactor with its own blast radius — worth doing at the point the third caller
  appears, which is this command, but worth calling out rather than folding in silently.
