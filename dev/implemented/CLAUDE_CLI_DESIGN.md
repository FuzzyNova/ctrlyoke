# Claude Code CLI Integration Design

This document details FlightPath's integration with the Claude Code CLI (Anthropic), including all available options, implementation status, and how settings are shared with Copilot CLI.

## Overview

FlightPath supports Claude Code CLI (`claude`) as an alternative AI provider to GitHub Copilot. Claude CLI provides deterministic completion detection, structured JSON output, and model selection (sonnet, opus, haiku).

**Key files:**

- `src/flightpath/harness/claude/ClaudeCliProvider.ts` — Main provider (CLI args, session management, MCP config)
- `src/flightpath/harness/claude/ClaudeResponseParser.ts` — Parses stream-json output
- `src/flightpath/harness/claude/ClaudeLogParser.ts` — Parses JSONL log files for session discovery
- `src/flightpath/harness/claude/ClaudeToolPermissionMapper.ts` — Converts tool permission settings to CLI args
- `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts` — Monitors Stop hook notification files
- `src/flightpath/harness/CliIntegration.ts` — Shared CLI execution orchestration

**Installation:**

```bash
npm install -g @anthropic-ai/claude-code
```

**Documentation:** https://docs.anthropic.com/en/docs/claude-code

## Completion Detection

FlightPath uses Claude's **Stop hook** for reliable completion detection in interactive TUI mode. This approach mirrors the Codex notify hook implementation and is future-proof.

### Stop Hook Architecture

**How it works:**

1. FlightPath passes `--settings` with Stop hook configuration
2. Hook script receives completion notification via stdin when Claude finishes
3. Script writes notification file to `.flightpath/temp/claude-notifications/{session_id}.json`
4. FlightPath monitors this file in parallel with TUI streaming
5. File detection (authoritative) races against screen-based parsing (fallback)

**Benefits:**

- **Future-proof**: Uses official Claude hook API, not TUI screen patterns
- **Reliable**: Structured JSON notifications, not regex matching
- **Clean**: Automatic file cleanup after reading
- **Non-invasive**: No modification of user's global Claude settings

**Implementation:**

- Script: `src/scripts/flightpath-claude-hook.js`
- Settings injection: `ClaudeCliProvider.buildStopHookSettings()`
- Monitoring: `ClaudeNotificationMonitor.monitorForCompletion()`

### Execution Modes

| Mode                  | Completion Detection               | Session ID Required?                           |
| --------------------- | ---------------------------------- | ---------------------------------------------- |
| **Headless** (`-p`)   | JSONL events (`{"type":"result"}`) | ✅ Automatic from stream-json                  |
| **Interactive** (TUI) | Stop hook → notification file      | ⚠️ Optional (fallback to directory monitoring) |

## Key Differences from Copilot CLI

| Aspect               | Copilot CLI                                                         | Claude CLI                                   |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Command              | `copilot`                                                           | `claude`                                     |
| Tool permission flag | `--allow-all-tools`                                                 | `--dangerously-skip-permissions`             |
| Shell tool name      | `shell`                                                             | `Bash`                                       |
| Write tool name      | `write`                                                             | `Write` (create) + `Edit` (modify)           |
| Model flag           | `--model claude-sonnet-4.5`                                         | `--model claude-sonnet-4-5-20250929`         |
| Session resume       | `--resume <id>`                                                     | `-r <id>` or `-c` (most recent)              |
| Output format        | Mixed text + stats                                                  | `--output-format json/text/stream-json`      |
| Prompt input         | `-p "<prompt>"` (agent content prepended via `<agentInstructions>`) | `-p` (stdin) or `--print` (non-interactive)  |
| File attachment      | `@path` (no auto-content)                                           | `@path` (auto-attaches content)              |
| Thinking mode        | Not applicable                                                      | **NOT AVAILABLE** via CLI (model-controlled) |
| Structured output    | Not available                                                       | `--json-schema` (validates response format)  |
| Completion detection | Log file monitoring (notify hook)                                   | Stop hook → notification file                |

## Current Implementation Status

### ✅ Implemented Flags

