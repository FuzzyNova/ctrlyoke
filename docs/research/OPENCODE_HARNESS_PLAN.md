# OpenCode CLI Harness — Implementation Plan

**Last Updated**: 2026-03-05 (fully researched — Phase 0 complete, ready to implement)
**opencode Version Researched**: 1.1.48
**Architecture**: Composition-Based (follows `docs/ADDING_NEW_CLI_PROVIDER.md`)
**Research Status**: All CLI flags and output formats verified via live `opencode --help`, `opencode run --help`, and live headless run.

---

## 1. What Is OpenCode?

[OpenCode](https://opencode.ai) is a multi-provider AI coding assistant CLI built by the SST team. Unlike Claude Code or Codex (which are locked to a single AI provider), opencode is an **AI-agnostic terminal agent** that supports 50+ models across providers including Anthropic, OpenAI, Google, and its own hosted models.

**Key differentiators from existing harnesses:**

| Feature         | Claude CLI               | Codex CLI                  | OpenCode CLI                                |
| --------------- | ------------------------ | -------------------------- | ------------------------------------------- |
| Provider        | Anthropic only           | OpenAI only                | 50+ providers/models                        |
| Output format   | stream-json (NDJSON)     | JSONL events               | JSONL events (`--format json`)              |
| Session resume  | `-r <sessionId>`         | `resume <id>`              | `-s <sessionId>`                            |
| Model format    | `claude-sonnet-4.5`      | `gpt-5.1-codex`            | `provider/model`                            |
| Completion hook | Stop hook (`--settings`) | notify hook (`--config`)   | Plugin system (`session.status` idle event) |
| MCP config      | `--mcp-config <file>`    | `-c 'mcp_servers...'` TOML | Project `opencode.json` file                |

---

## 2. OpenCode CLI Behavior Analysis

### 2.1 Headless Execution

Headless mode uses the `run` subcommand:

```bash
opencode run "your prompt here" --format json -m anthropic/claude-sonnet-4-6 [-s <sessionId>]
```

Note: `--format json` produces JSONL output and suppresses the TUI. There is no `--no-color` flag — it is not needed with `--format json`.

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
  "timestamp": 1772730525497,
  "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
  "part": {
    "id": "prt_cbef92738001sO9Yz5gBFDRdjA",
    "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
    "messageID": "msg_cbef92216001pTz2rRXHAS4mF5",
    "type": "step-start",
    "snapshot": "6c687ca9183ebc6a3056f158e336920a4ecacfc2"
  }
}
```

**`text`** — AI text response

```json
{
  "type": "text",
  "timestamp": 1772730526195,
  "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
  "part": {
    "id": "prt_cbef927390016biJfWiecUZpbp",
    "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
    "messageID": "msg_cbef92216001pTz2rRXHAS4mF5",
    "type": "text",
    "text": "Hello! 👋",
    "time": { "start": 1772730526194, "end": 1772730526194 }
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
    "id": "prt_...",
    "sessionID": "ses_...",
    "messageID": "msg_...",
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
  "timestamp": 1772730526285,
  "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
  "part": {
    "id": "prt_cbef92a03001QUrYmYIYouANFl",
    "sessionID": "ses_34106de37ffeG7oh0Bvq9cmRki",
    "messageID": "msg_cbef92216001pTz2rRXHAS4mF5",
    "type": "step-finish",
    "reason": "stop", // "stop" = complete, "tool-calls" = more steps follow
    "snapshot": "6c687ca9183ebc6a3056f158e336920a4ecacfc2",
    "cost": 0.01560475,
    "tokens": {
      "total": 14050,
      "input": 1,
      "output": 96,
      "reasoning": 0,
      "cache": { "read": 0, "write": 13953 }
    }
  }
}
```

**Note on `part` fields**: Every `part` object contains `id`, `sessionID`, and `messageID` fields in addition to the type-specific fields. The `step_finish` `tokens` object includes a `total` field (sum of all tokens) alongside `input`, `output`, `reasoning`, and `cache`.

**Completion signal**: `step_finish` with `part.reason === "stop"`.

**Session ID**: Extracted from `sessionID` field on any event line. Format: `ses_<alphanumeric>` (e.g., `ses_34106de37ffeG7oh0Bvq9cmRki`). Also present inside `part.sessionID` and `part.messageID` but reading the top-level field is simplest.

### 2.3 Session Management

- Session IDs format: `ses_355b84d3cffeU1eFE2d5lzBROE` (prefix `ses_` followed by alphanumeric)
- Resume with: `-s <sessionId>` in the `run` subcommand
- Avoid `-c` (global "continue last" — not project-scoped)
- No auto-resume on new sessions (no `-c` unless explicitly requested)

### 2.4 Interactive TUI Mode

```bash
opencode --prompt "your prompt" [flags...]
```

All CLI harnesses in FlightPath use `buildInteractiveTuiCommand()` to embed the prompt directly in the launch command — no `terminal.sendText()` is used. For opencode, the prompt is passed via the `--prompt` flag (verified via `opencode --help`). The top-level `opencode` command (TUI mode) accepts: `-m/--model`, `-s/--session`, `-c/--continue`, `--fork`, `--prompt`, `--agent`.

Unlike Claude/Codex which use process-level hooks (Stop hook, notify hook), opencode uses a **TypeScript plugin system** for extensibility. A workspace-level plugin in `.opencode/plugin/` is automatically loaded at opencode startup and can listen to lifecycle events including session completion.

**Strategy for interactive mode**: Deploy a FlightPath completion plugin to `.opencode/plugin/flightpath-completion-hook.js` in the workspace root before launching the TUI. The plugin listens for `session.status` idle events and writes a completion notification file. `OpenCodeNotificationMonitor` polls for this file exactly like `ClaudeNotificationMonitor` polls for Stop hook files.

See **Section 2.5** for the full plugin system details.

### 2.5 Plugin System (Completion Detection Mechanism)

OpenCode's plugin system is a TypeScript-first extensibility API more capable than Claude Code's hook system. Plugins are ES modules placed in `.opencode/plugin/` that export a `Plugin` function.

**Package**: `@opencode-ai/plugin` (provides TypeScript types)

**Plugin load locations** (both loaded automatically at startup):

| Scope   | Directory                             |
| ------- | ------------------------------------- |
| Project | `.opencode/plugin/` in workspace root |
| Global  | `~/.config/opencode/plugin/`          |

**Relevant lifecycle events for completion detection:**

| Event Type        | Fires When                 | Key Properties                                               |
| ----------------- | -------------------------- | ------------------------------------------------------------ |
| `session.created` | New session starts         | `event.properties.info.id`, `event.properties.info.parentID` |
| `session.status`  | Session status transitions | `event.properties.sessionID`, `event.properties.status.type` |
| `session.deleted` | Session removed            | `event.properties.info.id`                                   |

**Critical detail — child session filtering**: OpenCode supports multi-agent workflows where subagents create child sessions. `session.status` idle fires for every session including subagents. The plugin must track `parentID` from `session.created` to distinguish main sessions from subagents. Only fire the notification for sessions where `parentID` is null/absent.

**Why `session.status` over `session.idle`**:

- `session.idle` fires but exposes no `sessionID` in its properties — only `event.type`
- `session.status` with `status.type === "idle"` provides `event.properties.sessionID` enabling per-session disambiguation

**FlightPath completion hook plugin** (written to `.opencode/plugin/flightpath-completion-hook.js` before execution):

The plugin writes **two** files per session, matching the standardized two-file notification format used by Claude and Copilot harnesses (`{sessionId}-start.json` + `{sessionId}-stop.json`). This allows `OpenCodeNotificationMonitor` to extend `NotificationMonitorBase` and reuse all its monitoring logic without overriding `monitorForCompletion()` or `waitForSessionStart()`.

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
          // Write SessionStart file — enables waitForSessionStart() and early session ID capture
          try {
            mkdirSync(NOTIFY_DIR, { recursive: true });
            writeFileSync(
              `${NOTIFY_DIR}/${session.id}-start.json`,
              JSON.stringify({
                hookEvent: "SessionStart",
                sessionId: session.id,
                status: "started",
                timestamp: Date.now(),
              })
            );
          } catch (e) {
            /* ignore write errors */
          }
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
            // Write Stop file matching the standardized format used by Claude/Copilot
            writeFileSync(
              `${NOTIFY_DIR}/${sessionID}-stop.json`,
              JSON.stringify({
                hookEvent: "Stop",
                sessionId: sessionID,
                status: "completed",
                timestamp: Date.now(),
              })
            );
          } catch (e) {
            /* ignore write errors */
          }
        }
      }
    },
  };
};
```

**Important implementation details**:

- Plugin file is plain CommonJS `.js` (not TypeScript) — no compile step needed
- `NOTIFY_DIR` placeholder is replaced with the actual `.flightpath/temp/opencode-notifications/` path at plugin write time
- Plugin file is written to `.opencode/plugin/flightpath-completion-hook.js` before opencode starts, cleaned up via `getAdditionalCleanupFilePaths()` after execution
- The `.opencode/plugin/` directory is created if it doesn't exist
- Using `*-stop.json` + `*-start.json` naming (not `*-done.json`) lets `OpenCodeNotificationMonitor` inherit `NotificationMonitorBase` unchanged

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

OpenCode models use `provider/model` format. Unlike Claude or Codex (fixed provider model lists), every user's available model list is different — it depends on which API keys and providers they have configured in opencode. There are 90+ models across providers including `anthropic/`, `openai/`, `google/`, `opencode/` (hosted proxy), and many others.

**Runtime model discovery via `opencode models`**:

```bash
opencode models
# Output: one model ID per line, e.g.:
# opencode/claude-sonnet-4-6
# anthropic/claude-sonnet-4-6
# anthropic/claude-haiku-4-5
# opencode/gpt-5
# ...
```

Key properties of the command:
- Plain text output, one `provider/model` string per line (trivial to parse — no JSON flag needed)
- `opencode models <provider>` filters by provider (e.g., `opencode models anthropic`)
- `--verbose` flag adds cost metadata
- `--refresh` forces a cache refresh from models.dev
- Fast (uses a local cache); suitable for calling at harness initialization time

**Strategy — runtime discovery + fallback (same pattern as Copilot CLI)**:

Do NOT hardcode a model list. Instead, call `opencode models` at runtime (during `checkAvailability()` or on first use) and cache the result. Fall back to a minimal hardcoded list only if the command fails.

**Default model selection**: Since every user has different models, the default should be `anthropic/claude-sonnet-4-6` (widely available if the user has an Anthropic API key) but the UI should strongly encourage users to pick from their discovered list. The settings default is a hint, not a guarantee — validate against discovered models and warn if the configured model is not in the list.

**Fallback model list** (used only if `opencode models` fails):

```typescript
export const OPENCODE_CLI_FALLBACK_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "opencode/claude-sonnet-4-6",
] as const;
```

**`OpenCodeCliProvider` model discovery method**:

```typescript
async getAvailableModels(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("opencode models", { timeout: 5000 });
    return stdout.split("\n").map(l => l.trim()).filter(Boolean);
  } catch {
    return [...OPENCODE_CLI_FALLBACK_MODELS];
  }
}
```

This method is NOT part of `ICliProvider` — it is an opencode-specific public method called by `ModelRegistry` (or an equivalent opencode model registry utility) at harness initialization time. The discovered list is cached and exposed to the webview for the model dropdown, replacing any static enum in `package.json`.

---

## 3. Files to Create

Create 5 files in `src/flightpath/harness/opencode/`:

> **NOTE**: The correct directory is `src/flightpath/harness/opencode/` — this is where all other providers live (`claude/`, `codex/`, `copilot/`). Earlier drafts of this plan incorrectly used `src/flightpath/cli/opencode/`.

### 3.1 `OpenCodeCliProvider.ts`

Main provider implementing `ICliProvider`. Key decisions:

- `config.name`: `"opencode"`
- `config.terminalName`: `"OpenCode"`
- `config.usesInteractiveNotificationMonitor`: `true` (plugin-based idle detection)
- `config.shouldStreamHeadlessOutput`: `true`
- `buildHeadlessArgs()`: Returns `[...baseArgs, prompt]` — prompt as trailing positional arg(s) to `opencode run` (same as Codex). Full invocation: `opencode run "prompt" --format json -m model [-s sessionId]`
- `buildInteractiveTuiCommand()`: `opencode --prompt "${promptText}" ${baseArgs.join(" ")}` — prompt via `--prompt` flag (verified via `opencode --help`). Full invocation: `opencode --prompt "prompt" -m model [-s sessionId]`
- `formatFileReference()`: Return path as-is (no `@` prefix). OpenCode's inline `@` support is unconfirmed; the `-f <file>` flag (`opencode run -f <file>`) is the documented attachment method but is not used by the base `CliIntegration` adaptive prompt passing flow. See **Section 8 — Complex Prompt Handling**.
- `getMcpConfigArgs()`: Writes `.opencode/opencode.json` in the workspace root. Returns `[]` (config file is auto-detected by opencode; no CLI arg needed). The written path is returned by `getMcpConfigFilePath()` so `CliIntegration.cleanupWorkflowArtifacts()` deletes it after the workflow.
- `getMcpConfigFilePath()`: Returns the `.opencode/opencode.json` path so `CliIntegration` can delete it in the `cleanupWorkflowArtifacts()` finally block.
- `getAdditionalCleanupFilePaths(workspaceRoot)`: Returns `[pluginFilePath]` — the path to the written `.opencode/plugin/flightpath-completion-hook.js`. This method is a new optional method to add to `ICliProvider` (see Section 4.8 below).
- `checkAvailability()`: `execAsync("opencode --version")`
- `getVersion()`: Parse version from `opencode --version` output

**Interactive mode plugin lifecycle** (inside `buildCliArgs()` when `isInteractive === true`):

1. Get the plugin content string from `this.notificationMonitor.buildHookConfig(...)` — returns `type: "none"` since hookConfig is handled out-of-band
2. Call `(this.notificationMonitor as OpenCodeNotificationMonitor).getPluginContent(notifyDir)` to get the plugin JS content
3. Write it to `.opencode/plugin/flightpath-completion-hook.js` (creating the directory if needed)
4. The plugin path is tracked on `this` for `getAdditionalCleanupFilePaths()`

**Session handling in `buildCliArgs()`**:

- Headless mode args: `["run", "--format", "json", "-m", model]` + optional `["-s", sessionId]`
- Interactive mode args: `["--prompt", promptText, "-m", model]` + optional `["-s", sessionId]`
- Session resume: `-s <sessionId>` when `sessionId` is provided (both modes)
- No `-c` flag (global, not project-scoped — would resume a session from any project)
- `--variant` is available for headless mode only (`opencode run --variant high`) — add to headless args when configured
- `--agent` is available in both modes

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

Extends `NotificationMonitorBase` and implements `INotificationMonitor` — exactly like `ClaudeNotificationMonitor`. Because the plugin writes `{sessionId}-start.json` and `{sessionId}-stop.json` in the standardized format, the entire `monitorForCompletion()`, `waitForSessionStart()`, `cleanupNotificationFiles()`, and `extractSessionId()` implementations are **inherited for free** from `NotificationMonitorBase`.

Only two methods need to be implemented by `OpenCodeNotificationMonitor`:

**`buildHookConfig()`**: Returns `{ type: "none" }`. Plugin file management is handled as a side effect inside `OpenCodeCliProvider.buildCliArgs()` (writing the file when `isInteractive === true`) — not via the `buildHookConfig()` mechanism used by Claude/Codex. The hook config mechanism exists for providers that pass hook configs as CLI args; opencode uses a file it discovers at startup instead.

**`getNotificationDirectory()`**: Returns `path.join(workspaceRoot, ".flightpath", "temp", "opencode-notifications")`.

**Additional method** (not part of `INotificationMonitor` — called directly by `OpenCodeCliProvider`):

**`getPluginContent(notifyDir: string): string`**: Returns the plugin JS source with `NOTIFY_DIR` replaced by `notifyDir`. This is the string `OpenCodeCliProvider.buildCliArgs()` writes to `.opencode/plugin/flightpath-completion-hook.js`.

**`supportsSessionIdInFilename`**: `true` — files are named `{sessionId}-stop.json`.

**`waitForSessionStart()`**: Inherited from `NotificationMonitorBase` — waits for `{sessionId}-start.json` written by the plugin on `session.created`. Gives FlightPath the session ID immediately when the session begins, long before response completion. This is critical for multi-prompt workflows with `resumeSession: true`.

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
```

No static `OPENCODE_CLI_MODELS` array in `DashboardConstants` — models are discovered at runtime via `opencode models` and passed to the webview dynamically (same as Copilot CLI models). The default `"anthropic/claude-sonnet-4-6"` is used as a hint; the webview dropdown is populated from the runtime list.

### 4.3 `src/flightpath/IntegrationFactory.ts`

```typescript
import { OpenCodeCliProvider } from "./harness/opencode/OpenCodeCliProvider";

// Add method:
createOpenCodeCli(registerWithContext: boolean = true): CliIntegration {
  const provider = new OpenCodeCliProvider();
  return new CliIntegration(provider, this.platform, registerWithContext);
}

// Update createForHarness() switch — add before the default case:
case Harness.OpenCodeCli:
  return this.createOpenCodeCli(registerWithContext);
```

### 4.4 `src/utils/ConfigurationUtils.ts`

Add setting accessor (as a method on the exported object, matching the pattern used by `getClaudeCliModel()` and `getCodexCliModel()`):

```typescript
// In the OPENCODE CLI SETTINGS section:
getOpenCodeCliModel(): string {
  return getConfig().get<string>("openCodeCliModel", "anthropic/claude-sonnet-4-6");
},
```

Also update `getModelForHarness()` — this switch is missing an `OpenCodeCli` case and will silently fall through to the Copilot CLI model otherwise:

```typescript
case Harness.OpenCodeCli:
  return ConfigurationUtils.getOpenCodeCliModel();
```

### 4.5 `src/utils/ModelConstants.ts`

Add a fallback-only model list. Unlike Copilot/Claude/Codex which have static lists, opencode's full list comes from `opencode models` at runtime. `ModelConstants` only holds the fallback used when the CLI is unavailable:

```typescript
// Fallback only — runtime list comes from `opencode models`
export const OPENCODE_CLI_FALLBACK_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "opencode/claude-sonnet-4-6",
] as const;
```

**Do not** add `OPENCODE_CLI_MODELS` as a full static list — the `sync-models` script workflow does not apply to opencode since the model list is user-specific and changes without a new opencode release.

### 4.6 `package.json`

In `contributes.configuration.properties`:

- Add `opencode-cli` to `flightpath.harness` enum + `enumDescriptions`
- Add `flightpath.openCodeCliModel` setting as a **free-form string** (no `enum` — models are user-specific and discovered at runtime): `{ "type": "string", "default": "anthropic/claude-sonnet-4-6", "description": "Model for OpenCode CLI in provider/model format (e.g. anthropic/claude-sonnet-4-6). Run 'opencode models' to see available models." }`

Do NOT add an `enum` array to `flightpath.openCodeCliModel` in `package.json` — unlike other harnesses, the valid model list varies per user and is populated dynamically in the webview dropdown.

In `contributes.commands` / anywhere harness names appear as strings.

### 4.7 `schemas/prompt-schema.json`

Add `"opencode-cli"` to the `harness` field enum in the prompt schema.

### 4.8 `src/flightpath/harness/shared/interfaces/ICliProvider.ts`

Add a new optional method to support providers that write files for interactive setup (distinct from the MCP config file tracked by `getMcpConfigFilePath()`):

```typescript
/**
 * Return additional file paths to delete after workflow cleanup.
 *
 * Used by providers that write interactive-mode setup files that are
 * not covered by getMcpConfigFilePath() (e.g., OpenCode plugin file).
 * CliIntegration.cleanupWorkflowArtifacts() deletes all returned paths.
 *
 * @param workspaceRoot Workspace root directory
 * @returns Array of absolute file paths to delete (empty array = nothing to clean up)
 */
