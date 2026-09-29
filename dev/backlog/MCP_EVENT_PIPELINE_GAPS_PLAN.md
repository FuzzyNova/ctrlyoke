# MCP Event Pipeline Gaps — reliable detection and pairing of MCP tool calls on every harness

> **Status:** In progress — items 1–4 done; 5 remains open. Prerequisite for
> [`CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md`](CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md): purpose-built
> views are only as good as the `MCP_TOOL_CALL` events underneath them. Skill-mode calls still
> arrive as `BASH_COMMAND` until item 5 is complete.

## Findings (verified 2026-09-28 against real runs)

Evidence came from a one-step probe workflow run through the ctrlyoke CLI (`out/cli.js run`)
against a scratch git repo. The prompt began with `/mcp:ctrlyoke` and told the agent to call
`workflow_status`, `post_note`, `claim_paths` and `release_paths` in order. It ran on
**Copilot CLI 1.0.88** (`-m gpt-6-luna`) and **OpenCode 1.18.32** (`-m opencode/big-pickle`),
both headless. We inspected the recorded `events.jsonl`, the vendors' own logs
(`~/.copilot/session-state/<id>/events.jsonl`, `opencode export <id>`), and the result of
feeding the recorded events through the compiled `normalizeCliEvents`.

> Gotcha for anyone re-running this: ctrlyoke's MCP server is **opt-in**. Without
> `mcpServers: [ctrlyoke]` or an inline `/mcp:ctrlyoke`, the harness has no ctrlyoke tools and
> the agent quietly does something else. Our first probe did exactly that and looked like a
> parser bug.

### 1. Copilot CLI 1.0.x ctrlyoke calls are never classified as MCP

Copilot now names MCP tools `<server>-<tool>`, e.g. `ctrlyoke-claim_paths`.
`CliEventMapper.classifyMcpTool` (`src/core/harness/shared/CliEventMapper.ts:173`) only knows
the old Copilot form `server(tool)`, plus `mcp__s__t`, `s__t`, `mcp_*` and `s.t`. So every
Copilot MCP call falls through to a generic `TOOL_CALL` named `ctrlyoke-claim_paths`. None of
the existing tests cover Copilot MCP naming, so nothing caught the vendor change.

Copilot does record the server and tool as **structured fields** on both
`tool.execution_start` and the `assistant.message` `toolRequests[]` entry:

```json
{
  "type": "tool.execution_start",
  "data": {
    "toolCallId": "call_qcLN…",
    "toolName": "ctrlyoke-claim_paths",
    "arguments": { "paths": ["a.txt"], "reason": "probe" },
    "toolTitle": "claim_paths",
    "mcpServerName": "ctrlyoke",
    "mcpConfigServerName": "ctrlyoke",
    "mcpTransport": "stdio",
    "mcpConfigSource": "user",
    "mcpToolName": "claim_paths"
  }
}
```

**Copilot does send call parameters.** `arguments` is populated on every call. The earlier
belief that "Copilot sets no `parameters`" was a misreading of gap 2 below: the parameter-less
row is a duplicate, not the only row.

### 2. Every Copilot generic/MCP tool call renders as two rows

For each call, `CopilotLogParser` emits three events:

1. INITIATED, built by `CopilotToolBuilder.buildInitiatedEvents` → `BaseToolBuilder`: carries
   `parameters` and the call id.
2. COMPLETED, built by `CopilotToolBuilder.buildCompletedEvents`: carries `result` only. The
   generic `TOOL_CALL` fallback sets **no `id`**, and the `MCP_TOOL_CALL` branch sets no
   `parameters` and no id.
3. `TOOL_RESULT` carrying `toolCallId`.

`normalizeCliEventsWithSource` (`src/utils/CliEventNormalizer.ts:724`) merges event 3 into
event 1 by id. Event 2, though, is neither a `TOOL_RESULT` nor a member of
`SEMANTIC_OPERATION_TYPES`, so it is pushed as its own output row, and
`mergeInitiatedWithCompleted` has no `TOOL_CALL`/`MCP_TOOL_CALL` case anyway. The real run
normalized to:

```
toolCall ctrlyoke-claim_paths params: {"paths":["a.txt"],"reason":"probe"} result: yes id: call_qcLN…
toolCall ctrlyoke-claim_paths params: -                                    result: yes id: -
```

This affects **every Copilot tool that reaches the generic fallback**, not just MCP:
`report_intent`, `task_complete`, and any tool we don't classify. The webview store and
`outputProjection` both use this normalizer, so the duplicates reach the dashboard.

### 3. `McpToolCallData` has no call id

`McpToolCallData` (`src/types/CliOutputTypes.ts:459`) is `{server, tool, parameters?, result?}`.
Every other semantic type carries `toolCallId`, and `getToolCallId` in the normalizer reads it
generically. MCP pairing therefore always goes through the no-id LIFO guess in
`findPendingForResult`. With two MCP calls in flight at once (parallel tool calls, which Claude
and Copilot both do), a result can land on the wrong call. `getEventKey` makes this worse by
keying MCP on `mcp:server.tool`, so two calls to the same tool are indistinguishable.

### 4. OpenCode has no MCP detection, and its names are ambiguous

OpenCode reports ctrlyoke calls as tool parts named `<server>_<tool>`, e.g.
`ctrlyoke_claim_paths`. It carries **no structured server/tool metadata**: the export's
`state.metadata` is only `{truncated:false}`. `OpenCodeEventMapper`'s `default` branch maps it
to a generic `TOOL_CALL` (one row, with params and result, so there's no duplicate here). A
naive split can't recover server and tool, because both ctrlyoke tool names (`claim_paths`)
and server ids (`ctrlyoke-commit`) contain separators. Also, OpenCode's tool output arrived as
pretty-printed JSON while Copilot's was compact, so result parsing must not assume either.

**Hyphen capture (verified 2026-09-28):** OpenCode CLI 1.18.32 preserved the hyphen in the
server prefix. A scratch project config attached the compiled MCP server as
`ctrlyoke-commit`; `opencode export ses_f151550e8ffeqUgB90vCwiwXe6` recorded the tool part name
`ctrlyoke-commit_global_status` with call id `call_function_3ne426q3g8qm_1`. The requested
`workflow_status` tool was not available in the current server build, so the second and final
capture called its current `global_status` tool instead. The MCP capture fixture preserves the
tool name and event shape while replacing the local workspace path and generated identifiers.

### 5. Skill mode produces bash, not MCP

In `mcpMode: skill` the agent runs
`node "<mcp-server.js>" --tool <name> --args '<json>' …`
(`src/templates/skills/ctrlyoke-mcp-tools/SKILL.md:13`). That arrives as `BASH_COMMAND` on
every harness, so neither the views plan nor coordination attribution can see it.

### 6. All four probed harnesses emit all four MCP calls

The compiled single-file probe was run against Claude CLI 2.1.284, Codex CLI 0.157.0, Qwen CLI
0.24.4, and Antigravity CLI 1.2.12 using the shared cheapest-model map. Raw vendor records are
sanitized in `src/test/fixtures/mcp-probe/*.jsonl`; the ordinary parser contract test feeds each
capture through its runtime parser and then `normalizeCliEvents`.

- **Claude:** emitted four direct `tool_use` blocks and four matching `tool_result` records.
  `ToolSearch` queried the available tool names first; it was not an MCP call itself.
- **Codex:** emitted one `exec` custom-tool call whose JavaScript awaited all four
  `tools.mcp__ctrlyoke__…` calls and printed a JSON array of their four results. The parser's
  previous first-match regex kept only `workflow_status` and attached the whole array to it.
  In the final confirmation run Codex used indexed aliases (`tools[methods[i]](...)`) built from
  `ALL_TOOLS` and printed only a completion summary. `CodexToolBuilder` now extracts both forms,
  parses each argument object, assigns a derived call id, and pairs array results by order when
  present; when Codex omits individual results, each call carries the enclosing successful exec
  summary.
- **Qwen:** emitted all four calls in its `tool_call` envelope, with
  `name: "mcp__ctrlyoke__<tool>"`, nested arguments, and matching tool-result records.
  `QwenLogParser` unwraps that vendor envelope.
- **Antigravity:** emitted four separate `PLANNER_RESPONSE` transcript records and four
  corresponding result records. The earlier single-row fixture was synthetic and did not reflect
  the vendor transcript; no Antigravity parser change was needed. The fixture now exercises the
  raw transcript reader and the same stateful transcript mapper used at runtime.

The initial strict probe passed for Claude, Qwen, and Antigravity; Codex failed because the parser
only unwrapped one nested call. The Codex raw-fixture regression and a final strict live probe now
pass for both Codex and Antigravity.

## Design

### A. Structured identity first, name parsing second

Add an optional `mcp?: { server: string; tool: string }` hint to the tool-classification input.
Each provider fills it from structured data when the vendor provides it, and
`classifyMcpTool` uses the hint before trying any name regex:

- **Copilot:** `data.mcpServerName` / `data.mcpToolName` from `tool.execution_start`, stored on
  `CopilotPendingTool` so the completion path has them too. Prefer `mcpServerName` (the
  runtime name) and keep `mcpConfigServerName` as a fallback. Fall back to the
  `server(tool)` regex only for old logs in history.
- **OpenCode:** it has no structured data, so resolve the `<server>_<tool>` name against the
  **set of MCP server ids ctrlyoke attached to this execution**. The provider builds that set
  itself in the inline config. Use longest-prefix matching on `<id>_`, so `ctrlyoke-commit_…`
  wins over `ctrlyoke_…`. Before implementing, capture a run with a hyphenated server id
  (`ctrlyoke-commit`) to confirm whether OpenCode sanitizes `-` in the prefix, and match on the
  sanitized form if it does. The parser needs the attached-server set passed in; don't
  re-derive it from settings.
- Do **not** add a generic `<server>-<tool>` hyphen regex to the shared classifier. Ordinary
  tool names contain hyphens, and it would misclassify them on every harness.

### B. Give MCP calls a call id and pair them like everything else

- Add `toolCallId?: string` to `McpToolCallData` and populate it in `BaseToolBuilder` (the MCP
  case currently spreads extras onto the event, not into `data`), `CopilotToolBuilder`,
  `AntigravityToolEventBuilder`, Codex, and OpenCode (`part.callID`).
- `getEventKey` for MCP: `mcp:call:<id>` when an id exists, else today's `mcp:server.tool`.
- Pending MCP entries record `toolCallId`, so `findPendingForResult` matches by id instead of
  guessing.

### C. Stop Copilot from emitting an unpairable second event

Fix both halves so no provider can cause this again:

1. **Normalizer:** treat a `TOOL_CALL`/`MCP_TOOL_CALL` that carries a `result` **and** a call
   id matching an earlier row as a completion. Neither type is in `SEMANTIC_OPERATION_TYPES`,
   so the initiated row is usually **not** in `pending`; match it by id through
   `findOutputIndexByToolCallId` (which already reads `ToolCall.id` via `getToolCallId`) as
   well as through `pending`. Never merge on name alone — a result-bearing call with no id,
   or an id no earlier row has, stays its own row. Merge it with new `TOOL_CALL`/`MCP_TOOL_CALL`
   cases in `mergeInitiatedWithCompleted`, which keep the initiated `parameters` and take the
   completed `result`, mirroring the `ASK_USER_QUESTION` backfill.
2. **Copilot:** set `id` on the generic `TOOL_CALL` completion and `toolCallId` on the
   `MCP_TOOL_CALL` completion, and pass `parameters` through from `pendingTool.args`, which is
   already in scope. With (1) in place the two halves collapse into one row. The trailing
   `TOOL_RESULT` then finds the call already merged (the existing
   `findOutputIndexByToolCallId` guard) and is dropped as it is today for semantic types.

Add a regression test that feeds a real Copilot MCP start/complete/result triple through
`normalizeCliEvents` and asserts exactly one row with both `parameters` and `result`. Add a
second one for a non-MCP generic tool (`report_intent`), since that duplicate predates MCP.

### D. Skill-mode calls become MCP events

In the shared bash mapping (so every harness benefits), recognise a command that invokes the
ctrlyoke `mcp-server.js` with `--tool <name> --args <json>`. Match on the script basename plus
the `--tool` flag, not the absolute path. Rewrite it into a synthetic `MCP_TOOL_CALL`
`{server: MCP_SERVER_IDS.CTRLYOKE, tool, parameters: parsedArgs, toolCallId}` with stdout as
the result, and add a `via: "skill"` marker so the UI can badge it. Malformed `--args` JSON
leaves the event as plain `BASH_COMMAND`.

### E. A repeatable harness MCP probe

Turn the ad-hoc probe into a checked-in harness test (it lives under `npm run test:harness`,
so it only runs when explicitly requested, because it spends money). Per harness it runs the
four-call ctrlyoke prompt and asserts:

- each call normalizes to exactly one `MCP_TOOL_CALL` with `server: "ctrlyoke"`, the right
  `tool`, non-empty `parameters` where the call had arguments, a `result`, and a `toolCallId`;
- no generic `TOOL_CALL` row mentions a ctrlyoke tool name.

Use the cheapest model each harness supports, as this investigation did. **Live-run policy for this
plan's workflow (authorized by the user):** any implementation step may run targeted live
harness probes — a single harness test file, or a one-off CLI run on the cheapest model — when
real vendor output is needed to verify its work. The full `npm run test:harness` suite is
reserved for the orchestrator's review pass. Routine verification still uses `npm test`. Run it first against
Claude, Codex, Qwen and Antigravity to close gap 6, and save sanitized captures from each as
parser unit-test fixtures, so vendor renames show up in `npm test` rather than in the dashboard.

## Implementation order

1. [x] **C + B:** the duplicate-row fix and MCP call ids. This is a user-visible bug on every
       Copilot run today, independent of MCP. The `ctrlyoke-claim_paths` Copilot name still maps
       to generic `TOOL_CALL` in this step; structured MCP classification remains item 2. OpenCode's
       current mapper also emits only generic `TOOL_CALL` events, so it now carries `part.callID`;
       MCP classification remains item 3.
2. [x] **A (Copilot):** structured MCP identity, with a fixture test built from the
       capture above. The parser continues to use `tool.execution_start` as its tool-call
       source; `assistant.message.toolRequests` are not independently mapped. No design
       deviations.
3. [x] **A (OpenCode):** attached-server-set resolution. The 2026-09-28 capture confirmed raw
       hyphenated prefixes; the parser uses longest-prefix matching against ids attached to the
       execution and retains unmatched names as generic tool calls.
4. [x] **E:** add the all-six-harness probe and raw vendor fixtures for the four previously
       unverified harnesses. The Codex parser now expands multiple MCP calls and pairs the captured
       result array; Antigravity's four separate transcript calls are covered through its runtime
       transcript mapper. The strict probe passes for Claude, Codex, Qwen, and Antigravity.
5. [ ] **D:** skill-mode mapping (reopened — see Review notes).

## Review notes (2026-09-28)

- **Skill-mode rewrite lives in the display normalizer, not the event-production path.**
  `normalizeMcpSkillBashEvent` runs inside `normalizeCliEventsWithSource`, so raw-event consumers
  (`CommitMessageGenerator`'s streaming-events `submit_commit_message` detection,
  `TimelineRecorder`, `HistoryCandidateExtractor`, `CliTerminalFormatter`, persisted
  `events.jsonl`) still see `BASH_COMMAND`. Section D requires the rewrite where events are
  produced so every consumer benefits.
- Fixed in review: `TOOL_CALL`/`MCP_TOOL_CALL` completion merge dropped completion-side
  `parameters` when the initiated half had none.