| CLI Flag                              | FlightPath Setting/Schema                                         | Implementation                                                                               |
| ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--model <model>`                     | `flightpath.claudeCliModel`, `prompt.model`                       | Full support - aliases (sonnet/opus/haiku) or full names                                     |
| `--add-dir <directory>`               | Auto-includes workspace folders                                   | Full support - workspace folders auto-included                                               |
| `--tools "default"`                   | `flightpath.cliToolPermissions: allowAll`                         | Full support - default mode (safe automation)                                                |
| `--permission-mode bypassPermissions` | `flightpath.cliToolPermissions: allowAll/custom`                  | Full support - used for safe automation with deny list support                               |
| `--dangerously-skip-permissions`      | `flightpath.cliToolPermissions: dangerouslyAllowAll`              | Full support - bypasses all checks (use with caution)                                        |
| `--allowedTools <pattern>`            | `flightpath.cliAllowedTools` (shared)                             | Full support - auto-converted from Copilot format                                            |
| `--disallowedTools <pattern>`         | `flightpath.cliDeniedTools` (shared)                              | Full support - auto-converted from Copilot format, always applied except dangerouslyAllowAll |
| `--output-format stream-json`         | Hardcoded                                                         | Full support - always uses stream-json for real-time output                                  |
| `--verbose`                           | Auto-added for stream-json                                        | Full support - required for stream-json format                                               |
| `-r, --resume <sessionId>`            | `prompt.resumeSession: true` + session ID                         | Full support                                                                                 |
| `-c`                                  | `prompt.resumeSession: true` (no session ID)                      | Full support - continues most recent session                                                 |
| `--settings <json-string>`            | Auto-injected for stop hook (interactive mode)                    | Full support - passes Stop hook configuration                                                |
| `--mcp-config <path>`                 | Auto-generated for dynamic queue extension                        | Full support - FlightPath MCP server auto-configured when dynamic queue enabled              |
| `--allowed-tools mcp__flightpath`     | Auto-added with MCP config                                        | Full support - auto-approves FlightPath MCP tools                                            |
| Prompt via positional arg             | Prompt passed as first argument (headless) or typed (interactive) | Full support - `claude "@file" -p` for headless, stdin for interactive                       |

### ❌ Not Implemented Flags

**High Priority (Automation-Relevant):**

| CLI Flag                   | Priority | Notes                                                          |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `--json-schema <schema>`   | **HIGH** | JSON Schema for structured output validation - **CRITICAL**    |
| `--system-prompt <prompt>` | MEDIUM   | Complete system prompt override (not just append)              |
| `--fallback-model <model>` | MEDIUM   | Auto-fallback when primary model is overloaded                 |
| `--tools <tools...>`       | MEDIUM   | Specify built-in tools from predefined set (only with --print) |
| `--fork-session`           | MEDIUM   | Create new session ID when resuming (use with -r or -c)        |

**Low Priority (Utility/Debug):**

| CLI Flag                          | Priority | Notes                                                   |
| --------------------------------- | -------- | ------------------------------------------------------- |
| `--print`                         | LOW      | Print response and exit (non-interactive mode)          |
| `--append-system-prompt <prompt>` | LOW      | Append to default system prompt                         |
| `--verbose`                       | LOW      | Override verbose mode setting from config               |
| `-d, --debug [filter]`            | LOW      | Debug mode with category filtering (e.g., "api,hooks")  |
| `--input-format <format>`         | LOW      | Input format: text (default) or stream-json             |
| `--include-partial-messages`      | LOW      | Include partial chunks (requires --print + stream-json) |
| `--session-id <uuid>`             | LOW      | Use specific session ID (must be valid UUID)            |
| `--agents <json>`                 | LOW      | Define custom agents via JSON object                    |
| `--ide`                           | LOW      | Auto-connect to IDE if exactly one valid IDE available  |
| `--strict-mcp-config`             | LOW      | Only use MCP servers from --mcp-config                  |
| `--plugin-dir <paths...>`         | LOW      | Load plugins from directories (repeatable)              |
| `--setting-sources <sources>`     | LOW      | Comma-separated setting sources (user, project, local)  |

**Note:** `--max-turns <n>` does **NOT** exist in Claude CLI (removed from documentation)

---

## CLI Flag Reference

### Model Selection

```bash
--model <model>    # Full name or alias
```

**Model aliases (recommended):**

| Alias    | Full Model Name              | Use Case                    |
| -------- | ---------------------------- | --------------------------- |
| `sonnet` | `claude-sonnet-4-5-20250929` | Best balance (default)      |
| `opus`   | `claude-opus-4-20250514`     | Most capable, complex tasks |
| `haiku`  | `claude-haiku-4-20250514`    | Fastest, simple tasks       |

**Current behavior:**

- Default: `sonnet` (via `flightpath.claudeCliModel` setting)
- Per-prompt override via `prompt.model` field
- Supports both aliases (`sonnet`) and full names (`claude-sonnet-4-5-20250929`)
- If prompt specifies unsupported model, falls back to default with warning

**Example prompt file:**

```json
{
  "prompt": "Explain this code",
  "model": "opus"
}
```

### Directory Access

```bash
--add-dir <directory>    # Add allowed directory (can be used multiple times)
```

**Current behavior:**

- All workspace folders are automatically added via `--add-dir`
- No equivalent to Copilot's `--allow-all-paths` - Claude uses explicit directory allowlisting

### Tool Permissions

```bash
--dangerously-skip-permissions    # Skip all permission prompts (non-interactive)
--allowedTools <pattern>          # Allow specific tools
--disallowedTools <pattern>       # Disallow specific tools (takes precedence)
```

**Claude CLI Tool Names:**

| Tool        | Description             | Copilot Equivalent |
| ----------- | ----------------------- | ------------------ |
| `Bash`      | Shell command execution | `shell`            |
| `Read`      | Read file contents      | (always allowed)   |
| `Write`     | Create new files        | `write`            |
| `Edit`      | Edit existing files     | `write`            |
| `MultiEdit` | Batch file editing      | `write`            |
| `Glob`      | File pattern matching   | (always allowed)   |
| `Grep`      | Text search             | (always allowed)   |
| `LS`        | List directories        | (always allowed)   |
| `WebFetch`  | Fetch web content       | (no equivalent)    |
| `TodoWrite` | Todo management         | (no equivalent)    |

**Important:** Claude separates file creation (`Write`) from file modification (`Edit`). When converting Copilot's `write` pattern, only `Write` is allowed. Add `Edit` explicitly if you want to allow file modifications.

**Permission modes:**

| Mode                    | Setting Value           | Behavior                                                                    |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------- |
| Dangerously Allow All   | `"dangerouslyAllowAll"` | Uses `--dangerously-skip-permissions` (bypasses ALL checks, even deny list) |
| Allow All (RECOMMENDED) | `"allowAll"`            | Uses `--tools "default"` with deny patterns (safe automation)               |
| Custom                  | `"custom"`              | Uses specific `cliAllowedTools`/`cliDeniedTools` patterns                   |

**Default:** `allowAll` provides safe automation while respecting deny lists. Use `dangerouslyAllowAll` only in trusted sandboxed environments.

### Session Management

```bash
-r, --resume <sessionId>    # Resume specific session by ID
-c                          # Continue most recent session
```

**Current behavior:**

- Session ID extracted from Claude JSON response (`session_id` field in the `result` message)
- `prompt.resumeSession: true` with stored session ID uses `-r <sessionId>`
- `prompt.resumeSession: true` without session ID: **no resume flag applied** (starts fresh session)
- `prompt.resumeSession: false` or undefined: starts fresh session (no flags)

**Note:** FlightPath intentionally does **not** use the `-c` (continue most recent) flag, because `-c` is global across all projects and could accidentally resume a session from a different project or a stale session from another Claude instance.

### Print Mode (Non-Interactive)

```bash
-p, --print    # Print response and exit (non-interactive mode)
```

**Purpose:** Run Claude non-interactively for automation, piping, and scripting.

**Key differences from interactive mode:**

- **No workspace trust dialog** - Security prompts are skipped (use only in trusted directories)
- **Single response** - Exits after generating response (no follow-up turns)
- **Scriptable** - Works with pipes and redirection
- **Required for many flags** - Some options only work with `--print`:
  - `--json-schema` (structured output)
  - `--tools` (tool specification)
  - `--fallback-model` (automatic fallback)
  - `--output-format stream-json` (streaming)

**Examples:**

```bash
# Simple automation
echo "Explain this error" | claude --print

