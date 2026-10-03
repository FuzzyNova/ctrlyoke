# CLI Run Inspection Plan

> **Status: Implemented.** Phases 1–5 are complete. Phase 5's default
> `history show --json` projection removes repeated full workflow snapshots;
> `--summary` and `--events` provide compact and event-stream forms. The CLI
> docs include agent guidance and a run-investigation walkthrough.
>
> **Size measurement:** the §1 pre-change measurement was 38 MB. After
> `npm run compile:extension`, the referenced history emitted 40,899,443 bytes
> (about 39.0 MiB). This is the current local history and may have grown since
> the historical baseline; it is recorded as a point-in-time comparison, not a
> controlled same-data before/after benchmark. The default output no longer
> repeats each attempt's full workflow definition snapshot.
>
> Updated 2026-10-03.
>
> **Original problem:** before this plan, `ctrlyoke history` could only show a
> run's output all at once, so inspecting a large run meant downloading tens
> of megabytes and writing a parser.
>
> **Audience:** mostly agents. A person at a terminal can scroll and skim. An agent
> pays for every byte, cannot skim, and stops at the first error it can't fix.
> Every design choice below favours bounded output, a stable `--json` shape, and
> selectors an agent can copy from one command into the next.

---

## 1. Pre-change large-run measurements

Measured on `more bug backlog2` (one run, running; 64 steps in its working
file, 56 queue attempts and 11 `finalStep` review passes recorded, 7.5M tokens,
86 MB `events.jsonl`):

| Command                              | Time   | Output                                                                            |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------- |
| `history list`                       | ~1s    | 300 KB, 1,354 rows. No state filter; finding the 2 running workflows needs `grep` |
| `history runs --workflow K`          | <1s    | One row. STEPS column stale (see bugs below)                                      |
| `history show --workflow K`          | —      | Fails: `--run` is required even when the workflow has only one run                |
| `history show … --run 1`             | 5.2s   | **25 MB, 473k lines** of text                                                     |
| `history show … --run 1 --json`      | 3.4s   | **38 MB in 69 NDJSON lines**, 100 KB–2 MB per line                                |
| `history show … --step final`        | —      | **10 MB, all 11 review passes**. No way to pick one                               |
| `history show … --step 56` (pending) | —      | Two `Run terminated: paused` lines, exit 0                                        |
| `history search` (cold)              | 51–85s | Full index rebuild, 170–235 progress lines on stderr                              |

Getting a step outline (index, name, state, harness, first line of the prompt) took
a Node one-liner over the 38 MB NDJSON. That outline is the first thing anyone
investigating a run wants, and no command produces it.

The text output is also unreliable to parse: the text renderer's
`│ Step N/M` box appears inside recorded tool output too (agents that ran
`history show` recorded its output), giving 80 header lines for 69 attempts.

What already works well, and should be kept:

- `history search` results each carry a ready-to-run
  `--workflow … --run … --step …` selector. This is the right pattern for agents
  and the model for everything below.
- `--step` errors name the valid range.
- `history search` already has the right filter vocabulary (`--kind`, `--harness`,
  `--state`, `--since/--until`, `--limit/--offset`, `--snippet`).

## 2. Related bugs (fix independently of this plan)

- `dev/bugs/backlog/cli-history-step-counts-disagree-and-go-stale.md`: STEPS
  column, header totals, and `--step` validation disagree.
- `dev/bugs/backlog/run-definition-revision-regresses-after-mcp-append.md`:
  appended steps get no definition snapshot, so history attempts lose their
  step name and harness. The step overview (§3.2) must not depend on that snapshot.
- `dev/bugs/backlog/cli-history-show-pending-step-prints-run-terminated.md`
- `dev/bugs/backlog/history-search-index-hash-ignores-drive-letter-casing.md`
- `dev/bugs/backlog/cli-history-search-progress-floods-non-tty-stderr.md`

## 3. Proposed commands and options

### 3.1 `ctrlyoke status`: what is running right now

The MCP server already answers this with `global_status`
(`docs/reference/mcp-tools.md`; `handleGlobalStatus` in `src/mcp-server.ts`):
executing workflows only, each with `currentStep`, `totalSteps`, `completedSteps`,
harness, model, `startedAt`, `lastModifiedAt`, and worktree. The CLI has no
equivalent, so a user has to scan `history list` and then check `runner.json`
PIDs by hand to tell a live run from a crashed one.

