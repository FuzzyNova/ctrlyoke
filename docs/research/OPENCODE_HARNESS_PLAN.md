# OpenCode CLI Harness — Implementation Plan

**Last Updated**: 2026-03-01
**opencode Version Researched**: 1.1.48
**Architecture**: Composition-Based (follows `docs/ADDING_NEW_CLI_PROVIDER.md`)

---

## 1. What Is OpenCode?

[OpenCode](https://opencode.ai) is a multi-provider AI coding assistant CLI built by the SST team. Unlike Claude Code or Codex (which are locked to a single AI provider), opencode is an **AI-agnostic terminal agent** that supports 50+ models across providers including Anthropic, OpenAI, Google, and its own hosted models.

**Key differentiators from existing harnesses:**

| Feature | Claude CLI | Codex CLI | OpenCode CLI |
|---|---|---|---|
| Provider | Anthropic only | OpenAI only | 50+ providers/models |
| Output format | stream-json (NDJSON) | JSONL events | JSONL events (`--format json`) |
| Session resume | `-r <sessionId>` | `resume <id>` | `-s <sessionId>` |
| Model format | `claude-sonnet-4.5` | `gpt-5.1-codex` | `provider/model` |
| Completion hook | Stop hook (`--settings`) | notify hook (`--config`) | No hook system (use process exit) |
| MCP config | `--mcp-config <file>` | `-c 'mcp_servers...'` TOML | Project `opencode.json` file |

---

## 2. OpenCode CLI Behavior Analysis

### 2.1 Headless Execution

Headless mode uses the `run` subcommand:

```bash
opencode run "your prompt here" --format json -m anthropic/claude-sonnet-4-6 -s <sessionId>
```

**Relevant flags:**

| Flag | Description |
|---|---|
| `--format json` | Emit JSONL events (one JSON object per line) |
| `-m provider/model` | Model in `provider/model` format |
| `-s <sessionId>` | Resume existing session |
| `-c` | Continue most recent session (avoid — global, not project-scoped) |
| `--agent <name>` | Use a named agent (configured in opencode config) |
| `-f <file>` | Attach file(s) to the message |
| `--title <title>` | Session title |

### 2.2 JSON Event Stream (JSONL, `--format json`)

Each line is a self-contained JSON object:

**`step_start`** — Step begins
```json
{
  "type": "step_start",
  "timestamp": 1772383353853,
  "sessionID": "ses_355b84d3cffeU1eFE2d5lzBROE",
  "part": { "type": "step-start", "snapshot": "..." }
}
```

**`text`** — AI text response
```json
{
  "type": "text",
  "timestamp": 1772383353862,
  "sessionID": "ses_355b84d3cffeU1eFE2d5lzBROE",
  "part": {
    "type": "text",
    "text": "hello 👋",
    "time": { "start": ..., "end": ... }
  }
}
```

**`tool_use`** — Tool call (includes input AND output in one event)
```json
{
  "type": "tool_use",
  "timestamp": 1772383411284,
  "sessionID": "ses_355b76e3bffeeiyS3Yk7GQkl8x",
  "part": {
    "type": "tool",
    "callID": "call_3qQ0ZMYsX3hSkOqFC9RFB65k",
    "tool": "bash",
    "state": {
      "status": "completed",
      "input": { "command": "echo \"hello world\"", "description": "..." },
      "output": "hello world\n",
      "title": "Prints hello world to stdout",
      "metadata": { "output": "...", "exit": 0, "truncated": false }
    }
  }
}
```

**`step_finish`** — Step ends
```json
{
  "type": "step_finish",
  "timestamp": 1772383353900,
  "sessionID": "ses_355b84d3cffeU1eFE2d5lzBROE",
  "part": {
    "type": "step-finish",
    "reason": "stop",       // "stop" = complete, "tool-calls" = more steps follow
    "cost": 0.01560475,
    "tokens": {
      "input": 8861,
      "output": 7,
      "reasoning": 0,
      "cache": { "read": 0, "write": 0 }
    }
  }
}
```

**Completion signal**: `step_finish` with `part.reason === "stop"`.

**Session ID**: Extracted from `sessionID` field on any event line.

### 2.3 Session Management

- Session IDs format: `ses_355b84d3cffeU1eFE2d5lzBROE` (prefix `ses_` followed by alphanumeric)
- Resume with: `-s <sessionId>` in the `run` subcommand
- Avoid `-c` (global "continue last" — not project-scoped)
- No auto-resume on new sessions (no `-c` unless explicitly requested)

### 2.4 Interactive TUI Mode

```bash
opencode [project-path]
```

The TUI starts without a prompt. Unlike Claude/Codex, **opencode has no hook system** (no Stop hook, no notify hook) for completion detection. Interactive mode is therefore the major design challenge.

**Strategy for interactive mode**:
Use `usesInteractiveNotificationMonitor: false` — no file-based notification monitor. Rely on process exit for completion detection (consistent with how non-hooked CLIs are handled). This means interactive mode will detect completion when the terminal session ends, not after each individual prompt response.

> **Note**: This is a known limitation. Future enhancement: opencode's `serve` mode + HTTP API could enable a more sophisticated interactive integration, but that is out of scope for the initial implementation.

### 2.5 MCP Server Configuration

OpenCode reads MCP config from project-level `opencode.json` (merged with global config). The format uses a `"mcp"` key with local server definitions:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "flightpath": {
      "type": "local",
      "command": ["node", "/path/to/flightpath-mcp.js"],
      "environment": {
        "FLIGHTPATH_WORKSPACE": "/path/to/workspace",
        "FLIGHTPATH_WORKING_FILE": "/path/to/working.json"
      }
    }
  }
}
```

**Implementation approach**: Write `opencode.json` to the workspace root (or `.opencode/opencode.json`) before execution. This does not use a CLI flag (no `--mcp-config` equivalent). The file approach requires cleanup after execution to avoid polluting the project.

### 2.6 Tool Permissions

OpenCode uses a permissions model in its config file:

```json
{
  "permission": {
    "edit": "ask" | "allow",
    "bash": "ask" | "allow"
  }
}
```

Default behavior: **all operations are allowed without approval**. There are no granular `--allowedTools`/`--deniedTools` CLI flags. Tool permissions are config-file driven, similar to Codex's mode-based approach but with per-tool granularity.

**Implementation approach**: For `dangerouslyAllowAll` and `allowAll` modes, no permission config is needed (default behavior). For `custom` mode, write permission overrides into the `opencode.json` project config file.

### 2.7 Models

OpenCode models use `provider/model` format. Default recommended model: `anthropic/claude-sonnet-4-6`.

Top models available (from `opencode models` output):
- `anthropic/claude-sonnet-4-6` (recommended default — latest Anthropic)
- `anthropic/claude-opus-4-6`
- `anthropic/claude-haiku-4-5`
- `opencode/gpt-5.2-codex`
- `opencode/gpt-5`
- `opencode/claude-sonnet-4-6`
- `opencode/gemini-3-pro`

---

## 3. Files to Create

Create 5 files in `src/flightpath/cli/opencode/`:

### 3.1 `OpenCodeCliProvider.ts`

Main provider implementing `ICliProvider`. Key decisions:

- `config.name`: `"opencode"`
- `config.terminalName`: `"OpenCode"`
- `config.usesInteractiveNotificationMonitor`: `false` (no hook system)
- `config.shouldStreamHeadlessOutput`: `true`
- `buildHeadlessArgs()`: Returns `[...baseArgs, `"${prompt}"`]` (prompt last, like Codex)
- `buildInteractiveTuiCommand()`: `opencode [workspaceRoot]` (no prompt in TUI)
- `formatFileReference()`: Return path as-is (no `@` prefix; opencode uses `-f <file>` flag for file attachments)
- `getMcpConfigArgs()`: Writes `opencode.json` to `.flightpath/temp/opencode-mcp-{suffix}.json` and returns `null` — MCP config must be read from a project-level config file location (no CLI flag). This requires a different approach than Claude/Codex: write config to `.opencode/opencode.json` in the workspace root before execution. Return `[]` (no additional args needed) so `CliProviderUtils.buildMcpConfigBlock` proceeds, but the config file is written as a side effect.
- `checkAvailability()`: `execAsync("opencode --version")`
- `getVersion()`: Parse version from `opencode --version` output

**Session handling in `buildCliArgs()`**:
- Headless mode args: `["run", "--format", "json", "-m", model]`
- Session resume: `-s <sessionId>` when `sessionId` is provided
- No `-c` flag (global, not project-scoped)

### 3.2 `OpenCodeResponseParser.ts`

Implements `IResponseParser`. Parses JSONL output from `opencode run --format json`.

**Event type mapping**:
- `text` event → `CLI_EVENT_TYPES.TEXT` (from `part.text`)
- `tool_use` event with `part.tool === "bash"` → `CLI_EVENT_TYPES.BASH_COMMAND`
- `tool_use` event with `part.tool === "write"` or `"apply_patch"` → `CLI_EVENT_TYPES.FILE_WRITE` / `FILE_EDIT`
- `tool_use` event with `part.tool === "read"` → `CLI_EVENT_TYPES.FILE_READ`
- Other `tool_use` events → `CLI_EVENT_TYPES.TOOL_CALL`
- `step_finish` with `reason === "stop"` → end of response (not a user-visible event)

**Session ID extraction**: Read `sessionID` field from any event line (present on all events).

**Token usage**: Aggregated from all `step_finish` events:
- `tokens.input` → `inputTokens`
- `tokens.output` → `outputTokens`
- `tokens.cache.read` → `cachedInputTokens`
- `tokens.reasoning` → (note, not directly in `TokenUsage` but can be logged)

**`processStreamingChunk()`**: Parse incoming JSONL lines in real time. Buffer partial lines. Emit `CLI_EVENT_TYPES.TEXT` events for `text` type. Emit tool events for `tool_use`. Extract session ID.

**`extractSessionId()`**: Scan output for any line with `sessionID` field.

### 3.3 `OpenCodeNotificationMonitor.ts`

Implements `INotificationMonitor`. Since opencode has no hook system, this is a **stub implementation** that never signals completion via file notifications.

- `monitorForCompletion()`: Returns `{ completed: false, error: "opencode does not support notification-based completion" }` immediately (or just times out gracefully). The interactive mode will not use this in practice since `usesInteractiveNotificationMonitor: false`.
- `buildHookConfig()`: Returns a dummy config (never called with `usesInteractiveNotificationMonitor: false`)
- `getNotificationDirectory()`: Returns a path under `.flightpath/temp/opencode-notifications/` (unused but required by interface)
- `extractSessionId()`: Returns `data?.sessionId`

### 3.4 `OpenCodeToolPermissionMapper.ts`

Implements `IToolPermissionMapper`. OpenCode's permissions are config-file driven, not CLI-flag driven.

- `buildArgs()`: Always returns `[]` — no CLI flags for tool permissions
- `hasFullPermissions()`: Returns `true` for `dangerouslyAllowAll` and `allowAll` (default behavior allows all)
- Note the config-file permission approach: this will be handled as a side effect of `getMcpConfigArgs` writing the `opencode.json` config (which can also include `"permission"` settings)

### 3.5 `OpenCodeLogParser.ts`

Implements `ILogParser`. OpenCode may write log files, but log file parsing for interactive session ID discovery is low priority for initial implementation.

- Initial implementation: Return `undefined` for all session ID lookups (stub)
- Can be enhanced later if opencode writes discoverable log files

---

## 4. Changes to Existing Files

### 4.1 `src/types/FlightPathTypes.ts`

Add to `Harness` enum:
```typescript
OpenCodeCli = "opencode-cli", // OpenCode CLI
```

### 4.2 `src/types/DashboardConstants.ts`

```typescript
// In HARNESS_IDS:
OPENCODE_CLI: "opencode-cli",

