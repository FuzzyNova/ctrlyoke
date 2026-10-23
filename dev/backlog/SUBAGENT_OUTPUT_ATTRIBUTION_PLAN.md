# Subagent Output Attribution Plan

**Status:** Researched against all six harnesses (2026-10-15); staged for implementation 2026-10-23 (see "Implementation order").

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

The same gap loses usage. A step's tokens and cost come only from the records
ctrlyoke parses, so a child that writes elsewhere is not counted. Measured on
2026-10-23 for claude-cli interactive: across 35 sessions with subagents, the
`subagents/agent-*.jsonl` files held 42% of the sessions' cost ($211 of $505 at
API list prices), none of it in ctrlyoke's step totals.

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

Remove `callerType`, `CallerType`, and `CALLER_TYPES`. ctrlyoke is released,
so this was checked against the compatibility rules: `callerType` is persisted
inside `cliOutput*` events in each run's `events.jsonl` (timeline schema v2) and
passes through verbatim in `ctrlyoke history show --json --events`. It is
optional, undocumented (no schema, docs page or `--json` envelope definition
names it), and never held anything but `"direct"`, so removing it needs no
timeline schema bump: old files still carry it and are read fine because nothing
reads it, and older ctrlyoke versions ignore the new optional `subagent` /
`subagentSpawn` fields. Record the removal and the new fields under **Changed**
in `CHANGELOG.md`. Keep the `StreamingHistoryBuffer` merge guard, keyed on the
group key, so a subagent's text never coalesces into the parent's or a
sibling's.

The spawn card's live state also needs a home. Put it on `subagentSpawn`
(`statusLine?: string` and a `state` of running / completed / failed, as
constants in `DashboardConstants.ts`). Parsers express an update as another
tool-call event with the spawn's id, which `CliEventNormalizer` already merges
by id; the completion signal for a child (see section 3) sets `state`, not the
spawn tool's own result.

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

**Follower contract (fixed 2026-10-23 after the first attempt).** The first
`SubagentSourceFollower` was a one-shot `drain()` called from each provider's
`augmentParsedOutput`. That path is headless-only (`CliResponseCollector`), so
interactive mode never saw children, nothing streamed live, and antigravity and
opencode each re-implemented the usage merge by hand. The follower is rebuilt
to this contract, and every provider uses it:

- **Ownership.** One follower per attempt, owned by the provider's log parser
  and exposed through an optional `ILogParser` member (e.g.
  `getSubagentFollower?(): SubagentSourceFollower | undefined`), reset with the
  parser's other per-attempt state. Providers do not drain it themselves.
- **Registration.** `register(source)` with a typed
  `SubagentChildSource<TRecord>`: `key`, `attribution`, a `read(fromOffset)`
  (or async iterator) that returns new raw records plus the next offset, the
  provider's `map(record) => CliEvent[]`, `usage(record) => SubagentRecordUsage
