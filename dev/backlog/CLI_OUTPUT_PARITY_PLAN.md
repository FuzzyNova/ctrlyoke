# CLI Output Parity — bring headless `run` output up to date with the OutputPane

> **Status:** Not implemented. Research/audit only — no code changed yet.

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

## Root cause: two parallel event surfaces, not one

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

The clearest concrete example: `ConditionEvaluationSummary`
(`src/types/CtrlYokeTypes.ts:909-922`: `passed, action, script, expected, compareSource, actual,
actualSource, stdout, stderr, exitCode, durationMs, error`) is fully computed by
`WorkflowExecutor`/`EndConditionHandler` for every condition evaluation — it drives pass/fail
control flow regardless of who's watching — but it is only ever handed off inside a
dashboard-gated `if`:

```ts
// src/core/WorkflowExecutor.ts:3520-3528 (also :3985)
if (!result.shouldContinue) {
  if (context.dashboardProvider && signedStepIndex !== undefined) {
    context.dashboardProvider.updateStepStatus(signedStepIndex, {
      state: STEP_STATUS.FAILED,
      message: result.failureReason || "End condition failed",
      duration,
      endConditionResult: evaluationResult,
    });
  }
}
```

None of the 5 CLI emitters carry this object. A CLI user sees at most the flattened one-line
`"End condition failed"` status message — no script name, no stdout/stderr, no expected-vs-actual,
no duration.

## Row-kind audit

Source of truth for row kinds: `OUTPUT_ROW_KINDS` (`src/types/DashboardConstants.ts:3333-3351`),
17 values. Webview construction: `src/ui/webview-react/utils/outputRows.ts`. Webview rendering:
`src/ui/webview-react/components/output/OutputRow.tsx` + subcomponents in the same directory. CLI
rendering: `src/cli/CliTerminalFormatter.ts` + subscription wiring in `src/cli.ts:740-778`.

