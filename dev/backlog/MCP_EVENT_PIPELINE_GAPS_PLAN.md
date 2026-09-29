# MCP Event Pipeline Gaps — reliable detection and pairing of MCP tool calls on every harness

> **Status:** Not implemented. Prerequisite for
> [`CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md`](CTRLYOKE_MCP_TOOL_CALL_VIEWS_PLAN.md): purpose-built
> views are only as good as the `MCP_TOOL_CALL` events underneath them, and on two of the six
> harnesses today those events never exist.

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

### 5. Skill mode produces bash, not MCP

In `mcpMode: skill` the agent runs
`node "<mcp-server.js>" --tool <name> --args '<json>' …`
(`src/templates/skills/ctrlyoke-mcp-tools/SKILL.md:13`). That arrives as `BASH_COMMAND` on
every harness, so neither the views plan nor coordination attribution can see it.

### 6. Other harnesses are unverified

Claude, Codex, Qwen and Antigravity weren't probed in this pass. Their classifier paths exist
(`mcp__ctrlyoke__x`, Codex's `tools.mcp__…(` unwrapping, Antigravity's own builder), but
Copilot's silent rename shows that "has a code path" doesn't mean "works on the current CLI".

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
   id matching a pending entry as a completion. Merge it with new `TOOL_CALL`/`MCP_TOOL_CALL`
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

Use the cheapest model each harness supports, as this investigation did. Run it first against
Claude, Codex, Qwen and Antigravity to close gap 6, and save sanitized captures from each as
parser unit-test fixtures, so vendor renames show up in `npm test` rather than in the dashboard.

## Implementation order

1. **C + B:** the duplicate-row fix and MCP call ids. This is a user-visible bug on every
   Copilot run today, independent of MCP.
2. **A (Copilot):** structured MCP identity, with a fixture test built from the capture above.
3. **A (OpenCode):** attached-server-set resolution, after the hyphenated-server capture.
4. **E:** the probe and the fixtures for the four unverified harnesses. Fix whatever it finds.
5. **D:** skill-mode mapping.
