# Terminal Follow-up Tracking

**Status: Implemented (Claude CLI, Copilot CLI, Antigravity CLI, and Qwen CLI)**

This document records the shipped architecture for detecting background work and
resumed turns in the four CLI harnesses that expose structured session logs.
Codex and OpenCode continue to use the ordinary Layer-1 activity path; they do
not have provider-specific follow-up completion signals here. Qwen was added
after its CLI gained asynchronous background waits (verified on 0.26.0).

## Architecture

Follow-up tracking has two layers:

1. `SessionActivityWatcher` keeps the shared provider log reader alive after a
   prompt monitor resolves. It forwards later tool, user-steer, and response
   events while the interactive session remains open.
2. `CliLogMonitor` holds completion briefly when the provider reports pending
   background work. The monitor releases the hold when the provider observes a
   matching completion and a resumed turn, or when its normal timeout/backstop
   applies.

The provider parsers recognize native signals and feed the common
`BackgroundFollowUpState` state machine (`src/core/harness/shared/BackgroundFollowUpState.ts`).
The state machine tracks every concurrent task identity, removes only matching
completion notifications, and keeps a resumed-turn latch until the later turn
ends. This prevents a stale Stop/turn-end event from completing the prompt that
preceded a background-task notification. Providers may additionally configure a
small stale-stop guard for CLIs whose notification and turn events can be read
in the same poll.

`src/core/harness/SessionActivityWatcher.ts` and the monitor share one parser
instance. The monitor pauses the watcher while it owns the next prompt, then
the watcher resumes from the same read offset after that prompt settles.

The hold has **no time-based release**. It ends only when the parser reports
no pending work, or on cancellation, PTY exit, a harness error notification, or
`maxPromptTimeout`. An earlier version capped the hold at 10 minutes from hold
start. Session activity never reset that cap, so it committed steps while work
was genuinely unfinished: a background `npm run test:harness` run that took
about 30 minutes, and a step whose model was still working mid-turn after
consuming its task notifications. The hold keeps a single Stop-hook wait in
flight and re-arms it only after that wait settles, so log-event wakes never
leave orphaned pollers that could consume a later Stop file.

Because the hold can last indefinitely, every Stop it absorbs is shown to the
user. `CliLogMonitor` streams a `BACKGROUND_WORK_HOLD` event carrying the
parser's `getBackgroundWorkHoldSnapshot()`: the pending tasks (description,
command, launching tool, and provider task id, whichever the harness exposes)
and whether a resumed turn is still open. The monitor merges that event into
the step's final output the same way it merges user steers, so it survives
completion. Parsers capture task names at the launching tool call because the
signal that confirms a launch (Claude's `backgroundTaskId` result, Copilot's
async `tool.execution_complete`) does not repeat them. Antigravity's launch
record exposes only a task id.

## Claude CLI

Claude records background launches in assistant `tool_use` entries. Any tool
with `run_in_background: true` is a launch, including Bash and PowerShell; the
`Monitor` tool's `Monitor started` result is also asynchronous. The parser
tracks all task IDs, not only the latest Bash launch.