- `ctrlyoke status [--workflow K] [--json]`: same data and selection rules as
  `global_status`, plus runner liveness (PID alive + heartbeat age) so a stale
  `running` is reported as such rather than trusted.
- **Single source:** extract the `global_status` collection out of
  `mcp-server.ts` into a core service both hosts call. Do not re-implement it in
  `src/cli/`.

Also add `history list --state <state...>` (reusing the `--state` vocabulary and
validation from `history search`) plus `--limit`, `--since`, and `--sort latest`.
Then `history list --state running stopped error --since 7d` replaces today's 300 KB scan.

### 3.2 `history steps`: the overview (highest priority)

Illustrative output (column values are mock-ups, not measured):

```
ctrlyoke history steps --workflow K [--run R] [--json]
  #   NAME                                   STATE      HARNESS     MODEL        ELAPSED  ATTEMPTS  PROMPT
  0   plan                                   completed  claude-cli  opus         2m24s    1         Be my orchestrator for implementing fixes…
  1   Scope undo and history-search updates  completed  codex-cli   gpt-6-luna   24m10s   1         Fix two dashboard bugs from the backlog…
  …
  55  —                                      running    codex-cli   gpt-6-luna   —        1         Fix two bugs filed in commit 81f8b82d3…
  56  —                                      pending    —           —            —        0         …
  F   review                                 completed  claude-cli  opus         —        11 passes You're goal is to try and find…
```

- **Source:** the run's `workflow.ctrlyoke.json` (190 KB here) carries each step's
  `name`, `prompt`, and `_runtime` (`harness`, `model`, `startedAt`, `completedAt`,
  `elapsed`, `terminalStatus`, `sessionId`). That supplies the step rows in
  O(working-file) time and keeps them correct when a definition snapshot is
  missing. Attempt/pass counts use the bounded-memory lifecycle scan below.
- **Phase 1 decision — counts and tokens:** `RunOutputResolver.streamAttemptLifecycle`
  scanned the 86 MB event log in 1,781 ms in the CLI smoke run (13,364 output
  bytes), emits no output payloads, and supplies queue attempt and final-loop
  counts. Per-step tokens are omitted: attempt lifecycle records contain no
  token usage, so counting tokens would require a separate output projection or
  new persisted aggregates.
- Prompt column is the first line, truncated. `--full-prompts` prints each in full.
- Every row is a valid selector for §3.4. `--json` emits one object with
  `steps[]` and `finalStep` (with `passes[]`), each carrying the exact `--step` value.
- Optional: `ctrlyoke step list` as an alias, since `step edit/remove/reorder`
  already address the same indices.

### 3.3 Defaults that remove a round trip

- `--run` defaults to the latest run (`descriptor.latestRunRef`) for `show`,
  `steps`, and `runs`. Print the resolved run on stderr in text mode, and include
  it in `--json`.
- `--this-workflow` (already on `search`, keyed on `CTRLYOKE_WORKING_FILE`) on
  `steps` and `show` too, so an agent inside a run can inspect its own lineage
  without knowing its key.

### 3.4 Selecting attempts precisely

Today `--step` takes one index or `final`, and `final` means every pass.

- `--step` accepts a list and ranges: `--step 3,7,10-12`.
- Final-step passes: `--step final:latest`, `--step final:3` (1-based pass
  number, matching what §3.2 prints). `--step final` keeps its current meaning, all passes.
- `--attempt <n|latest|all>` for retried steps (default `all`, which is current behaviour).
- `--step running` / `--step latest`: the in-flight or most recent attempt. This
  is the thing someone watching a live run asks for most.
- Out-of-range and not-yet-started selectors: see the pending-step bug. A valid
  selector with no output yet prints its state and exits 0, without stray run events.

### 3.5 Filtering and bounding what `show` prints

- `--kind <kind...>`, reusing `HISTORY_EVENT_KINDS` and the validation from
  `history search`. `--kind prompt response` turns a 2 MB step into the request
  and the final answer, which is usually what to read first.
- `--path <substring>`: events touching a file, matching `search --path`.
- **Paging that matches MCP `read_output`:** `--limit <chars>`, `--cursor <opaque>`,
  `--tail <chars>`, with the same rules (paging requires exactly one selected
  attempt; the response says whether more remains and gives the next cursor).
  `handleReadOutput` in `src/mcp-server.ts` does this inline today. Extract it
  into a shared core helper so both surfaces page identically.
