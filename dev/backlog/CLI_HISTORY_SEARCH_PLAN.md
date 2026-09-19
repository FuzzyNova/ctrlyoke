# CLI History Search — expose global run-history search to agents

> **Status:** Not implemented. Research/design only — no code changed yet.
>
> **Sibling:** [`CLI_HISTORY_INSPECTION_PLAN.md`](./CLI_HISTORY_INSPECTION_PLAN.md) adds
> `history list` / `history runs` / `history show` under the same command group. This doc adds
> `history search` and assumes that vocabulary. The two are independently shippable, but search is
> materially more useful once `history show` exists — see "Sequencing" below.
>
> **Related:** `dev/implemented/HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` (the streaming reader this plan
> needs and that plan also needs — do not build it twice),
> `dev/backlog/HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md` (the silent-miss gap this command must
> disclose rather than inherit quietly).

## Problem

ctrlyoke has a good global history search, and it is reachable from exactly one place: the React
dashboard's `HistorySearchDrawer` (`src/ui/webview-react/components/search/HistorySearchDrawer.tsx`),
routed through `MESSAGE_TYPES.SEARCH_HISTORY` to `HistorySearchService`
(`src/ui/WebviewMessageRouter.ts:1353`). It is a human-only surface: a webview message, a debounce,
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
   (`src/mcp-server.ts:1678`) refuses to serve any workflow tool without a `CTRLYOKE_WORKING_FILE`,
   and its error message already says the words: _"to drive ctrlyoke from outside a workflow, use the
   ctrlyoke CLI."_ Cross-workflow history search has no run to answer for. The one existing
   cross-workflow tool, `global_status`, is deliberately narrow and read-only, and even it is
   documented as "the only tool that reports on workflows other than this server's own"
   (`mcp-server.ts:1458-1463`). A general search tool with seven filter dimensions and paging is not
   a second exception of the same size.
2. **MCP tool schemas are context the model pays for on every turn.** `MCP_TOOL_DEFINITIONS` is
   listed to the harness whenever the ctrlyoke server is attached (`spec-driven-loop` attaches it on
   both steps). A search tool with `query`/`eventKinds`/`harnesses`/`executionStates`/`since`/
   `until`/`pathContains`/`limit`/`offset` is a large schema, permanently resident, for a capability
   most steps never use. A CLI command costs nothing until invoked.
3. **In-workflow agents can already call the CLI.** They have a shell. `ctrlyoke history search` is
   read-only, so nothing about the attestation boundary in `resolveCallingContext`
   (`mcp-server.ts:453`) is bypassed by using it — there is no privileged state to reach. The CLI is
   the supported escape hatch for everything else that isn't run-scoped; search belongs with it.
4. **It composes.** `... | grep`, `| jq`, `> notes.md`, `--limit 5` for a cheap probe. An MCP tool
   returns one JSON blob into the model's context whether or not the model wanted all of it.

If in-workflow ergonomics ever demand a tool anyway, note there is already a bridge:
`ctrlyoke-mcp --tool <name> --args <json>` (`runMcpToolCli`, `mcp-server.ts:1872`). That is the
cheaper escalation than a new resident tool definition, and it should be considered before
`MCP_TOOL_DEFINITIONS` grows.

## Proposed command

### `ctrlyoke history search <query>`

```
$ ctrlyoke history search "EPERM" --kind bash --kind response --limit 3
3 of 41 results · index ready

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

Matches are per indexed event/field, not per occurrence. Indexed text is capped at 2000
characters per event, so a term appearing only later in a long output is not findable here —
use `ctrlyoke history show` on a known run for an exhaustive read.
```

The second line of each result is the payoff: it is a **copy-pasteable selector** for
`history show`/`rerun`/`step edit`. Search becomes the discovery half of the inspection plan's
commands rather than a dead end. Mapping comes straight off `HistorySearchResult.target`:
`{kind: "queue", stepIndex}` → `--step <stepIndex>`; `{kind: "finalStep", loopIndex}` → `--step final`.
If the inspection plan ships `history show` without `--step` (it flags that mapping as deferrable),
emit the line without `--step` rather than inventing a flag that does not exist yet.

