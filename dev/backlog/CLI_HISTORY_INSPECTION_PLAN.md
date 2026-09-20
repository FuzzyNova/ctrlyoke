# CLI History Inspection — discover workflow/run keys and dump run output

> **Status:** Not implemented. The core primitive in step 2 is implemented; the CLI commands remain
> planned work.
> Re-verified against the code on 2026-09-20; every file/line citation below was
> checked, and four claims in the previous draft were **wrong** — see
> "Corrections to the previous draft" before implementing anything.

### Step 2 implementation note

`RunOutputResolver.streamAttempts(manifestPath: string): AsyncGenerator<RunOutputResolverAttemptEvent, void, undefined>`
is implemented in `src/core/orchestration/RunOutputResolver.ts`. Its discriminated union yields
settled `ResolvedRunAttemptValue` records in settle order, with `unterminated: true` for open
attempts flushed at end-of-stream, plus runtime-transition and run-termination facts. Open state is
retained only for concurrently active attempts, with a just-terminated value held briefly when a
contiguous follow-up record can still extend it. `resolveAttempt` and `resolveLatestAttempts` are
both expressed as filters/reductions over `streamAttempts`; the delta/aggregate fold has one owner.

## Problem

`rerun`/`append`/`continue`/`step edit`/`step remove`/`step reorder` all require a
`--workflow <key>` and, for most of them, a `--run <ref|runId>` (or rerun's `--from`)
(`src/cli/CliRunCommandDefinitions.ts:110-147`, `src/cli/StepCommandDefinitions.ts:41-95`). There
is currently **no CLI-facing way to discover either value**. A user has to already know the
workflow key (e.g. from having just run it in the same session, or the VS Code dashboard) or go
spelunking by hand under `.ctrlyoke/.runs/<workflowKey>/` (or the user-scoped
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/` — see the debugging section of
`.github/copilot-instructions.md`) to find a `workflow.json` descriptor and its run directories.

The `history` command's own `--help` text says "Inspect and maintain persisted run history", but
today it only has two subcommands — `prune` and `relink`
(`src/cli/HistoryCommandDefinitions.ts:30-42`) — and both operate at the **project** scope (a
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

## Corrections to the previous draft

Read these first; three of them change the implementation, and the fourth was a bug in shipped
code that has since been fixed.

1. **`history show` cannot render `RunOutputResolver.stream()` events one-by-one as they arrive.**
   The timeline records streamed output as _deltas_ (`CLI_OUTPUT_CHUNK_APPENDED`,
   `CLI_OUTPUT_EVENTS_APPENDED`) **and** as a later _cumulative aggregate_
   (`CLI_OUTPUT_RECORDED`) for the same attempt. `resolveAttempt` spells the rule out —
   "A fresh aggregate supersedes every delta buffered before it"
   (`RunOutputResolver.ts:419-424`) — and folds them with `StreamingCliOutputAccumulator`. A
   naive append-order render therefore prints most of a step's output **twice**. This is the
   single most important change to the design; see "Rendering: fold per attempt, then render".
2. **`WorkflowPaths.runFilePath` is the wrong path.** It returns the run's working copy
   `workflow.ctrlyoke.json` (`src/utils/WorkflowPaths.ts:259`). `RunOutputResolver.stream()` takes a
   _manifest_ path — `WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef)`
   (`src/utils/WorkflowPaths.ts:298`). Note the module lives under `src/utils/`, not
   `src/core/orchestration/` where most other symbols cited here do; every bare `WorkflowPaths.ts:N`
   citation below means `src/utils/WorkflowPaths.ts`.
3. **`RunSummaryCache` does not make repeated `history list` invocations cheap.** It is an
   in-process memory cache; a one-shot CLI process starts cold every time and throws it away on
   exit. The previous draft's "the existing cache should make repeated invocations cheap
   regardless" is false for this consumer, and the O(lineages × runs) shape it waved away is the
   real cost. `getRunNavigationSummary` already exists to avoid exactly that — use it.
4. **`--no-color` was broken, and is now fixed — use the helper, not the old mechanism.**
   `runCommand` used to set `process.env.NO_COLOR = "1"` inside the command action, which never
   took effect: chalk 5 (`^5.6.2`) resolves `chalk.level` once while the module initializes, and
   in the esbuild bundle that is long before any action runs. So `--no-color` did nothing on
   `run`/`rerun`/`append`/`continue` in a TTY — the only place it could have mattered, since a
   redirected stream is already uncoloured. `ResolvedCliConfig.color` was likewise set at four
   sites and read at none.

   Fixed by `CliTerminalFormatter.setColorEnabled(enabled)`, which mutates `chalk.level` (and is
   deliberately a no-op for `true`, so omitting the flag never forces colour onto a pipe); the
   dead `color` field is gone. **Every new command's `--no-color` must call that helper** rather
   than reinventing either half. Covered by two cases in
   `src/test/unit/CliDryRunOutput.test.ts`.

5. **The registration sketches below (and in `CLI_HISTORY_SEARCH_PLAN.md`) show the wrong shape.**
   They write `.action(...)` as an inline closure, but no command group in this CLI is registered
   that way. All three existing definition modules take a handlers interface and delegate:
   `HistoryCommandHandlers` (`HistoryCommandDefinitions.ts:11-18`), `StepCommandHandlers`
   (`StepCommandDefinitions.ts:27-31`), `SecretCommandHandlers` (`SecretCommandDefinitions.ts:32`),
   each supplied by an object literal in `cli.ts` (`:184`, `:205`, `:235`). The split is the point:
   the definition module stays a pure, dependency-free description of the command surface, and the
   handler module is what the unit tests drive directly. **Extend the existing
   `HistoryCommandHandlers` interface with `list`/`runs`/`show` (and `search`) rather than inventing
   a second registration style**, and declare each command's options as an exported
   `History*Options` interface next to the existing `HistoryPruneOptions`/`HistoryRelinkOptions`.
   Read every `.action(...)` in the sketches below as `handlers.<name>(options)`.

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

One consequence of the scope difference is concrete rather than philosophical: `prune`/`relink`
take no `-d, --cwd` (`HistoryCommandDefinitions.ts:3-9`) and do no workspace bootstrap, because
they enumerate the whole user project registry. All three new subcommands are workspace-scoped and
therefore **do** need the bootstrap — see "Shared bootstrap".

## Proposed commands

### `ctrlyoke history list`

Lists every workflow lineage in the current workspace, i.e. every entry
`WorkflowLineageRepository.listLineageKeys(workspaceRoot)` finds under `WorkflowPaths.runsRoot`
(`WorkflowLineageRepository.ts:522-533`). For each key, read its descriptor via
`tryReadDescriptor(workspaceRoot, workflowKey)` (`WorkflowLineageRepository.ts:215-224` — the
non-throwing variant; a lineage whose descriptor is missing or mid-write is a legitimate row, not
an error) to get `workflowName`, `isFavorite`, `createdAt`, `lastModifiedAt`, `originalFile`
(`WorkflowLineageDescriptor`, `src/types/CtrlYokeTypes.ts:487-517`), falling back to
`readWorkflowDisplayName` (`WorkflowLineageRepository.ts:201-214`) for the name so this command
does not become a fourth copy of the descriptor-read-plus-derive pair that helper was created to
single-source.

```
$ ctrlyoke history list
KEY        NAME                          RUNS  LATEST            STATE
a1b2c3d4   Refactor auth middleware      4     2026-09-12 14:03   completed
e5f6a7b8   Nightly smoke test            1     2026-09-10 02:00   failed
```

Options: `-d, --cwd <path>` (matches every other workspace-scoped command), `--json` (array of
`{ workflowKey, workflowName, isFavorite, createdAt, lastModifiedAt, runCount, latestRun:
{ runId, runRef, executionState, startedAt, completedAt } }`).

Exclude lineages with `isSystemGenerated: true` from the default listing (mirrors
`WorkspaceSessionManager.ts:148`'s existing exclusion of system-generated lineages from
recent-session discovery) — add a `--all` flag to include them, since they are still real,
addressable lineages a power user might legitimately want to rerun.

**Do not call `getRunSummaries` per lineage for the RUNS/LATEST/STATE columns.** That reads every
run's `manifest.json` + `workflow.ctrlyoke.json` in every lineage, which is O(all runs in the
workspace) cold file I/O on a listing whose whole job is to be the cheap entry point. The purpose-
built alternative already exists: `OutputHistoryManager.getRunNavigationSummary(workflowKey)`
(`OutputHistoryManager.ts:1120-1149`) returns `{ runCount, primaryRunId }` from one `readdir` plus
**only the newest run's manifest** — its doc comment says it exists precisely to avoid "the per-run
cost this method exists to avoid". It does not currently expose `executionState`/`startedAt`, so
one of these two, decided at implementation time:

- **Preferred:** widen `getRunNavigationSummary`'s return to carry the newest run's
  `startedAt`/`executionState`. It already reads that manifest; the fields are free. Check whether
  the existing dashboard caller wants them too before adding a parallel method.
- Otherwise: add a thin public `getRunSummary(workflowKey, runRef)` wrapping the private
  `readRunSummaryRecord` (`OutputHistoryManager.ts:1246`) and call it once, for `runs[0]`.

Either way the per-lineage cost stays at one `readdir` + one descriptor read + one run's manifest,
not one run's manifest per run. Note that `executionState` sourced from the manifest alone can
differ from `RunSummary.executionState`, which lets the working file win (see
`readRunSummaryRecord`); for a display-only column that is an acceptable, and cheaper, answer —
state it in the code comment so the difference is not later "fixed" back into the expensive shape.

### `ctrlyoke history runs --workflow <key>`

Lists every run in one lineage, newest first, via `OutputHistoryManager.getRunSummaries(workflowKey)`
— the existing manifest-only listing that already reads each run's `manifest.json` +
`workflow.ctrlyoke.json` for harness/model disclosure without loading any output events
(`OutputHistoryManager.ts:1152-1162`, and `orchestration.instructions.md`'s `historyModel` section).
Here the per-run cost is the point of the command, so `getRunSummaries` is the right call — unlike
in `history list`. `RunSummary` (`WorkflowTimelineTypes.ts:124-143`) already carries exactly what a
user needs to pick a `--run`/`--from` value: `runId` (the short numeric ID `resolveCliRunRef`
accepts, `CliRunSelector.ts:14-64`), `runRef` (the stable directory-name selector), `startedAt`,
`completedAt`, `executionState`, `stepCount`, `primaryHarness`/`primaryModel`, `tokenTotals`,
`worktree`. It does **not** carry `workflowName`, so a header line naming the lineage needs
`readWorkflowDisplayName`.

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
`buildCliPreviewJsonResult` redacts other CLI JSON output, `CliJsonResultBuilder.ts:46-50`). No lock
is needed for this read (unlike `resolveCliRunRefAtLineage`, `CliRunSelector.ts:67-79`, which locks
specifically because it precedes a mutation) — plain `getRunSummaries` reads are already how the
webview's own run-list view works, uncached run listing included
(`orchestration.instructions.md`: "The run listing... is uncached too — one syscall").

### `ctrlyoke history show --workflow <key> --run <ref|runId>`

Prints one run's full recorded output to stdout in append order, so it can be read directly or
piped (`> file.txt`, `| less`, `| grep`).

Resolve `--run` through the same `resolveCliRunRef` used by `rerun`/`append`/`continue`
(`CliRunSelector.ts:14-64`) so `--run 3` and `--run run-1757603120000` both work identically to how
they already work for those commands — this is exactly the selector consistency `history runs`'
own printed `RUN`/`REF` columns are for. Use `resolveCliRunRef`, **not**
`resolveCliRunRefAtLineage`: the lock exists to make a selector durable across a following
mutation, and this command mutates nothing.

Then read the run's timeline via `RunOutputResolver.stream(manifestPath)`
(`RunOutputResolver.ts:202-216`) with `manifestPath` from
`WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef)` (`WorkflowPaths.ts:298`).

#### Rendering: fold per attempt, then render

This is the part the previous draft got wrong, and it is not a detail — it decides whether the
command needs a new core primitive.

`stream()` is lossless and append-ordered, which means it re-emits exactly what was written: for a
streaming harness, a long series of `STREAMING_CHUNK`/`STREAMING_EVENTS` deltas **followed by** a
`CLI_OUTPUT_RECORDED` aggregate that supersedes them. Rendering both prints the step twice.
Rendering only the deltas loses non-streaming harnesses and follow-up appends. Rendering only the
aggregate loses output that was streamed but never re-aggregated.

The correct projection already exists in core, twice: `RunOutputResolver.resolveAttempt`
(`:381-452`) and `resolveLatestAttempts` (`:459-…`) both walk `stream()`, buffer deltas in a
`StreamingCliOutputAccumulator` keyed per attempt, `discard()` on a fresh aggregate, and
`flush()` when the aggregate is still `isStreaming`. They differ only in what they retain.
`history show` needs a third retention policy — "every attempt, settled, in the order it settled"
— and it must not become a third copy of that switch.

**Recommendation: add `RunOutputResolver.streamAttempts(manifestPath)`**, an
`AsyncGenerator<ResolvedRunAttemptValue>` that yields each attempt once it settles (on
`ATTEMPT_TERMINATED`, or at end-of-stream for an attempt that never terminated), plus the
run-level `RUNTIME_TRANSITION`/`RUN_TERMINATED` facts. Memory stays bounded by the number of
_concurrently open_ attempts — which is the parallel-group width, not the run's event count — and
`resolveAttempt`/`resolveLatestAttempts` can then be expressed as filters over it, collapsing
three copies of the fold into one. This is the DRY answer and the only new core work this plan
needs; the previous draft's "nothing here requires new core/orchestration primitives" was wrong.

With a per-attempt generator in hand the CLI render loop is small, and maps onto the same
`CliTerminalFormatter` calls `cli.ts`'s live subscriptions already make (`cli.ts:886-1027`):

| `ResolvedRunAttemptValue` field                                        | Render call                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `prompt`, `kind`, `startReason`, `definition.step`                     | `renderPromptHeader` (+ `renderFinalStepLabel` for a finalStep target)    |
| `output.structured?.events`                                            | `renderEvents(events, target)`                                            |
| `output.response` when there are no structured events                  | `renderStreamingChunk(chunk, target)` then `flushStreamingBuffer(target)` |
| `output.scriptVerdict` / `output.cliCommand` / script-sourced `output` | `renderScriptOutput(output, target)`                                      |
| `scriptOutput` (`SCRIPT_EXECUTION`)                                    | `renderScriptOutput`'s command/stdout/stderr/exit-code rows               |
| `terminalState` / `terminalReason`                                     | `renderStatusMessage`                                                     |
| run-level `RUN_TERMINATED`                                             | a terminal status line                                                    |

Two facts about `CliTerminalFormatter` that constrain this, both verified:

- **It writes to `console.log`/`process.stdout.write` directly and takes no writer.** Only
  `renderExecutionPreview` accepts a `writeLine` (`CliTerminalFormatter.ts:394-397`). So
  `--json` mode must bypass the formatter entirely rather than redirect it, and any progress or
  diagnostic line this command emits has to go through `console.error` to stay out of a pipe.
- **It holds module-level mutable state** — `_streaming`, `_scriptStreaming`, `_scriptHeaders`
  (`CliTerminalFormatter.ts:515-526`), keyed by `target` + `runIndex` + `attemptIndex`. That
  keying happens to be exactly right for a historical replay of many attempts, but
  `flushStreamingBuffer(target)` must be called at each attempt boundary (as
  `onPromptComplete` does at `cli.ts:1021`) or the last partial line of each attempt is withheld.

**Redaction is already handled at the persistence layer**, not something this command needs to add:
`TimelineRecorder` runs every manifest and event write through `secretRedactionService.redactValue`
(`TimelineRecorder.ts:107, 230, 292`), so `events.jsonl` is already redacted at rest. `history show`
reads the same redacted records the dashboard does — no new secret-exposure surface. Redact again
at the `--json` boundary anyway, matching `buildCliPreviewJsonResult`'s belt-and-braces convention.

#### Script and condition data is fully available

`history show` renders rich `SCRIPT_VERDICT`/`SCRIPT_OUTPUT`/`SCRIPT_COMMAND` rows purely by
reading what is already persisted. `ScriptExecutionReporter.report()`
(`src/core/orchestration/ScriptExecutionReporter.ts:200`) calls `history.saveExecutionOutput(...)`
with a `CliOutput` carrying a full `scriptVerdict` (`:337-344`, populated by `createVerdict()` at
`:379`) and separately `history.recordScriptExecution(...)` with
`command`/`stdout`/`stderr`/`exitCode` (`:345`) — both gated on `context.historyFilePath && history`,
never on a dashboard being attached. `RunOutputResolver` surfaces both: the `OUTPUT` event's
`attempt.output.scriptVerdict`/`.cliCommand`/`.response`, and the dedicated `SCRIPT_EXECUTION`
event kind (`RunOutputResolver.ts:157-160, 318-333`).

(The previous draft spent a long paragraph arguing this command need not wait on
`CLI_OUTPUT_PARITY_PLAN.md`'s live-emitter fix. That plan is implemented — `renderScriptOutput` and
`getScriptVerdictStatusSummary` exist at `CliTerminalFormatter.ts:543,550` — so the argument is
moot and the paragraph is gone. The conclusion it reached still holds and is now just the design:
one formatter, shared by the live stream and the historical dump.)

#### Options

- `-d, --cwd <path>`
- `--workflow <key>` (required)
- `--run <ref|runId>` (required)
- `--step <index|final>` — scope to one queue step (zero-based, matching `step edit --index`) or to
  the final-step loops. **Ship this in the first pass.** The previous draft called the mapping
  half-considered and deferrable; with `streamAttempts` it is a one-line filter on
  `attempt.target`, whose type is already the exact discriminated union needed
  (`OutputExecutionTarget = { kind: "queue", stepIndex } | { kind: "finalStep", loopIndex }`,
  `src/types/OutputHistoryTypes.ts:24-26`), and whose two `kind` values are `FINAL_STEP_PHASES`
  (`DashboardConstants.ts:1038-1041`) — so no parallel notion of "final" gets invented. `--step
