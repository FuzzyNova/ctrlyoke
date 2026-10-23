# Copilot async shells read to completion with `read_powershell` stay pending forever

- **Found:** 2026-10-23 by Copilot CLI, while a step launched five async shells and polled them
- **Area:** `src/core/harness/copilot/CopilotLogParser.ts` (`trackBackgroundWorkState`), `src/core/harness/CliLogMonitor.ts` (background-work hold)
- **Resolution:** fixed in this commit

## Symptom

A Copilot step finishes its turn and fires its Stop hook, but ctrlyoke keeps the
step running. The session log says:

```
[CliLogMonitor] Completion detected via Stop hook
[CliLogMonitor] Background task still pending — holding completion until the harness auto-resumes and truly finishes
```

and then nothing happens. No further Stop hook ever arrives, because Copilot has
nothing left to do. The step stays "running" until the 10-minute idle backstop
force-completes it. Every shell the model had already finished and read is
still listed as pending background work.

## Steps to Reproduce

Observed in `ctrlyoke-1792759723098.log` (step 6/6 of the
`document-token-data` run, started 14:30:55Z, Stop hook 14:37:36Z) and the
session's `events.jsonl` (`~/.copilot/session-state/08db36bf-…/`):

1. The model launches several async shells in one turn, using the `powershell`
   tool with `mode: "async"` and a `shellId` for each (`copilot`, `codex`,
   `opencode`, `qwen`, `agy`).
2. It polls them with `read_powershell`, passing each `shellId`. Some shells
   finish while a read is waiting on them, so that read returns
   `exit 0 … <shellId: codex completed with exit code 0>`.
3. The model ends its turn, and the Stop hook fires.
4. ctrlyoke holds the step.

The notification record of the whole session shows why:

| Shell      | How its completion reached the model                                | `system.notification`         |
| ---------- | ------------------------------------------------------------------- | ----------------------------- |
| `opencode` | Finished on its own between two reads                               | `shell_completed` at 14:34:24 |
| `copilot`  | `read_powershell` returned "completed with exit code 0" at 14:31:37 | none                          |
| `agy`      | `read_powershell` returned "completed" at 14:32:00                  | none                          |
| `codex`    | `read_powershell` returned "completed" at 14:32:00                  | none                          |
| `qwen`     | `read_powershell` returned "completed" at 14:32:36                  | none                          |

Only `opencode` was cleared. The other four stayed in `pendingTasks`.

A shorter reproduction should work: one async shell that runs a few seconds, then
`read_powershell` with enough wait that it returns the completed result, then end
the turn.

## Root Cause

`CopilotLogParser.trackBackgroundWorkState` has exactly three ways to remove a
pending shell:

1. a `system.notification` whose `kind.type` is in
   `COPILOT_SHELL_COMPLETION_NOTIFICATION_KINDS`
   (`CopilotLogParser.ts:988`),
2. `stop_powershell`'s `tool.execution_start` (`:978`), and
3. a `session.start` reset (`:940`).

The launch is recorded at `tool.execution_complete` with `executionMode:
"async"` (`:962`).

In this capture Copilot emitted `system.notification` only for the shell that
finished **while no tool call was reading it**, and none for the four whose
completion a `read_powershell` returned (the existing `stop_powershell` comment
documents the same "no notification" shape for the stop case). That is
inferred from one session, so confirm it with a second capture before
relying on it. When the model reads a shell with `read_powershell` and
the read returns its completed result, the model has consumed the completion
in-turn and Copilot sends no notification. The parser has no rule for this, so
the shell stays in `BackgroundFollowUpState.pendingTasks`, and
`isCompletionBlocked()` stays true. `CliLogMonitor`'s hold loop
(`runBackgroundWorkHold`) then waits for a resume that cannot come.

This is the third member of a family: detached shells reporting
`shell_detached_*` kinds, and `stop_powershell` never producing a notification,
were fixed the same way before. The invariant behind all of them is that a
shell leaves `pendingTasks` as soon as the log shows the model has _seen_ it
finish.

Details from the capture that the fix depends on:

