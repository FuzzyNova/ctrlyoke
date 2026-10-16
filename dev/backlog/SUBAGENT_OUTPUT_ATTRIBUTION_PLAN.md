# Subagent Output Attribution Plan

**Status:** Researched against all six harnesses (2026-10-15); ready to implement.

## Problem

When a step's agent launches a foreground subagent, the subagent's tool calls,
text, and thinking either stream into the parent step's output with nothing
marking them as the subagent's (claude-cli, copilot-cli), or never reach the
output at all (codex-cli, opencode-cli, qwen-cli, antigravity-cli). With several
subagents running at once, the claude-cli output pane interleaves four agents'
work as if one agent did all of it.

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
  Confirmed in the capture below: subagent `tool_use` blocks also carry
  `caller: {type: "direct"}`.
- `OpenCodeLogParser` hardcodes `CALLER_TYPES.DIRECT` for its `task`-tool
  spawns.
- No webview component reads `callerType`. Its only consumer is
  `StreamingHistoryBuffer`'s event-merge check, which refuses to coalesce
  adjacent events whose `callerType` differs.
- `CopilotLogParser` ignores `data.parentToolCallId`, so copilot-cli has the same
  interleaving bug as claude-cli.
- `QwenLogParser` unwraps Qwen's `tool_call` bridge only for MCP names
  (`mcp__…`). The subagent spawn often arrives through the same bridge
  (`tool_call` with `input.name: "agent"`) and currently renders as a generic
  `tool_call` row.

## Research findings

Each harness was run with its `HARNESS_MODELS` model (`src/test/harness/helpers/harnessRunner.ts`)
and the prompt "launch TWO subagents in parallel; A runs `echo hello-from-A` and
reads `alpha.txt`, B runs `echo hello-from-B` and reads `beta.txt`". Raw stdout
and the session logs were captured, not ctrlyoke's parsed `events.jsonl`.

| Harness (version)     | Headless source | Spawn tool                                   | Where child activity appears                                  | Link from child to spawn call                                                   |
| --------------------- | --------------- | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| claude-cli 2.1.301    | stdout          | `Agent`                                      | **Inline** in stdout                                          | `parent_tool_use_id` on every child message                                     |
| copilot-cli 1.0.96    | stdout          | `task`                                       | **Inline** in stdout and in `session-state/<id>/events.jsonl` | `data.parentToolCallId` on most child events                                    |
| qwen-cli 0.25.1       | log             | `agent` (often via the `tool_call` bridge)   | Stdout inline; session log **sidechain file** per child       | Sidechain filename and `agentId` end in the spawn call id                       |
| codex-cli 0.162.1     | log             | `spawn_agent` (`namespace: "collaboration"`) | **Child rollout file** per child; nothing in `exec --json`    | Child `session_meta.parent_thread_id` + `agent_path` = spawn output `task_name` |
| opencode-cli 1.19.0   | stdout          | `task`                                       | **Child session**; nothing in `run --format json`             | Child `session.parentID`; running `task` part's `state.metadata.sessionId`      |
| antigravity-cli 1.3.6 | log             | `invoke_subagent` (one call, N children)     | **Child transcript** per child                                | Spawn result lists each child's `conversationId` and `logAbsoluteUri`           |

Every harness exposes enough to attribute child activity to the spawning call.
Two harnesses carry the link inline in the stream ctrlyoke already reads. The
other four write each child to its own file or session, so ctrlyoke must
discover and follow it.

### claude-cli

Headless stdout (`-p --output-format stream-json --verbose`). Verified: every
message the child produces carries `parent_tool_use_id` set to the `Agent`
`tool_use` id: its prompt `user` message, each `assistant` message, and each
`tool_result` `user` message. Main-thread messages carry `null`. Child messages
also carry `agent_id`.

