# Subagent Output Attribution Plan

**Status:** Not started.

## Problem

When a headless claude-cli step launches a foreground subagent (the `Agent`
tool), the subagent's own tool calls, text, and thinking stream into the parent
step's output with nothing marking them as the subagent's. With several
subagents running at once, the output pane interleaves four agents' work as if
one agent did all of it.

Observed in the 2026-10-10 bug-hunt run (`bug-hunt-2026-10-10T12-48-17-338`,
final-step pass 2): the parent's `Agent` tool call for "Hunt bugs: config &
webview store" is followed by `wc -l src/config/CtrlYokeConfigService.ts …`,
which is plainly that subagent's command, yet it is persisted with
`callerType: "direct"` and rendered as a parent row between the parent's own
commands.

A related symptom, already fixed, was the subagent's prompt being recorded as a
human `USER_STEER` row (`dev/bugs/implemented/claude-subagent-prompts-classified-as-human-steers.md`).
That fix drops the prompt message as `"other"`; the prompt is still visible
because the parent's `Agent` tool call carries it in `parameters.prompt`.

## Current state

The codebase already has a half-built attribution field that does not work:

- `CALLER_TYPES` (`src/types/DashboardConstants.ts`) defines `DIRECT` and
  `SUBAGENT`, and `CliEvent.callerType` / `ToolCall.callerType`
  (`src/types/CliOutputTypes.ts`) are documented as "subagent when produced
  inside a spawned sub-agent".
- `ClaudeLogParser` fills `callerType` from the tool-use block's `caller.type`.
  That field describes how the model invoked the tool (`direct` for an ordinary
  call), not which agent made the call, so it never yields `subagent`.
- `OpenCodeLogParser` hardcodes `CALLER_TYPES.DIRECT` for its `task`-tool
  spawns.
- No webview component reads `callerType`. Its only consumer is
  `StreamingHistoryBuffer`'s event-merge check, which refuses to coalesce
  adjacent events whose `callerType` differs.

## Proposal

### 1. Attribute events to their spawn, don't add new event types

Replace `callerType` with an optional `parentToolCallId` on `CliEvent` (and on
`ToolCall` data where it is duplicated today), naming the `toolCallId` of the
`Agent` call that spawned the producing subagent. Absent means the step's own
agent.

Rejected alternative: parallel event types (`subagentText`,
`subagentToolCall`, …). Every renderer, the history projection, find/search
segmentation, row-height estimation, and `CliTerminalFormatter` would need a
second branch per type. A single optional field reuses all of them.

`callerType` and the `SUBAGENT` constant should be removed rather than kept
alongside the new field (pre-release, no compatibility constraint). Keep the
`StreamingHistoryBuffer` merge guard, keyed on `parentToolCallId`, so a
subagent's text never coalesces into the parent's.

### 2. Claude: read `parent_tool_use_id` from headless stdout

Claude's `stream-json` messages carry `parent_tool_use_id`: `null` on the main
thread, the `Agent` tool_use id on a foreground subagent's messages.
`ClaudeLogParser` already declares the field on `ClaudeProviderEvent` (added
for the steer fix). Stamp it onto every event `extractStructuredEventsFromEvent`
produces from that message, including tool results.

**Verify first.** The shape above comes from the SDK message format; it has not
been checked against a captured ctrlyoke headless run, because `events.jsonl`
stores events after parsing. Capture one real stdout sample of a step with
parallel foreground subagents and confirm that assistant messages and
tool-result `user` messages (not just the prompt) carry the id.

### 3. Render the `Agent` call as a spawn card

Give `CLAUDE_TOOL_NAMES.AGENT` its own renderer instead of
`GenericToolCallOutput`: description and `subagent_type` in the header, the
prompt collapsible, the final result at the bottom. Rows whose
`parentToolCallId` matches the card render nested under it (collapsible, and
collapsed once the call completes), or, as a first cut, indented with the
subagent's description as a label. Parallel subagents then stay visually
separate even though their events interleave in time.

Row building lives in `src/ui/webview-react/utils/outputRows.ts`; nesting has to
cooperate with its virtualization and height estimation, and with
`outputFind.ts` so find still reaches collapsed subagent rows.

`CliTerminalFormatter` should indent subagent rows under the spawn line the same
way.

### 4. Other harnesses

- **opencode:** its `task` tool spawns subagents (`OpenCodeLogParser`,
  "A subagent was spawned via the task tool"). Check whether its event stream
  links child-session activity to the spawning call; if so, populate
  `parentToolCallId` the same way.
- **copilot-cli, codex-cli, qwen-cli, antigravity-cli:** check whether each
  surfaces subagent activity in its stream at all before doing anything.

## Out of scope

- **Background subagents** (`run_in_background`). Their activity never streams
  into the parent's stdout; only the completion `<task-notification>` does,
  which existing background-work handling already covers.
- **Interactive mode.** ctrlyoke tails the session log, and Claude writes each
  subagent's transcript to its own `subagents/agent-*.jsonl` file, so subagent
  activity never reaches the parent's output there. Surfacing it would mean
  tailing those files, a separate feature.

## Tests

- `src/test/suite/harness/LogParsers.test.ts`: Claude events from a subagent
  message carry `parentToolCallId`; main-thread events don't. Use a fixture
  built from the captured stdout sample in step 2.
- `StreamingHistoryBuffer` tests: parent and subagent text don't merge.
- Webview (`src/ui/webview-react/test/`): rows with `parentToolCallId` nest
  under their `Agent` card; two interleaved subagents stay in separate groups;
  find matches inside a collapsed subagent group.