final` shows every final-step loop; every selection shows every attempt for the matched targets,
  consistent with how the webview shows attempt-group history rather than only the latest. A
  `--latest-attempt-only` flag can follow if anyone asks.
- `--json` — emit the raw per-attempt records as JSON Lines (one JSON object per line) instead of
  formatted text, so tooling can consume it (`jq`, a script that greps for a specific script
  failure) without re-parsing formatted terminal output. NDJSON rather than one blob because a run
  can hold thousands of events and the reader is a generator; see the `--json` note under
  "Risks".
- `--no-color` — one call to `CliTerminalFormatter.setColorEnabled(options.color !== false)`, as
  `runCommand` now does; see correction 4.

Non-goals for a first pass: interactive paging (the user can pipe to `less`/`more` themselves),
re-rendering a _live_ (`RUNNING`) run's in-progress output (this command reads a settled
`events.jsonl`; a live run should be watched via a second `ctrlyoke run` subscription or the
dashboard, not this command — though reading a currently-running run's history up to "now" is
harmless and should not be specially blocked either).

## Shared bootstrap — done

The shared bootstrap is implemented in `src/cli/CliWorkspaceBootstrap.ts` as
`bootstrapCliWorkspace(options, cliOverlay = {})`. It resolves `options.cwd ?? process.cwd()`,
initializes CLI logging, installs the user and workspace config backends, applies the supplied
`PartialCtrlYokeSettings` overlay, initializes run-history storage when it has not already been
frozen, and initializes the project-state registry with the repository toplevel.

`initializeRunHistoryLocation` is **not** optional: `WorkflowPaths.runsRoot` resolves through
`getFrozenRunHistoryLocation()` (`WorkflowPaths.ts:158-163`), so every lineage and run path these
commands touch is wrong without it — the commands would silently list nothing rather than fail.

The helper returns `{ workspaceRoot, createOutputHistoryManager, createLineageRepository }`.
The two service members are lazy factories so existing `step edit`/`remove`/`reorder` commands
retain their current service-construction timing. `prepareStepCommand` is now a thin wrapper that
passes the returned `workspaceRoot` to `createStepCommandContext`; the three inspection handlers
and `CLI_HISTORY_SEARCH_PLAN.md` can use the same helper without duplicating bootstrap logic.

Note that `handleHistoryCommand` (`cli.ts:1188-1194`) already does the right thing for these:
catch, print `Error: <message>` in red, `process.exit(2)`. Reuse it. Usage/parse errors and "no
such workflow key" both exit 2; there is no success-with-no-results exit code to invent.

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
  .option("--json", "Emit newline-delimited JSON attempt records instead of formatted text")
  .option("--no-color", ...)
  .action(...)
```