A launch can also happen with no `run_in_background: true` at all: a plain
foreground Bash/PowerShell call that exceeds its timeout is auto-promoted to a
background task by the CLI mid-execution ("Command did not complete within
its Ns timeout and was moved to the background"), visible only in the tool
result's `toolUseResult.backgroundTaskId` — the originating `tool_use.input`
never gets `run_in_background: true` because the caller never asked for
background mode. `trackAsyncLaunchResult` treats any tool_result carrying
`backgroundTaskId` as a launch for this reason, independent of the input-flag
path. Missing this case let a step complete before its own background
command (and that command's later `<task-notification>`) had finished.

A launch remains pending until Claude delivers the matching task notification:

- a `user` `task-notification` record between turns, or
- a `queued_command` attachment delivered during a turn.

`queue-operation` records are bookkeeping only and never clear pending state.
After a notification is consumed, the parser latches the resumed turn and only
clears that latch when the subsequent assistant turn reaches its terminal stop
reason. This is the completion signal consumed by `CliLogMonitor`.

## Copilot CLI

Copilot's `tool.execution_complete` event starts an asynchronous shell when
`executionMode` is `async`; the shell ID is the task identity. A matching
`system.notification` removes that ID — but the `kind.type` naming is not
uniform: plain async shells report `shell_completed`/`shell_failed`, while a
shell launched with the newer `detach: true` argument (`toolTelemetry.
properties.detached: "true"`) instead reports `shell_detached_completed`/
`shell_detached_failed`. Both families must be matched
(`COPILOT_SHELL_COMPLETION_NOTIFICATION_KINDS`); matching only the plain names
leaves a detached shell's ID in `pendingTaskIds` forever, so
`hasPendingBackgroundWork()` never clears and the step is held "still
pending" past its actual completion until the 10-minute idle backstop force-
completes it. Confirmed against a real capture: two concurrent detached
PowerShell background tasks both completed and their output was read back,
the turn ended cleanly with no background work left, and ctrlyoke still
reported the step running because the `shell_detached_completed` notifications
were silently ignored. The parser then waits for `assistant.turn_start` and
`assistant.turn_end` to confirm the resumed turn.

A shell the model stops itself via `stop_powershell` never gets a
`system.notification` — that event is reserved for a shell finishing on its
own — so the parser also removes the shellId immediately on that tool's
`tool.execution_start`. Without this, an explicitly-stopped shell stays
pending for the rest of the interactive session and every later Stop hook is
absorbed by the background-work hold instead of completing.

Copilot uses the shared state machine with **no** stale-stop guard (like
Antigravity below, unlike an earlier version of this doc). Copilot's log
watcher stays active during a background-work hold, so `resumedTurnClosed()`
is normally reached via live tailing _between_ two real Stop hooks, not
caught up inside either one's own catch-up read — a nonzero guard assumes the
latter shape and, when closure instead happens live between Stops, requires a
Stop hook that never comes after the CLI genuinely finishes, hanging the step
until the 10-minute idle backstop. Confirmed against a real capture: two
detached shells launched, an early Stop fired while both were still running
(not stale — genuinely pending), the notifications/turn-resume/turn-close all
landed live between that Stop and the next, and a `staleStopGuardChecks: 2`
guard held the step "still running" past the second (and final) Stop because
Copilot never sent a third. The same capture also exposed a second bug: the
notification handler used to unconditionally reset the "turn started" latch
on every consumed notification, including one landing after `turn_start` for
an already-in-progress resumed turn (two concurrent shells' notifications can
straddle `turn_start`) — this forced an extra, unneeded turn cycle before
closure and could permanently miss it if the model reports completion within
that same first turn. Fixed by only setting the latch from `turn_start`,
never clearing it from a notification.

## Antigravity CLI

Antigravity has two complementary sources:

- The Go `cli-*.log` is used for conversation/session discovery and the
  top-level completion marker.
- The per-session `brain/<conversationId>/.../transcript_full.jsonl` is the
  authoritative response stream. `transcript.jsonl` is used only when the full
  file is absent; it is never read as a second peer stream.

`AntigravityTranscriptReader` consumes the selected JSONL file incrementally in
append-only file order. It retains an incomplete trailing line, resets safely
on truncation/replacement, and skips malformed or unknown entries without
re-emitting already consumed events. The mapper emits planner, tool, checkpoint,
error, and user events as they arrive, so the final response is assembled from
the mapped stream rather than from a completion-time “latest response” scan.
The session watcher tails that authoritative transcript independently of the Go
log. This matters when resuming a conversation starts a new CLI process: the
originally discovered `cli-*.log` can become permanently stale while the same
conversation continues appending follow-ups to `transcript_full.jsonl`.

Planner `tool_calls` are paired with their result on the adjacent transcript
line (file order), not by arithmetic on sparse or non-monotonic `step_index`
values. This preserves command text, file contents, structured edits, MCP
targets, exit codes, and unified diffs.

Background work is represented by separate records. A launch is a
`MODEL`-sourced entry with `status: "RUNNING"` — observed agy output always
types these `GENERIC` (never a per-tool type like `RUN_COMMAND`), so launch
detection keys on status alone and recovers the task ID from the freeform
`Tool is running as a background task with task id: <id>` content. A later
`SYSTEM`/`SYSTEM_MESSAGE` entry reports that task's success or failure. The
parser matches those IDs in `BackgroundFollowUpState`, then uses the terminal
planner response as the resumed-turn completion signal. Antigravity runs
`BackgroundFollowUpState` with **no** stale-stop guard (unlike Copilot):
`AntigravityTranscriptReader.watchForChanges` tails the transcript on its own
250ms poll, independent of Stop-hook timing, so `isCompletionBlocked()` is
already settled by the time a Stop hook fires — there is no "old stale Stop
catches up the resume in the same read" race to guard against. A real agy
turn commonly emits exactly one Stop hook per exchange, so a guard requiring
one more Stop after the resume closes would never resolve on its own,
falsely holding a finished session until the 10-minute idle backstop
(`ConfigurationUtils.getBackgroundWorkIdleBackstopMs`) forced it through.
Confirmed against a real capture: a single `npm test` background task whose
notification and terminal planner response both landed via the transcript
watcher ~2s before the session's only Stop hook fired; with the guard in
place this held for the full backstop instead of completing immediately.

## Qwen CLI

Qwen delivers background notifications only in the interactive TUI. Its
headless modes never feed them to the model: one-shot `-p` exits after the
final turn, and with ctrlyoke's `--input-format stream-json` flags the model
polls the shell's status files with `read_file` instead.

A launch is confirmed by the tool-result text, which is the only place the task
id appears: `Background shell started.\nid: <id>` (`run_shell_command` with
`is_background: true`), `Background agent launched successfully.\ntask_id: <id>`
(`agent`; top-level subagents run in the background by default), and
`Monitor started.\nid: <id>` (`monitor`). Each task's terminal
`<task-notification>` (`<task-id>`, `<status>` `completed`/`failed`/`cancelled`)
arrives as a `user` record with `subtype: "notification"` and
`provenance: "system"`, and starts its own model turn. That turn closes at its
next assistant record without a `functionCall`. A monitor's `running` pulses
wake turns too but do not finish it, and `task_stop` cancels a monitor without
any notification, so the parser clears it from the `Monitor "<id>" cancelled.`
result. A stopped shell or agent still gets its terminal notification.

Only a notification record stamped `deliveredTurn: true` latches a resumed turn.
Qwen also persists unstamped copies, before delivery or for a delivery into the
turn already running, and no new turn is guaranteed to follow those, so they
only clear the task. One record can carry several envelopes when Qwen drains a
backlog into one turn. Like Copilot and Antigravity, Qwen runs with no
stale-stop guard. The parser resets at the start of `discoverSessionLog()`,
because Qwen writes one log file per session. The real capture is
`src/test/fixtures/qwen/interactive-background-shells.session.jsonl`: three
concurrent shells (10/20/30 s), one notification and one resumed turn each.

## User-steer and completion flow

The provider parser classifies genuine user-steer records separately from the
prompt dispatched by ctrlyoke. `CliLogMonitor` sends parsed events to the
workflow only after the provider-specific pending/resumed state is settled;
`SessionActivityWatcher` continues forwarding later activity for an interactive
session. No UI-only suppression is involved.

## Verification

The implementation and regressions are covered by:

- `src/test/unit/BackgroundFollowUpState.test.ts`
- `src/test/unit/AntigravityLogParser.test.ts`
- `src/test/unit/QwenLogParser.test.ts`
- `src/test/unit/CliLogMonitor.test.ts`
- `src/test/suite/harness/LogParsers.test.ts`

The full extension and UI test suites pass with the harness suites excluded by
the repository test command.