| Row Kind | What it represents | Webview richness | CLI status | Gap details |
|---|---|---|---|---|
| `ATTEMPT_GROUP_SUMMARY` | Collapsed summary of a retry/manual-rerun attempt group (`outputRows.ts:2460-2473`) | Clickable "N attempts · total" button expanding back into individual attempts (`OutputRow.tsx:1918-1935`) | **Missing** | Retry state only reaches `dashboardSink.updateRetryAttempt` (`IDashboardSink.ts:108-113`). CLI shows only an inline "Retry N"/"Re-run N" label in the step header (`CliTerminalFormatter.ts:643-658`) — no aggregate. |
| `PARALLEL_GROUP_HEADER` | Header marking a parallel-step group's start, with per-branch chips (`outputRows.ts:2098-2154`) | Title/summary, running/complete/failed counts, group-wide undo/redo, per-branch solo/hide chips | **Missing (dry-run only)** | Only `renderExecutionPreview` prints a static one-line group banner pre-execution (`CliTerminalFormatter.ts:238-249`). Live parallel state is dashboard-sink-gated (`WorkflowInstance.ts:2880-2890, 3131-3141`) — no live per-branch counts during `run`. |
| `STEP_ANCHOR` | Invisible scroll/minimap DOM anchor (`outputRows.ts:2357-2362, 2977-2982`) | 1px invisible div, no content | **N/A — webview-only** | Pure virtualized-list/minimap scaffolding; meaningless in a linear terminal stream. No action needed. |
| `STEP_HIDDEN` | Placeholder for a user-hidden step's rows (`outputRows.ts:2368-2379`) | Bordered strip with "Show" button, hidden-activity indicator | **N/A — webview-only** | Interactive filter/collapse affordance; no CLI equivalent needed. |
| `FINAL_STEP_LABEL` | Caption marking a final-step-loop iteration (`outputRows.ts:2382-2389`) | Small uppercase caption | **Partial** | CLI prints a generic step header for every step incl. final-loop steps but has no distinct "final step" labeling; final-step phase tracking is dashboard-sink-only (`WorkflowInstance.ts:3242-3244`). |
| `STATUS` | Lifecycle/info/warning/error banner (`outputRows.ts:2404-2422`) | Colored left-border block by severity, optional timestamp | **Full** | `StatusMessageReporter.report()` is the single call site feeding both the dashboard sink and the CLI's `onWorkflowStatusMessage`; `renderStatusMessage` (`CliTerminalFormatter.ts:678-689`) renders the same data. No gap. |
| `CLI_HEADER` | Attempt chrome: timestamp, step label, harness/model, run/attempt badge, streaming indicator, undo/redo; also branches for pre-condition/end-condition/worktree-setup labeling (`outputRows.ts:2568-2582`) | Two-branch composite widget with distinct icon+label per branch | **Partial** | Harness/model printed once at run start only (`src/cli.ts:703-705`), not per-step/attempt; no re-display on override; no condition-header branch equivalent to the webview's pre/end-condition/worktree-setup icon labeling. |
| `PROMPT` | Raw prompt text sent to the harness (`outputRows.ts:2623-2631`) | Full verbatim text with clickable atomic-context-reference chips | **Partial** | `renderPromptHeader` shows only up to 5 preview lines (`MAX_PREVIEW_LINES = 5`, `CliTerminalFormatter.ts:661`) then truncates — no full-text view, no reference-chip parsing. |
| `CLI_COMMAND` | The actual CLI invocation run for a step (`outputRows.ts:2633-2644`) | Left-bordered mono block, clickable file-path links | **Full-ish** | `renderPromptHeader`'s `cliCommand` branch prints `$ <cliCommand>` with a yellow border (`CliTerminalFormatter.ts:628-634`) — reasonable content parity; only missing interactivity, which is expected for a terminal. |
| `SCRIPT_COMMAND` | Underlying shell command a pre/end-condition script ran (same shape as `CLI_COMMAND`, different border color) | Same renderer as `CLI_COMMAND` | **Missing** | `ConditionEvaluationSummary.script` never reaches the CLI (dashboard-gated — see root cause). CLI has zero visibility into which command a condition is about to run. |
| `ERROR` | Error/warning banner tied to a specific attempt (`outputRows.ts:2647-2662`) | Left-bordered block, red "Error:"/amber "Warning:", optional timestamp | **Partial** | Ad hoc `console.error(chalk.red(...))` scattered through `cli.ts` (e.g. ~458-470, 623-631, 906-997, 1204-1206, 1561-1607, 1710-1724, 1923-1924) plus `renderStatusMessage`'s error branch — always a flattened string, no structured error object. |
| `STRUCTURED_EVENT` | Per-`CliEvent` row inside an attempt — tool calls, diffs, bash, file ops, ask-user-question, etc. (`outputRows.ts:2716-2814`) | Richest kind: ~15 sub-renderers by event type, each independently collapsible, diff gap-collapsing, undo/redo | **Partial — see sub-taxonomy below** | `CliTerminalFormatter.renderEvent` (`CliTerminalFormatter.ts:393-609`) handles 11 of 16 `CLI_EVENT_TYPES`, all drastically flattened (param/output slicing, 60-line diff cap). `ASK_USER_QUESTION` and `COMPACTION` have **no case at all** — silently dropped, confirmed by reading the switch (verified: no `default` branch either, `CliTerminalFormatter.ts:609`). |
| `PLAIN_RESPONSE` | Response text when an attempt has no structured events (`outputRows.ts:2703-2714, 2830-2862`) | Markdown-rendered (tables, code fences, mermaid), animated while streaming | **Full-ish** | `renderStreamingChunk`/TEXT handling gives a live typewriter stream — reasonable parity; missing markdown rendering is an expected terminal limitation, not a real gap. |
| `SCRIPT_OUTPUT` | Script stdout/stderr sliced into bounded rows for virtualization (`outputRows.ts:2080-2090, 2821-2827, 2843-2849`) | Mono block per segment, "show N more lines" tail-toggle | **Missing** | `ConditionEvaluationSummary.stdout/stderr` computed regardless of consumer, but only forwarded through the same dashboard-gated path as `SCRIPT_COMMAND`/`SCRIPT_VERDICT`. CLI sees no script output at all for conditions. |
| `SCRIPT_VERDICT` | Pass/fail verdict of a pre/end-condition or script step (`outputRows.ts:2881-2890`) | Collapsed one-liner ⇄ expanded card: Compare/Expected/Actual/Matched-by/Result/Action/Error | **Missing** | Same root cause as `SCRIPT_OUTPUT`/`SCRIPT_COMMAND` — dropped at `WorkflowExecutor.ts:3520-3528` before reaching any CLI emitter. **The single most concrete, best-evidenced gap in this audit**: no pass/fail badge, comparison values, or duration for any condition in CLI mode today. |
| `STATS` | Token/cost/session/timing footer for a completed attempt (`outputRows.ts:2903-2911`) | Pipe-separated stat chips: context %, token totals w/ cached/created breakdown, cost, compaction count, session ID, elapsed time, exit code | **Full** | `renderStats` (`CliTerminalFormatter.ts:695-772`) is explicitly documented as mirroring the webview stats section, sourced from the same `PromptCompleteData`/`TokenFormatting` helpers. No gap. |
| `COORDINATION_ACTIVITY` | Multi-agent coordination protocol entry addressed to a step (`outputRows.ts:2989-2995`) | Left-accent block with participant attribution + entry summary, marked untrusted content | **Missing** | Sourced purely from webview store state (`useWorkflowStore().coordinationScope`) with **no `WorkflowInstance` emitter counterpart at all** — not a CLI oversight so much as a feature that was never wired past the webview. |

