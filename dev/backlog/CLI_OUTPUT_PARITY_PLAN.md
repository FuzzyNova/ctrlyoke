# CLI Output Parity — render everything the dashboard Output pane renders

> **Status:** Not implemented. Audit taken 2026-10-04 against `OutputPane.tsx` →
> `OutputRow.tsx` (dashboard) and `src/cli/CliTerminalFormatter.ts` + the headless
> subscriptions in `src/cli.ts` (CLI). Builds on
> [`CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md`](../implemented/CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md),
> whose "Out of scope" section deferred CLI formatting of ctrlyoke's own MCP tools to this
> follow-up.

## Problem

Headless `ctrlyoke run` and `ctrlyoke history show` print a step's output through
`CliTerminalFormatter`. That renderer grew separately from the dashboard and now drops or
misprints several things the Output pane shows:

- **Whole event types are silent.** `USER_STEER` has no case in `renderEvent`; a comment
  calls it "display-only", but the dashboard renders it as a "● User message" block. A
  human steering a headless step leaves no trace in the terminal.
- **Events print twice or in fragments.** The dashboard pairs an operation's `initiated`
  event with its `completed`/`failed` event and folds `TOOL_RESULT` into its call before it
  builds a row (`normalizeCliEvents` + `getVisibleStructuredEvents`). The CLI prints every raw
  event as it arrives. A Bash command prints `$ cmd` once when it starts and again with its
  output, and Copilot's duplicate generic/MCP call rows are printed twice. The fix for those
  rows in
  [`MCP_EVENT_PIPELINE_GAPS_PLAN.md`](../implemented/MCP_EVENT_PIPELINE_GAPS_PLAN.md) lives
  in the normalizer, which the CLI never calls.
- **Detail is dropped inside events that do render.** Examples: a failed `TOOL_RESULT` with
  only `error` text prints nothing, web-search failures are invisible, file-read line ranges
  are lost, and ctrlyoke's own MCP tools print as a truncated JSON one-liner instead of their
  purpose-built summary.

The trigger for this audit was a doubled `[2 recall-info] [2 recall-info]` prefix. It came
from a `USER_STEER` event that printed nothing but still wrote the step prefix. That was fixed
by writing the prefix only when an event prints (`beginEventOutput`). Copilot's echoed prompt
was also being misclassified as a steer in headless mode; the headless event pumps now receive
`dispatchedPromptText`, so it is correctly hidden. Both fixes left the underlying gap: genuine
steers still do not render.

## Principle

The terminal is an append-only stream; the dashboard is a re-renderable view. Parity means
**the same information, in the same order, with the same filtering**, not the same
interactivity. Specifically:

- Anything the dashboard **shows** (text, labels, statuses, errors, counts, summaries) must
  be printed by the CLI, bounded, with the existing `formatTruncationNotice` pointer to
  `events.jsonl` wherever it truncates.
- Anything the dashboard **hides** must be hidden in the CLI by the **same shared code**,
  not a parallel rule: echoed prompts (classifier), superseded `initiated` events, duplicate
  tool rows, and `CONTEXT_WINDOW_SYNC`.