// In HARNESS_INFO:
[HARNESS_IDS.OPENCODE_CLI]: { name: "OpenCode CLI", shortName: "OpenCode" },

// In DEFAULT_MODELS:
[HARNESS_IDS.OPENCODE_CLI]: "anthropic/claude-sonnet-4-6",

// Add new constant block:
export const OPENCODE_CLI_MODELS = [
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Anthropic)" },
  { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (Anthropic)" },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (Anthropic)" },
  { value: "opencode/gpt-5.2-codex", label: "GPT 5.2 Codex (OpenCode)" },
  { value: "opencode/gpt-5", label: "GPT 5 (OpenCode)" },
  { value: "opencode/gemini-3-pro", label: "Gemini 3 Pro (OpenCode)" },
] as const;
```

### 4.3 `src/flightpath/IntegrationFactory.ts`

```typescript
import { OpenCodeCliProvider } from "./cli/opencode/OpenCodeCliProvider";

// Add method:
createOpenCodeCli(registerWithContext: boolean = true): CliIntegration {
  const provider = new OpenCodeCliProvider();
  return new CliIntegration(provider, this.context, registerWithContext);
}

// Update createForHarness() switch:
case Harness.OpenCodeCli:
  return this.createOpenCodeCli(registerWithContext);
```

### 4.4 `src/utils/ConfigurationUtils.ts`

Add setting accessor:
```typescript
static getOpenCodeCliModel(): string {
  return ConfigurationUtils.get<string>("openCodeCliModel", "anthropic/claude-sonnet-4-6");
}
```

### 4.5 `src/utils/ModelConstants.ts`

Add opencode model constants (for the model dropdown and validation):
```typescript
export const OPENCODE_CLI_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-haiku-4-5",
  "opencode/gpt-5.2-codex",
  "opencode/gpt-5",
  "opencode/gemini-3-pro",
  // ... others from `opencode models` output
] as const;
```

### 4.6 `package.json`

In `contributes.configuration.properties`:
- Add `opencode-cli` to `flightpath.harness` enum + `enumDescriptions`
- Add `flightpath.openCodeCliModel` setting (string, default `"anthropic/claude-sonnet-4-6"`, enum from model list)

In `contributes.commands` / anywhere harness names appear as strings.

### 4.7 `schemas/prompt-schema.json`

Add `"opencode-cli"` to the `harness` field enum in the prompt schema.

---

## 5. MCP Integration — Design Decision

OpenCode does not support a `--mcp-config <file>` CLI flag. MCP servers are configured via a JSON config file that opencode reads at startup.

**Config file location opencode reads (in priority order)**:
1. `OPENCODE_CONFIG_CONTENT` env var (inline JSON string)
2. `opencode.json` in project root
3. `.opencode/opencode.json` in project root
4. `~/.config/opencode/opencode.json` (global)

**Recommended approach**: Use `OPENCODE_CONFIG_CONTENT` environment variable to inject the MCP config at process spawn time. This avoids writing/cleaning up files and prevents project pollution. The env var accepts a full JSON config string.

```typescript
// In OpenCodeCliProvider.getMcpConfigArgs():
// Returns null (no CLI args needed)
// But sets process environment via a new mechanism