getAdditionalCleanupFilePaths?(workspaceRoot: string): string[];
```

Update `CliIntegration.cleanupWorkflowArtifacts()` to also call this:

```typescript
override async cleanupWorkflowArtifacts(
  workingFilePath: string | undefined,
  workspaceRoot: string
): Promise<void> {
  const configPath = this.provider.getMcpConfigFilePath?.(
    workingFilePath,
    workspaceRoot
  );
  if (configPath) {
    await fs.promises.unlink(configPath).catch(() => {});
  }
  // Clean up provider-specific interactive setup files (e.g., OpenCode plugin)
  const additionalPaths = this.provider.getAdditionalCleanupFilePaths?.(workspaceRoot) ?? [];
  for (const p of additionalPaths) {
    await fs.promises.unlink(p).catch(() => {});
  }
}
```

### 4.9 `src/flightpath/WorkflowOrchestrator.ts`

This file has **5 touch points** that must all be updated — it was missing from the original plan entirely:

1. **Field declaration** (alongside the other four integration fields):

```typescript
private readonly openCodeCliIntegration: CliIntegration;
```

2. **Constructor initialization** (in the "Create the four shared harness integrations" block):

```typescript
this.openCodeCliIntegration = this.integrationFactory.createOpenCodeCli();
```

3. **`allIntegrations` wiring array** (harness status subscriptions):

```typescript
[HARNESS_IDS.OPENCODE_CLI, this.openCodeCliIntegration],
```

4. **`resolveDetectorIntegration()` switch**:

```typescript
case Harness.OpenCodeCli:
  return this.openCodeCliIntegration;
