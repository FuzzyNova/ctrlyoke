# CLI Event Rendering Parity — print what the dashboard Output pane shows, filtered by the same code

> **Status:** Ready to implement. Audit taken 2026-10-04 against `OutputPane.tsx` →
> `OutputRow.tsx` (dashboard) and `src/cli/CliTerminalFormatter.ts` + the headless
> subscriptions in `src/cli.ts` (CLI), then re-verified against the code the same day; every
> open question from the draft is decided below under [Decisions](#decisions).
>
> **Predecessor:** [`CLI_OUTPUT_PARITY_PLAN.md`](../implemented/CLI_OUTPUT_PARITY_PLAN.md)
> (implemented) wired script/condition output, verdicts, parallel-group and retry aggregates,
> and the missing `ASK_USER_QUESTION`/`COMPACTION`/`FOLLOW_UP_RESUMED` cases into the CLI. It
> deliberately left `USER_STEER` unrendered as "display-only". That holds for live `ctrlyoke
run`, but not for `history show` replaying a dashboard run that was steered; see
> [§1](#1-user-steers). This plan also picks up the CLI formatting of
> ctrlyoke's own MCP tools that
> [`CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md`](../implemented/CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md)
> deferred under "Out of scope".

## Progress

- **Phase 1 complete.** Added CLI user-steer rendering and exhaustive event handling,
  shared tool-result text and MCP label utilities, and failed tool/web-search detail
  rendering. No deviations from the phase scope.
- **Phase 2 complete.** Added the incremental `CliEventNormalizer` and
  `isOpenCliOperation`, moved the superseded-Bash and duplicate-file-edit
  visibility predicates into shared utilities, and added the per-target
  `CliEventStream` used by live output and history replay. Completed the
  normalized-slot rendering and detail fixes: bounded Bash output, ranged
  `FILE_READ` headers, bounded `FILE_WRITE` previews, and the missing-diff
  `FILE_EDIT` placeholder. The dashboard still uses the function-form
  normalizer and its output filtering is unchanged.
- **Phase 3, item 1 complete.** Moved ctrlyoke MCP tool parsing and summaries to
  `src/utils/ctrlyokeToolViews/`, including an exhaustive neutral registry for
  all 13 tools. Kept height estimation and find-match slicing in the webview,
  and moved the shared coordination presentation helpers with their parsers.
  `npm run typecheck`, `npm run lint`, `npm run compile`, and `npm test` passed.

## Problem

Headless `ctrlyoke run` and `ctrlyoke history show` print a step's output through
`CliTerminalFormatter`. That renderer grew separately from the dashboard and now drops or
misprints several things the Output pane shows:

- **Recorded steers are silent on replay.** `USER_STEER` has no case in `renderEvent`; a
  comment calls it "display-only", but the dashboard renders it as a "● User message" block.
  A run started from the dashboard in interactive mode can be steered, and those steers are
  persisted to `events.jsonl`. `ctrlyoke history show` replays that run without the human's
  messages, so the replay reads as if the agent changed course on its own.
- **Events print twice or in fragments.** The dashboard runs the attempt's whole event list
  through `normalizeCliEvents` (inside `getVisibleStructuredEvents`), which merges each
  operation's `initiated` event with its `completed`/`failed` event and folds `TOOL_RESULT`
  into its call before a row is built. The CLI prints every raw event as it arrives. A Bash
  command prints `$ cmd` once when it starts and again with its output, and Copilot's
  duplicate generic/MCP call rows print twice. The fix for those rows in
  [`MCP_EVENT_PIPELINE_GAPS_PLAN.md`](../implemented/MCP_EVENT_PIPELINE_GAPS_PLAN.md) lives in
  the normalizer, which the CLI never calls — live or in `history show`.
- **Detail is dropped inside events that do render.** A failed `TOOL_RESULT` with only `error`
  text prints nothing, web-search failures are invisible, file-read line ranges are lost,
  Bash output is unbounded, and ctrlyoke's own MCP tools print as a truncated JSON one-liner
  instead of their purpose-built summary.

The trigger for this audit was a doubled `[2 recall-info] [2 recall-info]` prefix. It came
from a `USER_STEER` event that printed nothing but still wrote the step prefix; that is fixed
(`beginEventOutput` writes the prefix only when an event prints). Copilot's echoed prompt was
also being misclassified as a steer in headless mode; the headless event pumps now receive
`dispatchedPromptText`, so it is correctly hidden. Neither fix touched replay, where genuine
recorded steers still do not render.

## Principle

The terminal is an append-only stream; the dashboard is a re-renderable view. Parity means
**the same information, in the same order, with the same filtering**, not the same
interactivity. Specifically:

- Anything the dashboard **shows** (text, labels, statuses, errors, counts, summaries) is
  printed by the CLI, bounded, with the existing `formatTruncationNotice` pointer to
  `events.jsonl` wherever it truncates.
- Anything the dashboard **hides** is hidden in the CLI by the **same shared code**, not a
  parallel rule: echoed prompts (parser classifier), merged `initiated` halves (normalizer),
  superseded Bash `initiated` rows (`getVisibleStructuredEvents`), and `CONTEXT_WINDOW_SYNC`.
- Pure UI affordances are out of scope: see [Not in scope](#not-in-scope).

## Decisions

Each draft open question, answered. Where re-verification changed the draft's premise, the
correction is stated.

**D1 — Live pairing uses an incremental normalizer, not CLI-side correlation.** The draft had
the CLI export `getToolCallId`/`getEventKey` from `CliEventNormalizer.ts` and track open
operations itself. Re-reading the normalizer, the keys are the easy part: the pairing rules
also include id-disagreement rejection, the trailing-path match for Copilot's
relative-vs-absolute `apply_patch` paths, the adjacent-duplicate-completion merge, the
"Copilot trailing `TOOL_RESULT` must not hijack an in-flight call" guard, the id-less LIFO
fallback, and the skill-event rewriter. Re-deriving any of that in the CLI is exactly the
parallel rule the Principle forbids. Re-running `normalizeCliEvents` over the whole attempt on
every batch is also out: it clones every event per call, so a long attempt goes quadratic.

Instead, turn the body of `normalizeCliEventsWithSource` into a stateful
`CliEventNormalizer` class in the same file whose `append(events)` processes new events with
the identical loop and returns the slot indices it opened or changed.
`normalizeCliEventsWithSource` becomes `new CliEventNormalizer().append(events)` followed by a
snapshot, so there is still exactly one implementation. This works because the loop only ever
`push`es to `output` or replaces an entry in place; a slot's index is stable as input grows.

**D2 — One stream renderer serves live runs and `history show`.** A per-target
`CliEventStream` (in `src/cli/`) owns one `CliEventNormalizer` and the per-slot print state.
Live runs call `append(batch)` from the `onTargetStreamingEvents` subscription; history
replay calls `append(allEvents)` once and then `finish()`. Same rules, same output, one code
path. (Today `renderHistoryAttempt` passes the raw, un-normalized `events.slice(0, maxEvents)`
straight to `CliTerminalFormatter.renderEvents`; nothing on the CLI side calls
`getVisibleStructuredEvents` or the normalizer.)

**D3 — Each slot prints each part at most once, as soon as its data exists.** A slot's parts
are its header line, running marker, body (Bash output, diff, write preview, tool result,
ctrlyoke tool view) and error. After each `append`, every touched slot prints the parts that
now have data and have not printed yet. This one rule covers every case:

- `initiated` and `completed` in the same batch → one settled block, no marker.
- `initiated` alone → header with a running `…` marker; the later completion prints only
  the body/error.
- A slot completed by `TOOL_RESULT` that later gets its semantic completion with a diff →
  the diff prints then, once.
- Copilot's call-without-result followed by the same call with a result → the normalizer
  merges them into one slot, so one header and one result.
- An adjacent duplicate completion merged into an already-settled slot → nothing new to print.

"Open" means the normalizer's own rule: export `isOpenCliOperation(event)` from
`CliEventNormalizer.ts` (today's `createPendingEvent(...) !== undefined` test) rather than
re-deriving status checks. Do not use pending-list membership: a semantic slot stays pending
after a `TOOL_RESULT` merge even though its status is already `completed`.

**D4 — A body printed away from its header re-emits a compact header.** Track the
last-printed slot (target key + slot index) next to `_streaming`. If anything else printed
after this slot's header — another target in a parallel group, or another event of the same
target — the body is preceded by the slot's one-line header (`$ cmd`, `~ path`,
`MCP: server.tool`) with the target prefix. Otherwise it continues directly under the marker.

**D5 — Superseded Bash `initiated` rows use the dashboard's predicate.** When the normalizer
cannot merge them, `getVisibleStructuredEvents` hides an `initiated` Bash row followed by a
completion of the same command. Extract that test (and the `FILE_EDIT` hide-diff test beside
it) into a shared `findSupersededInitiatedIndex` in `src/utils/`, used by
`getVisibleStructuredEvents` and by `CliEventStream`. In the stream, a supersession means the
new completion prints as the body of the earlier marker (D3/D4) instead of a second header.
`getVisibleStructuredEvents` itself stays in the webview (it builds webview row records); only
the predicate moves.

**D6 — State lifetime.** A target's `CliEventStream` lives from its attempt's `onPromptStart`
until the next attempt of the same target starts or `releaseHeadlessOutputState` runs, not
until `onPromptComplete`, so post-completion follow-up activity (D9) still pairs with the
attempt's open calls. The event list it holds duplicates `OutputCaptureBuffer`'s
`accumulatedEvents` for the same attempt; that is bounded by one attempt per target and is
acceptable.

**D7 — `history show --max-events` counts normalized slots.** It counts what the user sees,
not raw events, so `--max-events 20` prints 20 blocks. Update the omitted-count message
accordingly.

**D8 — Error rows need no new payload.** The draft asked whether every attempt
`errorMessage` reaches the terminal. It does:

- Harness failures (`handleHarnessFailure`) emit a status message containing
  `failureReason` on all three branches: retry, continue, and stop.
- Other prompt failures call `notifyUserFeedback(..., "error", "Failed to execute …: <reason>")`,
  which `ConsoleUserFeedbackSink` writes to stderr.
- `history show` prints the attempt's `terminalReason`.

`PromptCompleteData` stays as it is. The parity test asserts each path prints its reason.

**D9 — Forward post-completion follow-up activity to the CLI.** The draft asked whether the
CLI receives `FOLLOW_UP_RESUMED`. Live, it does not: `SessionActivityRecorder` sends resumed
activity only to `dashboardSink`, and the divider is synthesized in two places (the recorder's
`persistResumedSessionActivity`, and `workflowStore` for the live dashboard). `history show`
already renders the persisted divider.

Add a `onResumedActivityEvents(target, events)` callback to `SessionActivityRecorderPort`.
`persistResumedSessionActivity` calls it with its computed `eventsToAppend`, so the CLI's
divider decision is the persisted one. `WorkflowInstance` fires `_targetStreamingEventsEmitter`
from it. The step-name expression that `WorkflowExecutor` builds inline twice (for chunks and
for events) moves into one helper that both the executor and this path use. Activity that
arrives after the whole run has settled is still lost, because the process exits.
`CONTEXT_WINDOW_SYNC` stays unrendered.

**D10 — ctrlyoke tool models split into a neutral model plus a webview view.** Details in
[§3](#3-ctrlyoke-mcp-tool-views). Two facts the draft missed:

- The `*Model.ts` files import through the webview's tsconfig aliases (`@root/…`,
  `@utils/…`). The neutral copies must use relative imports.
- `stepMutationModel.ts` pulls `rdvAdapter` for its height estimate, so that file must split
  as well.

Webview tests that import the models switch to the new paths. No re-export shims: the
project is pre-release.

**D11 — No `--verbose` raw tail.** `--verbose` already means "show debug information" (log
level and run-header details). Overloading it with event output would mix two meanings. The
`events.jsonl` pointer is the route to raw params and results.

**D12 — Bash output uses the script-output caps.** The dashboard's collapsed preview is an
interactive affordance that expands on click; the terminal cannot expand. Bound Bash output
with the existing `MAX_SCRIPT_OUTPUT_LINES`/`MAX_SCRIPT_OUTPUT_CHARS` (200 lines / 20,000
characters) and a `formatTruncationNotice` line. Script output and Bash output are the same
kind of thing to a reader.

**D13 — Snapshot-derived content stays dashboard-only.** The dashboard reconstructs a missing
`FILE_EDIT` diff, and a deleted file's removed content, from the workspace snapshot
(`getSnapshotStructuredPatch` and its neighbours in the webview's `outputRenderUtils.ts`).
The CLI has no snapshot live. For `FILE_EDIT` with no diff it prints `(no diff recorded)`
rather than a bare path; `FILE_DELETE` gets no content preview.

**D14 — Command line shows working directory and injection like the dashboard.** Move
`formatCliCommandDisplay` (webview `utils/outputCommandDisplay.ts`) to `src/utils/`. Add
`workingDirectory` to `PromptStartData`'s second fire. `OutputCaptureBuffer` already holds it
on the step entry, and `cliCommandWasInjected` is already on the payload.

**D15 — Script exit code is already covered; drop that gap.** The draft listed "script exit
code missing from the stats line". In fact, `ScriptExecutionReporter.report()` attaches a
`scriptVerdict` to every non-cancelled script output, including `SCRIPT_STEP`, and the CLI
verdict block prints `Exit code:`. A cancelled script has no exit code on either side.

**D16 — Retry aggregate gains token totals.** `renderAttemptGroupSummary` sums each attempt's
`PromptCompleteData.tokens` through `resolveTokenTotal`/`formatTokenCount` (already imported),
matching the dashboard's "N attempts · tokens total".

**D17 — Closing block mirrors `RunSummaryBanner`, minus the ownership banner.** After
`✓ Workflow completed successfully` / `✗ Workflow ended`, print:

- the run id;
- the run's token totals from `promptQueue.getState().tokenTotals`;
- when the run used a worktree, the branch, the path, and the outcome line.

For the worktree line, use `projectWorktreeRuntime` (already in `CtrlYokeTypes.ts`) and move
`formatWorktreeOutcome` from `RunSummaryBanner.tsx` to `src/utils/` so both sides word the
outcome identically.

`WorkspaceWorktreeOwnershipBanner` is **out of scope**. It describes the opened workspace,
not the run. Its data comes from the extension's activation-time worktree discovery (a Git
worktree scan in `ExternalRunWatchCoordinator`), which the CLI does not run and should not
add to startup just to print one line.

**D18 — No header timestamp.** Live output is happening now, and `history show` already
prints the run's start time in its run header. Adding a per-attempt timestamp would cost a
line per step for little value.

**D19 — The parity guard is a compile-time exhaustive switch.** End `renderEvent`'s switch
with an explicit `case CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC: break;` and a `default` that
assigns `event.type` to `never`. A new `CLI_EVENT_TYPES` member then fails `npm run
typecheck` until it has a case, which would have caught `USER_STEER`, and no runtime test is
needed. The neutral ctrlyoke tool registry gets the same guarantee from its
`Record<McpToolName, …>` type.

## Audit — structured events (`CLI_EVENT_TYPES`)

Dashboard column = `StructuredEventContent` in `OutputRow.tsx`. CLI column =
`CliTerminalFormatter.renderEvent`.

| Event                  | Dashboard                                                                                    | CLI today                                                                              | Change                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT`                 | Markdown with context-reference links                                                        | Raw streamed text                                                                      | None. Raw markdown reads acceptably in a terminal.                                                                                            |
| `THINKING`             | Labelled block                                                                               | `● <label>` + dimmed, indented text                                                    | None.                                                                                                                                         |
| `USER_STEER`           | "● User message" block, markdown body                                                        | **Nothing**                                                                            | **Render it** ([§1](#1-user-steers)). The echoed prompt stays hidden by the classifier.                                                       |
| `BASH_COMMAND`         | One row per command after normalization; superseded `initiated` row hidden; output collapsed | Every raw event; `$ cmd` repeats on completion; output **unbounded**; no running state | Stream rendering (D1–D5); `$ cmd …` marker while open; output bounded per D12.                                                                |
| `FILE_EDIT`            | Path + diff; superseded `initiated` diff hidden; diff from snapshot when the event lacks one | `~ Editing path…` then `~ path` + diff (60 lines)                                      | Stream rendering; `(no diff recorded)` when there is no diff (D13).                                                                           |
| `FILE_WRITE`           | Path, status, content preview (diffable as all-added)                                        | `+ path (N bytes)`                                                                     | Bounded content preview as added lines: `renderDiffBlock` with empty `oldContent`.                                                            |
| `FILE_READ`            | Path **with line range** (`getFileReadHeaderText`), status, error                            | Path only; `initiated` skipped                                                         | Header via the shared `getFileReadHeaderText` so `path:12-40` survives; print on open like other operations (one line; success adds nothing). |
| `FILE_DELETE`          | Path, success/error, removed content from snapshot when known                                | `- path` or failure line                                                               | None beyond stream rendering (D13).                                                                                                           |
| `MCP_TOOL_CALL`        | ctrlyoke tools → purpose-built view; others → `MCP: server.tool` + params + result           | `⚙ server:tool {params…80}` + result ≤100 chars                                        | Label `MCP: server.tool`; ctrlyoke tools via the neutral views ([§3](#3-ctrlyoke-mcp-tool-views)).                                            |
| `WEB_SEARCH`           | Query, **success/error**                                                                     | Query only                                                                             | Print failure and error text.                                                                                                                 |
| `TOOL_CALL`            | Name, params, result/error                                                                   | `⚙ name {params…80}` + result                                                          | Result text via the shared `getToolResultText`; pairing via stream rendering.                                                                 |
| `TOOL_RESULT`          | `getToolResultText`: `error` when failed, else `output`, else "Success"/"Failed"             | Prints only when `result.output` is set                                                | **A failed result with only `error` prints nothing today.** Use `getToolResultText`. Most results disappear into their call once normalized.  |
| `ASK_USER_QUESTION`    | Questions, options, answers, declines                                                        | Same, bounded                                                                          | None.                                                                                                                                         |
| `COMPACTION`           | Divider with trigger + token counts                                                          | Same, plus summary                                                                     | None.                                                                                                                                         |
| `FOLLOW_UP_RESUMED`    | Divider with time                                                                            | Same, but live runs never receive one                                                  | Forward resumed activity (D9).                                                                                                                |
| `BACKGROUND_WORK_HOLD` | Headline + pending tasks                                                                     | Same                                                                                   | None.                                                                                                                                         |
| `CONTEXT_WINDOW_SYNC`  | Never rendered; refreshes the stats footer                                                   | Never rendered                                                                         | None; becomes an explicit no-op case (D19).                                                                                                   |

## Audit — row kinds (`OUTPUT_ROW_KINDS`)

| Row kind                           | Dashboard                                                                    | CLI today                                                          | Change                                  |
| ---------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `CLI_HEADER`                       | Step label, name, harness · model, re-run/retry badge, timestamp             | `renderPromptHeader`: same fields, no timestamp                    | None (D18).                             |
| `PROMPT`                           | Full prompt                                                                  | 20-line preview + truncation notice                                | None (bounded by design).               |
| `CLI_COMMAND` / `SCRIPT_COMMAND`   | `formatCliCommandDisplay`: working directory, or the injected-prompt wording | `$ command`                                                        | Shared `formatCliCommandDisplay` (D14). |
| `ERROR`                            | `Error:`/`Warning:` line from the attempt's `errorMessage`                   | Reason printed via status message, stderr, or `terminalReason`     | None (D8); covered by a test.           |
| `PLAIN_RESPONSE`                   | Raw response when no structured events                                       | `renderStreamingChunk`                                             | None.                                   |
| `SCRIPT_OUTPUT` / `SCRIPT_VERDICT` | Bounded output, verdict block                                                | `renderScriptOutput` (bounded) + verdict incl. exit code           | None (D15).                             |
| `STATUS`                           | Severity-styled message                                                      | `renderStatusMessage`                                              | None.                                   |
| `STATS`                            | Tokens/context, cost, session, elapsed, exit code                            | `renderStats`; exit code lives in the verdict block                | None (D15).                             |
| `ATTEMPT_GROUP_SUMMARY`            | "N attempts · tokens total"                                                  | `↻ step: N attempts · Ns total` (at end)                           | Add token total (D16).                  |
| `PARALLEL_GROUP_HEADER`            | Header with live member state                                                | Header + tally lines                                               | None.                                   |
| `FINAL_STEP_LABEL`                 | Pass caption                                                                 | `renderFinalStepLabel`                                             | None.                                   |
| `STEP_ANCHOR`, `STEP_HIDDEN`       | Scroll anchor; "hidden step" placeholder                                     | —                                                                  | UI-only.                                |
| `RunSummaryBanner` (outside rows)  | Run id, start time, state, token totals, worktree outcome                    | `✓ Workflow completed successfully` / `✗ Workflow ended: <status>` | Closing block (D17).                    |
| `WorkspaceWorktreeOwnershipBanner` | Notice that the opened workspace is a managed worktree branch                | —                                                                  | Out of scope (D17).                     |

## Design

### 1. User steers

**Where a steer can reach the CLI renderer.** Steering needs a live PTY.
`HarnessIntegration.sendSteerMessage` is a no-op, and only `CliIntegration`'s interactive
session overrides it. So in `ctrlyoke run`:

- **Headless:** nothing can steer the harness, so a genuine `USER_STEER` never arrives. One
  that does is a misclassification, like the Copilot echoed-prompt bug.
- **`--interactive`:** the harness TUI is passed through and shows the user's own typing
  natively; `renderEvent` never runs.

The only source of genuine steers is **`history show`** replaying a run executed elsewhere —
typically a dashboard interactive run, where `CliLogEventPump` recorded the human's messages
as `USER_STEER` events.

Rendering the case in the shared `renderEvent` is still right for live runs. If a
misclassified echo ever reappears, it shows up visibly as a "User message" instead of hiding
behind the silent no-op that produced the doubled-prefix bug.

Add a `USER_STEER` case to `renderEvent`: a `● User message` heading in the dashboard's info
colour (`chalk.blue`, matching the `FOLLOW_UP_RESUMED` divider), then the text through
`writeBoundedEventDetail` capped at `MAX_PREVIEW_LINES` (20). A steer is a prompt, so it gets
the prompt preview's bound, not the 8-line event-detail bound.

Echoed-prompt suppression stays in each parser's `classifyUserEvent`, which returns
`injected-prompt` for ctrlyoke's own prompt. All three event pumps (`CliLogMonitor`, the
headless stdout pump in `CliTransportCoordinator`, and `HeadlessLogTail`) pass
`dispatchedPromptText`, so a `USER_STEER` that reaches any renderer is genuine. The CLI must
**not** add its own "looks like the prompt" filter. Remove the "display-only, intentionally
unhandled" comment at the end of `renderEvent` (replaced by D19's exhaustive tail).

### 2. Stream rendering (pairing and deduplication)

1. **`CliEventNormalizer` class** (`src/utils/CliEventNormalizer.ts`, D1). Move the loop state
   (`output`, `sourceIndexes`, `pending`, `skillEventRewriter`) onto the instance:
   `append(events): number[]` returns the touched slot indices, and `snapshot():
NormalizedCliEvent[]` returns the current slots. Rewrite `normalizeCliEventsWithSource` on
   top of it. Export `isOpenCliOperation`. The webview is unchanged: it still calls the
   function form.
2. **`findSupersededInitiatedIndex`** moves from `getVisibleStructuredEvents` into
   `src/utils/` (D5). `getVisibleStructuredEvents` calls it, and the webview's behaviour is
   unchanged.
3. **`CliEventStream`** (`src/cli/CliEventStream.ts`, D2–D4, D6). It holds one normalizer and
   a `Map<slotIndex, Set<SlotPart>>` of printed parts, where `SlotPart` is a `const` union
   (`header`, `marker`, `body`, `error`). Methods: `append(events)`, `finish()`, `dispose()`.
   TEXT and THINKING slots go straight to the formatter's existing streaming path; every
   other slot goes through the part-printing rule. The per-type part renderers are the
   current `renderEvent` cases, split into header and body halves; `renderEvent` itself
   remains the entry point for a settled one-shot event.
4. **Wiring.** `CliTerminalFormatter` keeps a `Map<targetKey, CliEventStream>`.
   - `renderEvents(events, target)` appends to the target's stream, creating it on demand.
   - `cli.ts`'s `onPromptStart` (first fire) disposes and replaces the stream for that
     target; `releaseHeadlessOutputState` disposes all of them.
   - `HistoryInspectionCommands.renderHistoryAttempt` creates a stream, appends the events,
     and calls `finish()`, with `--max-events` applied to slots (D7).

Interleaving: parallel branches already stream into one terminal with `[N step]` prefixes.
D4's last-printed-slot tracking supplies the re-emitted header and prefix.

### 3. ctrlyoke MCP tool views

The view models in `src/ui/webview-react/components/output/ctrlyoke-tools/*Model.ts` mix
three concerns:

- platform-neutral parsing and summaries (`parse*Params`, `parse*ResultText`, `*Summary`,
  `*SearchText`);
- webview height estimation (`estimate*Height`, which pulls `toolCallLayout`/`rdvAdapter`);
- React bodies.

The CLI can only import the first. The split:

1. **Neutral module `src/utils/ctrlyokeToolViews/`**, with relative imports only (D10):
   - one file per tool holding its params/result types, `parse*`, `*Summary`,
     `*SearchText`, any `warning` test, and a new `*TerminalLines(params, result):
ToolTerminalLine[]`;
   - `shared.ts` with `isRecord`, `tryParseJson`, `unwrapCtrlYokeToolResultText`, and the
     prompt-preview helpers; the find-highlight `sliceFindMatches` stays in the webview;
   - `coordinationParticipantParser.ts`;
   - `COORDINATION_UNTRUSTED_LABEL` and whatever of `coordinationPresentation.ts` the parsers
     need, moved rather than re-exported;
   - `registry.ts`: a `CtrlYokeToolModel<P, R>` interface, a full
     `Record<McpToolName, CtrlYokeToolModel<unknown, unknown>>`, and
     `resolveCtrlYokeToolModel(data)`. The resolver is the current `resolveCtrlYokeToolView`
     body: server check via `MCP_SERVER_IDS.CTRLYOKE`/`CTRLYOKE_COMMIT`, success and
     `Error:` guards, parse, summary, warning.

   `ToolTerminalLine` is `{ text: string; tone?: ToolTerminalTone }`, where the tone union
   comes from a `TOOL_TERMINAL_TONES` `const` object (`warning`, `muted`, `untrusted`), so the
   neutral module never picks colours.

2. **The webview keeps** `estimate*Height`, the React views, and `sliceFindMatches`.
   `CtrlYokeToolView<P, R>` becomes `CtrlYokeToolModel<P, R> & { estimateHeight }`, built
   from the neutral registry. Its own `Record<McpToolName, …>` stays the webview's
   completeness check. `stepMutationModel.ts`'s `rdvAdapter`-dependent estimate stays
   webview-side. Behaviour is unchanged; existing webview tests change only their import
   paths.
3. **Move `getToolResultText`** (webview `utils/toolResultText.ts`) to `src/utils/`. It is
   already the dashboard's result-text choice that the draft proposed creating. The neutral
   `unwrapCtrlYokeToolResultText` needs it too.
4. **Add `formatMcpToolLabel(server, tool)`** (`MCP: server.tool`) in `src/utils/`. It
   replaces today's three inline copies in `OutputRow.tsx`, `outputFind.ts` and
   `markdownExport.ts`, and is used by the CLI.
5. **CLI rendering of `MCP_TOOL_CALL`.** On open, print the generic `MCP: server.tool` marker.
   On settle, `resolveCtrlYokeToolModel` decides the body:
   - **Resolved:** print `⎿ <summary>`, in warning colour when `warning` is set (e.g.
     `claim_paths` denials), then the terminal lines, bounded at `MAX_EVENT_DETAIL_LINES`
     with a truncation notice. Map `untrusted` lines to the dim style and prefix the block
     once with `COORDINATION_UNTRUSTED_LABEL`.
   - **Not resolved** — parse failure, error result, or a non-ctrlyoke server: print the
     generic params and result via `getToolResultText`, keeping the red error line.

   This is the dashboard's contract.

Per-tool terminal bodies (all 13 `McpToolName`s; the summaries are the existing ones):

| Tool                    | Terminal body                                                    |
| ----------------------- | ---------------------------------------------------------------- |
| `append_step`           | One line per landed step: position, name, harness · model.       |
| `edit_step`             | Changed fields; the prompt as a bounded preview when it changed. |
| `remove_step`           | None (the summary names the step).                               |
| `reorder_steps`         | `from → to` pairs.                                               |
| `post_note`             | Note text, `untrusted`.                                          |
| `read_notes`            | One line per entry (`readNotesEntryText`), `untrusted`.          |
| `claim_paths`           | Granted paths; denied paths with their owners as `warning`.      |
| `release_paths`         | Released paths.                                                  |
| `workflow_status`       | Progress line plus `workflowStatusRowPrefix` + name per step.    |
| `global_status`         | One line per workflow: name, state, harness.                     |
| `read_output`           | `readOutputHeading` per item plus a bounded preview.             |
| `list_harnesses`        | One line per harness with its models.                            |
| `submit_commit_message` | The full message, bounded at `MAX_PREVIEW_LINES`.                |

### 4. Per-event detail fixes

These are small, independent changes, each reusing a shared helper:

- `TOOL_RESULT`, `TOOL_CALL`, generic `MCP_TOOL_CALL`: result text via `getToolResultText`.
  Remove the 100/200-character slices and bound with `writeBoundedEventDetail` instead.
- `WEB_SEARCH`: on failure, `✗ "query"` plus the error text.
- `FILE_READ`: header via `getFileReadHeaderText`. Move it from the webview's `outputFind.ts`
  to `src/utils/`; it depends only on `buildSelectionReferenceText` in `src/completions/`.
- `FILE_WRITE`: bounded content preview as added lines.
- `FILE_EDIT`: `(no diff recorded)` when there is neither patch nor old/new content (D13).
- `BASH_COMMAND`: bounded output (D12), with a running marker while open.

### 5. Row-level chrome

- Command line: shared `formatCliCommandDisplay` plus `workingDirectory` on `PromptStartData`
  (D14). Script commands keep their own border but use the same formatter.
- Retry aggregate token total (D16).
- Closing block (D17).
- Resumed follow-up activity (D9).

## Not in scope

- Interactivity: undo/redo, collapse/expand, Raw toggles, find highlighting, hide/solo step,
  minimap, copy buttons, clickable context references.
- Markdown rendering of `TEXT`/steer bodies. Raw markdown reads acceptably in a terminal, and
  a terminal markdown renderer is a separate decision (dependency, width handling, `--no-color`).
- Snapshot-derived diffs and delete previews (D13), and the workspace worktree ownership
  banner (D17).
- Per-attempt timestamps (D18) and reprinting stats for `CONTEXT_WINDOW_SYNC` follow-ups.
- Switching the dashboard to the incremental normalizer. It could adopt `CliEventNormalizer`
  later; this plan leaves its call sites alone.
- Interactive (`--interactive`) mode, which passes the harness TUI through untouched.
- `--json` / `--quiet` output, whose contract is unchanged. Every change stays inside the
  existing `!options.quiet && !options.json` block, and `CliJsonResultBuilder` output
  stays byte-identical.

## Implementation phases

Each phase is one committable unit with its own tests, and leaves `npm test` green.

### Phase 1 — Outright missing renders

- `USER_STEER` case (§1) and the D19 exhaustive tail.
- `TOOL_RESULT`/`TOOL_CALL`/generic MCP text via a moved `getToolResultText`.
- `WEB_SEARCH` failure.
- `formatMcpToolLabel`, adopted by the three webview sites and the CLI.

### Phase 2 — Stream rendering

1. `CliEventNormalizer` class plus `isOpenCliOperation`. The existing normalizer tests must
   pass unchanged.
2. Extract `findSupersededInitiatedIndex`. The webview tests must pass unchanged.
3. `CliEventStream` and the formatter wiring, covering live and `history show` (D7).
4. Bash bounds (D12), `FILE_READ` header, `FILE_WRITE` preview, `FILE_EDIT` no-diff line (§4).

### Phase 3 — ctrlyoke MCP tool views

1. Neutral module move (§3 steps 1–3); the webview behaves identically. Ship it as its own
   commit.
2. CLI renderer plus terminal bodies. Ship `post_note` and `append_step` first, as the
   original views plan did, then the rest in the same phase.

### Phase 4 — Chrome and follow-ups

- `formatCliCommandDisplay` + `workingDirectory` (D14).
- Retry token total (D16).
- Closing block with the moved `formatWorktreeOutcome` (D17).
- Resumed-activity forwarding (D9).

## Tests

Formatter tests follow `src/test/unit/CliDryRunOutput.test.ts` (compiled formatter in a child
process, `FORCE_COLOR=0`). Moved modules keep or move their existing tests.

- **Normalizer equivalence:** for every existing normalizer fixture, splitting the input into
  every possible two-batch cut, and into single-event batches, gives a final
  `CliEventNormalizer` snapshot equal to `normalizeCliEventsWithSource(all)`. Each `append`
  returns exactly the slots whose content changed.
- **Steers:** `history show` over a recorded attempt containing a `USER_STEER` renders its
  text once, prefixed once, in event order. As a regression guard, the full live headless
  pipeline with a Copilot `user.message` echoing the dispatched prompt renders no steer.
- **Bash:** `initiated` → `completed` in separate batches prints the command once with a
  marker and then the body. In one batch it prints one settled block. With another target's
  output in between, the body re-emits the compact header and prefix. Output over 200 lines
  prints a notice. An unpaired `initiated` leaves its marker.
- **Superseded `initiated`:** a Bash completion the normalizer cannot merge prints as the
  marker's body, not as a second header.
- **Copilot duplicates:** generic and MCP calls (pipeline-gaps fixtures) print one call each,
  live and through `history show`.
- **Late diff:** a `FILE_EDIT` settled by `TOOL_RESULT`, then completed with a patch, prints
  the diff exactly once.
- **Failures:** a failed `TOOL_RESULT` with only `error`, and a failed `WEB_SEARCH`, print
  their errors. Harness-failure stop, harness-failure continue, and non-harness failure each
  print the failure reason (D8).
- **ctrlyoke tools:** each tool renders summary + body from a recorded result. Parse failure
  and error result fall back to the generic line. An event with no `parameters` still renders
  from the result. `claim_paths` with denials uses the warning tone.
- **History:** `--max-events N` prints N normalized blocks and reports the omitted slot count.
- **Follow-ups:** resumed activity after a step completes reaches the CLI once, with one
  divider per attempt, matching the persisted events.
- **Closing block:** run id, token totals, and the worktree outcome line for each
  `formatWorktreeOutcome` branch. `--json` output is byte-identical to before.