- `--max-events <n>` / `--head`/`--tail` on events for the text renderer, with
  a trailing `… N more events (use --cursor X)` line rather than silent truncation.

### 3.6 A `--json` shape an agent can afford

Each NDJSON line today is a whole attempt: `definition` (the entire workflow
definition snapshot, repeated on every line), `prompt`, `output.structured`, and
`responseText`.

- Default `--json` drops the repeated full-definition snapshot and keeps
  `definition.step` (the attempt's own step), plus a `definitionRevision` reference.
- `--json --summary`: per attempt, only target, attempt/run index, state, timings,
  tokens, prompt, and `responseText` (bounded by `--limit`).
- `--json --events`: one NDJSON line **per event** instead of per attempt, so
  `head`, `grep`, and streaming consumers work on bounded lines.
- Text output stays human-oriented. Document that agents should use `--json`,
  because rendered text can contain nested ctrlyoke boxes from recorded tool output.

## 4. Single-source notes

- Attempt reconstruction stays in `RunOutputResolver.streamAttempts`. New filters
  apply to its output (or push down into it for kind filtering) and must not fork
  a second timeline reader.
- Selector parsing (`parseHistoryShowStep`, `matchesHistoryShowStep`,
  `resolveCliRunRef` in `src/cli/HistoryInspectionCommands.ts`) grows into one
  selector module shared by `show`, `steps`, and the `step` edit commands, so an
  index printed by one command is always accepted by the others.
- Paging and live-run status move out of `mcp-server.ts` into core (§3.1, §3.5),
  so the CLI and MCP surfaces cannot drift. **This shares code only. MCP scoping
  does not change.** The MCP server stays pinned to its own run through
  `CTRLYOKE_WORKING_FILE` (`requireRunAddress`). `read_output` stays limited to that
  run and keeps its parallel-group boundary, and no MCP tool gains a workflow or run
  argument. The CLI is the surface for reading other runs from outside, as
  `history show` already is. The new commands are CLI entry points over the same
  core helpers.
- Kind, state, and harness vocabularies come from the existing constants
  (`HISTORY_EVENT_KINDS`, `EXECUTION_STATES`, `HARNESS_IDS`), as `search` already does.

## 5. Phasing

1. **Overview and defaults — complete:** `history steps`, `--run` defaulting to
   latest, `history list --state/--limit/--since`, and live step totals/name
   fallbacks in history output. Step counts use a filtered lifecycle stream;
   per-step tokens remain out for the reason above.
2. **Selectors — complete:** step lists/ranges, `final:N`/`final:latest`,
   `--attempt`, `--step running|latest`, and shared CLI step-selector parsing.
3. **Filters and paging on `show` — complete:** `--kind`, `--path`, character
   paging shared with MCP `read_output`, and bounded text event rendering.
4. **`ctrlyoke status` — complete:** extracted `global_status` collection into
   `GlobalWorkflowStatusService` shared by MCP and CLI; CLI adds runner-lock
   liveness and text/JSON output.
5. **JSON slimming — complete:** default attempt NDJSON retains only the
   attempt's `definition.step` and a top-level `definitionRevision`, not the
   repeated full workflow snapshot. `--summary` emits compact per-attempt
   records and honors output paging for `responseText`; `--events` emits one
   NDJSON record per output event with its attempt target and indices.

## 6. Testing and docs

- Unit tests in `src/test/unit/HistoryInspectionCommands.test.ts` for each new
  selector and filter, built against a fixture run that has appended steps without
  definition snapshots, a resumed pause, multiple `finalStep` passes, a retried
  step, and a pending step (the shapes that broke in §1).
- A size regression test: `history steps --json` on a fixture with large outputs
  stays bounded by the working file, not by `events.jsonl` (covered in
  `src/test/unit/HistoryInspectionCommands.test.ts`).
- Update `docs/cli/ctrlyoke.md` and `docs/reference/commands.md`. Add an
  "investigating a run" walkthrough (`status` → `steps` → `show --step N --kind
prompt response` → `show --step N --tail 4000`) aimed at agents, and link it from
  `docs/troubleshooting/index.md`. Done in
  `docs/troubleshooting/investigating-a-run.md`; commands use compact JSON output.

## 7. Non-goals

- Interactive TUI browsing. Paging here means bounded, resumable output, not a pager.
- Changing what is recorded in `events.jsonl`, apart from the optional manifest
  counters in §3.2.
- Cross-run diffing or export (`RUN_EXPORT_PLAN.md` owns portable runs).