### Options

| Option                              | Maps to                               | Notes                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<query>` (positional)              | `HistorySearchQuery.query`            | Required, min 2 chars (`MIN_QUERY_LENGTH`, `HistorySearchIndexService.ts:40`). Substring, case-insensitive — same matcher as the drawer, no regex.                                                                      |
| `-d, --cwd <path>`                  | workspace root                        | Matches every other command.                                                                                                                                                                                            |
| `--workflow <key...>`               | `filters.workflowKeys`                | Repeatable. Values come from `history list`.                                                                                                                                                                            |
| `--this-workflow`                   | `filters.workflowKeys`                | Derives the key from `CTRLYOKE_WORKING_FILE` via `WorkflowPaths.parseWorkingFileAddressFromPath` — the in-workflow agent's equivalent of the drawer's "Only &lt;workflow&gt;" checkbox. Errors if the env var is unset. |
| `--kind <kind...>`                  | `filters.eventKinds`                  | Validated against `HISTORY_EVENT_KINDS` values (`DashboardConstants.ts:2882`). Invalid value → exit 2 listing the valid set.                                                                                            |
| `--harness <id...>`                 | `filters.harnesses`                   | Validated against `HARNESS_IDS`.                                                                                                                                                                                        |
| `--state <state...>`                | `filters.executionStates`             | Run outcome, per `EXECUTION_STATES`.                                                                                                                                                                                    |
| `--path <substring>`                | `filters.pathContains`                | Same `\\`→`/` + lowercase normalization `HistorySearchFilters.ts` already applies.                                                                                                                                      |
| `--since <when>` / `--until <when>` | `filters.since` / `.until` (epoch ms) | Accept ISO-8601 and a short relative form (`7d`, `24h`, `30m`). Resolve through one shared parser and reuse it if `history runs` later grows the same flags.                                                            |
| `--limit <n>`                       | `HistorySearchQuery.limit`            | Default **20** (agents want a probe, not a page); hard-capped at 100, mirroring the router's `Math.min(message.limit, 100)`.                                                                                            |
| `--offset <n>`                      | `HistorySearchQuery.offset`           | Random-access, same as the drawer's virtualized paging.                                                                                                                                                                 |
| `--snippet <chars>`                 | see below                             | Context width around the match. Default 100.                                                                                                                                                                            |
| `--json`                            | output format                         | One versioned JSON result line.                                                                                                                                                                                         |
| `--no-rebuild`                      | index policy                          | See "The hard part".                                                                                                                                                                                                    |
| `--no-color`                        | output format                         | Matches other commands.                                                                                                                                                                                                 |

`--snippet` requires a small core change: `projectHistorySearchResult`'s window is hardcoded at 40
characters before / 60 after, with a 100-character head fallback
(`HistorySearchResultUtils.ts:58-70`). Parameterize it with those values as defaults so the drawer
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
  "totalCountExact": true,
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

`totalCountExact` is new and is explained in the next section.

## The hard part: a resident index in a one-shot process

This is the design problem the command actually has, and it is not the CLI plumbing.

`HistorySearchIndexService` answers a query by holding **every indexed document in process memory**
and scanning them (`collectMatches`, `HistorySearchIndexService.ts:166`). That is a reasonable
design for the extension host, which pays the load once and amortizes it over a session. It is the
wrong shape for a process that starts, answers one question, and exits. The measurements in
`HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` (1181 lineages / 1430 runs / 983k documents / 976 MB of
shards) are the numbers a CLI invocation would pay **every time**:

|                                     |           |
| ----------------------------------- | --------- |
| Cold `loadIfPossible()`             | 31,257 ms |
| Warm `loadIfPossible()`             | 5,544 ms  |
| Resident set with index loaded      | 1,850 MB  |
| Freshness check (`isManifestFresh`) | ~350 ms   |

A 31-second, 1.8 GB `ctrlyoke history search` is not a tool an agent will use twice. Two things
follow.

### 1. Add a streaming query path, and share it with the residency plan

Rather than `loadIfPossible()` → scan-in-memory, the CLI should stream the shard JSONL files and
retain only **projected results**, never the source documents:

- Shards are already newline-delimited and already read with `streamFileLines`
  (`HistorySearchIndexService.ts:618-625`), so the reading half exists.
- For each line: parse, `matchesFilters`, substring-match, and if it hits, project it
  (`projectHistorySearchResult`) and drop the document. A `HistorySearchResult` is a bounded
  snippet plus identity fields — hundreds of bytes, against up to `MAX_INDEXED_TEXT_LENGTH` (2000
  chars) of text per document. Memory becomes **O(matches)** instead of O(index).
- Sort and dedupe the projected results exactly as `collectMatches` does today (`compareDocuments`
  then `getHistorySearchDocumentDedupeKey`), then slice the window. The dedupe key is derived from
  the _projected_ result, which is why the whole match set still has to be walked — that constraint
  is unchanged and is already documented in `orchestration.instructions.md`.
- Cap retention at `MAX_SNAPSHOT_RESULTS` (50,000, already the service's own bound). Past the cap,
  report `totalCountExact: false` and stop counting rather than silently lying — hence the field in
  the JSON contract above.

**This is the same primitive `HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md` needs for the extension host.**
Build it once, in core (`HistorySearchIndexService`, or a `HistorySearchIndexReader` it delegates to),
and let both callers use it. Two streaming readers that disagree about dedupe ordering would be a
genuinely nasty bug: the dashboard and the CLI would return different result sets for the same
query. Whichever plan lands first owns the implementation; the other adopts it.

If measurement later shows O(matches) is still too much for a degenerate query, the next step is a
two-pass reader (pass 1 retains only `{dedupeKey, sortKey, shard, line}` tuples to get an exact
count and the window's identity; pass 2 re-streams only the shards holding the window). Do not build
that up front — measure first, the way the residency plan's numbers were produced.

### 2. Decide the rebuild policy explicitly, and never block silently

`search()` calls `ensureReady()` (`HistorySearchIndexService.ts:254`), which triggers a
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
  to `searchLegacy` (`HistorySearchService.ts:82-116`), which scans only as far as `offset + limit`
  and reports `totalCount = scanned.length` — a number that is _not_ the match count. That is
  acceptable for a drawer that keeps paging; it is actively misleading as a CLI/JSON field. The CLI
  should either suppress `totalCount` (emit `totalCountExact: false`) or decline the fallback, and
  must say `indexState: "fallback"` loudly either way. The realistic trigger is not exotic: a
  concurrent VS Code window holding the index manifest lock past
  `REBUILD_LOCK_TIMEOUT_MS` (60 s, `historySearchRebuildWorker.ts:57`) throws straight into this path.

Keep all of this behind **one** entry point. Extend `HistorySearchService.search` with an options
argument (`{ allowRebuild, allowLegacyFallback, snippetChars }`) rather than forking a second search
service for the CLI — the drawer and the CLI must not drift into two matchers.

### 3. Rebuilding from the CLI writes the shared index

Worth knowing rather than worth preventing: a CLI rebuild writes `.search-index/` under the same
`projectStateRoot` the extension host uses (`getIndexDir`, `HistorySearchIndexService.ts:666`), so
the work benefits a later dashboard search too. The worker resolves fine from the CLI bundle —
`getWorkerScriptPath`'s second candidate is `path.join(__dirname, "historySearchRebuildWorker.js")`,
and esbuild emits `out/historySearchRebuildWorker.js` next to `out/cli.js` (`esbuild.js:399-414`),
which is also what `.vscodeignore:32` ships. No new build wiring is needed; a test asserting the CLI
can locate the worker is cheap insurance against that layout changing.

## Honesty about what search cannot find

Two known behaviours will bite agents harder than they bite humans, because an agent treats "no
results" as an answer and moves on. Both must appear in the command's own output, not only in docs:

1. **A result is one matching event/field, not one occurrence.** A response mentioning a term 40
   times is one result. Already documented in `orchestration.instructions.md`; an agent comparing
   `totalCount` against a `grep -c` will otherwise conclude something is broken.
2. **Indexed text is truncated at `MAX_INDEXED_TEXT_LENGTH` (2000 chars,
   `historySearchRebuildWorker.ts:42`) before matching**, so a term that appears only later in a
   long output is invisible — on one real workspace this silently dropped >100 otherwise-matching
   documents in a single run (`HISTORY_SEARCH_TRUNCATED_TEXT_MATCH_PLAN.md`). This cap is a
   deliberate OOM defence, not a bug to patch here.

So: **never print a bare "No results."** Print the footer shown in the example above, pointing at
`history show` (or `read_output`, in-workflow) for an exhaustive read of a known run. This is the
cheapest possible mitigation of a gap this command would otherwise inherit silently.

## Implementation sketch

Handler in `src/cli/HistoryInspectionCommands.ts` — the same new file the inspection plan proposes,
since the two share the bootstrap — following the existing `(options, io) => Promise<void>` shape of
`pruneHistoryCommand`/`relinkHistoryCommand`, with no `confirmMutation` (nothing mutates).

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
  .option("--no-rebuild", "Search the existing index without rebuilding a stale one")
  .option("--json", "Emit one versioned JSON result line")
  .option("--no-color")
  .action(...)
```