# Pipe log analysis
tail -f app.log | claude --print "analyze this"

# Structured output
claude --print --json-schema '{"type":"object","properties":{"summary":{"type":"string"}}}' < prompt.txt

# With output format
claude --print --output-format json -p "List files in current dir"
```

**Status:** Not implemented in FlightPath

**Potential use:** Could replace current stdin-based approach for better compatibility with advanced flags like `--json-schema`.

### Output Format

```bash
--output-format stream-json    # Real-time streaming with metadata (always used)
--verbose                      # Required for stream-json format (auto-added)
```

**FlightPath always uses `stream-json` format** for real-time streaming updates with full metadata. The `--verbose` flag is automatically added.

**stream-json output structure:**

The `stream-json` format with `--verbose` outputs **a stream of JSON objects** as Claude processes the request:

1. **Init event** - Session metadata (once at start):

```json
{"type":"system","subtype":"init","session_id":"...","tools":[...],"model":"..."}
```

2. **Assistant messages** - Response content (one or more as generated):

```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Response chunk"}],"usage":{...}},"session_id":"..."}
```

3. **Tool use events** - When Claude calls tools (if applicable):

```json
{"type":"tool_use","name":"Read","input":{...}}
{"type":"tool_result","content":"..."}
```

4. **Result summary** - Final metadata (once at end):

```json
{"type":"result","subtype":"success","result":"Full response","session_id":"...","usage":{...},"total_cost_usd":0.123,"modelUsage":{...}}
```

**Real-time streaming:** Multiple JSON objects are emitted as Claude thinks, uses tools, and generates responses - not just 3 fixed objects. The stream includes all intermediate steps in the agent's workflow.

**FlightPath parsing:**

- Real-time streaming: Extracts text from `message.content` in assistant objects as they arrive
- Tool call summaries: Displays detailed tool usage (e.g., `[Tool: Bash → git status]`, `[Tool: Write → file.txt]`)
- Metadata extraction: Parses session_id, usage stats, and costs from result object at completion
- Human-readable output: Displays clean text in dashboard, not raw JSON
- Handles variable-length streams with tool calls and multi-turn reasoning

**JSON output structure:**

```json
{
  "type": "result",
  "result": "Response text content",
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 5678,
    "total_tokens": 6912
  },
  "session_id": "abc123-...",
  "model": "claude-sonnet-4-5-20250929",
  "duration_ms": 3456,
  "is_error": false
}
```

**FlightPath implementation:**

- Always uses `stream-json` format for real-time streaming + full metadata
- Statistics extracted: token counts, model, duration, costs
- Graceful fallback: if JSON parsing fails, workflow continues with error logged
- `--verbose` flag automatically added

### Structured Output (JSON Schema)

```bash
--json-schema <schema>    # JSON Schema for structured output validation
```

**Purpose:** Enforce structured responses from Claude for reliable parsing in automation workflows.

**Example:**

```bash
claude -p --json-schema '{"type":"object","properties":{"success":{"type":"boolean"},"errors":{"type":"array","items":{"type":"string"}}},"required":["success"]}'
```

**Use cases for FlightPath:**

- End condition validation with predictable response format
- Multi-step workflows with structured intermediate outputs
- Parsing tool usage results consistently
- Extracting specific data from responses (e.g., file paths, test results)

**Status:** **Not implemented** - HIGH priority for automation reliability

**Potential integration:**

- Add `responseSchema` field to `prompt-schema.json`
- Validate response against schema after execution
- Better error messages when responses don't match expected format

### Permission Modes

```bash
--permission-mode <mode>    # Granular permission control
```

**Available modes:**

| Mode                | Behavior                                                             |
| ------------------- | -------------------------------------------------------------------- |
| `default`           | Prompt for all permissions (interactive only)                        |
| `acceptEdits`       | Auto-accept file edits, prompt for other operations                  |
| `bypassPermissions` | Skip all permission prompts BUT respects deny list (safe automation) |
| `dontAsk`           | Similar to bypass but with different security implications           |
| `plan`              | Planning mode (may restrict certain operations)                      |

**Current FlightPath implementation:**

- **allowAll mode**: Uses `--permission-mode bypassPermissions` + `--tools "default"` with deny list (recommended)
- **custom mode**: Uses `--permission-mode bypassPermissions` with custom allow/deny patterns
- **dangerouslyAllowAll mode**: Uses `--dangerously-skip-permissions` (bypasses ALL checks including deny list)

**Key discovery (Dec 2025):** `--permission-mode bypassPermissions` RESPECTS the deny list, making it safe for automation. This is different from `--dangerously-skip-permissions` which ignores all rules.

**Future enhancement:** Add `flightpath.claudeCliPermissionMode` setting to support all modes, especially:

- `acceptEdits` - Safer for workflows that only modify existing files
- `plan` - For multi-step planning before execution

### System Prompt Customization

```bash
--system-prompt <prompt>           # Replace entire system prompt
--append-system-prompt <prompt>    # Append to default system prompt
```

**Differences:**

- `--system-prompt`: **Replaces** Claude's default system prompt entirely (advanced use only)
- `--append-system-prompt`: **Adds** to the default system prompt (safer, recommended)

**Use cases for FlightPath:**

- Workflow-specific instructions (e.g., "Always include git commands in responses")
- Domain-specific context (e.g., "You are helping with a React TypeScript project")
- Output format preferences (e.g., "Always provide code with file paths")
- Behavioral constraints (e.g., "Never suggest breaking changes without approval")

**Status:** Not implemented - MEDIUM priority

**Potential integration:**

- Add `systemPromptAppend` field to `prompt-schema.json`
- Allow per-workflow system prompt customization
- Template variables for common patterns (project type, language, etc.)

### Advanced Session Options

```bash
--fork-session                 # Create new session ID when resuming
--session-id <uuid>            # Use specific session ID
```

**Fork session:** Useful for branching conversation trees

- Resume from a previous session with `-r <id>`
- But create a new session ID for this branch
- Preserves history without polluting original session

**Fixed session ID:** Reproducible automation

- Specify exact UUID for the session
- Useful for testing and debugging workflows
- Must be valid UUID format

**Status:** Not implemented - LOW priority

### Fallback Model

```bash
--fallback-model <model>    # Auto-fallback when primary model overloaded
```

**Behavior:** When primary model returns overload error, automatically retry with fallback model.

**Example:**

```bash
claude -p --model opus --fallback-model sonnet
```

**Use case for FlightPath:**

- Start with Opus for complex tasks, fallback to Sonnet if unavailable
- Ensure workflow continues even during high-demand periods
- Cost optimization (prefer cheaper model when available)

**Status:** Not implemented - MEDIUM priority (only works with `--print` mode)

---

## Tool Pattern Conversion

FlightPath uses **shared settings** for tool permissions (`cliAllowedTools`, `cliDeniedTools`) to simplify configuration. Patterns use Copilot CLI format and are automatically converted for Claude CLI.

### Conversion Map

| Copilot Pattern | Claude Pattern | Notes                        |
| --------------- | -------------- | ---------------------------- |
| `shell`         | `Bash`         | Shell command execution      |
| `shell(git:*)`  | `Bash(git:*)`  | Pattern arguments preserved  |
| `write`         | `Write`        | Create files only (not Edit) |
| `bash`          | `Bash`         | Lowercase accepted           |
| `read`          | `Read`         | Lowercase accepted           |
| `edit`          | `Edit`         | Lowercase accepted           |
| `multiedit`     | `MultiEdit`    | Lowercase accepted           |
| `glob`          | `Glob`         | Lowercase accepted           |
| `grep`          | `Grep`         | Lowercase accepted           |
| `ls`            | `LS`           | Lowercase accepted           |
| `webfetch`      | `WebFetch`     | Lowercase accepted           |

### Conversion Logic

```typescript
// From ClaudeToolPermissionMapper.ts (convertToClaudeFormat)
private convertToClaudeFormat(copilotPattern: string): string {
  const parsed = this.parsePattern(copilotPattern);
  if (!parsed) return copilotPattern;
  const [toolName, toolArgs] = parsed;
  const claudeName = COPILOT_TO_CLAUDE_MAP[toolName.toLowerCase()];
  if (claudeName) {
    return claudeName + toolArgs;
  }
  return copilotPattern; // MCP tool or unknown - pass through unchanged
}
```

### Examples

**Settings (settings.json):**

```json
{
  "flightpath.claudeCliToolPermissions": "custom",
  "flightpath.cliAllowedTools": ["shell(git:*)", "write"],
  "flightpath.cliDeniedTools": ["shell(git push)"]
}
```

**Resulting Claude CLI arguments:**

```bash
claude -p --allowedTools "Bash(git:*)" --allowedTools "Write" --disallowedTools "Bash(git push)"
```

**Most common pattern (recommended):**

```json
{
  "flightpath.claudeCliToolPermissions": "allowAll",
  "flightpath.cliDeniedTools": ["shell(rm:*)", "shell(git push:*)"]
}
```

**Resulting Claude CLI arguments:**

```bash
claude -p --tools "default" --disallowedTools "Bash(rm:*)" --disallowedTools "Bash(git push:*)"
```

This enables safe automation: allow all tools but deny destructive operations.

---

## VS Code Settings Reference

### Claude-Specific Settings

| Setting                         | Type | Default      | Description                                                                   |
| ------------------------------- | ---- | ------------ | ----------------------------------------------------------------------------- |
| `flightpath.claudeCliModel`     | enum | `"sonnet"`   | Default model (sonnet, opus, haiku)                                           |
| `flightpath.cliToolPermissions` | enum | `"allowAll"` | Permission mode (dangerouslyAllowAll, allowAll, custom) - shared with Copilot |

### Shared Settings (Copilot + Claude)

| Setting                      | Type     | Default                | Description                                                        |
| ---------------------------- | -------- | ---------------------- | ------------------------------------------------------------------ |
| `flightpath.cliAllowedTools` | string[] | `[...]`                | Tool patterns to allow (Copilot format) - used in custom mode only |
| `flightpath.cliDeniedTools`  | string[] | `["shell(rm:*)", ...]` | Tool patterns to deny (Copilot format) - ALWAYS applied            |

**Note:** `cliDeniedTools` applies in all modes except `dangerouslyAllowAll`.

### Integration Mode Selection

```json
{
  "flightpath.provider": "claude-cli"
}
```

**Modes:**

- `"copilot-cli"` - Copilot CLI (default)
- `"claude-cli"` - Claude Code CLI
- `"copilot-chat"` - Copilot Chat window (UI automation mode)

---

## Error Handling

### Initialization Errors

| Error Type        | Message                                                                             | Resolution                    |
| ----------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| Command not found | "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code" | Install the CLI globally      |
| Permission denied | "Claude Code CLI permission denied. Check PATH and file permissions"                | Fix PATH or file permissions  |
| Timeout           | "Claude Code CLI detection timed out"                                               | Check system resources, retry |

### Execution Errors

| Error Type         | Handling                                                  |
| ------------------ | --------------------------------------------------------- |
| JSON parse failure | Graceful fallback to text parsing                         |
| Non-zero exit code | Error message extracted from stderr or JSON `error` field |
| `is_error: true`   | Treated as failure even with exit code 0                  |
| Process killed     | Cancellation detected, no error shown                     |

---

## Event System

Claude CLI fires the same events as Copilot CLI for UI integration:

| Event                | When Fired                     | Payload                      |
| -------------------- | ------------------------------ | ---------------------------- |
| `onStatusChange`     | Initialization complete/failed | `CopilotStatus` enum         |
| `onPromptReady`      | Before prompt execution starts | `{ fullPrompt, cliCommand }` |
| `onStreamingChunk`   | During stdout streaming        | Chunk string                 |
| `onResponseComplete` | After successful completion    | Full response text           |

---

## Comparison: When to Use Which CLI

| Use Case                     | Recommendation | Reason                                   |
| ---------------------------- | -------------- | ---------------------------------------- |
| GitHub Copilot subscription  | Copilot CLI    | Uses your existing subscription          |
| Prefer Claude models         | Claude CLI     | Direct access to Claude models           |
| Need Opus for complex tasks  | Claude CLI     | Copilot doesn't offer Opus               |
| Team uses GitHub extensively | Copilot CLI    | Better GitHub MCP integration            |
| Need fast iteration (Haiku)  | Claude CLI     | Haiku is fastest for simple tasks        |
| MCP server customization     | Either         | Both support MCP (not yet in FlightPath) |

---

## Security Considerations

1. **Skip permissions mode:** `--dangerously-skip-permissions` grants full tool access. Only use in trusted environments.

2. **Custom permissions:** Use `cliAllowedTools`/`cliDeniedTools` for granular control. Deny patterns always take precedence.

3. **Directory access:** Unlike Copilot's `--allow-all-paths`, Claude requires explicit `--add-dir` for each allowed directory.

4. **File operations:** Claude separates `Write` (create) from `Edit` (modify). Consider allowing only what's needed.

---

## Implementation Notes

### Architecture

FlightPath uses a provider/integration pattern:

```
CliIntegration (shared orchestration in src/flightpath/harness/CliIntegration.ts)
    │
    └── ICliProvider (interface)
            │
            ├── ClaudeCliProvider       (src/flightpath/harness/claude/)
            │       ├── ClaudeResponseParser      — stream-json parsing
            │       ├── ClaudeLogParser            — JSONL log file parsing
            │       ├── ClaudeNotificationMonitor  — Stop hook notifications
            │       └── ClaudeToolPermissionMapper — Tool arg conversion
            │
            ├── CopilotCliProvider      (src/flightpath/harness/copilot/)
            │
            └── CodexCliProvider        (src/flightpath/harness/codex/)