// In OpenCodeCliProvider.buildCliArgs():
// Returns env var injection info instead of CLI args
```

> **Challenge**: The current `ICliProvider.getMcpConfigArgs()` only returns CLI argument arrays, not environment variables. Two options:
> 1. **(Simpler)** Write a temp `opencode.json` file to `.flightpath/temp/mcp-config-opencode-{suffix}.json` and pass its path via `OPENCODE_CONFIG` env var (opencode reads this env var as a custom config path)
> 2. **(Cleaner)** Use `OPENCODE_CONFIG_CONTENT` env var with the full JSON string

Option 1 is preferred because it follows the existing file-based pattern used by Claude's `--mcp-config`. The implementation would return `[]` from `getMcpConfigArgs()` but set an env var that gets passed to the process spawn. This requires a minor extension to the provider interface or a workaround via a new method.

**Simplest viable approach for initial implementation**: Since `getMcpConfigArgs()` only returns args, write a project-level `.opencode/opencode.json` before execution and clean it up after. Track the file path so it can be deleted in the finally block.

---

## 6. Completion Detection Strategy

### Headless Mode
Parse `step_finish` events with `reason === "stop"` from the JSONL stream. This is reliable and deterministic.

### Interactive Mode
No hook system available. `usesInteractiveNotificationMonitor: false` means `CliIntegration` will use its fallback: detect completion via terminal process exit. This is the same approach as the Copilot CLI (which also doesn't support a hook in all configurations).

---

## 7. Step-By-Step Implementation Checklist

### Phase 1: Core Provider (5 files in `src/flightpath/cli/opencode/`)
- [ ] Create `OpenCodeCliProvider.ts`
- [ ] Create `OpenCodeResponseParser.ts`
- [ ] Create `OpenCodeNotificationMonitor.ts` (stub)
- [ ] Create `OpenCodeToolPermissionMapper.ts`
- [ ] Create `OpenCodeLogParser.ts` (stub)

### Phase 2: Type System Updates
- [ ] `FlightPathTypes.ts` — Add `Harness.OpenCodeCli`
- [ ] `DashboardConstants.ts` — Add `HARNESS_IDS.OPENCODE_CLI`, `HARNESS_INFO`, `DEFAULT_MODELS`, `OPENCODE_CLI_MODELS`
- [ ] `ModelConstants.ts` — Add `OPENCODE_CLI_MODELS` array

### Phase 3: Integration Wiring
- [ ] `IntegrationFactory.ts` — Add `createOpenCodeCli()` + update `createForHarness()`
- [ ] `ConfigurationUtils.ts` — Add `getOpenCodeCliModel()`

### Phase 4: Settings + Schema
- [ ] `package.json` — Add `opencode-cli` to `harness` enum, add `openCodeCliModel` setting
- [ ] `schemas/prompt-schema.json` — Add `opencode-cli` to harness enum
- [ ] Run `npm run generate-schema` to regenerate YAML schema

### Phase 5: Webview UI (Dashboard)
- [ ] Update harness selector in React webview to include OpenCode CLI option
- [ ] Add model dropdown for opencode (if not already handled by generic model selector)

### Phase 6: Testing
- [ ] Unit test `OpenCodeResponseParser` — test all event types (step_start, text, tool_use, step_finish)
- [ ] Unit test session ID extraction
- [ ] Unit test token usage aggregation
- [ ] Unit test tool call mapping (bash → BASH_COMMAND, etc.)
- [ ] Manual testing: headless mode with `opencode run --format json`
- [ ] Manual testing: session resume with `-s <sessionId>`

---

## 8. Key Implementation Notes

### Session ID Extraction
Every JSONL line includes `sessionID`. Extract from the **first** event line rather than waiting for completion. This enables session resumption for the next prompt in a multi-step workflow.

### Model Validation
OpenCode models use `provider/model` format (e.g., `anthropic/claude-sonnet-4-6`). Unlike Claude (which has aliases like `sonnet`) or Codex (short names), opencode requires the full `provider/model` string. No alias resolution is needed — pass the model string directly.

### No `-c` Flag
Avoid using `-c` (continue most recent session). It's global across all projects and could accidentally resume a session from a different project. Only use `-s <sessionId>` with an explicit ID from workflow state.

### Token Usage Accumulation
Token costs are reported per-step (each `step_finish`). Aggregate across all steps to report totals. The final aggregated cost represents the full prompt-response cycle.

### File References
OpenCode uses `-f <file>` for file attachments, not inline `@` references. The `formatFileReference()` method should return the path as-is. File attachment via the `-f` flag is not currently implemented in the base `CliIntegration` flow, so initial implementation can omit file attachment support.

---

## 9. Open Questions / Future Work

1. **MCP integration**: The env-var approach (`OPENCODE_CONFIG_CONTENT`) is cleaner than file-based. Consider whether to extend `ICliProvider` with an `getSpawnEnv?()` method to support env-var injection.

2. **Interactive mode**: opencode's `serve` mode starts an HTTP server. A future enhancement could use the HTTP API (`opencode attach`) for richer interactive completion detection.

3. **Agent support**: OpenCode supports named agents via `--agent <name>`. These are configured in `opencode.json`. For initial implementation, use the existing `HarnessIntegration.buildPromptText()` agent injection (reads `.agent.md` file and injects as system prompt). Later, could support native opencode agents via an `agent` property mapping.

4. **Variant support**: OpenCode supports `--variant` for model-specific reasoning effort (e.g., `high`, `max`, `minimal`). This could be exposed as an optional setting.

5. **Model discovery**: Run `opencode models` programmatically to keep the model list current (similar to the `sync-models` workflow). The opencode model list changes frequently as new providers/models are added.