- Pure UI affordances are out of scope: see [Not in scope](#not-in-scope).

## Audit — structured events (`CLI_EVENT_TYPES`)

Dashboard column = `StructuredEventContent` in `OutputRow.tsx`. CLI column =
`CliTerminalFormatter.renderEvent`.

| Event                  | Dashboard                                                                                                            | CLI today                                                                                    | Gap                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT`                 | Markdown with context-reference links                                                                                | Raw streamed text                                                                            | None required. Raw markdown is readable in a terminal (see [Not in scope](#not-in-scope)).                                                                                                                                              |
| `THINKING`             | Labelled block                                                                                                       | `● <label>` + dimmed, indented text                                                          | None.                                                                                                                                                                                                                                   |
| `USER_STEER`           | "● User message" block, markdown body                                                                                | **Nothing**                                                                                  | **Missing.** Render genuine steers (see [§1](#1-user-steers)). The echoed prompt must stay hidden.                                                                                                                                      |
| `BASH_COMMAND`         | One row per command; `initiated` row hidden once its `completed`/`failed` arrives; output collapsed to N lines/chars | Prints every event; `$ cmd` repeats on completion; output is **unbounded**; no running state | Pair initiated/completed ([§2](#2-pairing-and-deduplication)); bound output with the same line/char caps and a truncation notice; show a running marker for an unpaired `initiated`.                                                    |
| `FILE_EDIT`            | Path + diff; `initiated` diff hidden once completed; diff from snapshot when the event lacks one                     | `~ Editing path…` then `~ path` + diff (60 lines)                                            | Pairing; fall back to a "no diff recorded" line instead of a silent bare path.                                                                                                                                                          |
| `FILE_WRITE`           | Path, status, content preview (diffable as all-added)                                                                | `+ path (N bytes)`                                                                           | Print a bounded content preview as added lines (reuse `renderDiffBlock` with empty `oldContent`).                                                                                                                                       |
| `FILE_READ`            | Path **with line range** (`getFileReadHeaderText`), status, error                                                    | Path only; `initiated` skipped                                                               | Use the shared header text so `path:12-40` survives; the header helper is webview-local and must move to a neutral util.                                                                                                                |
| `FILE_DELETE`          | Path, success/error, diff of removed content when known                                                              | `- path` or failure line                                                                     | Optional removed-content preview, bounded. Low priority.                                                                                                                                                                                |
| `MCP_TOOL_CALL`        | ctrlyoke tools → purpose-built view; others → `MCP: server.tool` + params + result                                   | `⚙ server:tool {params…80}` + result ≤100 chars                                              | ctrlyoke tools need the shared summaries ([§3](#3-ctrlyoke-mcp-tool-views)); generic label should match the dashboard's `MCP: server.tool`.                                                                                             |
| `WEB_SEARCH`           | Query, **success/error**                                                                                             | Query only                                                                                   | Print the failure and error text.                                                                                                                                                                                                       |
| `TOOL_CALL`            | Name, params, result/error with expansion                                                                            | `⚙ name {params…80}` + result                                                                | Pairing with `TOOL_RESULT`; otherwise fine.                                                                                                                                                                                             |
| `TOOL_RESULT`          | `output`, or `error`, or "Success"/"Failed"                                                                          | Prints only when `result.output` is set                                                      | **A failed result with only `error` prints nothing.** Mirror the dashboard's text choice. Most of these disappear once paired into their call.                                                                                          |
| `ASK_USER_QUESTION`    | Questions, options, answers, declines                                                                                | Same, bounded                                                                                | None.                                                                                                                                                                                                                                   |
| `COMPACTION`           | Divider with trigger + token counts                                                                                  | Same, plus summary                                                                           | None.                                                                                                                                                                                                                                   |
| `FOLLOW_UP_RESUMED`    | Divider with time                                                                                                    | Same                                                                                         | None. Note the dashboard **synthesizes** this divider in `workflowStore` (`computeStreamingEventsToMerge`) for post-completion activity. Confirm the CLI receives one through `onTargetStreamingEvents`, or synthesize it the same way. |
| `BACKGROUND_WORK_HOLD` | Headline + pending tasks                                                                                             | Same                                                                                         | None.                                                                                                                                                                                                                                   |
| `CONTEXT_WINDOW_SYNC`  | Never rendered; refreshes the stats footer                                                                           | Never rendered                                                                               | None for rendering. Stats are printed once at completion, so post-completion updates are lost; acceptable, see [§5](#5-row-level-chrome).                                                                                               |

## Audit — row kinds (`OUTPUT_ROW_KINDS`)

| Row kind                           | Dashboard                                                                        | CLI today                                                          | Gap                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLI_HEADER`                       | Step label, name, harness · model, re-run/retry badge, timestamp                 | `renderPromptHeader`: same fields, no timestamp                    | Timestamp optional.                                                                                                                                                           |
| `PROMPT`                           | Full prompt                                                                      | 20-line preview + truncation notice                                | None (bounded by design).                                                                                                                                                     |
| `CLI_COMMAND` / `SCRIPT_COMMAND`   | Command with working directory and "injected" marker (`formatCliCommandDisplay`) | `$ command`                                                        | Working directory and injected marker missing; `formatCliCommandDisplay` is webview-local.                                                                                    |
| `ERROR`                            | `Error:`/`Warning:` line from the attempt's `errorMessage`                       | Not printed from the attempt                                       | `PromptCompleteData` carries no error. Verify every failure reaches the terminal through a status message; if not, add `errorMessage` to the completion payload and print it. |
| `PLAIN_RESPONSE`                   | Raw response when no structured events                                           | `renderStreamingChunk`                                             | None.                                                                                                                                                                         |
| `SCRIPT_OUTPUT` / `SCRIPT_VERDICT` | Bounded output, verdict block                                                    | `renderScriptOutput` (bounded) + verdict                           | None.                                                                                                                                                                         |
| `STATUS`                           | Severity-styled message                                                          | `renderStatusMessage`                                              | None.                                                                                                                                                                         |
| `STATS`                            | Tokens/context, cost, session, elapsed, **script exit code**                     | `renderStats`: same minus exit code                                | Script exit code missing from the stats line (verdict block covers verdicts, not plain script steps).                                                                         |
| `ATTEMPT_GROUP_SUMMARY`            | "N attempts · tokens total"                                                      | `↻ step: N attempts · Ns total` (at end)                           | Token total missing.                                                                                                                                                          |
| `PARALLEL_GROUP_HEADER`            | Header with live member state                                                    | Header + tally lines                                               | None.                                                                                                                                                                         |
| `FINAL_STEP_LABEL`                 | Pass caption                                                                     | `renderFinalStepLabel`                                             | None.                                                                                                                                                                         |
| `STEP_ANCHOR`, `STEP_HIDDEN`       | Scroll anchor; "hidden step" placeholder                                         | —                                                                  | UI-only.                                                                                                                                                                      |
| `RunSummaryBanner` (outside rows)  | Run id, start time, state, **token totals**, worktree                            | `✓ Workflow completed successfully` / `✗ Workflow ended: <status>` | Print run id, totals, and worktree path in the closing block.                                                                                                                 |
| `WorkspaceWorktreeOwnershipBanner` | Worktree ownership notice                                                        | —                                                                  | Print once at run start when it applies.                                                                                                                                      |

## Design

### 1. User steers

Add a `USER_STEER` case to `renderEvent`. It prints a `● User message` heading in the
dashboard's info colour, followed by the text, bounded with `writeBoundedEventDetail`.

Echoed-prompt suppression stays where it is now: in each parser's `classifyUserEvent`, which
returns `injected-prompt` for ctrlyoke's own prompt. All three event pumps
(`CliLogMonitor`, the headless stdout pump in `CliTransportCoordinator`, and
`HeadlessLogTail`) pass `dispatchedPromptText`, so a `USER_STEER` that reaches any renderer
is genuine. The CLI must **not** add its own "looks like the prompt" filter; a second rule
would drift from the classifier. Remove the "display-only, intentionally unhandled" comment at
the end of `renderEvent`.

### 2. Pairing and deduplication

The CLI has to apply the same pairing rules the dashboard does, without giving up live output.

- **History replay** (`HistoryInspectionCommands.renderHistoryAttempt`) has the whole event
  list. Run it through `normalizeCliEvents` (already in `src/utils/`) and the
  initiated-row hiding from `getVisibleStructuredEvents` before `renderEvents`. Move
  `getVisibleStructuredEvents` from `src/ui/webview-react/utils/outputRenderUtils.ts` into
  `src/utils/` so both renderers share one implementation.
- **Live runs** receive events in batches. Printing only at completion would hide long Bash
  commands until they finish, so the formatter instead tracks open operations by the
  normalizer's correlation key (`toolCallId`, falling back to the same type+path/command key
  the normalizer uses). The behaviour:
  - An `initiated` event prints a one-line running marker (`$ cmd …`, `~ Editing path…`).
  - The matching `completed`/`failed` event prints only the body (output, diff, exit status)
    under that marker. It does not repeat the header.
  - A `TOOL_RESULT` prints under its open call.
  - A completion with no open operation prints in full, as today.

  Export the correlation helpers (`getToolCallId`, `getEventKey`) from
  `CliEventNormalizer.ts` rather than re-deriving keys in the CLI. Copilot's duplicate rows
  (a call with params followed by the same call with a result) must collapse to one printed
  call. Cover this with the Copilot fixture from the pipeline-gaps plan.