```

`HarnessIntegration` (abstract base in `src/flightpath/HarnessIntegration.ts`) provides shared
prompt-building and agent expansion logic used by `CliIntegration` and `CopilotChatIntegration`.

### Key Methods

| Method                         | Class                      | Purpose                                                      |
| ------------------------------ | -------------------------- | ------------------------------------------------------------ |
| `buildCliArgs()`               | ClaudeCliProvider          | Construct CLI arguments from settings/prompt                 |
| `buildHeadlessArgs()`          | ClaudeCliProvider          | Add headless-specific flags (-p, --output-format, --verbose) |
| `buildInteractiveTuiCommand()` | ClaudeCliProvider          | Build command string for interactive TUI mode                |
| `validateAndGetModel()`        | ClaudeCliProvider          | Resolve aliases, validate, fallback if needed                |
| `getMcpConfigArgs()`           | ClaudeCliProvider          | Generate --mcp-config file and return args                   |
| `buildStopHookSettings()`      | ClaudeCliProvider          | Write stop hook settings JSON, return temp file path         |
| `checkAvailability()`          | ClaudeCliProvider          | Detect CLI availability via `claude --version`               |
| `parse()`                      | ClaudeResponseParser       | Parse complete stream-json output to structured events       |
| `processStreamingChunk()`      | ClaudeResponseParser       | Parse stream-json chunks for real-time content extraction    |
| `extractSessionId()`           | ClaudeResponseParser       | Extract session ID from stream-json output                   |
| `discoverSessionLog()`         | ClaudeLogParser            | Find matching JSONL session log by prompt text + time        |
| `extractResponse()`            | ClaudeLogParser            | Extract full response from JSONL log events                  |
| `buildArgs()`                  | ClaudeToolPermissionMapper | Build --permission-mode, --allowedTools, --disallowedTools   |
| `monitorForCompletion()`       | ClaudeNotificationMonitor  | Monitor Stop hook notification files for completion          |

**Shared execution orchestration (in `src/flightpath/harness/CliIntegration.ts`):**

| Method                | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `initialize()`        | Detect CLI availability and set up integration |
| `sendPrompt()`        | Execute prompt with all configured flags       |
| `executeHeadless()`   | Background process mode with temp file prompt  |
| `executeInTerminal()` | Interactive TUI mode with stop hook monitoring |

### Process Execution

**Headless mode (background process):**

Prompt is written to a temp file and passed as the first positional argument:

```
claude "@.flightpath/temp/prompt.md" -p --output-format stream-json --verbose [other args]
```

Output is parsed in real-time by `ClaudeResponseParser.processStreamingChunk()` as stdout chunks arrive. On completion, `ClaudeResponseParser.parse()` extracts the full response, session ID, and token usage from the final stream-json output.

**Interactive mode (TUI terminal):**

Claude runs in a terminal panel. Completion is detected via the Stop hook:

1. `ClaudeCliProvider.buildStopHookSettings()` writes hook config to a temp JSON file
2. `--settings <file>` is passed to Claude CLI, registering the Stop hook
3. When Claude finishes, the hook writes a notification file to `.flightpath/temp/claude-notifications/`
4. `ClaudeNotificationMonitor.monitorForCompletion()` watches for this file and signals completion

## Future Enhancements

| Enhancement                  | Priority   | CLI Flag                 | Notes                                                                                                                  |
| ---------------------------- | ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Structured output validation | **HIGH**   | `--json-schema`          | Critical for reliable automation and response parsing                                                                  |
| System prompt customization  | **MEDIUM** | `--append-system-prompt` | Workflow-specific instructions                                                                                         |
| Model fallback               | **MEDIUM** | `--fallback-model`       | Handle overload situations gracefully                                                                                  |
| Session forking              | MEDIUM     | `--fork-session`         | Branch conversation trees                                                                                              |
| Agent support                | ~~MEDIUM~~ | ~~`--agents`~~           | **Implemented via prompt prepending** - agent content embedded in `<agentInstructions>` tags; works with all providers |
| Tool specification           | LOW        | `--tools`                | Limit to specific built-in tools                                                                                       |
| Debug mode                   | LOW        | `-d, --debug`            | Category filtering for troubleshooting                                                                                 |

**Note:** `--permission-mode` and `--mcp-config` are now implemented (see Implemented Flags section above).

**Note on Thinking Mode:** Claude CLI does **NOT** provide a command-line option to control thinking mode/level. Thinking appears to be controlled at the model level and cannot be specified per-request via CLI flags.

---

## Context Attachment Behavior

### File Reference Syntax

Both Copilot and Claude CLI use identical `@pathFromRoot` syntax. See [COPILOT_CLI_DESIGN.md - File Reference Syntax](./COPILOT_CLI_DESIGN.md#file-reference-syntax-pathfromroot) for complete format documentation.

### Automatic File Content Attachment

Claude CLI **automatically attaches file content** when you reference files using `@path` syntax:

- **Example**: For `c:\dev\FlightPath\docs\COPILOT_SYSTEM_PROMPT_SONNET4.5.md`, use `@docs\COPILOT_SYSTEM_PROMPT_SONNET4.5.md`
- **Behavior**: Claude automatically reads and includes the full file content in the context

**Key differences from Copilot CLI:**

| Aspect              | Copilot CLI                                              | Claude CLI                                               |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| File content        | **NOT** auto-attached, requires explicit tool calls      | **Auto-attached** with `@path` syntax                    |
| Custom instructions | `.github/copilot-instructions.md` + folder-level pattern | **Only** `CLAUDE.md` (root + per-folder)                 |
| Instruction mapping | Requires `@filepath` references to trigger folder-level  | No conditional mapping (only fixed `CLAUDE.md` files)    |
| Line ranges         | Not supported natively (FlightPath implements via XML)   | Not supported natively (FlightPath implements via XML)   |
| Directory context   | Not supported natively (Chat only, FlightPath can add)   | Not supported natively (Chat only, FlightPath can add)   |
| Symbol context      | Not supported natively (Chat only, FlightPath can add)   | Not supported natively (Chat only, FlightPath can add)   |
| File reference      | `@path` (native) or `#file:path` (FlightPath convention) | `@path` (native) or `#file:path` (FlightPath convention) |