### `STRUCTURED_EVENT` sub-taxonomy (`CLI_EVENT_TYPES`, `DashboardConstants.ts:3023-3064`)

| Event type | Webview renderer | CLI handling |
|---|---|---|
| `TEXT` | `TextOutput`, markdown + find-highlight | Handled — live streaming text (`CliTerminalFormatter.ts:374-421`) |
| `THINKING` | `ThinkingOutput`, indented "● Thinking" block | Handled (flattened) |
| `USER_STEER` | Display-only "● User message" passthrough | Arguably N/A — display-only in the webview too |
| `BASH_COMMAND` | `BashOutput.tsx` — collapsible command + independently collapsible stdout/stderr, exit-code badge, duplicate-output suppression | Handled but flattened — plain interleaved `console.log`, no independent stdout/stderr sectioning (`CliTerminalFormatter.ts:450-473`) |
| `FILE_EDIT` | `DiffView.tsx` — full unified/split diff, collapsed-context-gap expansion, undo/redo | Handled via `renderDiffBlock`/`parseUnifiedDiff` (`CliTerminalFormatter.ts:70-188`) but capped at `MAX_DIFF_LINES = 60` (line 46), no gap-collapsing, no undo |
| `FILE_WRITE` | Full new-content block + undo/redo | Handled (flattened) |
| `FILE_READ` | Path + optional line-range ref | Handled |
| `FILE_DELETE` | Path + success/error + undo/redo | Handled |
| `MCP_TOOL_CALL` | Label + collapsible params/output/error | Handled (flattened, 80-char param slice) |
| `WEB_SEARCH` | Query + success/error | Handled |
| `TOOL_CALL` (generic) | `GenericToolCallOutput` via `toolCallLayout.ts`'s `buildToolCallRenderPlan` | Handled (flattened) |
| `TOOL_RESULT` | Standalone result rendering when not paired inline | Handled (100-char output slice, `CliTerminalFormatter.ts:597-608`) |
| `ASK_USER_QUESTION` | Interactive Q&A block: question, options, recorded answer | **Missing — no case in the switch; silently dropped** |
| `COMPACTION` | Pill: "Conversation compacted — X → Y tokens" | **Missing — silently dropped** |
| `FOLLOW_UP_RESUMED` | Pill divider marking post-completion resumed activity | Not handled (minor) |
| `CONTEXT_WINDOW_SYNC` | Invisible marker (webview also renders `null`) | N/A both sides |

`toolCallLayout.ts` is shared collapse-state math (`buildToolCallRenderPlan`) computing per-section
(params/output/error) expansion/truncation independently — underlies several structured-event
subtypes' collapse behavior in the webview, not a distinct row kind itself.

## Priority ranking for fixing