| undefined` (model, input, output, cache-read, cache-write, 1-hour
  cache-write subset, reasoning; deduplicated by a provider-supplied
  `recordId`), and `isComplete(record)` for the card's completion signal. No
  `as unknown as` casts: the record type is a generic parameter.
- **Live tailing.** The shared pipeline starts the follower with the attempt's
  `onStreamingEvents` callback: `HeadlessLogTail` for headless log sources and
  `CliLogMonitor` / `SessionActivityWatcher` for interactive. It polls each
  registered source on the existing tail interval and streams attributed events
  as they appear, plus a spawn-card update (`subagentSpawn.state`) when
  `isComplete` fires.
- **Final output.** Before final output is returned, the shared code (not the
  provider) drains every registered source to EOF within `DRAIN_DEADLINE_MS`
  and merges the result through one helper, e.g. `mergeSubagentOutput(output,
drain)` in `src/core/harness/shared/`: attributed events appended in
  timestamp order, spawn states applied, per-child usage added into
  `TokenUsage.modelUsage` per model and into the totals (input, output,
  cache-read, cache-write, long-TTL, reasoning), and `totalConfidence` set to
  `PARTIAL` when a registered source could not be read. The call sites are
  `CliResponseCollector` (headless) and `CliLogMonitor`'s completion and failure
  finalization (interactive), so the two modes cannot diverge.
- **Opt-out of usage per mode.** A source registered for events only (claude
  headless, qwen headless, where the parent stream's totals already include
  children) passes no `usage`.

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

### 4. Count subagent tokens and cost

Every followed child source carries per-call usage in the same shape as the
parent's records (Claude `message.usage`, Qwen `usageMetadata`, Codex
`token_count`, Antigravity transcript and statusline usage, OpenCode
`step_finish` `tokens`). Fold it into the step's `TokenUsage` so the attempt
total, the cost estimate, the Stats tab and the harness cards include the
children's work:

- **Reuse each parser's usage accumulation**, run per child source, then add
  the child's sums into the step's input, output, cache-read, cache-write
  (including Claude's 1-hour `cache_creation.ephemeral_1h_input_tokens`
  subset) and reasoning counts. Dedupe by message id per source, as
  `ClaudeLogParser` already does for the main log.
- **Children may run a different model.** A Claude `Explore` subagent often
  runs Haiku while the parent runs Opus, so one blended count priced at the
  parent's rates is wrong. Price each model separately: keep per-model usage
  (the shape of the existing `modelUsage` metadata) and sum the per-model
  costs in `calculateAttemptCost`.
- **Context window stays the parent's.** Children have their own context;
  `contextWindowUsedTokens` must keep coming from the parent's last call.
- **Don't count twice.** Before adding a child's usage, check whether the
  stream ctrlyoke already reads includes it. All six harnesses are answered
  below ("Measured usage coverage"): only Copilot's OTel path already includes
  children; for the other five, ctrlyoke's current source is parent-only.
  Codex's child rollout replays the parent's history (see the codex-cli
  gotchas), so only its own `token_count` deltas count.
- **Harness-reported cost.** Claude's `total_cost_usd` and OpenCode's
  `part.cost` may already include children. Compare against the per-model
  calculation, and keep the existing divergence check meaningful.

Usage from a child source that can't be read (missing file, link never
resolved) marks the attempt's coverage partial, so totals show **≥** instead
of silently undercounting. `calculateAttemptCost`
(`src/utils/ModelPricing.ts`) continues to suppress the whole attempt's cost
for `TOKEN_TOTAL_CONFIDENCE.PARTIAL`. A lower-bound estimate would risk being
read as the full bill; the token count still exposes the lower-bound marker.

Per-model usage is a new optional field on the persisted `TokenUsage` /
`CliOutput.tokens`; adding it is additive and needs no timeline schema bump,
but runs recorded before it keep a single blended count.

#### Measured usage coverage

Captured 2026-10-23, headless, one parent launching two parallel subagents that
each run `echo` and read a file. The prompt is the research prompt above. Each
run's stdout and session files were compared. Models were the `HARNESS_MODELS`
ones, with `haiku` for claude-cli and a `sonnet` override on one child.

| Harness (version)     | Does the stream or log ctrlyoke reads include the children?                                      | Where the children's usage is                                                            | Children's share of the run |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------- |
| claude-cli 2.1.309    | `result.usage` **no**; `result.modelUsage` and `total_cost_usd` **yes**                          | `subagents/agent-*.jsonl` (also in headless)                                             | see below                   |
| copilot-cli 1.0.103   | **Yes**: OTel `chat <model>` spans and `session.shutdown.modelMetrics` both include child calls  | Already in the same OTel and `events.jsonl` streams                                      | 4 of 6 model calls          |
| codex-cli 0.163.0     | **No**: `turn.completed.usage` and the parent rollout's `token_count` are parent-only            | Each child rollout's `token_count`                                                       | 58,612 of 128,504 input     |
| qwen-cli 0.26.0       | **No** in the chat log ctrlyoke reads. `result.usage` (headless) **does**, plus background calls | `subagents/<sessionId>/agent-*.jsonl` `usageMetadata`                                    | 70,449 of 160,217 prompt    |
| opencode-cli 1.19.4   | **No**: stdout `step_finish.tokens` is parent-only                                               | Child session sidecar (`step-finish` parts)                                              | ~168k of ~221k total        |
| antigravity-cli 1.4.6 | **No**: stdout `result.usage` and the parent transcript are parent-only                          | Each child's `transcript_full.jsonl` `PLANNER_RESPONSE` `input_tokens` / `output_tokens` | ~58k of ~96k input          |

Per harness:

- **claude-cli.** `result.usage` is parent-only (4 in / 13,982 cache-write /
  45,717 cache-read / 631 out) and matches the main transcript's sums.
  `result.modelUsage[model]` has the children folded in per model, and
  `total_cost_usd` is exactly the sum of `modelUsage[*].costUSD`. Inline child
  `assistant` messages in stdout carry only early streaming snapshots (3 and 16
  output tokens against 387 and 172 in the transcripts), so they can't be
  summed. `modelUsage` equals the main transcript plus every
  `subagents/agent-*.jsonl`, summed per model and deduped by `message.id`, with
  no difference in any count (haiku: 8 / 1,018 / 67,308 / 37,488; sonnet: 4 / 172
  / 21,592 / 23,351). The `task_progress` and `task_notification` system events
  carry a per-child `usage: {total_tokens, tool_uses, duration_ms}`, a single
  total with no split by type or model: fit for a status line only.
- **copilot-cli.** Headless stdout carries no token counts at all (its `result`
  event has only `premiumRequests`). The session's `events.jsonl` has one
  `session.usage_record` per model call, and child calls carry
  `parentToolCallId` and `initiator: "sub-agent"`. The OTel file has a
  `chat <model>` span for every call including the children's, plus aggregate
  `invoke_agent` spans. `CopilotLogParser` sums only the `chat` spans, so it
  **already counts children once**. In the OTel run the `chat` sums equal
  `session.shutdown.modelMetrics` per model (gpt-5.6-luna: 48,060 in / 300 out;
  gpt-6-luna: 30,406 / 791), and that event also splits usage per agent
  (`agentMetrics`). **Children ran a different model**: `gpt-5.6-luna` for the
  `task` subagents against `gpt-6-luna` for the parent, so the sum is priced at
  the parent's rates today. The context-window reading needs
  care too: `usage_info` events for child calls (limit 200,000, against the
  parent's 272,000) land on the same top-level `invoke_agent` span, so
  `contextWindowUsedTokens` can read a child's fill mid-run. It is only correct
  once the parent's last call lands. The model also sometimes skips the
  subagents and does the work itself (one of three runs did), so assert on
  `subagent.started` in a test fixture rather than trusting the prompt.
- **codex-cli.** `turn.completed.usage` (69,892 in / 66,816 cached / 292 out)
  equals the parent rollout's final `total_token_usage`. Each child rollout has
  its own `token_count` events (29,296 and 29,316 in), the same model as the
  parent. They contain no replayed copy of the parent's `token_count` records,
  so the child's own totals can be added as they are. The replayed history
  noted above is messages only.
- **qwen-cli.** The main chat log holds the parent's calls only (5 calls, 89,768
  prompt). The sidechain files hold the children's (2 calls each, 35,223 and
  35,226 prompt), so logs plus sidechains total 160,217. The headless
  `result.usage` is larger (204,514), and a control run with no subagents shows
  the same gap (log and stream 31,999 prompt, `result.usage` 53,365). **That
  gap is not a Qwen bug.** `result.usage` is built from Qwen's session
  telemetry (`computeUsageFromMetrics` over `uiTelemetryService`), which counts
  every API response in the process, while the chat log records only the main
  chat's assistant turns. A control run with Qwen's telemetry outfile enabled
  (`QWEN_TELEMETRY_ENABLED=true QWEN_TELEMETRY_TARGET=local