### FlightPath Implementation for Claude CLI

**Current behavior (needs optimization):**

- FlightPath uses `processPromptAttachments()` from base class
- Converts `#file:path` to XML `<attachment>` blocks
- **Issue**: Duplicates file content (both XML attachment + Claude auto-attachment)

**Proposed optimization:**

- Convert `#file:path` → `@path` for full file references
- Keep XML attachments only for line ranges (`#selection::-`)
- Let Claude's native attachment handle full files (more efficient)
- **Note**: Custom instructions limited to `CLAUDE.md` files only

### Line Range Support

Neither Copilot nor Claude CLI natively support line ranges. FlightPath implements this feature for both:

- **Format**: `#selection::-`
- **Implementation**: Extract lines and include in XML `<attachment>` block
- **Behavior**: Works consistently across both CLI integrations

**Example:**

```markdown
Analyze the error handling in #selection::-
```

FlightPath converts this to:

````xml
<attachment id="file:src/extension.ts:45-67">
Excerpt from src/extension.ts, lines 45 to 67:
```typescript
// ... line 45-67 content ...
```
</attachment>
````

### Directory Context Inclusion

**VS Code Chat Feature**: `#file:directoryPath`

See [COPILOT_CLI_DESIGN.md - Directory Context Inclusion](./COPILOT_CLI_DESIGN.md#directory-context-inclusion) for complete documentation.

**Summary for Claude CLI:**

- VS Code Chat supports directory structure attachment via `#file:directoryPath`
- ❌ Not natively supported by Claude CLI
- Same FlightPath implementation approach as Copilot (read directory structure → XML attachment)

### Symbol Context Inclusion

**VS Code Chat Feature**: `#sym:symbolName`

See [COPILOT_CLI_DESIGN.md - Symbol Context Inclusion](./COPILOT_CLI_DESIGN.md#symbol-context-inclusion) for complete documentation.

**Summary for Claude CLI:**

- VS Code Chat supports targeted symbol attachment via `#sym:symbolName`
- ❌ Not natively supported by Claude CLI
- Same FlightPath implementation approach as Copilot (symbol resolution → line range → XML attachment)

### Custom Instructions

**Copilot CLI:**

- Automatically attaches `.github/copilot-instructions.md` (project-level, always included)
- Automatically attaches `.github/instructions/*.instructions.md` (folder-level, when referenced files match front matter)
- Requires `@pathFromRoot` syntax to trigger folder-level instruction discovery

**Claude CLI:**

- Natively supports only `CLAUDE.md` files (one at project root, optionally one per folder)
- Does NOT natively support `.github/instructions/*.instructions.md` pattern
- **Does NOT support conditional attachment** based on front matter (key limitation vs Copilot)
- **File chaining works**: `@` references in instruction files are loaded recursively
  - `CLAUDE.md` can use `@.github/copilot-instructions.md` to include that file
  - Those files can in turn use `@` to include other files (e.g., `@.github/instructions/ui.instructions.md`)
  - Creates recursive reference chain that loads multiple instruction files
  - **Limitation**: ALL files in chain are ALWAYS included (no selective/conditional loading)
- **Needed enhancement**: FlightPath should implement Copilot's pattern-based conditional inclusion
  - Parse `applyTo` front matter from `.github/instructions/*.instructions.md` files
  - Only include instruction files when working with files matching their patterns
  - Provides intelligent, context-aware instruction loading (not just static file chains)

**Example (Copilot native):**

```markdown
Improve error handling in @src/flightpath/base/CopilotIntegration.ts
```

This automatically attaches `.github/instructions/flightpath-base.instructions.md` in Copilot because it has:

```yaml
---
applyTo: "src/flightpath/base/**"
---
```

**Example (Claude workaround using chained references):**

`CLAUDE.md` can include multiple instruction files via `@` references:

```markdown
# FlightPath Project Memory

## Core Project Context

Always read the main project instructions:

@.github/copilot-instructions.md

## Selective Instruction Files

Read the relevant instruction file(s) based on which files you're working with:

- `src/flightpath/harness/**` → `@.github/instructions/harness-integrations.instructions.md`
- `src/ui/**` → `@.github/instructions/ui.instructions.md`
```

Those referenced files can in turn reference others:

`.github/copilot-instructions.md`:

```markdown
# FlightPath VS Code Extension

## Test: Chained reference from copilot-instructions.md

@.github/instructions/ui.instructions.md
```

This creates a recursive chain that loads all instruction files. However, **this is NOT equivalent to Copilot's conditional inclusion system** - all files in the chain are always loaded, regardless of which files you're actually working with. FlightPath should implement pattern-based conditional inclusion for Claude to match Copilot's intelligent context-aware behavior.

---

## Related Documentation

- [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) - Copilot CLI reference (parallel document)
- [CODEX_CLI_INTEGRATION.md](./CODEX_CLI_INTEGRATION.md) - OpenAI Codex CLI integration
- [CHAT_MODE_LIMITATIONS.md](./CHAT_MODE_LIMITATIONS.md) - Why CLI is preferred over Chat
- [END_CONDITIONS.md](./END_CONDITIONS.md) - Validation script execution
- [CODE_ORGANIZATION_REFACTOR.md](./CODE_ORGANIZATION_REFACTOR.md) - Shared CLI utilities documentation

## Version Compatibility

This documentation is based on Claude Code CLI as of January 2026. Run `claude --version` to check your installed version and `claude --help` for the latest options.