```jsonl
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01HJ…","name":"Agent","input":{"description":"Run echo and read alpha.txt","subagent_type":"general-purpose","prompt":"…"}}]},"parent_tool_use_id":null}
{"type":"system","subtype":"task_started","task_id":"ae06…","tool_use_id":"toolu_01HJ…","description":"Run echo and read alpha.txt","subagent_type":"general-purpose","is_backgrounded":false,"spawn_depth":1}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01EN…","name":"Bash","input":{"command":"echo hello-from-A"},"caller":{"type":"direct"}}]},"parent_tool_use_id":"toolu_01HJ…","agent_id":"ae06…"}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01EN…","type":"tool_result","content":"hello-from-A"}]},"parent_tool_use_id":"toolu_01HJ…","agent_id":"ae06…"}
{"type":"system","subtype":"task_progress","tool_use_id":"toolu_01HJ…","description":"Reading alpha.txt","last_tool_name":"Read"}
{"type":"system","subtype":"task_notification","tool_use_id":"toolu_01HJ…","status":"completed"}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01HJ…","type":"tool_result","content":[{"type":"text","text":"[Subagent hand-back] …"}]}]},"parent_tool_use_id":null}
```

- The child's final answer was not streamed as a separate `assistant` text
  message. It arrives only as the `Agent` tool result.