```

5. **`propagateWorkflowNameToIntegrations()`**:

```typescript
this.openCodeCliIntegration.setWorkflowName(name);
```

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
3. When the AI finishes responding (session goes idle), the plugin writes `<sessionId>-stop.json` to the notify directory
4. `OpenCodeNotificationMonitor.monitorForCompletion()` detects the file (via inherited `NotificationMonitorBase` logic) and returns `{ completed: true }`
5. `CliIntegration` continues with end condition evaluation and next prompt dispatch
6. On workflow completion/cancellation, the plugin file is deleted from `.opencode/plugin/`

**Child session filtering** is critical: the plugin only fires for top-level sessions (no `parentID`), preventing false positives from agentic sub-tasks.

**Comparison with other harnesses**:

| Harness     | Mechanism                           | How Config Is Delivered             | Notification File                    |
| ----------- | ----------------------------------- | ----------------------------------- | ------------------------------------ |
| Claude CLI  | Stop hook → writes `*-stop.json`    | `--settings` JSON flag              | `{id}-start.json` + `{id}-stop.json` |
| Codex CLI   | Notify hook → writes file           | `--config` TOML inline flag         | `notify-{id}.json`                   |
| Copilot CLI | Session hook → writes `*-stop.json` | Log file monitoring                 | `{id}-start.json` + `{id}-stop.json` |
| OpenCode    | Plugin idle → writes `*-stop.json`  | File written to `.opencode/plugin/` | `{id}-start.json` + `{id}-stop.json` |

---

## 7. Step-By-Step Implementation Checklist

### Phase 0: Pre-Implementation Research (Complete ✅)

- [x] Run `opencode --help` and `opencode run --help` — all flags confirmed (2026-03-05)
- [x] Interactive TUI prompt syntax — uses `--prompt` flag: `opencode --prompt "prompt" -m model [-s sessionId]`. NOT a positional arg.
- [x] Headless output format — confirmed via live run: `opencode run "hello" --format json` emits JSONL with `step_start`, `text`, `step_finish` events. No `--no-color` flag exists (not needed with `--format json`).
- [x] Session ID format — confirmed: `ses_<alphanumeric>` (e.g., `ses_34106de37ffeG7oh0Bvq9cmRki`)
- [ ] `@path` file references in prompt text — **not yet tested**. Low priority for MVP; document as known gap (see Section 8).

### Phase 1: Interface Extension

- [ ] `ICliProvider.ts` — Add optional `getAdditionalCleanupFilePaths?(workspaceRoot: string): string[]`
- [ ] `CliIntegration.ts` — Update `cleanupWorkflowArtifacts()` to call `getAdditionalCleanupFilePaths()`

### Phase 2: Core Provider (5 files in `src/flightpath/harness/opencode/`)

- [ ] Create `OpenCodeCliProvider.ts`
- [ ] Create `OpenCodeResponseParser.ts`
- [ ] Create `OpenCodeNotificationMonitor.ts` (extends `NotificationMonitorBase`; implements `buildHookConfig()` → `none`, `getNotificationDirectory()`, `getPluginContent()`)
- [ ] Create `OpenCodeToolPermissionMapper.ts`
- [ ] Create `OpenCodeLogParser.ts` (stub — implements `ILogParser`)

### Phase 3: Type System Updates

- [ ] `FlightPathTypes.ts` — Add `Harness.OpenCodeCli = "opencode-cli"`
- [ ] `DashboardConstants.ts` — Add `HARNESS_IDS.OPENCODE_CLI`, entry in `HARNESS_INFO`, entry in `DEFAULT_MODELS`, and `OPENCODE_CLI_MODELS` array (as `{ value, label }` objects for UI)
- [ ] `ModelConstants.ts` — Add `OPENCODE_CLI_MODELS` as flat string array (for validation/`sync-models`). Note: dual-location like `CODEX_CLI_MODELS` is intentional — `DashboardConstants` has display labels, `ModelConstants` has raw IDs.

### Phase 4: Integration Wiring

- [ ] `IntegrationFactory.ts` — Add `createOpenCodeCli()` + add case to `createForHarness()`
- [ ] `ConfigurationUtils.ts` — Add `getOpenCodeCliModel()` + add `Harness.OpenCodeCli` case to `getModelForHarness()`
- [ ] `WorkflowOrchestrator.ts` — 5 touch points: field, constructor, allIntegrations array, `resolveDetectorIntegration()` switch, `propagateWorkflowNameToIntegrations()`

### Phase 5: Settings + Schema

- [ ] `package.json` — Add `opencode-cli` to `flightpath.harness` enum + description; add `flightpath.openCodeCliModel` as a free-form string setting (no `enum` — model list is user-specific and runtime-discovered)
- [ ] `schemas/prompt-schema.json` — Add `"opencode-cli"` to the `harness` enum
- [ ] Run `npm run generate-schema` to regenerate YAML schema
- [ ] **Note**: Do NOT run `sync-models` for opencode — the model list is user-specific and comes from `opencode models` at runtime

### Phase 6: Webview UI (Dashboard)

- [ ] Update harness selector in React webview to include OpenCode CLI option
- [ ] Add model dropdown for opencode (if not already handled by generic model selector)

### Phase 7: Testing

- [ ] Unit test `OpenCodeResponseParser` — test all event types (step_start, text, tool_use, step_finish)
- [ ] Unit test session ID extraction from first JSONL event
- [ ] Unit test token usage aggregation across multiple `step_finish` events
- [ ] Unit test tool call mapping (bash → BASH_COMMAND, write → FILE_WRITE, read → FILE_READ, etc.)
- [ ] Unit test `OpenCodeNotificationMonitor` — wildcard and session-specific file detection
- [ ] Unit test `getPluginContent()` — verify notify dir substitution replaces `PLACEHOLDER_NOTIFY_DIR`
- [ ] Unit test plugin writes correct `*-start.json` + `*-stop.json` format (manual)
- [ ] Manual testing: headless mode with `opencode run --format json`
- [ ] Manual testing: session resume with `-s <sessionId>` across two prompts
- [ ] Manual testing: interactive mode — verify plugin writes stop file and FlightPath advances
- [ ] Manual testing: plugin cleanup — verify `.opencode/plugin/flightpath-completion-hook.js` is deleted on workflow end

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

### Complex Prompt Handling (>300 chars)

FlightPath's adaptive prompt passing writes complex prompts to a temp file and calls `formatFileReference()` to format the path. The resulting instruction ("Follow instructions in {ref}") is then embedded in the CLI command.

For opencode, `formatFileReference()` returns the path as-is (no `@` prefix). Whether opencode resolves inline file references in the prompt text is **unconfirmed** — opencode uses `-f <file>` as the documented file attachment mechanism.

**Risk**: If opencode doesn't read inline file references, complex prompts will fail silently (the AI will see the instruction text but not the file contents).

**Mitigation options** (not yet verified for opencode):

- If `opencode --prompt "Follow instructions in path/to/file.md"` works → no change needed
- If `-f` is required → for headless: `opencode run -f "{file}" "Follow instructions in the attached file"`; for interactive: `opencode --prompt "Follow instructions in the attached file" -f "{file}"`. Note: `-f` is only documented for `opencode run`, not the TUI mode — this may be a headless-only option.

For MVP, track this as a known gap and document it in test results.

---

## 9. Key Implementation Notes (Additions)

### Plugin File Conflict Avoidance

The plugin filename `flightpath-completion-hook.js` in `.opencode/plugin/` must not collide with user-created plugins. This name is distinctive enough but should be documented in the FlightPath release notes as a reserved filename for opencode projects.

### Plugin Cleanup on Cancellation

The plugin file (`.opencode/plugin/flightpath-completion-hook.js`) must be removed when:

- Workflow completes normally
- Workflow is cancelled by the user
- Workflow errors out

`OpenCodeCliProvider` implements `getAdditionalCleanupFilePaths(workspaceRoot)` returning the plugin file path. `CliIntegration.cleanupWorkflowArtifacts()` (via the new extension in Section 4.8) deletes it in the `finally` block alongside the MCP config file.

### `.opencode/` Directory in `.gitignore`

Recommend documenting that `.opencode/plugin/flightpath-completion-hook.js` and `.opencode/opencode.json` (when generated by FlightPath) should be added to `.gitignore`. FlightPath could add these entries automatically when it first creates the `.opencode/` directory in a workspace.

---

## 10. Open Questions / Future Work

1. **MCP integration via env var**: The `OPENCODE_CONFIG_CONTENT` env var approach is cleaner than file-based (no cleanup needed, no project pollution). Consider extending `ICliProvider` with `getSpawnEnv?(workspaceRoot, workingFilePath): NodeJS.ProcessEnv` to support env-var-based config injection. For initial implementation, use the file-based `.opencode/opencode.json` approach (already handled via `getMcpConfigFilePath()`).

2. **Session ID in interactive mode — already resolved**: The plugin now writes `{sessionId}-start.json` on `session.created`, enabling `waitForSessionStart()` inherited from `NotificationMonitorBase`. This gives FlightPath the session ID immediately at session start, not waiting for completion. ✅

3. **Agent support**: OpenCode supports named agents via `--agent <name>`. These are configured in `opencode.json`. For initial implementation, use the existing `HarnessIntegration.buildPromptText()` agent injection (reads `.agent.md` file and injects as system prompt). Later, could support native opencode agents via an `agent` property mapping.

4. **Variant support**: OpenCode supports `--variant` for model-specific reasoning effort (e.g., `high`, `max`, `minimal`). This could be exposed as an optional `flightpath.openCodeVariant` setting.

5. ~~**Model discovery via sync-models**~~ — **Resolved ✅**: `opencode models` outputs one `provider/model` per line (no `--json` flag needed). The `sync-models` workflow does NOT apply — models are user-specific and discovered at runtime. See Section 2.8 for the full runtime discovery strategy. The webview model dropdown is populated from a live `opencode models` call (cached), not from a static list in `ModelConstants`.

6. ~~**Interactive mode initial prompt syntax**~~ — **Resolved ✅**: `opencode --prompt "prompt" -m model [-s sessionId]`. The `--prompt` flag (not a positional arg) is the correct syntax, confirmed via `opencode --help`.