QWEN_TELEMETRY_OUTFILE=…`) listed four `api_response` events summing to
  exactly `result.usage` (43,009 in / 783 out / 12,143 cached): the two
  main-chat calls, plus two background calls that never reach the chat log, a
  `side-query:auto-memory-recall` call and a `managed-auto-memory-extractor`
  subagent call (9,222 in / 468 out). So `result.usage` is complete billing for
  the process, including children and these background calls. It is the more
  accurate headless number, not an inflated one. The stream's child messages
  carry zeroed usage (`input_tokens: 0`).
  ctrlyoke reads `usageMetadata` from the chat log and uses the `result` event
  only for errors, so today it under-counts both the children and the
  background calls. No tokenizing is involved either way: both options read
  counts Qwen already reports.
- **opencode-cli.** Stdout `step_finish.tokens` covers the parent session only
  (3 steps, 53,495 total). The two child sessions, found through the `task`
  part's `state.metadata.sessionId`, held 84,824 and 83,080 total, so
  children were over three times the parent's tokens in this run. `part.cost`
  was 0 throughout (free model), so cost can't be cross-checked here. Whether
  `part.cost` includes child cost remains unverified. Child
  sessions use `message.info.tokens` and `step-finish` parts in the same shape
  as the parent's.
- **antigravity-cli.** Stdout `result.usage` (38,698 in) is exactly the sum of
  the parent's five `agent_response` steps, so it excludes the children. Each
  child's `transcript_full.jsonl` records `input_tokens` and `output_tokens` on
  every `PLANNER_RESPONSE` (about 29k input for each child here). The spawn
  carries `"Model": "inherit"`, so children use the parent's model unless the
  call says otherwise. `cache_read_tokens` was 0 throughout.

Consequences for the design:

- **claude-cli headless is currently wrong, in a way that is easy to fix.**
  `ClaudeLogParser` takes the top-level `result.usage` as the attempt total,
  which excludes children, while it stores `total_cost_usd` and `modelUsage`,
  which include them. Token counts and the reported cost therefore disagree
  whenever a subagent ran, and the divergence check fires for the wrong reason.
  The fix needs no subagent files: use `modelUsage` for the per-model token
  counts (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheCreationInputTokens`) and sum them into the step totals.
