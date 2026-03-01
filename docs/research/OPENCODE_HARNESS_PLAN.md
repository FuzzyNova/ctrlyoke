# OpenCode CLI Harness — Implementation Plan

**Last Updated**: 2026-03-01 (updated with plugin system research)
**opencode Version Researched**: 1.1.48
**Architecture**: Composition-Based (follows `docs/ADDING_NEW_CLI_PROVIDER.md`)

---

## 1. What Is OpenCode?

[OpenCode](https://opencode.ai) is a multi-provider AI coding assistant CLI built by the SST team. Unlike Claude Code or Codex (which are locked to a single AI provider), opencode is an **AI-agnostic terminal agent** that supports 50+ models across providers including Anthropic, OpenAI, Google, and its own hosted models.

**Key differentiators from existing harnesses:**

| Feature         | Claude CLI               | Codex CLI                  | OpenCode CLI                      |
| --------------- | ------------------------ | -------------------------- | --------------------------------- |
| Provider        | Anthropic only           | OpenAI only                | 50+ providers/models              |
| Output format   | stream-json (NDJSON)     | JSONL events               | JSONL events (`--format json`)    |
| Session resume  | `-r <sessionId>`         | `resume <id>`              | `-s <sessionId>`                  |
| Model format    | `claude-sonnet-4.5`      | `gpt-5.1-codex`            | `provider/model`                  |
| Completion hook | Stop hook (`--settings`) | notify hook (`--config`)   | Plugin system (`session.status` idle event) |
| MCP config      | `--mcp-config <file>`    | `-c 'mcp_servers...'` TOML | Project `opencode.json` file      |

---

## 2. OpenCode CLI Behavior Analysis

### 2.1 Headless Execution

Headless mode uses the `run` subcommand:

```bash
opencode run "your prompt here" --format json -m anthropic/claude-sonnet-4-6 -s <sessionId>
```

**Relevant flags:**

| Flag                | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `--format json`     | Emit JSONL events (one JSON object per line)                      |
| `-m provider/model` | Model in `provider/model` format                                  |
| `-s <sessionId>`    | Resume existing session                                           |
| `-c`                | Continue most recent session (avoid — global, not project-scoped) |
| `--agent <name>`    | Use a named agent (configured in opencode config)                 |
| `-f <file>`         | Attach file(s) to the message                                     |
| `--title <title>`   | Session title                                                     |

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
    "reason": "stop", // "stop" = complete, "tool-calls" = more steps follow
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

The TUI starts without a prompt. Unlike Claude/Codex which use process-level hooks (Stop hook, notify hook), opencode uses a **TypeScript plugin system** for extensibility. A workspace-level plugin in `.opencode/plugin/` is automatically loaded at opencode startup and can listen to lifecycle events including session completion.

**Strategy for interactive mode**: Deploy a FlightPath completion plugin to `.opencode/plugin/flightpath-completion-hook.js` in the workspace root before launching the TUI. The plugin listens for `session.status` idle events and writes a completion notification file. `OpenCodeNotificationMonitor` polls for this file exactly like `ClaudeNotificationMonitor` polls for Stop hook files.

See **Section 2.5** for the full plugin system details.

### 2.5 Plugin System (Completion Detection Mechanism)

OpenCode's plugin system is a TypeScript-first extensibility API more capable than Claude Code's hook system. Plugins are ES modules placed in `.opencode/plugin/` that export a `Plugin` function.

**Package**: `@opencode-ai/plugin` (provides TypeScript types)

**Plugin load locations** (both loaded automatically at startup):

| Scope   | Directory                        |
|---------|----------------------------------|
| Project | `.opencode/plugin/` in workspace root |
| Global  | `~/.config/opencode/plugin/`     |

**Relevant lifecycle events for completion detection:**

| Event Type        | Fires When                              | Key Properties                                                  |
|-------------------|-----------------------------------------|-----------------------------------------------------------------|
| `session.created` | New session starts                      | `event.properties.info.id`, `event.properties.info.parentID`   |
| `session.status`  | Session status transitions              | `event.properties.sessionID`, `event.properties.status.type`   |
| `session.deleted` | Session removed                         | `event.properties.info.id`                                      |

**Critical detail — child session filtering**: OpenCode supports multi-agent workflows where subagents create child sessions. `session.status` idle fires for every session including subagents. The plugin must track `parentID` from `session.created` to distinguish main sessions from subagents. Only fire the notification for sessions where `parentID` is null/absent.

**Why `session.status` over `session.idle`**:
- `session.idle` fires but exposes no `sessionID` in its properties — only `event.type`
- `session.status` with `status.type === "idle"` provides `event.properties.sessionID` enabling per-session disambiguation

**FlightPath completion hook plugin** (written to `.opencode/plugin/flightpath-completion-hook.js` before execution):

```javascript
// Auto-generated by FlightPath — do not edit
const { writeFileSync, mkdirSync } = require("fs");
const NOTIFY_DIR = "PLACEHOLDER_NOTIFY_DIR"; // replaced at runtime
const mainSessions = new Set();

exports.FlightPathHook = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const session = event.properties.info;
        if (!session.parentID) {
          mainSessions.add(session.id);
        }
      }
      if (event.type === "session.deleted") {
        mainSessions.delete(event.properties.info.id);
      }
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties;
        if (status.type === "idle" && mainSessions.has(sessionID)) {
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            writeFileSync(
              `${NOTIFY_DIR}/${sessionID}-done.json`,
              JSON.stringify({ sessionId: sessionID, timestamp: Date.now(), hookEvent: "idle" })
            );
          } catch (e) { /* ignore write errors */ }
        }
      }
    }
  };
};
```

**Important implementation details**:
- Plugin file is plain CommonJS `.js` (not TypeScript) — no compile step needed
- `NOTIFY_DIR` placeholder is replaced with the actual `.flightpath/temp/opencode-notifications/` path at plugin write time
- Plugin file is written to `.opencode/plugin/flightpath-completion-hook.js` before opencode starts, cleaned up in the `finally` block after execution
- The `.opencode/plugin/` directory is created if it doesn't exist

### 2.6 MCP Server Configuration

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

### 2.7 Tool Permissions

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

### 2.8 Models

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
- `config.usesInteractiveNotificationMonitor`: `true` (plugin-based idle detection)
- `config.shouldStreamHeadlessOutput`: `true`
- `buildHeadlessArgs()`: Returns `[...baseArgs, `"${prompt}"`]` (prompt last, like Codex)
- `buildInteractiveTuiCommand()`: `opencode [workspaceRoot]` (no prompt in TUI)
- `formatFileReference()`: Return path as-is (no `@` prefix; opencode uses `-f <file>` flag for file attachments)
- `getMcpConfigArgs()`: Writes `opencode.json` to `.opencode/opencode.json` in the workspace root (merging MCP config with any permission settings). Returns `[]` (no CLI args needed — opencode reads the config file automatically). Config file is written as a side effect and cleaned up in the `finally` block.
- `checkAvailability()`: `execAsync("opencode --version")`
- `getVersion()`: Parse version from `opencode --version` output

**Interactive mode plugin lifecycle** (in `buildCliArgs()` or a new `prepareExecution()` hook):

1. Write the FlightPath completion hook plugin to `.opencode/plugin/flightpath-completion-hook.js` (with the actual notify dir substituted)
2. Create the `.opencode/plugin/` directory if needed
3. Register the plugin file path for cleanup in the `finally` block

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

Implements `INotificationMonitor`. Uses the opencode plugin system for completion detection — analogous to `ClaudeNotificationMonitor` but using a written plugin file instead of a `--settings` hook config.

**`monitorForCompletion()`**: Polls `.flightpath/temp/opencode-notifications/` for `<sessionId>-done.json` files written by the FlightPath completion hook plugin. Logic mirrors `ClaudeNotificationMonitor`:
- If `sessionId` is known: poll for `<sessionId>-done.json`
- Wildcard mode (`sessionId = undefined`): scan for any `*-done.json` file newer than `startTime`
- Delete the file on detection
- Return `{ completed: true, data: { sessionId, hookEvent: "idle" } }`

**`buildHookConfig()`**: Returns the plugin file content as a string (type `"plugin-file"`). Called by `OpenCodeCliProvider` to get the content to write to `.opencode/plugin/flightpath-completion-hook.js`. The `scriptPath` parameter receives the notify directory path (not a script path — reused as the notify dir parameter).

**`getNotificationDirectory()`**: Returns `.flightpath/temp/opencode-notifications/` under `workspaceRoot`.

**`extractSessionId()`**: Returns `data?.sessionId` from the notification file content.

**`supportsSessionIdInFilename`**: `true` — files are named `<sessionId>-done.json`.

**No `waitForSessionStart()`** needed (session ID comes from the first JSONL event in headless mode; in interactive mode, it comes from the first `session.created` event via the plugin, which writes the `<sessionId>-done.json` only on idle, but the session ID can be read from that filename directly).

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
>
> 1. **(Simpler)** Write a temp `opencode.json` file to `.flightpath/temp/mcp-config-opencode-{suffix}.json` and pass its path via `OPENCODE_CONFIG` env var (opencode reads this env var as a custom config path)
> 2. **(Cleaner)** Use `OPENCODE_CONFIG_CONTENT` env var with the full JSON string

Option 1 is preferred because it follows the existing file-based pattern used by Claude's `--mcp-config`. The implementation would return `[]` from `getMcpConfigArgs()` but set an env var that gets passed to the process spawn. This requires a minor extension to the provider interface or a workaround via a new method.

**Simplest viable approach for initial implementation**: Since `getMcpConfigArgs()` only returns args, write a project-level `.opencode/opencode.json` before execution and clean it up after. Track the file path so it can be deleted in the finally block.

---

## 6. Completion Detection Strategy

### Headless Mode

Parse `step_finish` events with `reason === "stop"` from the JSONL stream. This is reliable and deterministic — no plugin needed for headless.

### Interactive Mode

Use the opencode plugin system. `usesInteractiveNotificationMonitor: true` enables the standard file-polling path in `CliIntegration`.

**Execution flow**:
1. Before launching the TUI: `OpenCodeCliProvider` writes `flightpath-completion-hook.js` to `.opencode/plugin/` with the workspace-specific notify directory path substituted in
2. User sees the opencode TUI and interacts with it
3. When the AI finishes responding (session goes idle), the plugin writes `<sessionId>-done.json` to the notify directory
4. `OpenCodeNotificationMonitor.monitorForCompletion()` detects the file and returns `{ completed: true }`
5. `CliIntegration` continues with end condition evaluation and next prompt dispatch
6. On workflow completion/cancellation, the plugin file is deleted from `.opencode/plugin/`

**Child session filtering** is critical: the plugin only fires for top-level sessions (no `parentID`), preventing false positives from agentic sub-tasks.

**Comparison with other harnesses**:

| Harness     | Mechanism                          | How Config Is Delivered         |
|-------------|------------------------------------|---------------------------------|
| Claude CLI  | Stop hook → writes `*-stop.json`   | `--settings` JSON flag          |
| Codex CLI   | Notify hook → writes file          | `--config` TOML inline flag     |
| OpenCode    | Plugin idle event → writes `*-done.json` | File written to `.opencode/plugin/` |

---

## 7. Step-By-Step Implementation Checklist

### Phase 1: Core Provider (5 files in `src/flightpath/cli/opencode/`)

- [ ] Create `OpenCodeCliProvider.ts`
- [ ] Create `OpenCodeResponseParser.ts`
- [ ] Create `OpenCodeNotificationMonitor.ts` (full implementation — plugin-based)
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
- [ ] Unit test `OpenCodeNotificationMonitor` — wildcard and session-specific file detection
- [ ] Unit test plugin file generation — verify notify dir substitution
- [ ] Manual testing: headless mode with `opencode run --format json`
- [ ] Manual testing: session resume with `-s <sessionId>`
- [ ] Manual testing: interactive mode — verify plugin writes done file and FlightPath advances

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

## 9. Key Implementation Notes (Additions)

### Plugin File Conflict Avoidance

The plugin filename `flightpath-completion-hook.js` in `.opencode/plugin/` must not collide with user-created plugins. This name is distinctive enough but should be documented in the FlightPath release notes as a reserved filename for opencode projects.

### Plugin Cleanup on Cancellation

The plugin file must be removed when:
- Workflow completes normally
- Workflow is cancelled by the user
- Workflow errors out

Use the same `finally` block pattern used for the `opencode.json` config file cleanup.

### `.opencode/` Directory in `.gitignore`

Recommend documenting that `.opencode/plugin/flightpath-completion-hook.js` and `.opencode/opencode.json` (when generated by FlightPath) should be added to `.gitignore`. FlightPath could add these entries automatically when it first creates the `.opencode/` directory in a workspace.

---

## 10. Open Questions / Future Work

1. **MCP integration**: The env-var approach (`OPENCODE_CONFIG_CONTENT`) is cleaner than file-based. Consider whether to extend `ICliProvider` with an `getSpawnEnv?()` method to support env-var injection.

2. **Session ID in interactive mode via plugin**: The plugin writes `<sessionId>-done.json` on idle, but we need the session ID _before_ idle to enable session resumption for the next prompt. Consider whether the plugin should also write a `<sessionId>-start.json` file on `session.created` (mirroring Claude's SessionStart hook) — this gives us the session ID as soon as the session starts, not only on completion.

3. **Agent support**: OpenCode supports named agents via `--agent <name>`. These are configured in `opencode.json`. For initial implementation, use the existing `HarnessIntegration.buildPromptText()` agent injection (reads `.agent.md` file and injects as system prompt). Later, could support native opencode agents via an `agent` property mapping.

4. **Variant support**: OpenCode supports `--variant` for model-specific reasoning effort (e.g., `high`, `max`, `minimal`). This could be exposed as an optional setting.

5. **Model discovery**: Run `opencode models` programmatically to keep the model list current (similar to the `sync-models` workflow). The opencode model list changes frequently as new providers/models are added.

6. **Plugin for session start detection**: Extend the completion hook plugin to also write `<sessionId>-start.json` on `session.created` (for non-parentID sessions). This enables `waitForSessionStart()` in `OpenCodeNotificationMonitor`, paralleling the Claude implementation and giving FlightPath the session ID immediately rather than waiting for completion.