Handlers follow the same `(options, io) => Promise<void>` shape as
`pruneHistoryCommand`/`relinkHistoryCommand`, but without the confirmation/mutation machinery
(`confirmMutation`) since none of these three mutate anything. `HistoryCommandIo`
(`HistoryCommands.ts:19-24`) can be reused with `isInteractive`/`confirm` unused, or narrowed to
`{ writeOut, writeErr }` — the latter is cleaner and costs one type.

Reused building blocks:

- `WorkflowLineageRepository.listLineageKeys` / `.tryReadDescriptor` / `.readWorkflowDisplayName` —
  `history list`
- `OutputHistoryManager.getRunNavigationSummary` — `history list`'s RUNS/LATEST/STATE columns
- `OutputHistoryManager.getRunSummaries` — all of `history runs`
- `CliRunSelector.resolveCliRunRef` — `history show --run`
- `WorkflowPaths.manifestPath` — `history show`
- `RunOutputResolver` — `history show`, via the new `streamAttempts` (the one new core primitive)
- `CliTerminalFormatter` — `history show`'s text rendering

## Tests

`src/test/unit/` (per the routing table), following the shape of the existing CLI command tests
`StepCommands.test.ts` and `SecretCommands.test.ts`. The three that carry the most weight:

1. **`streamAttempts` against a fixture run whose step has both deltas and a later aggregate** —
   asserting the step's text appears exactly once. This is the regression the previous design
   would have shipped, and nothing else exercises it.
