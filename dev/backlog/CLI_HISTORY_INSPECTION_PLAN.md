# CLI History Inspection — discover workflow/run keys and dump run output

> **Status:** Not implemented. Research/design only — no code changed yet.

## Problem

`rerun`/`append`/`continue`/`step edit`/`step remove`/`step reorder` all require a
`--workflow <key>` and, for most of them, a `--run <ref|runId>` (or rerun's `--from`)
(`src/cli/CliRunCommandDefinitions.ts:110-147`, `src/cli/StepCommandDefinitions.ts:44-95`). There
is currently **no CLI-facing way to discover either value**. A user has to already know the
workflow key (e.g. from having just run it in the same session, or the VS Code dashboard) or go
spelunking by hand under `.ctrlyoke/.runs/<workflowKey>/` (or the user-scoped
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/` — see the debugging section of
`.github/copilot-instructions.md`) to find a `workflow.json` descriptor and its run directories.

The `history` command's own `--help` text says "Inspect and maintain persisted run history", but
today it only has two subcommands — `prune` and `relink`
(`src/cli/HistoryCommandDefinitions.ts:29-42`) — and both operate at the **project** scope (a
user's whole repo-keyed state directory, via `ProjectStateLifecycle`), not at the
**workflow-lineage** scope the user actually needs for rerun/append/continue/step. There is no
"inspect" half of that description at all yet.

Separately, there is no way to print a historical run's recorded output to the terminal (to read
it, or pipe it to a file) — the only way to see a past run's output is through the VS Code
dashboard's Output pane.

This doc proposes closing both gaps under `history`, as two related but independent features:

1. **Discovery**: list workflow lineages in a workspace, and list runs within one lineage —
   giving users the exact `--workflow`/`--run`/`--from` values the execution commands need.
2. **Dump**: print one run's full recorded output to stdout.

## Why this belongs under `history`, and how it's scoped differently from `prune`/`relink`

`prune`/`relink` manage the **project registry** — one entry per repo, under
`ProjectStateLifecycle`/`inspectUserProjects()`, answering "does this project's state directory
still point at a repo that exists." The new commands operate one level down, inside a single
project's `.runs/` tree (`WorkflowPaths.runsRoot`), answering "what workflow lineages exist here"
and "what runs does this lineage have." Both are legitimately "inspect and maintain persisted run
history" — they just operate at different scopes within it. Reuse the same `history` command
group rather than inventing a sibling top-level command; align option names with the execution
commands (`--workflow <key>`, `--run <ref|runId>`) that already define this vocabulary
(`CliRunCommandDefinitions.ts`, `StepCommandDefinitions.ts`), and reuse the `list` subcommand name
already established by `secret list` (`SecretCommandDefinitions.ts:72`).

## Proposed commands

### `ctrlyoke history list`

Lists every workflow lineage in the current workspace, i.e. every entry
`WorkflowLineageRepository.listLineageKeys(workspaceRoot)` finds under `WorkflowPaths.runsRoot`
(`WorkflowLineageRepository.ts:495-506`). For each key, read its descriptor via
`readDescriptor(workspaceRoot, workflowKey)` to get `workflowName`, `isFavorite`, `createdAt`,
`lastModifiedAt`, `originalFile` (`WorkflowLineageDescriptor`, `WorkflowLineageRepository.ts:118-130`),
and pair it with a one-call `getRunSummaries(workflowKey)`
(`OutputHistoryManager.ts:1108-1112`) to report run count and the latest run's
`executionState`/`startedAt`.

```
$ ctrlyoke history list
KEY        NAME                          RUNS  LATEST            STATE
a1b2c3d4   Refactor auth middleware      4     2026-09-12 14:03   completed
e5f6a7b8   Nightly smoke test            1     2026-09-10 02:00   failed
```

Options: `-d, --cwd <path>` (matches every other command), `--json` (array of
`{ workflowKey, workflowName, isFavorite, createdAt, lastModifiedAt, runCount, latestRun:
{ runId, runRef, executionState, startedAt, completedAt } }`).

Exclude lineages with `isSystemGenerated: true` from the default listing (mirrors
`WorkspaceSessionManager`'s existing exclusion of system-generated lineages from recent-session
discovery, per `orchestration.instructions.md`) — add a `--all` flag to include them, since they
are still real, addressable lineages a power user might legitimately want to rerun.

### `ctrlyoke history runs --workflow <key>`

Lists every run in one lineage, newest first, via `OutputHistoryManager.getRunSummaries(workflowKey)`
— the existing manifest-only listing that already reads each run's `manifest.json` +
`workflow.ctrlyoke.json` for harness/model disclosure without loading any output events
(`OutputHistoryManager.ts:1102-1112`, `orchestration.instructions.md`'s `historyModel` section).
`RunSummary` (`WorkflowTimelineTypes.ts:123-142`) already carries exactly what a user needs to pick
a `--run`/`--from` value: `runId` (the short numeric ID `resolveCliRunRef` accepts,
`CliRunSelector.ts:32-49`), `runRef` (the stable directory-name selector), `startedAt`,
`completedAt`, `executionState`, `stepCount`, `primaryHarness`/`primaryModel`, `tokenTotals`,
`worktree`.

```
$ ctrlyoke history runs --workflow a1b2c3d4
RUN  REF                        STARTED            STATE       STEPS  HARNESS    TOKENS
4    run-1757689383000          2026-09-12 14:03   completed   5      claude-cli 12,480
3    run-1757603120000          2026-09-11 09:41   failed      3      claude-cli 4,102
2    run-1757516800000          2026-09-10 11:02   completed   5      copilot-cli 9,870
1    run-1757430400000          2026-09-09 08:15   completed   5      copilot-cli 8,220
```

Options: `-d, --cwd <path>`, `--json` (array of `RunSummary`, already a stable webview-facing
contract per its own doc comment — safe to serialize as-is, redacted the same way
`buildCliPreviewJsonResult` redacts other CLI JSON output). No lock is needed for this read (unlike
`resolveCliRunRefAtLineage`, which locks specifically because it precedes a mutation) — plain
`getRunSummaries` reads are already how the webview's own run-list view works, uncached run listing
included (`orchestration.instructions.md`: "The run listing... is uncached too — one syscall").

### `ctrlyoke history show --workflow <key> --run <ref|runId>`

Prints one run's full recorded output to stdout, newest-attempt-first-per-step in the same
append order it was recorded, so it can be read directly or piped (`> file.txt`, `| less`, `| grep`).

Resolve `--run` through the same `resolveCliRunRef` used by `rerun`/`append`/`continue`
(`CliRunSelector.ts:14-64`) so `--run 3` and `--run run-1757603120000` both work identically to how
they already work for those commands — this is exactly the selector consistency `history runs`'
own printed `RUN`/`REF` columns are for. Then stream the run's timeline via
`RunOutputResolver.stream(manifestPath)` (`RunOutputResolver.ts:202-210`) — the same lossless,
bounded-memory, append-order reader `OutputHistoryTimelineAdapter` and prior-context resolution
already use — and render each event as it's read (no need to materialize the whole run in memory:
`stream()` is an `AsyncGenerator` for exactly this reason).

Rendering should reuse `CliTerminalFormatter`, extended by
[`CLI_OUTPUT_PARITY_PLAN.md`](CLI_OUTPUT_PARITY_PLAN.md), rather than inventing a second formatter:
a historical dump and a live headless run should look the same. Concretely, add a small adapter
that maps `RunOutputResolverEvent` kinds onto the same render calls `cli.ts`'s live subscriptions
already make —`ATTEMPT_STARTED` → `renderPromptHeader`-equivalent, `STREAMING_EVENTS`/`OUTPUT` →
`renderEvent(s)`, `SCRIPT_EXECUTION` → the new script-verdict/output renderer from the parity plan,
`RUNTIME_TRANSITION`/`RUN_TERMINATED` → a terminal status line.

**Important: this command does not need to wait on the parity plan's live-emitter fix to get
script/condition data.** The parity plan's SCRIPT_VERDICT/SCRIPT_OUTPUT/SCRIPT_COMMAND gap is
specifically that `WorkflowExecutor`'s live `dashboardProvider.updateStepStatus(...,
{endConditionResult})` call is dashboard-gated (`WorkflowExecutor.ts:3520-3528`) and never reaches
the CLI's live emitters. But the timeline itself already has this data unconditionally:
`ScriptExecutionReporter.report()` (`src/core/orchestration/ScriptExecutionReporter.ts:172-346`)
calls `history.saveExecutionOutput(...)` with a `CliOutput` that carries a full `scriptVerdict`
(`ScriptExecutionReporter.ts:295-303`, populated by `createVerdict()` at lines 348-377) and
separately calls `history.recordScriptExecution(...)` with `command`/`stdout`/`stderr`/`exitCode`
(lines 306-327) — both **unconditional on `context.historyFilePath && history`**, not on
`dashboardProvider` being present. `RunOutputResolver` already surfaces both: the `OUTPUT` event's
`attempt.output.scriptVerdict`/`.cliCommand`/`.response`, and the dedicated `SCRIPT_EXECUTION` event
kind (`scriptOutput: ScriptRuntimeOutput`, `RunOutputResolver.ts:157-160, 321-334`). So `history
show` can render rich `SCRIPT_VERDICT`/`SCRIPT_OUTPUT`/`SCRIPT_COMMAND` rows today, purely by
reading what's already persisted — it's a rendering task, not a data-availability task. (It should
still share the parity plan's eventual renderer once that lands, for one formatter instead of two.)

**Redaction is already handled at the persistence layer**, not something this command needs to add:
`TimelineRecorder` runs writes through `secretRedactionService`
(confirmed via `src/core/orchestration/TimelineRecorder.ts`'s import), so `events.jsonl` is already
redacted at rest. `history show` reads the same redacted records the dashboard does — no new
secret-exposure surface.

Options:

- `-d, --cwd <path>`
- `--workflow <key>` (required)
- `--run <ref|runId>` (required)
- `--step <index>` — optional, scope to one queue step (or `final` for final-step loop attempts),
  since a 5-step run's full dump can be long and a user who already knows which step failed
  shouldn't have to grep for it themselves.
- `--json` — emit the raw `RunOutputResolverEvent` stream as JSON Lines (one event per line)
  instead of formatted text, so tooling can consume it (`jq`, a script that greps for a specific
  `SCRIPT_EXECUTION` failure, etc.) without re-parsing formatted terminal output. This is a more
  useful contract than a single JSON blob for a run that could have thousands of events — keep it
  streaming, matching how `stream()` itself is a generator.
- `--no-color` (matches other commands' convention).

Non-goals for a first pass: interactive paging (the user can pipe to `less`/`more` themselves),
re-rendering a *live* (`RUNNING`) run's in-progress output (this command reads a settled
`events.jsonl`; a live run should be watched via a second `ctrlyoke run` subscription or the
dashboard, not this command — though reading a currently-running run's history up to "now" is
harmless and should not be specially blocked either).

## Implementation sketch

New file `src/cli/HistoryInspectionCommands.ts` (parallel to `HistoryCommands.ts`), registered
alongside the existing two in `HistoryCommandDefinitions.ts`'s `registerHistoryCommands`:

```ts
history
  .command("list")
  .description("List workflow lineages in this workspace")
  .option("-d, --cwd <path>", "Working directory (default: current directory)")
  .option("--all", "Include system-generated lineages")
  .option("--json", "Output as JSON")
  .action(...)

history
  .command("runs")
  .description("List runs within a workflow lineage")
  .requiredOption("--workflow <key>", "Workflow lineage key")
  .option("-d, --cwd <path>", ...)
  .option("--json", "Output as JSON")
  .action(...)

history
  .command("show")
  .description("Print a run's recorded output")
  .requiredOption("--workflow <key>", "Workflow lineage key")
  .requiredOption("--run <ref|runId>", "Target run reference or numeric run ID")
  .option("--step <index|final>", "Only show one step's attempts")
  .option("-d, --cwd <path>", ...)
  .option("--json", "Emit newline-delimited JSON events instead of formatted text")
  .option("--no-color", ...)
  .action(...)
```

Handlers live in `src/cli/HistoryInspectionCommands.ts`, following the same
`(options, io) => Promise<void>` shape as `pruneHistoryCommand`/`relinkHistoryCommand` for
consistency, but without the confirmation/mutation machinery (`confirmMutation`) since none of
these three mutate anything.

Reused building blocks (nothing here requires new core/orchestration primitives, only new CLI
wiring around existing ones):

- `WorkflowLineageRepository.listLineageKeys` / `.readDescriptor` — `history list`
- `OutputHistoryManager.getRunSummaries` — `history list`'s latest-run column, and all of
  `history runs`
- `CliRunSelector.resolveCliRunRef` — `history show --run`
- `WorkflowPaths.runFilePath` (to get the manifest path) — `history show`
- `RunOutputResolver.stream` — `history show`
- `CliTerminalFormatter` (extended per `CLI_OUTPUT_PARITY_PLAN.md`) — `history show`'s text
  rendering

## Risks / open questions

- **Large histories.** `history list` reads every lineage's run summaries to compute a "latest
  run" column; on a workspace with many lineages this is O(lineages) `getRunSummaries` calls, each
  already internally batched/cached (`RunSummaryCache`, per `orchestration.instructions.md`) but
  still real I/O. Consider a `--no-latest`/faster mode if this proves slow in practice, rather than
  guessing up front — the existing cache should make repeated invocations cheap regardless.
- **`--step` filtering granularity.** `RunOutputResolver` addresses attempts by
  `OutputExecutionTarget` (`{kind: "queue", stepIndex}` or `{kind: "finalStep", loopIndex}`), so
  `--step final` needs to map onto final-step loop targets specifically, not just "the last queue
  step" — reuse `FINAL_STEP_PHASES` rather than inventing a parallel notion of "final."
  Non-negotiable for a first pass; `--step` can be deferred rather than shipped with a
  half-considered mapping.
  - Should `--step` also allow selecting one specific attempt (e.g. only the retry that
    eventually failed), or always show every attempt for that step? Default to every attempt —
    consistent with how the webview shows attempt-group history rather than only the latest one —
    with a possible `--latest-attempt-only` flag later if requested.
- **JSON Lines vs. single JSON array for `--json`.** Streaming NDJSON matches `RunOutputResolver`'s
  own generator shape and avoids materializing a whole run's events in memory just to serialize
  them — but it's a different `--json` contract than the single-object-per-line convention used
  elsewhere in the CLI (e.g. `validate --json` emits "one versioned JSON result line",
  `cli-binary.instructions.md`/`cli.ts:304`). Document this difference clearly in `--help` output
  and in user-facing docs so `history show --json` isn't mistaken for `validate`'s single-blob
  convention.
- **Dependency on `CLI_OUTPUT_PARITY_PLAN.md`.** `history show`'s formatted-text mode is most
  valuable once that plan's richer `SCRIPT_VERDICT`/`ASK_USER_QUESTION`/`COMPACTION` rendering
  exists, so the same renderer serves both live and historical output. It is not, however, a hard
  prerequisite (see the "does not need to wait" note above) — `history show` could ship first with
  today's `CliTerminalFormatter` and pick up the richer rendering for free whenever the parity plan
  lands, as long as both share one formatter module rather than diverging into two.