1. **Script/condition verdict + output (`SCRIPT_VERDICT`, `SCRIPT_OUTPUT`, `SCRIPT_COMMAND`) —
   highest value, pure data-plumbing fix.** `ConditionEvaluationSummary` already exists in memory
   at the point of failure/success; it just needs a path out. Requires: a new CLI-facing emitter
   (or reuse of `onWorkflowStatusMessage`'s shape extended with an optional structured payload) on
   `WorkflowInstance` carrying `ConditionEvaluationSummary`, a subscription in `cli.ts`, and a new
   `CliTerminalFormatter` render method for script name / pass-fail badge / stdout+stderr /
   expected-vs-actual / duration. No existing CLI code does any of this today, even as a stub.

2. **`ASK_USER_QUESTION` and `COMPACTION` structured events — correctness gap, not just
   richness.** These aren't missing polish; a mid-turn interactive AI question in headless mode
   currently produces **zero terminal output**, which can look like a hang. Cheapest fix in this
   whole doc: both event types already flow through `onTargetStreamingEvents` since 11 sibling
   types do — this is purely two missing `case` arms in `CliTerminalFormatter.renderEvent`.

3. **Parallel-group and attempt-group aggregation (`PARALLEL_GROUP_HEADER`,
   `ATTEMPT_GROUP_SUMMARY`) — data gap.** Live parallel-branch and retry-attempt state is pushed
   only through dashboard-sink methods (`updateStepsExtended`, `updateRetryAttempt`,
   `updateProgress`, each gated `if (this.dashboardSink)`). CLI has no live per-branch
   running/done/failed visibility beyond the pre-execution dry-run preview, and no consolidated
   retry summary beyond an inline "Retry N" token.

4. **Richer structured-event formatting (diff gap-collapsing, untruncated bash stdout/stderr
   sectioning, tool params) — polish, lower priority.** The data already reaches the CLI; this is
   purely about `CliTerminalFormatter.ts` doing less truncation and more structure. Consider
   whether terminal width/paging makes some of this (e.g. full untruncated diffs) actively worse
   for a headless user before investing here — a terminal isn't a scrollable virtualized list, so
   "match the webview" isn't automatically the right target for every row.

5. **`CLI_HEADER` per-attempt harness/model redisplay, full untruncated `PROMPT` text, `FINAL_STEP_LABEL` distinct labeling — polish.** Each is a real but smaller gap; bundle with whichever phase above touches the same header-rendering code.

6. **`COORDINATION_ACTIVITY` — likely out of scope for now.** No `WorkflowInstance` emitter exists
   for it at all (webview-store-only feature). Fixing this is really "wire coordination activity
   into `WorkflowInstance`'s event surface for both consumers," a bigger, separate change from CLI
   parity work — flag it here but don't bundle it into a CLI-parity effort.

7. **No action needed:** `STEP_ANCHOR`, `STEP_HIDDEN` (virtualized-list/minimap scaffolding,
   meaningless outside a scrollable DOM list), `CONTEXT_WINDOW_SYNC` (invisible both sides),
   `USER_STEER` (display-only passthrough in the webview too).

## Risks / open questions

- **Terminal is not a virtualized scrollable list.** Several webview behaviors (collapse-by-default
  diffs, "show N more lines" tail-toggles, hidden-step filtering) exist specifically to keep a
  massive DOM list cheap to render and navigate. A CLI has no equivalent cost problem but also no
  equivalent affordance to re-expand something once it's scrolled past — decide per row kind
  whether "print everything" or "print a bounded summary + note that more exists" is the right
  headless default, rather than assuming parity means identical verbosity.
- **`--quiet`/`--json` modes must stay unaffected.** All of this rendering is already gated behind
  `!options.quiet && !options.json` in `cli.ts:735-739`; any new emitter subscriptions added for
  Phase 1/2 above must respect the same gate and must not leak decorative output into JSON mode
  (per `cli-binary.instructions.md`).
- **New CLI-facing emitter shape.** Adding a `ConditionEvaluationSummary`-carrying emitter is the
  biggest structural change here — decide whether it's a new dedicated `TypedEmitter` field on
  `WorkflowInstance` (matching the existing "designed for the standalone CLI" pattern) or an
  extension of an existing one (e.g. widening `onWorkflowStatusMessage`'s payload). Prefer a new
  dedicated emitter — widening the existing flattened `{message, severity}` shape risks the same
  kind of stringly-typed drift the codebase's constants conventions exist to avoid.
- **Verify no regressions to the dashboard path.** Any change to `WorkflowExecutor.ts`'s
  dashboard-gated blocks (e.g. lines 3520-3528, 3985) must add a CLI-facing emit alongside the
  existing dashboard-sink call, not replace or restructure it.
