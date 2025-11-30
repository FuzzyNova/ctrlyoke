# Claude Code CLI Integration Design

This document details FlightPath's integration with the Claude Code CLI (Anthropic), including all available options, implementation status, and how settings are shared with Copilot CLI.

## Overview

FlightPath supports Claude Code CLI (`claude`) as an alternative AI provider to GitHub Copilot. Claude CLI provides deterministic completion detection, structured JSON output, and model selection (sonnet, opus, haiku).

**Key file:** `src/flightpath/cli/ClaudeCommandLineIntegration.ts`

**Installation:**

```bash
npm install -g @anthropic-ai/claude-code
```

**Documentation:** https://docs.anthropic.com/en/docs/claude-code

## Key Differences from Copilot CLI

| Aspect               | Copilot CLI                         | Claude CLI                           |
| -------------------- | ----------------------------------- | ------------------------------------ |
| Command              | `copilot`                           | `claude`                             |
| Tool permission flag | `--allow-all-tools`                 | `--dangerously-skip-permissions`     |
| Shell tool name      | `shell`                             | `Bash`                               |
| Write tool name      | `write`                             | `Write` (create) + `Edit` (modify)   |
| Model flag           | `--model claude-sonnet-4.5`         | `--model claude-sonnet-4-5-20250929` |
| Session resume       | `--resume <id>`                     | `-r <id>` or `-c` (most recent)      |
| Output format        | Mixed text + stats                  | `--output-format json` or `text`     |
| Prompt input         | `-p "<prompt>"` or `--agent` + `-p` | `-p` (stdin)                         |

## Current Implementation Status

### ✅ Implemented Flags

| CLI Flag                         | FlightPath Setting/Schema                      | Implementation                                           |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `--model <model>`                | `flightpath.claudeCliModel`, `prompt.model`    | Full support - aliases (sonnet/opus/haiku) or full names |
| `--add-dir <directory>`          | Auto-includes workspace folders                | Full support - workspace folders auto-included           |
| `--dangerously-skip-permissions` | `flightpath.claudeCliToolPermissions: skipAll` | Full support - default behavior                          |
| `--allowedTools <pattern>`       | `flightpath.cliAllowedTools` (shared)          | Full support - auto-converted from Copilot format        |
| `--disallowedTools <pattern>`    | `flightpath.cliDeniedTools` (shared)           | Full support - auto-converted from Copilot format        |
| `--output-format <format>`       | `flightpath.claudeCliOutputFormat`             | Full support - json (default) or text                    |
| `-r, --resume <sessionId>`       | `prompt.newChatSession: false` + session ID    | Full support                                             |
| `-c`                             | `prompt.newChatSession: false` (no session ID) | Full support - continues most recent session             |
| `-p`                             | Prompt text                                    | Full support (via stdin)                                 |

### ❌ Not Implemented Flags

| CLI Flag                 | Priority | Notes                                  |
| ------------------------ | -------- | -------------------------------------- |
| `--print`                | Low      | Print-only mode without tool execution |
| `--append-system-prompt` | Low      | Custom system prompt additions         |
| `--mcp-server <config>`  | Medium   | MCP server configuration               |
| `--verbose`              | Low      | Verbose output mode                    |
| `--max-turns <n>`        | Low      | Limit conversation turns               |

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

| Mode     | Setting Value | Behavior                                       |
| -------- | ------------- | ---------------------------------------------- |
| Skip All | `"skipAll"`   | Uses `--dangerously-skip-permissions`          |
| Custom   | `"custom"`    | Uses shared `cliAllowedTools`/`cliDeniedTools` |

### Session Management

```bash
-r, --resume <sessionId>    # Resume specific session by ID
-c                          # Continue most recent session
```

**Current behavior:**

- Session ID extracted from Claude JSON response (`session_id` field)
- `prompt.newChatSession: false` with stored session ID uses `-r <sessionId>`
- `prompt.newChatSession: false` without session ID uses `-c` (most recent)
- `prompt.newChatSession: true` or undefined starts fresh session (no flags)

### Output Format

```bash
--output-format <format>    # json or text
```

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

**Current behavior:**