Bootstrap is the same sequence `prepareStepCommand` already performs (`cli.ts:1213-1238`) —
`Log.initializeCli`, config backends, `initializeRunHistoryLocation`, `ProjectStateRegistry`
initialize — and that sequence is now used by three command families, so lift it into one shared
helper rather than pasting a third copy. `initializeRunHistoryLocation` is non-optional here:
`getIndexDir` resolves through `getFrozenRunHistoryLocation()`, so skipping it points the search at
the wrong state root.

Reused building blocks (no new core primitives beyond the streaming reader):

- `HistorySearchService.search` — the single search entry point, extended with the options argument
- the streaming index reader — shared with `HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md`
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
the text/JSON renderers, the `indexState`/`totalCountExact` disclosure paths, and — the one worth
the most — a streaming-reader test asserting it returns the _same ordered, deduped_ results as the
current in-memory `collectMatches` for a fixture index. That test is what keeps the dashboard and
the CLI from drifting.

### Docs

Add `## ctrlyoke history search` to `docs/cli/ctrlyoke.md`, next to the inspection plan's new
sections, including the NDJSON-vs-single-blob note and the truncation caveat.

## Sequencing

Independently shippable, but the selector lines in its output point at `history show`, so the
natural order is: `history list`/`runs`/`show` first, then `search`. If search ships first, its
selector lines still work for `rerun`/`append`/`step edit`, which already take `--workflow`/`--run`
today — so shipping first is not blocked, only slightly less useful.

The streaming reader is the one genuine cross-plan dependency. It can land here or in
`HISTORY_SEARCH_INDEX_RESIDENCY_PLAN.md`; it must not land in both.

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
  actually runs, and because every result costs context. Revisit if it turns out agents mostly want
  a wide first page.
- **Relative time parsing (`7d`) is new vocabulary for the CLI.** Keep the parser small and shared;
  if `history runs` later wants `--since`, it must not grow a second dialect.
- **Where the shared bootstrap helper lives.** `prepareStepCommand` is currently private to
  `cli.ts`. Lifting it (to `src/cli/CliWorkspaceBootstrap.ts` or similar) touches the step commands,
  so it is a small refactor with its own blast radius — worth doing at the point the third caller
  appears, which is this command, but worth calling out rather than folding in silently.