Interleaving: parallel branches already stream into one terminal with `[N step]` prefixes.
A body printed under a marker must re-emit that prefix if another target wrote in between.
Track the last-written target key next to `_streaming`.

### 3. ctrlyoke MCP tool views

The view models in `src/ui/webview-react/components/output/ctrlyoke-tools/*Model.ts` mix
three concerns:

- platform-neutral parsing and summaries (`parse*Params`, `parse*ResultText`, `*Summary`,
  `*SearchText`);
- webview height estimation (`estimate*Height`, which pulls `toolCallLayout`/`rdvAdapter`);
- React bodies.

The CLI can only import the first.

1. Move each tool's parse functions, summary, and a new `terminalLines(params, result)` into a
   neutral module, `src/utils/ctrlyokeToolViews/`. `terminalLines` returns the body as plain
   lines with semantic tags (`warning`, `muted`, `untrusted`), not colours. Also move
   `unwrapCtrlYokeToolResultText`, `tryParseJson`, `isRecord`,
   `coordinationParticipantParser`, and `COORDINATION_UNTRUSTED_LABEL` (today in the webview's
   `utils/coordinationPresentation.ts`), plus the resolver (server id via
   `MCP_SERVER_IDS.CTRLYOKE` and the commit-server constant, tool via the `MCP_*_TOOL_NAME`
   constants). Height estimation and React bodies stay in the webview folder and import the
   neutral models. The webview registry's typed `Record<McpToolName, …>` stays the
   completeness check, and the neutral registry gets its own full `Record` so a new tool fails
   to compile until it has terminal output too.