- `system` `task_started` / `task_progress` / `task_notification` /
  `task_updated` carry `tool_use_id` and a live status line ("Reading
  alpha.txt"). They can drive the spawn card's status line and completed state.
- **Interactive mode** writes each child to
  `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`
  (records have `isSidechain: true` and `agentId`), with a sibling
  `agent-<agentId>.meta.json`:
  `{"agentType":"general-purpose","description":"…","toolUseId":"toolu_01Go…","spawnDepth":1,"requestShape":"foreground",…}`.
  `toolUseId` is the link. The earlier plan put interactive mode out of scope
  because it needs a sidechain tailer. Qwen, Codex and Antigravity need that
  tailer anyway (below), so Claude interactive now comes in at low cost.

### copilot-cli

Headless stdout (`--output-format json`) and the interactive session log
`~/.copilot/session-state/<sessionId>/events.jsonl` carry the same events. Child
events carry `data.parentToolCallId` = the parent's `task` `toolCallId`:

```jsonl
{"type":"tool.execution_start","data":{"toolCallId":"call_B4sG…","toolName":"task","arguments":{…}}}
{"type":"subagent.started","data":{"toolCallId":"call_B4sG…","agentName":"task","agentDisplayName":"alpha-reader","agentDescription":"Read alpha secret word","model":"gpt-5.6-luna","executionMode":"sync"}}
{"type":"assistant.message","data":{"content":"","toolRequests":[{"name":"powershell","toolCallId":"call_UP2R…"}],"parentToolCallId":"call_B4sG…"}}
{"type":"tool.execution_start","data":{"toolCallId":"call_UP2R…","toolName":"powershell","parentToolCallId":"call_B4sG…"}}
{"type":"tool.shell_output","data":{"toolCallId":"call_UP2R…","stream":"stdout","text":"hello-from-A"}}
{"type":"tool.execution_complete","data":{"toolCallId":"call_UP2R…","success":true,"parentToolCallId":"call_B4sG…"}}
{"type":"assistant.message","data":{"content":"PINEAPPLE","phase":"final_answer","parentToolCallId":"call_B4sG…"}}
{"type":"subagent.completed","data":{"toolCallId":"call_B4sG…","agentDisplayName":"alpha-reader","totalToolCalls":2,"durationMs":6449}}
```

Carry `parentToolCallId`: `assistant.turn_start/turn_end`, `assistant.message`,
`assistant.message_delta`, `tool.execution_start`, `tool.execution_complete`.

Do **not** carry it: `tool.shell_output`, `tool.execution_partial_result`,
`assistant.tool_call_delta`, and `user.message` for the child prompt (that one
has `source: "agent-<sessionId>"` and `parentAgentTaskId` instead). The parser
needs a `toolCallId → parentToolCallId` map, filled from `tool.execution_start`,
to attribute shell output and partial results.

No `assistant.reasoning_delta` was seen for the children; child reasoning
arrives only inside `assistant.message.data.reasoningText`, which carries the
id.

### qwen-cli

Headless stdout has the same shape as Claude: child messages carry
`parent_tool_use_id` = the spawn call id. **But ctrlyoke's Qwen headless source
is the session log**, and the main chat log
(`~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`) holds no child
records at all. Qwen writes each child to a sidechain file:

```
~/.qwen/projects/<sanitized-cwd>/subagents/<sessionId>/agent-<agentName>-<spawnCallId>.jsonl
```

Each record is an ordinary Qwen chat-log record plus `agentId`
(`"general-purpose-call_9484…"` = `<agentName>-<spawnCallId>`), `agentName`, and
`isSidechain: true`. Use `agentName` to strip the prefix rather than splitting
on `-`. The same files exist in interactive mode, so one implementation covers
both modes.

Spawn call in the parent log, via the deferred-tool bridge:

```json
{
  "functionCall": {
    "id": "call_9484…",
    "name": "tool_call",
    "args": {
      "name": "agent",
      "arguments": {
        "description": "Run echo and read alpha.txt",
        "prompt": "…",
        "run_in_background": false,
        "subagent_type": "general-purpose"
      }
    }
  }
}
```

The first bridged attempt was refused ("Deferred tool "agent" has no verified
schema review") until the model ran `tool_search select:agent`. Expect `agent`
both bare and bridged. Generalize the bridge unwrapping in
`QwenLogParser.buildFunctionCallEvents` beyond MCP names, so a bridged `agent`
is classified as the spawn.

One of the two qwen runs segfaulted (exit 139) before any output, under Git
Bash with `< /dev/null`. The retry succeeded. This is unrelated to subagents
and is noted only so a reader doesn't chase it.

### codex-cli

`codex exec --json` stdout emits **no spawn item and no child activity**. It
shows only `collab_tool_call` items with `tool: "wait"` and empty
`receiver_thread_ids`. ctrlyoke's Codex headless source is the rollout log,
which links children:

Parent rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`):

```jsonl
{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","namespace":"collaboration","arguments":"{\"task_name\":\"agent_a\",\"fork_turns\":\"all\",\"message\":\"gAAAAA…\"}","call_id":"call_0df5…"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_0df5…","output":"{\"task_name\":\"/root/agent_a\"}"}}
{"type":"response_item","payload":{"type":"agent_message","author":"/root/agent_a","recipient":"/root","content":[{"type":"input_text","text":"Message Type: FINAL_ANSWER\n…\nPayload:\nRan `echo hello-from-A`. The secret word … PINEAPPLE"}]}}
```

Child rollout, written beside the parent in the same date directory, one per
child:

```json
{
  "type": "session_meta",
  "payload": {
    "id": "01a14212-1be5-…",
    "session_id": "<root thread id>",
    "parent_thread_id": "<parent thread id>",
    "source": {
      "subagent": {
        "thread_spawn": {
          "parent_thread_id": "…",
          "depth": 1,
          "agent_path": "/root/agent_a",
          "agent_nickname": "Carver"
        }
      }
    },
    "thread_source": "subagent",
    "agent_path": "/root/agent_a"
  }
}
```

The link chain: spawn `call_id` → `function_call_output.task_name`
(`/root/agent_a`) → the child rollout whose `session_meta.parent_thread_id` is
the parent thread and whose `agent_path` equals that `task_name`. The child
rollout uses the same record format the existing `CodexLogParser` already maps.
Its `event_msg item_completed` records carry the child `thread_id`.

Gotchas:

- `fork_turns: "all"` makes the child rollout **replay the parent's history**
  first: developer/user messages, including the original user prompt. The
  child's own work starts at its `event_msg task_started` whose
  `turn_attribution.initiating_agent_path` is set (here `"/root"`), followed by
  an `agent_message` `NEW_TASK`. Skip everything before that point, or the
  parent's prompt is re-attributed to the child.
- The spawn `message` (the child's prompt) is **encrypted** (`gAAAAA…`) in both
  rollouts, so the spawn card can show `task_name` and `agent_nickname`, not the
  prompt. The child's `FINAL_ANSWER` `agent_message` in the parent rollout is
  plaintext and serves as the result.
- `multi_agent` is on by default in 0.162.1. `--enable multi_agent_v2` produced
  identical stdout.
- Interactive mode reads the same rollouts, so one implementation covers both
  modes.

### opencode-cli

`opencode run --format json` stdout emits only the parent session's parts. The
`task` tool appears once, already `completed`, with
`state.metadata = {parentSessionId, sessionId: <child>, model}` and an output of
`<task id="ses_child…" state="completed"><task_result>…`. Child activity is
absent.

A probe plugin (an `event` hook appending every bus event to a file) confirmed
that the **plugin sees child sessions live**:

- `session.created` with `info.parentID` = the main session, for each child.
- `message.part.updated` / `message.part.delta` for every child part, with
  `part.sessionID` = the child. These are the same part shapes `run --format
json` emits for the parent.
- The parent's `task` part goes `pending` → `running` (now with
  `state.metadata.sessionId` = the child) → `completed`. The `running` update is
  the earliest point that maps child session → `callID`.

`opencode export <childSessionId>` also returns the child transcript, with
`info.parentID` and identical part shapes. That is a usable post-hoc fallback,
but the provider rules forbid `export` as the headless live source.

ctrlyoke's plugin (`src/scripts/ctrlyoke-opencode-plugin.ts`) already tracks
child sessions by `parentID` to avoid false stops. It is the natural place to
forward child parts.

### antigravity-cli

`agy --print --output-format stream-json` stdout shows the spawn as one
`step_update` with `step_type: "subagent"`, `tool_name: "invoke_subagent"`, and
`subagent_info.subagents[]` (`role`, `initial_prompt`, `conversation_id`,
`log_uri`). It shows no child activity. ctrlyoke's Antigravity headless source
is the transcript
(`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`):

```jsonl
{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"invoke_subagent","args":{"Subagents":"[{\"Prompt\":\"…\",\"Role\":\"Subagent A\",\"TypeName\":\"self\",…},{…\"Role\":\"Subagent B\"…}]"}}]}
{"step_index":2,"type":"GENERIC","content":"…Created the following subagents:\n{\n  \"conversationId\": \"195d6d7f-…\",\n  \"logAbsoluteUri\": \"file:///C:/Users/…/brain/195d6d7f-…/.system_generated/logs/transcript.jsonl\", …}\n{ …8650f029-… }\nThe subagents will send you a message when they have completed…"}
{"step_index":4,"type":"SYSTEM_MESSAGE","content":"…[Message] timestamp=… sender=195d6d7f-… priority=MESSAGE_PRIORITY_HIGH content=I ran the shell command … PINEAPPLE"}
```

Each child transcript has the **same record format** as the parent, so the
existing `AntigravityTranscriptReader` / `AntigravityToolEventBuilder` map it
unchanged. Step 0 is a `SYSTEM_MESSAGE` from `sender=<parent conversationId>`
carrying the prompt. The child reports back with a `send_message` tool call to
the parent.

Differences from the other harnesses:

- **One spawn call, N children.** Attribution needs a per-child key under the
  spawn call: the child `conversationId`, labelled by `Role`.
- **Asynchronous.** The `invoke_subagent` step finishes in about 0.15 s. Children
  keep running, and their results come back later as parent `SYSTEM_MESSAGE`
  steps with `sender=<child conversationId>`. The parent process stays alive
  until it has handled them, so the run does not end early. The spawn card must
  stay "running" until the child's report arrives, not close when the tool step
  completes.
- Antigravity tool-call ids are synthetic (`${eventId}:tool-${index}`, see
  `AntigravityLogParser`). The spawn card's id is whatever id the parser assigns
  the `invoke_subagent` call. Child events reference that same id.
- Interactive mode tails the same transcripts, so one implementation covers both
  modes.

## Proposal

### 1. Attribute events to their spawn, don't add new event types

Replace `callerType` with an optional `subagent` attribution on `CliEvent`, and
on `ToolCall` data where it is duplicated today:

```ts
interface SubagentAttribution {
  /** toolCallId of the spawning call in the parent agent's stream. */
  parentToolCallId: string;
  /**
   * Distinguishes siblings spawned by one call (antigravity-cli's
   * invoke_subagent spawns N). Omitted when a call spawns exactly one child.
   */
  agentId?: string;
}
```

Absent means the step's own agent. The group key for rendering and merging is
`(parentToolCallId, agentId)`. Nested subagents (Claude and Codex support depth
greater than 1) need nothing extra: a grandchild's `parentToolCallId` names a
spawn call that itself carries attribution, so the groups form a tree.

Rejected alternative: parallel event types (`subagentText`,
`subagentToolCall`, …). Every renderer, the history projection, find/search
segmentation, row-height estimation, and `CliTerminalFormatter` would need a
second branch per type. A single optional field reuses all of them.

Remove `callerType`, `CallerType`, and `CALLER_TYPES` (pre-release, no
compatibility constraint). Keep the `StreamingHistoryBuffer` merge guard, keyed
on the group key, so a subagent's text never coalesces into the parent's or a
sibling's.

Normalize the spawn itself on the parent's `ToolCall`: a parser that recognizes
its harness's spawn tool sets
`subagentSpawn?: { description?: string; agentType?: string; prompt?: string; children?: { agentId: string; label?: string }[] }`.
The renderer then keys off `subagentSpawn`, not off six harness tool names.
Each provider keeps its spawn tool name in its own protocol constants (`Agent`,
`task`, `agent`, `spawn_agent`, `invoke_subagent`), not in a shared list.

### 2. Two ingestion patterns

**A. Inline stamping** (link already in the stream ctrlyoke reads):

- **claude-cli headless:** stamp `parent_tool_use_id` onto every event
  `extractStructuredEventsFromEvent` produces from that message, including tool
  results. `ClaudeProviderEvent` already declares the field. Map `system`
  `task_progress.description` onto the spawn card's live status, and
  `task_notification.status` onto its terminal state.
- **copilot-cli, both modes:** read `data.parentToolCallId`. Keep a
  per-parse-session `toolCallId → parentToolCallId` map, filled on
  `tool.execution_start`, for `tool.shell_output` /
  `tool.execution_partial_result`. Use `subagent.started`'s
  `agentDisplayName` / `agentDescription` for the card header.

**B. Followed child sources** (child written elsewhere): add one shared
`SubagentSourceFollower` under `src/core/harness/shared/`. The provider's log
parser registers child sources as it discovers them, as
`{ attribution, open(): AsyncIterable<raw record> }`. The follower tails each
one, runs every record through **the provider's own existing record mapping**,
stamps the attribution, and merges the results into the step's event stream.
Rules:

- Discovery is provider-specific. Tailing, lifecycle, drain-on-exit and
  deduplication are shared. The headless path and the interactive path both go
  through it, so they cannot diverge (the `resolveHeadlessSourceMode()` rule).
- On process exit, drain every registered child to EOF **before** final output
  collection. Child files can trail the parent's last record by a few hundred
  ms.
- Tail a child only once its link is known. Never guess a file by mtime: parallel
  workflows share these directories.

Per harness:

| Harness                      | Discover from                                                                                | Child source                                                                                    | Skip                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| claude-cli interactive       | `subagents/agent-*.meta.json` appearing beside the session log; `toolUseId` → attribution    | `agent-<agentId>.jsonl`                                                                         | none                                                                                |
| qwen-cli (both modes)        | spawn call (bare `agent` or bridged `tool_call{name:"agent"}`); call id                      | `subagents/<sessionId>/agent-<agentName>-<callId>.jsonl`                                        | none                                                                                |
| codex-cli (both modes)       | `spawn_agent` `function_call_output.task_name`                                               | rollout in the session's date dir with matching `parent_thread_id` + `agent_path`               | everything before the child's first `task_started` with `initiating_agent_path` set |
| antigravity-cli (both modes) | the `GENERIC` result after `invoke_subagent` (`conversationId` + `logAbsoluteUri` per child) | child `transcript.jsonl`; `agentId` = child `conversationId`, label = `Role` from the call args | none                                                                                |
| opencode-cli (both modes)    | the ctrlyoke plugin                                                                          | a plugin-written sidecar `<runId>-subagents.jsonl`, see below                                   | none                                                                                |

**opencode sidecar:** extend `ctrlyoke-opencode-plugin.ts` to append, for every
`message.part.updated` whose `part.sessionID` is a known child session (from
`session.created` with `parentID`), `{childSessionId, part}` to a per-run
sidecar. It also appends the parent `task` part's `running` update, which maps
`childSessionId → callID`. The provider follows that sidecar through
`SubagentSourceFollower` and maps parts with the existing
`OpenCodeEventMapper`. Interactive mode still polls `export` for the parent and
can use the same sidecar for children. Grandchildren work the same way: a child
whose `parentID` is itself a child.

### 3. Render the spawn as a card

Give `ToolCall`s with `subagentSpawn` their own renderer instead of
`GenericToolCallOutput`:

- The header shows the description, agent type or label, and a live status line
  where the harness provides one: Claude `task_progress`, Copilot
  `subagent.*`.
- The prompt is collapsible. It is absent for codex, whose prompt is encrypted.
- The final result goes at the bottom.

Rows whose group key matches render nested under the card, collapsible and
collapsed once the child completes. As a first cut, they can instead be
indented with the child's label. For antigravity's N-child spawn, the card holds
one sub-group per `agentId`. Parallel subagents stay visually separate even
though their events interleave in time.

A card's "complete" state comes from the child, not the spawn tool result:
antigravity's tool step finishes immediately. Use the harness's completion
signal: Claude `task_notification`, Copilot `subagent.completed`, Codex/Qwen
child final message, opencode child `session.idle` / `task` part `completed`,
antigravity parent `SYSTEM_MESSAGE` with `sender=<child>`.

Row building lives in `src/ui/webview-react/utils/outputRows.ts`. Nesting has to
cooperate with its virtualization and height estimation, and with
`outputFind.ts` so find still reaches collapsed subagent rows.

`src/cli/CliTerminalFormatter.ts` should indent subagent rows under the spawn
line the same way.

### 4. Suggested order

1. Data model swap (`callerType` → `subagent` / `subagentSpawn`) plus the merge
   guard.
2. Inline harnesses: claude-cli headless and copilot-cli. This fixes the
   reported interleaving bug.
3. Card renderer and terminal formatter.
4. `SubagentSourceFollower`, with qwen-cli first: its sidechain filename already
   carries the call id, which makes it the simplest follower case.
5. codex-cli, antigravity-cli, claude-cli interactive, then opencode-cli (needs
   the plugin change).

## Out of scope

- **Background subagents**: Claude/Qwen `run_in_background`, and any Copilot
  `subagent.started` with `executionMode` other than `"sync"`. Their completion
  arrives as a notification that existing background-work handling already
  covers. (Antigravity children are asynchronous but the parent waits for them,
  so they are in scope.)
- Showing codex-cli subagent prompts: they are encrypted at rest.

## Tests

Build fixtures from the record shapes quoted above (trim paths and ids):

- `src/test/suite/harness/LogParsers.test.ts`:
  - Claude: child messages, including tool results, carry `parentToolCallId`,
    and main-thread messages don't. `caller.type: "direct"` on a child
    `tool_use` must not be read as attribution.
  - Copilot: child events carry it, and `tool.shell_output` for a child tool
    call is attributed through the `toolCallId` map.
  - Qwen: a bridged `tool_call{name:"agent"}` is classified as a spawn, and
    sidechain records are attributed via the filename's call id.
  - Codex: a child rollout's replayed parent history is skipped, and the
    `task_name → agent_path` link resolves.
  - Antigravity: one `invoke_subagent` yields two attributed groups keyed by
    `conversationId`.
  - opencode: sidecar parts map to the `task` `callID` through the `running`
    part's `metadata.sessionId`.
- `SubagentSourceFollower`: drains registered children before completion, never
  tails a source whose link isn't known, deduplicates re-read records.
- `StreamingHistoryBuffer`: parent and subagent text don't merge, and neither do
  two sibling subagents' texts.
- Webview (`src/ui/webview-react/test/`): rows nest under their spawn card; two
  interleaved subagents stay in separate groups; an antigravity spawn shows one
  sub-group per child; the card stays running after the spawn tool result until
  the child completes; find matches inside a collapsed subagent group.
- A `src/test/harness/` case (run only when the harness suite is explicitly
  requested), modelled on this research prompt: two parallel subagents, each
  echoing a marker, and the step's output attributes each marker command to a
  different spawn.