2. **`--step final` selects final-step loops, not the last queue step** — a fixture with both.
3. **`history list` does not read every run's manifest.** Count `readManifest` calls (or stub the
   history manager) against a lineage with several runs and assert one. Without this, the cheap
   path silently regresses to the expensive one on the first refactor.

## Docs

Add `## ctrlyoke history list` / `runs` / `show` to `docs/cli/ctrlyoke.md`, after the existing
`## ctrlyoke history prune` / `relink` sections (`:145`, `:166`) and before `## ctrlyoke step`
(`:181`). Include the NDJSON note (below) so `history show --json` isn't mistaken for `validate`'s
single-blob convention.

## Risks / open questions

- **JSON Lines vs. single JSON object for `--json`.** Streaming NDJSON matches the reader's
  generator shape and avoids materializing a whole run in memory just to serialize it — but it is a
  different `--json` contract than the one-versioned-line convention used elsewhere in the CLI
  (`validate --json`, `cli-binary.instructions.md`, `cli.ts:304`). Keep NDJSON and document the
  difference in both `--help` and the docs page. `CLI_HISTORY_SEARCH_PLAN.md` deliberately goes the
  other way for `history search --json`, because a search response is bounded by `--limit`; the two
  choices and the one reason for each should be stated together.
- **`streamAttempts` and interleaved parallel branches — resolved.** Attempts from a parallel group
  interleave in the timeline, so "the order it settled" is not "the order it started". The
  generator deliberately yields settle order without sorting, matching live CLI output; callers
  that want a presentation order can sort the settled values after consuming them.
- **An attempt that never terminated.** An interrupted run leaves an attempt with no
  `ATTEMPT_TERMINATED`. `streamAttempts` must yield it at end-of-stream rather than dropping it, and
  `history show` should mark it — an interrupted run is one of the main reasons to read this output.