2. In `renderEvent`'s `MCP_TOOL_CALL` case, resolve the view first. On success, print the
   summary as the header line, with warning colour when the view flags it (e.g. `claim_paths`
   denials), then print `terminalLines` bounded by `writeBoundedEventDetail`. Fall back to
   the generic rendering on parse failure, on an error result (keeping the red error line),
   and for non-ctrlyoke servers. This is the same contract as the dashboard.
3. Per-tool terminal bodies follow the table in the implemented views plan:
   - `append_step`: landed positions and names.
   - `post_note` / `read_notes`: note text, marked untrusted with the same
     `COORDINATION_UNTRUSTED_LABEL`.
   - `claim_paths`: granted paths and denied paths with their owners.
   - `workflow_status`: progress plus a compact step list.
   - `submit_commit_message`: the full message.
   - The rest: summary plus a short list.

   No Raw toggle; a `--verbose` run can append the generic params/result after the summary.

### 4. Per-event detail fixes

These are small, independent changes in `renderEvent`, each reusing a shared helper:

- `TOOL_RESULT`: same text choice as the dashboard (`error` when failed, else `output`, else
  "Success"/"Failed"). Move that choice into a shared helper next to `getToolResultText`.
- `WEB_SEARCH`: print failure + error.
- `FILE_READ`: line range through a shared `getFileReadHeaderText`.
- `FILE_WRITE`: bounded content preview.
- `BASH_COMMAND`: apply line/char caps, so long command output gets the same bound and
  `events.jsonl` pointer as script output.
- Generic MCP label: `MCP: server.tool`, matching the dashboard and find text.

### 5. Row-level chrome

- Command line: share `formatCliCommandDisplay` (working directory, injected marker) by
  moving it out of the webview.
- Stats: add the script exit code; add the token total to the retry aggregate.
- Errors: confirm or add the attempt `errorMessage` path (see the row audit).
- Closing block: run id, token totals (`WorkflowTokenTotals`), and worktree path, mirroring
  `RunSummaryBanner`. Print the worktree ownership notice once at start.
- `CONTEXT_WINDOW_SYNC`: leave as is. Stats print once per attempt; reprinting a footer for
  post-completion follow-ups would add noise to an append-only stream.

## Not in scope

- Interactivity: undo/redo, collapse/expand, Raw toggles, find highlighting, hide/solo step,
  minimap, copy buttons, clickable context references.
- Markdown rendering of `TEXT`/steer bodies. Raw markdown reads acceptably in a terminal, and
  a terminal markdown renderer is a separate decision (dependency, width handling, `--no-color`).
- Interactive (`--interactive`) mode, which passes the harness TUI through untouched.
- `--json` / `--quiet` output, whose contract is unchanged.

## Implementation order

1. **User steers** ([§1](#1-user-steers)) and the `TOOL_RESULT`/`WEB_SEARCH` silent-failure
   fixes. Small, and each closes an outright missing render.
2. **Pairing** ([§2](#2-pairing-and-deduplication)): move `getVisibleStructuredEvents` to
   `src/utils/`, normalize history replay, then live open-operation tracking. Fixes the
   doubled Bash commands and Copilot's duplicate calls.
3. **ctrlyoke MCP tool views** ([§3](#3-ctrlyoke-mcp-tool-views)): neutral model move first
   (webview behaviour unchanged, existing webview tests must pass untouched), then the CLI
   renderer, shipping `post_note` and `append_step` first as the original plan did.
4. Remaining per-event detail ([§4](#4-per-event-detail-fixes)) and row chrome
   ([§5](#5-row-level-chrome)).

## Tests

All in `src/test/unit/CliDryRunOutput.test.ts` style (compiled formatter in a child process,
`FORCE_COLOR=0`), plus moved-module tests where code moves.

- `USER_STEER` renders its text once, prefixed once; the full headless pipeline with a
  Copilot `user.message` echoing the dispatched prompt renders no steer.
- Bash `initiated` → `completed` prints the command once; a long output is bounded with a
  notice; an unpaired `initiated` leaves a running marker.
- Copilot duplicate generic and MCP calls (pipeline-gaps fixtures) print one call each, live
  and through `history show`.
- Failed `TOOL_RESULT` with only `error`, and a failed `WEB_SEARCH`, print their errors.
- Each ctrlyoke tool: summary + body from a recorded result; parse failure and error result
  fall back to the generic line; an event with no `parameters` still renders from the result.
- A parity guard: a test that fails when a `CLI_EVENT_TYPES` member has neither a
  `renderEvent` case nor an entry in an explicit "never rendered" list
  (`CONTEXT_WINDOW_SYNC` only). This would have caught `USER_STEER`. Keep the same
  exhaustiveness for the ctrlyoke tool registry via its `Record` type.