- Copilot 1.0.103's `read_powershell` result, when the shell is done, ends with
  `<shellId: <id> completed with exit code <n>>`. When it is not done, it ends
  with `<command with shellId: <id> is still running after <n> seconds. …>`. Five
  different wordings of the "still running" form appear across this machine's
  session logs, so the "still running" form is not stable and must not be
  matched positively.
- The `read_powershell` call's own `tool.execution_start` carries
  `arguments.shellId` (a string such as `"codex"`).
- `tool.execution_complete` for a read carries `toolTelemetry.properties`
  `read_target_state: "active"` in both the finished and the timed-out case, so
  it cannot tell them apart. Only the result text can.
- The `tool.execution_complete` handler deletes the call's entry from
  `toolCallSummaries` before the rest of the method runs (`:959-960`), and the
  summary is the only place the tool name survives to completion time.

## Suggested Fix

1. In `trackBackgroundWorkState`, at `tool.execution_complete`, keep the summary
   that was looked up and, when `summary.toolName === "read_powershell"`, check
   the result text. If it contains a completion marker of the form
   `<shellId: <id> completed …>`, call `backgroundFollowUpState.remove(<id>)`.
   Do not call `consumeNotification`: it latches
   `resumedTurnCompletionPending`, which waits for a resumed turn that will
   never start, because the model already handled the result in the same turn.
2. Take the id from the result's own marker, not from `arguments.shellId`: a
   read can name a shell that is not the one reporting. Reuse or extend
   `extractShellId` (`:1095`) and put the completion pattern behind a named
   constant next to `COPILOT_STOP_SHELL_TOOL_NAME` (`:198`), per the "no string
   flow control" rule. Match only the completion form, never the "still running"
   one.
3. Check the other tools that return a shell's final state to the model and add
   them only if the capture shows the same gap: `write_powershell` and
   `list_powershell` both read shell state. Verify against a real log first
   rather than guessing at wording.
4. Update the doc comment above `backgroundFollowUpState` (`:890-903`) and the
   Copilot background-tracking bullet in
   `.github/instructions/harness-cli-providers.instructions.md`. Both currently
   say only a notification or `stop_powershell` clears a shell.

### Tests

In `src/test/suite/harness/LogParsers.test.ts`, beside the `stop_powershell`
cases (around line 4024), using the existing `asyncLaunch` helper:

- A `read_powershell` call whose result ends `<shellId: shell-1 completed with
exit code 0>` removes `shell-1`, so `hasPendingBackgroundWork()` is false.
- The same read with a "still running after 5 seconds" result leaves it pending,
  using more than one of the observed wordings.
- With `shell-1` and `shell-2` pending, completing one leaves the other pending.
- A failed or non-zero exit (`completed with exit code 1`) also clears it.
- No resumed-turn latch is left behind: after the removal, a following
  `assistant.turn_end` is not needed for `hasPendingBackgroundWork()` to be
  false.
- A real-shaped fixture of the three-event sequence (`tool.execution_start` with
  `toolName: "read_powershell"`, then `tool.execution_complete` with the result
  content) goes through `trackBackgroundWorkState` in order, so the summary
  lookup is exercised and not just the removal.

Also add a `CliLogMonitor.test.ts` case, next to the detached-shell ones near
line 1206, showing that a Stop hook is accepted rather than held once every
pending shell has been read to completion.

### Confirmation

A scan of all 2,129 local Copilot sessions confirmed the inference before the fix:
99 `read_powershell` results ended with a completion marker, none was ever followed by a
`system.notification` for that shell, and the marker's id always matched
`arguments.shellId`. Every one of them ended its result with the marker. Detached shells
use the form `<detached command with shellId: <id> completed with exit code <n>>`.
`write_powershell` and `list_powershell` never returned a completion marker, so step 3
added nothing for them.

### Related

- Detached shells reporting `shell_detached_completed`, and `stop_powershell`
  producing no notification, are documented in the same instruction file and
  fixed in the same method.
- `BackgroundFollowUpState` has no time-based release, so any pending id that can
  never clear (this bug, or a shell killed by the machine) costs the full
  10-minute idle backstop. The hold log line does not name the pending ids, which
  made this diagnosis require reading `events.jsonl`. Logging
  `getBackgroundWorkHoldSnapshot().pendingTasks` when the hold starts would make
  the next one a one-line diagnosis.
