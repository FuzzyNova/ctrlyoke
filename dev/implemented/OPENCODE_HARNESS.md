# OpenCode CLI Harness — Reference

**Status**: Implemented ✅
**Implemented**: 2026-03-07
**opencode Version Researched**: 1.1.48
**Architecture**: Composition-Based

Source: `src/flightpath/harness/opencode/`

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
