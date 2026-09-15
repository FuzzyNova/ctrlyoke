# CLI Output Parity — bring headless `run` output up to date with the OutputPane

> **Status:** Phase 1 complete; Phases 2–4 remain planned. The audit below was re-verified
> against the code on 2026-09-15 and three findings in the original draft were corrected — see
> "Root cause (corrected)".

## Problem

The webview dashboard's Output pane (`src/ui/webview-react/components/output/`) has accumulated a
lot of structured rendering over time — pre/end-condition script output, pass/fail verdict cards,
parallel-group progress, retry-attempt summaries, tool-call/diff formatting — while
`src/cli.ts` / `src/cli/CliTerminalFormatter.ts` was not kept in step. Headless `ctrlyoke run`
users now see a visibly poorer, less informative stream than what the dashboard shows for the same
run, and for two structured-event subtypes the CLI shows nothing at all.

This doc is the audit: every row kind the OutputPane can render, whether the CLI has an equivalent,
and — where it doesn't — whether that's a rendering gap (data exists, CLI just doesn't format it)
or a data-availability gap (the underlying event never reaches CLI code in the first place).

## Root cause (corrected)

The original draft of this doc placed the script/condition gap at
`WorkflowExecutor.ts:3520-3528` and proposed a new emitter carrying
`ConditionEvaluationSummary`. Re-verification shows that is the wrong hook point and the wrong
payload. Three corrections, each of which changes the implementation plan:

**1. `ScriptExecutionReporter.report()` is the single funnel, not `WorkflowExecutor`.**
`src/core/orchestration/ScriptExecutionReporter.ts` is the one call path every script execution
passes through — all four `SCRIPT_OUTPUT_SOURCES` (`PRE_CONDITION`, `END_CONDITION`,
`SCRIPT_STEP`, `WORKTREE_SETUP`). Inside `report()` it already constructs precisely the data the
three missing row kinds render:

- `initOutput.cliCommand = properties.script` → the `SCRIPT_COMMAND` row
- `publishChunk()` streaming stdout/stderr → the `SCRIPT_OUTPUT` rows
- `finalOutput.scriptVerdict = this.createVerdict(...)` → the `SCRIPT_VERDICT` card

All three are dispatched only through `dispatchDashboardOutput()` / `publishChunk()`, both of
which are `context.dashboardProvider?.…` gated, plus the history manager. The
`WorkflowExecutor.ts:3520-3528` block the draft pointed at is merely the _failure status update_
for end-conditions — it is downstream of the verdict, and covers one of the four sources.
Hooking `ScriptExecutionReporter` fixes all three row kinds for all four sources in one place.

**2. The payload should be `CliOutput` (carrying `ScriptVerdict`), not `ConditionEvaluationSummary`.**
`ScriptVerdict` (`CtrlYokeTypes.ts:~893-905`) carries `outcome` (passed/failed/errored),
`matchRule`, `action`, `actionDetail` and `timedOut`. `ConditionEvaluationSummary`
(`CtrlYokeTypes.ts:909-922`) is the narrower projection retained for the automation result and
has none of those. Emitting `ConditionEvaluationSummary` would hand the CLI a strictly poorer
object than the webview renders. `ScriptExecutionReporter` already assembles a `CliOutput` with
`scriptVerdict` attached — that is the object to forward.

**3. `--json` mode is not affected and already reports condition results.**
`src/cli/CliJsonResultBuilder.ts` already imports and projects `ConditionEvaluationSummary`
(see `:502`), sourced from the persisted workflow file via
`PromptQueue.getPreConditionSummary()` / `getEndConditionSummary()`. So the claim "the data never
reaches CLI code" is true only of the _live headless stream_. Any change here must leave
`CliJsonResultBuilder` output byte-identical.

**4. Parallel-group and retry aggregation are rendering gaps, not data gaps.**
`PromptStartData` and `PromptCompleteData` (`src/core/OutputCaptureBuffer.ts:23-47`) both already
carry `parallelGroupId`, and both already carry `attemptIndex`/`runIndex`. Both emitters are
already subscribed in `cli.ts`. The group's membership and names are in the workflow file the CLI
itself loaded. So the CLI can derive per-branch running/done/failed counts and a retry-attempt
aggregate from data it already receives — no new core emitter is required for these.

## Background: two parallel event surfaces, not one

`WorkflowInstance` exposes **two independent event surfaces**, and most of the real gaps below
trace back to this split rather than to `CliTerminalFormatter.ts` being merely under-featured:

1. **`IDashboardSink`** (`src/types/IDashboardSink.ts:70-129`) — ~20 `update*`/`notify*` methods
   (`updateStepStatus` carrying `endConditionResult?: unknown`, `updateStepsExtended`,
   `updateRetryAttempt`, `updateCliStreamingEvents`, `notifyNotificationEvent`, etc.). Consumed
   only by the webview dashboard.
2. **Five `TypedEmitter` fields** built specifically for the CLI
   (`src/core/WorkflowInstance.ts:490-522`, comment: "Designed for the standalone CLI"):
   `onPromptStart`, `onPromptComplete`, `onWorkflowStatusMessage` (a flattened
   `{stepIndex, message: string, severity: string}`), `onTargetStreamingEvents`,
   `onTargetStreamingChunk`.

`src/cli.ts:713-729` constructs `WorkflowInstance` with `dashboardSink: undefined` and only
subscribes to the 5 CLI emitters (`src/cli.ts:740-778`). Anything gated on
`if (context.dashboardProvider && ...)` never executes in CLI mode — for several row kinds this is
a genuine "data never computed for/forwarded to headless mode" gap, not just a missing formatter.

The script/condition rows are where this split bites hardest: everything a verdict card needs is
computed unconditionally inside `ScriptExecutionReporter.report()` (it drives pass/fail control
flow regardless of who is watching) and then handed off only to `context.dashboardProvider`. None
of the 5 CLI emitters carry it, so a headless user sees at most the flattened one-line
`formatVerdictSummary()` status — no script name, no stdout/stderr, no expected-vs-actual, no
duration. See "Root cause (corrected)" above for the exact hook point.

## Row-kind audit

Source of truth for row kinds: `OUTPUT_ROW_KINDS` (`src/types/DashboardConstants.ts:3333-3351`),
17 values. Webview construction: `src/ui/webview-react/utils/outputRows.ts`. Webview rendering:
`src/ui/webview-react/components/output/OutputRow.tsx` + subcomponents in the same directory. CLI
rendering: `src/cli/CliTerminalFormatter.ts` + subscription wiring in `src/cli.ts:740-778`.

| Row Kind                | What it represents                                                                                                                                                                                         | Webview richness                                                                                                                            | CLI status                           | Gap details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATTEMPT_GROUP_SUMMARY` | Collapsed summary of a retry/manual-rerun attempt group (`outputRows.ts:2460-2473`)                                                                                                                        | Clickable "N attempts · total" button expanding back into individual attempts (`OutputRow.tsx:1918-1935`)                                   | **Missing (rendering gap)**          | The aggregate goes to `dashboardSink.updateRetryAttempt` (`IDashboardSink.ts:108-113`), but `attemptIndex`/`runIndex` are already on `PromptStartData`/`PromptCompleteData`, so the CLI can derive its own. Today it prints only an inline "Retry N"/"Re-run N" in the step header (`CliTerminalFormatter.ts:643-658`) with no closing aggregate.                                                                                                                                                                         |
| `PARALLEL_GROUP_HEADER` | Header marking a parallel-step group's start, with per-branch chips (`outputRows.ts:2098-2154`)                                                                                                            | Title/summary, running/complete/failed counts, group-wide undo/redo, per-branch solo/hide chips                                             | **Missing (rendering gap)**          | Only `renderExecutionPreview` prints a static one-line group banner pre-execution (`CliTerminalFormatter.ts:238-249`). `parallelGroupId` **is** already present on both `PromptStartData` and `PromptCompleteData` (`OutputCaptureBuffer.ts:30,41`), so live per-branch counts are derivable in `cli.ts` today — no new core emitter needed. (The draft cited `WorkflowInstance.ts:2880-2890, 3131-3141` as the data gap; those are queue-mutation sites — `append_step` and clipboard paste — not live execution state.) |
| `STEP_ANCHOR`           | Invisible scroll/minimap DOM anchor (`outputRows.ts:2357-2362, 2977-2982`)                                                                                                                                 | 1px invisible div, no content                                                                                                               | **N/A — webview-only**               | Pure virtualized-list/minimap scaffolding; meaningless in a linear terminal stream. No action needed.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STEP_HIDDEN`           | Placeholder for a user-hidden step's rows (`outputRows.ts:2368-2379`)                                                                                                                                      | Bordered strip with "Show" button, hidden-activity indicator                                                                                | **N/A — webview-only**               | Interactive filter/collapse affordance; no CLI equivalent needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `FINAL_STEP_LABEL`      | Caption marking a final-step-loop iteration (`outputRows.ts:2382-2389`)                                                                                                                                    | Small uppercase caption                                                                                                                     | **Partial**                          | CLI prints a generic step header for every step incl. final-loop steps but has no distinct "final step" labeling; final-step phase tracking is dashboard-sink-only (`WorkflowInstance.ts:3242-3244`).                                                                                                                                                                                                                                                                                                                     |
| `STATUS`                | Lifecycle/info/warning/error banner (`outputRows.ts:2404-2422`)                                                                                                                                            | Colored left-border block by severity, optional timestamp                                                                                   | **Full**                             | `StatusMessageReporter.report()` is the single call site feeding both the dashboard sink and the CLI's `onWorkflowStatusMessage`; `renderStatusMessage` (`CliTerminalFormatter.ts:678-689`) renders the same data. No gap.                                                                                                                                                                                                                                                                                                |
| `CLI_HEADER`            | Attempt chrome: timestamp, step label, harness/model, run/attempt badge, streaming indicator, undo/redo; also branches for pre-condition/end-condition/worktree-setup labeling (`outputRows.ts:2568-2582`) | Two-branch composite widget with distinct icon+label per branch                                                                             | **Partial**                          | Harness/model printed once at run start only (`src/cli.ts:703-705`), not per-step/attempt; no re-display on override; no condition-header branch equivalent to the webview's pre/end-condition/worktree-setup icon labeling.                                                                                                                                                                                                                                                                                              |
| `PROMPT`                | Raw prompt text sent to the harness (`outputRows.ts:2623-2631`)                                                                                                                                            | Full verbatim text with clickable atomic-context-reference chips                                                                            | **Partial**                          | `renderPromptHeader` shows only up to 5 preview lines (`MAX_PREVIEW_LINES = 5`, `CliTerminalFormatter.ts:661`) then truncates — no full-text view, no reference-chip parsing.                                                                                                                                                                                                                                                                                                                                             |
| `CLI_COMMAND`           | The actual CLI invocation run for a step (`outputRows.ts:2633-2644`)                                                                                                                                       | Left-bordered mono block, clickable file-path links                                                                                         | **Full-ish**                         | `renderPromptHeader`'s `cliCommand` branch prints `$ <cliCommand>` with a yellow border (`CliTerminalFormatter.ts:628-634`) — reasonable content parity; only missing interactivity, which is expected for a terminal.                                                                                                                                                                                                                                                                                                    |
| `SCRIPT_COMMAND`        | Underlying shell command a pre/end-condition script ran (same shape as `CLI_COMMAND`, different border color)                                                                                              | Same renderer as `CLI_COMMAND`                                                                                                              | **Missing**                          | `ScriptExecutionReporter` sets `initOutput.cliCommand = properties.script` but dispatches it only via `dispatchDashboardOutput()`. CLI has zero visibility into which command a condition is about to run.                                                                                                                                                                                                                                                                                                                |
| `ERROR`                 | Error/warning banner tied to a specific attempt (`outputRows.ts:2647-2662`)                                                                                                                                | Left-bordered block, red "Error:"/amber "Warning:", optional timestamp                                                                      | **Partial**                          | Ad hoc `console.error(chalk.red(...))` scattered through `cli.ts` (e.g. ~458-470, 623-631, 906-997, 1204-1206, 1561-1607, 1710-1724, 1923-1924) plus `renderStatusMessage`'s error branch — always a flattened string, no structured error object.                                                                                                                                                                                                                                                                        |
| `STRUCTURED_EVENT`      | Per-`CliEvent` row inside an attempt — tool calls, diffs, bash, file ops, ask-user-question, etc. (`outputRows.ts:2716-2814`)                                                                              | Richest kind: ~15 sub-renderers by event type, each independently collapsible, diff gap-collapsing, undo/redo                               | **Partial — see sub-taxonomy below** | `CliTerminalFormatter.renderEvent` (`CliTerminalFormatter.ts:393-609`) handles 14 of 16 `CLI_EVENT_TYPES`, all drastically flattened (param/output slicing, 60-line diff cap). `USER_STEER` and `CONTEXT_WINDOW_SYNC` remain intentionally unrendered because they are display-only/invisible on both sides.                                                                                                                                                                                                              |
| `PLAIN_RESPONSE`        | Response text when an attempt has no structured events (`outputRows.ts:2703-2714, 2830-2862`)                                                                                                              | Markdown-rendered (tables, code fences, mermaid), animated while streaming                                                                  | **Full-ish**                         | `renderStreamingChunk`/TEXT handling gives a live typewriter stream — reasonable parity; missing markdown rendering is an expected terminal limitation, not a real gap.                                                                                                                                                                                                                                                                                                                                                   |
| `SCRIPT_OUTPUT`         | Script stdout/stderr sliced into bounded rows for virtualization (`outputRows.ts:2080-2090, 2821-2827, 2843-2849`)                                                                                         | Mono block per segment, "show N more lines" tail-toggle                                                                                     | **Missing**                          | `ScriptExecutionReporter.publishChunk()` streams sanitized stdout/stderr, but only to `dashboardProvider` / the history manager. CLI sees no script output at all for conditions.                                                                                                                                                                                                                                                                                                                                         |
| `SCRIPT_VERDICT`        | Pass/fail verdict of a pre/end-condition or script step (`outputRows.ts:2881-2890`)                                                                                                                        | Collapsed one-liner ⇄ expanded card: Compare/Expected/Actual/Matched-by/Result/Action/Error                                                 | **Missing**                          | Same funnel as `SCRIPT_OUTPUT`/`SCRIPT_COMMAND`: the full `ScriptVerdict` is attached as `finalOutput.scriptVerdict` in `ScriptExecutionReporter` and then dispatched dashboard-only. **The single most concrete, best-evidenced gap in this audit**: no pass/fail badge, comparison values, or duration for any condition in CLI mode today — only the flattened one-liner from `formatVerdictSummary()` that rides `onWorkflowStatusMessage`.                                                                           |
| `STATS`                 | Token/cost/session/timing footer for a completed attempt (`outputRows.ts:2903-2911`)                                                                                                                       | Pipe-separated stat chips: context %, token totals w/ cached/created breakdown, cost, compaction count, session ID, elapsed time, exit code | **Full**                             | `renderStats` (`CliTerminalFormatter.ts:695-772`) is explicitly documented as mirroring the webview stats section, sourced from the same `PromptCompleteData`/`TokenFormatting` helpers. No gap.                                                                                                                                                                                                                                                                                                                          |
| `COORDINATION_ACTIVITY` | Multi-agent coordination protocol entry addressed to a step (`outputRows.ts:2989-2995`)                                                                                                                    | Left-accent block with participant attribution + entry summary, marked untrusted content                                                    | **Missing**                          | Sourced purely from webview store state (`useWorkflowStore().coordinationScope`) with **no `WorkflowInstance` emitter counterpart at all** — not a CLI oversight so much as a feature that was never wired past the webview.                                                                                                                                                                                                                                                                                              |

### `STRUCTURED_EVENT` sub-taxonomy (`CLI_EVENT_TYPES`, `DashboardConstants.ts:3023-3064`)

| Event type            | Webview renderer                                                                                                                | CLI handling                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEXT`                | `TextOutput`, markdown + find-highlight                                                                                         | Handled — live streaming text (`CliTerminalFormatter.ts:374-421`)                                                                                             |
| `THINKING`            | `ThinkingOutput`, indented "● Thinking" block                                                                                   | Handled (flattened)                                                                                                                                           |
| `USER_STEER`          | Display-only "● User message" passthrough                                                                                       | Arguably N/A — display-only in the webview too                                                                                                                |
| `BASH_COMMAND`        | `BashOutput.tsx` — collapsible command + independently collapsible stdout/stderr, exit-code badge, duplicate-output suppression | Handled but flattened — plain interleaved `console.log`, no independent stdout/stderr sectioning (`CliTerminalFormatter.ts:450-473`)                          |
| `FILE_EDIT`           | `DiffView.tsx` — full unified/split diff, collapsed-context-gap expansion, undo/redo                                            | Handled via `renderDiffBlock`/`parseUnifiedDiff` (`CliTerminalFormatter.ts:70-188`) but capped at `MAX_DIFF_LINES = 60` (line 46), no gap-collapsing, no undo |
| `FILE_WRITE`          | Full new-content block + undo/redo                                                                                              | Handled (flattened)                                                                                                                                           |
| `FILE_READ`           | Path + optional line-range ref                                                                                                  | Handled                                                                                                                                                       |
| `FILE_DELETE`         | Path + success/error + undo/redo                                                                                                | Handled                                                                                                                                                       |
| `MCP_TOOL_CALL`       | Label + collapsible params/output/error                                                                                         | Handled (flattened, 80-char param slice)                                                                                                                      |
| `WEB_SEARCH`          | Query + success/error                                                                                                           | Handled                                                                                                                                                       |
| `TOOL_CALL` (generic) | `GenericToolCallOutput` via `toolCallLayout.ts`'s `buildToolCallRenderPlan`                                                     | Handled (flattened)                                                                                                                                           |
| `TOOL_RESULT`         | Standalone result rendering when not paired inline                                                                              | Handled (100-char output slice, `CliTerminalFormatter.ts:597-608`)                                                                                            |
| `ASK_USER_QUESTION`   | Interactive Q&A block: question, options, recorded answer                                                                       | **Handled** — question/options/resolution rendered with bounded preview art and explicit truncation notices                                                   |
| `COMPACTION`          | Pill: "Conversation compacted — X → Y tokens"                                                                                   | **Handled** — trigger/token pill rendered with bounded summary and explicit truncation notices                                                                |
| `FOLLOW_UP_RESUMED`   | Pill divider marking post-completion resumed activity                                                                           | **Handled** — short follow-up divider                                                                                                                         |
| `CONTEXT_WINDOW_SYNC` | Invisible marker (webview also renders `null`)                                                                                  | N/A both sides                                                                                                                                                |

`toolCallLayout.ts` is shared collapse-state math (`buildToolCallRenderPlan`) computing per-section
(params/output/error) expansion/truncation independently — underlies several structured-event
subtypes' collapse behavior in the webview, not a distinct row kind itself.

## Decisions on the open questions

These were open in the draft; they are decided here so implementation does not have to re-litigate
them.

**D1 — New dedicated emitter, carrying `CliOutput`.** Add a new `TypedEmitter` field on
`WorkflowInstance` in the existing "Designed for the standalone CLI" block rather than widening
`onWorkflowStatusMessage`'s flattened `{message, severity}` shape. Widening the stringly-typed
payload is exactly the drift the codebase's constants conventions exist to prevent. The emitter
carries the `CliOutput` that `ScriptExecutionReporter` already builds (which includes
`source`, `cliCommand`, `exitCode` and `scriptVerdict`), plus the `OutputExecutionTarget`, so the
CLI can attribute it to the right step or finalStep loop exactly as the other targeted emitters do.

**D2 — Hook at `ScriptExecutionReporterContext`, not at the executor.** `ScriptExecutionReporterContext`
already carries optional non-dashboard callbacks (`onStatusMessage`, `captureCompletedOutput`,
`onFinalStepStatusMessage`). Add sibling optional callbacks there and wire them at the two places
that construct the context — `WorkflowInstance.buildWorkflowExecutionContext()` (the queue/condition
path) and the worktree-setup context (`WorkflowInstance.ts:~4862-4875`). This adds a CLI-facing emit
_alongside_ the existing dashboard-sink dispatch; it must not replace or restructure it.

**D3 — Bounded-with-notice is the headless default, not untruncated parity.** A terminal has no
re-expand affordance, so "match the webview" is not automatically right. The rule for every new
or widened CLI renderer: print a bounded amount and, when truncated, say so explicitly with the
omitted count (e.g. `… 412 more lines (see .ctrlyoke/.runs/…/events.jsonl)`), rather than either
silently cutting or dumping unbounded output. Existing silent truncations (`MAX_DIFF_LINES`,
`MAX_PREVIEW_LINES`, the 80/100-char slices) should gain the same notice.

**D4 — `--quiet` / `--json` stay untouched.** Every new subscription goes inside the existing
`executionMode === HEADLESS && !options.quiet && !options.json` block in `cli.ts:~734`. No new
decorative output may reach stdout in JSON mode, and `CliJsonResultBuilder` output must remain
byte-identical (it already reports condition summaries — see Root cause #3).

**D5 — `COORDINATION_ACTIVITY` is out of scope.** No `WorkflowInstance` emitter exists for it at
all; it is webview-store-only. Wiring coordination activity into the shared event surface is a
separate change and is not part of this effort.

## Implementation phases

Each phase is a self-contained, committable unit.

### Phase 1 — Missing structured-event cases (smallest, zero cross-layer risk) — **Done**

`CliTerminalFormatter.renderEvent`'s switch (`src/cli/CliTerminalFormatter.ts:403-610`) ends at
`TOOL_RESULT` with **no `default` branch**, so `ASK_USER_QUESTION`, `COMPACTION`,
`FOLLOW_UP_RESUMED`, `USER_STEER` and `CONTEXT_WINDOW_SYNC` all fall through silently. The first
two are correctness gaps — a mid-turn interactive question in headless mode currently produces
zero terminal output, which reads as a hang. Add `case` arms for `ASK_USER_QUESTION` (question,
options, and the resolved answer/decline from `AskUserQuestionData`) and `COMPACTION` (a
`preTokens → postTokens` one-liner from `CompactionData`), plus `FOLLOW_UP_RESUMED` as a divider.
`USER_STEER` and `CONTEXT_WINDOW_SYNC` stay deliberately unrendered. These event types already
arrive on `onTargetStreamingEvents` alongside the 11 handled siblings — no plumbing needed.

### Phase 2 — Script/condition output, command and verdict reach the CLI (highest value)

Implements D1 + D2. Adds the emitter, the context callbacks, both wiring sites, the `cli.ts`
subscription, and the `CliTerminalFormatter` renderers for script command / streamed script output /
verdict card (pass-fail badge, compare source, expected vs actual, matched-by rule, action, exit
code, duration, error). Covers all four `SCRIPT_OUTPUT_SOURCES` in one change. Verdict rendering
should reuse the existing shared `formatVerdictSummary()` wording where it fits rather than
re-deriving comparison phrasing.

### Phase 3 — Parallel-group and retry-attempt aggregation

Pure `cli.ts` + formatter work per Root cause #4: track `parallelGroupId` across `onPromptStart` /
`onPromptComplete` to print a group header on first branch start and a running/done/failed tally as
branches settle, and print a closing attempt-group aggregate ("N attempts · total elapsed") when a
step with `attemptIndex > 0` finishes.

### Phase 4 — Header, prompt and truncation-notice polish

Per-attempt harness/model in the step header (today printed once at run start,
`cli.ts:~703-705`), a condition/worktree-setup header branch matching the webview's `CLI_HEADER`
labeling, a distinct `FINAL_STEP_LABEL` caption for final-step-loop iterations, and D3's
truncation notices applied to the existing `MAX_PREVIEW_LINES` / `MAX_DIFF_LINES` /
param-and-output slice sites.

### Not planned

`STEP_ANCHOR`, `STEP_HIDDEN` (virtualized-list/minimap scaffolding, meaningless outside a
scrollable DOM list), `CONTEXT_WINDOW_SYNC` (invisible both sides), `USER_STEER` (display-only
passthrough in the webview too), and `COORDINATION_ACTIVITY` (D5).

## Remaining risks

- **Regression to the dashboard path.** Phase 2 touches `ScriptExecutionReporter`, which every
  script execution in both runtimes flows through. The CLI emit must be added beside the existing
  dashboard dispatch, never in place of it; `src/test/**` coverage for the reporter must assert the
  dashboard path is unchanged when no CLI callback is supplied.
- **Double-reporting the verdict.** `ScriptExecutionReporter.emitStatus()` already pushes a
  flattened one-liner through `statusReporter.report()`, which the CLI renders today via
  `onWorkflowStatusMessage`. Phase 2 adds a richer verdict card for the same event — decide
  explicitly whether the one-liner is suppressed in CLI mode or kept as the collapsed form, and do
  not ship both unconditionally.