- **Don't add the subagent transcripts on top of that in claude-cli
  headless**, or the children are counted twice. `modelUsage` already has them.
- **`modelUsage` has no 1-hour / 5-minute cache-write split.** Only the
  top-level `result.usage.cache_creation` has it, and that is parent-only. In
  this capture the parent wrote its cache at the 1-hour TTL and both children at
  5 minutes. For the priced split, take the parent's 1-hour subset from
  `result.usage` and treat the rest of the cache writes as 5-minute, or, when
  the transcripts are readable, take each child's split from its own file. The
  second is exact; the first slightly underprices any child that used the
  1-hour TTL.
- **claude-cli interactive has no result event**, so the transcripts are the
  only source: the main transcript is parent-only, and the children are only in
  `subagents/agent-*.jsonl`. Add those, per model, once each. This is the 42%
  gap measured above.
- **Codex, OpenCode and Antigravity** need the follower from step 4 before
  their children can be counted, and each can then simply add the child
  source's sums to the parent's. There is no double counting to guard against
  in any of them.
- **Qwen headless** can skip the follower for token counts: take the `result`
  event's `usage` (whole-process, children and background calls included) as the
  attempt total, as the claude-cli headless fix does with `modelUsage`. It has
  no per-model split, but it is one model per process unless a fast model is
  configured. Do not also add the sidechain files in headless, or the children
  count twice. **Qwen interactive** has no result event, so there the chat log
  plus the sidechain files are the source, and the background calls (memory
  recall/extraction, which only the telemetry sees) stay uncounted. Document
  that as a known limit rather than chasing it.
- **Copilot needs pricing, not collection.** The tokens are already in the
  total. Keep per-model usage from the `chat <model>` spans (or from
  `session.shutdown.modelMetrics`) so child calls are priced at their own
  model's rates, and keep the child's context fill out of
  `contextWindowUsedTokens`.
- **Per-model pricing is needed across the board.** Claude's `Explore` runs
  Haiku under an Opus parent; Copilot's `task` subagents ran a different model
  from the parent in this capture. Only Codex and Antigravity (`inherit`)
  matched the parent here, and either can be configured differently.

### 5. Implementation order

Each item is one session; tick it when it lands.

- [x] 1. Data model swap (`callerType` → `subagent` / `subagentSpawn`) plus the
      merge guard.
- [x] 2. claude-cli headless inline stamping, spawn normalization, and
      `task_*` status/completion. Fixes the reported interleaving bug.
- [x] 3. copilot-cli inline stamping (both modes).
- [x] 4. Per-model usage and pricing, plus the inline-source usage fixes that
      need no follower: claude-cli headless `result.modelUsage`, copilot-cli
      per-model `chat` spans and the child context-window leak, qwen-cli
      headless `result.usage`.
- [ ] 5. Dashboard spawn card and nested rows; terminal formatter indentation
      (independent files, may run in parallel). Terminal half done
      (765b32752); dashboard card rendering, description/status/prompt find
      segments, docs, and changelog are committed separately. Remaining:
      connect collapsible child groups to virtualized rows (including
      interleaved siblings, antigravity N-child groups, grandchildren, and
      late-arriving spawn calls), auto-expand those groups on find, and add the
      corresponding nesting/collapse/find tests.
- [x] 6a. Rebuild `SubagentSourceFollower` to the follower contract in
      section 2B and wire it into the shared headless and interactive
      pipelines.
- [x] 6b. qwen-cli on the follower (both modes, bridge unwrapping, qwen
      interactive child usage).
- [x] 7. claude-cli interactive follower plus child usage (the largest
      measured usage gap).
- [ ] 8. codex-cli follower plus child usage.
- [ ] 9. antigravity-cli follower (N children, asynchronous completion) plus
      child usage. A first cut landed in 26409d384 on the old one-shot drain;
      move it onto the follower contract.
- [ ] 10. opencode-cli plugin sidecar, follower, and child usage. A first cut
      landed in 584be3d4d / 5e5d328f6 on the old one-shot drain (scans every
      sidecar in the notify dir, headless only); move it onto the follower
      contract.
- [ ] 11. Harness-suite case, user docs (`docs/guide/usage-and-stats.md`
      subagent note, output guide), CHANGELOG sweep, and moving this plan to
      `dev/implemented/`.

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
- Usage: a step with one child adds the child's input, output, cache-read and
  cache-write counts to the step's totals exactly once; a child on a different
  model is priced at its own model's rates; the context window stays the
  parent's; an unreadable child source marks coverage partial.
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