- Default: `json` (enables structured parsing)
- Statistics extracted: token counts, model, duration
- Graceful fallback: if JSON parsing fails, treats as plain text

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
// From ClaudeCommandLineIntegration.ts
private convertToolPatternToClaudeFormat(copilotPattern: string): string {
  const match = copilotPattern.match(/^(\w+)(\(.+\))?$/);
  if (!match) return copilotPattern;

  const [, toolName, args] = match;
  const claudeToolName = COPILOT_TO_CLAUDE_TOOL_MAP[toolName.toLowerCase()] || toolName;
  return args ? claudeToolName + args : claudeToolName;
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

---

## VS Code Settings Reference

### Claude-Specific Settings

| Setting                               | Type | Default     | Description                         |
| ------------------------------------- | ---- | ----------- | ----------------------------------- |
| `flightpath.claudeCliModel`           | enum | `"sonnet"`  | Default model (sonnet, opus, haiku) |
| `flightpath.claudeCliToolPermissions` | enum | `"skipAll"` | Permission mode (skipAll, custom)   |
| `flightpath.claudeCliOutputFormat`    | enum | `"json"`    | Output format (json, text)          |

### Shared Settings (Copilot + Claude)

| Setting                      | Type     | Default | Description                             |
| ---------------------------- | -------- | ------- | --------------------------------------- |
| `flightpath.cliAllowedTools` | string[] | `[]`    | Tool patterns to allow (Copilot format) |
| `flightpath.cliDeniedTools`  | string[] | `[]`    | Tool patterns to deny (Copilot format)  |

### Integration Mode Selection

```json
{
  "flightpath.provider": "claude-cli"
}
```

**Modes:**

- `"copilot-cli"` - Copilot CLI (default)
- `"claude-cli"` - Claude Code CLI
- `"copilot-chat"` - Copilot Chat window (legacy)

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

### Class Hierarchy

```
CopilotIntegration (abstract base)
    │
    ├── BaseCliIntegration (shared CLI utilities)
    │       │
    │       ├── CopilotCommandLineIntegration
    │       │
    │       └── ClaudeCommandLineIntegration
    │
    └── CopilotChatIntegration (legacy UI automation)
```

### Key Methods

| Method                               | Purpose                                         |
| ------------------------------------ | ----------------------------------------------- |
| `initialize()`                       | Detect CLI availability via `claude --version`  |
| `sendPrompt()`                       | Execute prompt with all configured flags        |
| `buildCliArgs()`                     | Construct CLI arguments from settings/prompt    |
| `validateAndGetModel()`              | Resolve aliases, validate, fallback if needed   |
| `convertToolPatternToClaudeFormat()` | Convert Copilot tool patterns to Claude format  |
| `getToolPermissionArgs()`            | Build `--allowedTools`/`--disallowedTools` args |
| `parseJsonOutput()`                  | Parse structured JSON response                  |
| `parseTextOutput()`                  | Fallback for plain text responses               |
| `getStatus()`                        | Return availability and version info            |

### Process Execution

```typescript
// Prompt sent via stdin, not command argument
const result = await this.spawnProcess("claude", args, {
  stdin: promptText,
  timeout: 300000, // 5 minutes
  onStdout: (chunk) => this.streamingChunkEmitter.fire(chunk),
});
```

---

## Future Enhancements

| Enhancement              | Priority | Notes                                   |
| ------------------------ | -------- | --------------------------------------- |
| MCP server configuration | Medium   | Add custom MCP servers via settings     |
| Agent support            | Medium   | Investigate Claude's agent capabilities |
| Max turns limit          | Low      | Limit conversation turns per prompt     |
| Custom system prompts    | Low      | Append to system prompt per-workflow    |

---

## Related Documentation

- [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) - Copilot CLI reference (parallel document)
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall FlightPath architecture
- [CHAT_MODE_LIMITATIONS.md](./CHAT_MODE_LIMITATIONS.md) - Why CLI is preferred over Chat
- [END_CONDITIONS.md](./END_CONDITIONS.md) - Validation script execution

## Version Compatibility

This documentation is based on Claude Code CLI as of November 2025. Run `claude --version` to check your installed version and `claude --help` for the latest options.
