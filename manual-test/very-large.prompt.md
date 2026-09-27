This is a prompt to test very large prompt files. What follows is just copy and pasted text to increase the size of the prompt file:

# Copilot CLI Integration Design

This document details FlightPath's integration with the GitHub Copilot CLI, including all available options, current implementation status, and planned enhancements.

## Overview

FlightPath uses the GitHub Copilot CLI (`copilot`) as the default integration mode for executing prompts. CLI mode provides deterministic completion detection, structured output, and better reliability compared to Chat window automation.

**Key file:** `@src/flightpath/cli/CopilotCommandLineIntegration.ts`

## Current Implementation Status

### ✅ Implemented Flags

| CLI Flag                | FlightPath Setting/Schema                    | Implementation                                                   |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `--model <model>`       | `flightpath.copilotCliModel`, `prompt.model` | Full support - validates against CLI-supported models            |
| `--add-dir <directory>` | `flightpath.copilotCliAllowedDirs`           | Full support - workspace folders auto-included                   |
| `--allow-all-tools`     | `flightpath.cliToolPermissions`              | Full support - "dangerouslyAllowAll", "allowAll", "custom" modes |
| `--allow-tool`          | `flightpath.cliAllowedTools`                 | Full support - pattern-based tool permissions                    |
| `--deny-tool`           | `flightpath.cliDeniedTools`                  | Full support - deny patterns (takes precedence)                  |
| `--allow-all-paths`     | `flightpath.copilotCliAllowAllPaths`         | Full support                                                     |
| `--log-dir <directory>` | `flightpath.copilotCliLogDir`                | Full support - user-configurable or OS temp                      |
| `--log-level <level>`   | `flightpath.copilotCliLogLevel`              | Full support - debug/all for troubleshooting                     |
| `--resume [sessionId]`  | `prompt.newChatSession`                      | Full support                                                     |
| `-p, --prompt <text>`   | Prompt text                                  | Full support (stdin for non-agent, arg for agent)                |
| `--agent <agent>`       | `prompt.agent`                               | Full support                                                     |

### ❌ Not Implemented Flags

| CLI Flag                             | Priority | Notes                                                    |
| ------------------------------------ | -------- | -------------------------------------------------------- |
| `--continue`                         | Low      | Resume most recent session (we use explicit session IDs) |
| `--additional-mcp-config <json>`     | Medium   | MCP server configuration                                 |
| `--disable-builtin-mcps`             | Low      | Disable built-in MCP servers                             |
| `--disable-mcp-server <server-name>` | Low      | Disable specific MCP server                              |
| `--enable-all-github-mcp-tools`      | Low      | Enable all GitHub MCP tools                              |
| `--disable-parallel-tools-execution` | Low      | Sequential tool execution                                |
| `--disallow-temp-dir`                | Low      | Prevent temp directory access                            |
| `--no-custom-instructions`           | Low      | Disable AGENTS.md loading                                |
| `--stream <mode>`                    | Low      | We handle streaming via stdout callbacks                 |
| `--banner`                           | None     | Not relevant for automation                              |
| `--screen-reader`                    | None     | Not relevant for automation                              |
| `--no-color`                         | None     | Output is parsed, color irrelevant                       |

## CLI Flag Reference

### Model Selection

```bash
--model <model>    # Choices: claude-sonnet-4.5, claude-sonnet-4, claude-haiku-4.5, gpt-5
```

**Current behavior:**

- Default: `claude-sonnet-4.5` (via `flightpath.copilotCliModel` setting)
- Per-prompt override via `prompt.model` field
- If prompt specifies unsupported model, falls back to default with warning

### Directory Access

```bash
--add-dir <directory>           # Add allowed directory (can be used multiple times)
--allow-all-paths               # Disable path verification entirely
--disallow-temp-dir             # Prevent access to system temp directory
```

**Current behavior:**

- Workspace folders are automatically added via `--add-dir`
- Additional directories configurable via `flightpath.copilotCliAllowedDirs`
- `--allow-all-paths` enabled by default via `flightpath.copilotCliAllowAllPaths`

### Tool Permissions

```bash
--allow-all-tools               # Allow all tools without confirmation
--allow-tool [tools...]         # Allow specific tools (pattern-based)
--deny-tool [tools...]          # Deny specific tools (takes precedence)
```

**Permission Pattern Syntax:**

```
shell(command:*?)     # Match shell commands
                      # shell(git:*)    - all git commands
                      # shell(npm test) - exact npm test command

write                 # Match file creation/modification tools

<mcp-server>(tool?)   # Match MCP server tools
                      # MyMCP           - all tools from MyMCP
                      # MyMCP(my_tool)  - specific tool from MyMCP
```

**Examples:**

```bash
# Allow all git commands except push
--allow-tool 'shell(git:*)' --deny-tool 'shell(git push)'

# Allow file writing
--allow-tool 'write'

# Allow MCP server but deny specific tool
--allow-tool 'MyMCP' --deny-tool 'MyMCP(dangerous_tool)'
```

**Current behavior:**

- **allowAll** mode: Uses `--allow-all-tools` with deny patterns (default)
- **custom** mode: Uses specific `cliAllowedTools` patterns with deny patterns
- **Deny patterns ALWAYS applied** regardless of mode (per Copilot CLI design)
- Full pattern syntax support (`shell(git:*)`, `write`, `github(search_repositories)`)
- Deny patterns take precedence over allow patterns
- Settings are shared with Claude CLI (auto-converted: `shell` → `Bash`, `write` → `Write`)

**Important:** Both modes respect `cliDeniedTools`. This enables the common pattern of "allow all tools except these specific ones" via `allowAll` mode with custom deny list.

### Session Management

```bash
--resume [sessionId]    # Resume previous session (optional specific ID)
--continue              # Resume most recent session
```

**Current behavior:**

- Session ID extracted from log files (`session-{GUID}.log`)
- `prompt.newChatSession: false` uses `--resume <sessionId>`
- `--continue` not implemented (we track explicit session IDs)

### Agent Selection

```bash
--agent <agent>    # Use custom agent (only in prompt mode with -p)
```

**Current behavior:**

- Full support via `prompt.agent` field
- Automatically adds `.agent` suffix if missing
- Enhanced error messages for agent discovery failures

### MCP Configuration

```bash
--additional-mcp-config <json>       # Add MCP servers (JSON string or @filepath)
--disable-builtin-mcps               # Disable all built-in MCPs
--disable-mcp-server <server-name>   # Disable specific MCP server
--enable-all-github-mcp-tools        # Enable full GitHub MCP tools
```

**Current behavior:** Not implemented

### Logging

```bash
--log-dir <directory>    # Set log directory (default: ~/.copilot/logs/)
--log-level <level>      # none, error, warning, info, debug, all, default
```

**Log levels:**

- `none` - No logging
- `error` - Only errors
- `warning` - Errors and warnings
- `info`/`default` - Errors, warnings, and info
- `debug`/`all` - Everything including debug

**Current behavior:**

- `--log-dir` configurable via `flightpath.copilotCliLogDir` setting (defaults to OS temp)
- `--log-level` configurable via `flightpath.copilotCliLogLevel` setting (defaults to CLI default)
- Logs used for session ID extraction from log filenames

### Streaming & Display

```bash
--stream <mode>      # on/off - enable/disable streaming
--no-color           # Disable color output
--banner             # Show startup banner
--screen-reader      # Screen reader optimizations
```

**Current behavior:**

- Streaming handled via stdout callbacks in `spawnProcess()`
- Other flags not relevant for automation

### Other Flags

```bash
--no-custom-instructions              # Disable AGENTS.md and instruction files
--disable-parallel-tools-execution    # Execute tools sequentially
```

**Current behavior:** Not implemented

## Environment Variables

| Variable                           | Purpose                                |
| ---------------------------------- | -------------------------------------- |
| `COPILOT_ALLOW_ALL`                | Set to "true" to auto-allow all tools  |
| `COPILOT_MODEL`                    | Default model (overridden by --model)  |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Additional instruction directories     |
| `GH_TOKEN` / `GITHUB_TOKEN`        | Authentication token                   |
| `XDG_CONFIG_HOME`                  | Config directory (default: ~/.copilot) |
| `XDG_STATE_HOME`                   | State directory (default: ~/.copilot)  |

**Current behavior:** None explicitly set by FlightPath

---

## Implemented Enhancements

### 1. ✅ Granular Tool Permissions

**Goal:** Allow users to specify exactly which tools Copilot can use, with deny patterns always taking precedence.

**Settings (`package.json`):**

```json
{
  "flightpath.cliToolPermissions": "dangerouslyAllowAll" | "allowAll" | "custom",
  "flightpath.cliAllowedTools": ["shell(git:*)", "write", "github"],
  "flightpath.cliDeniedTools": ["shell(git push)", "shell(rm:*)"]
}
```

**Note:** This setting is shared between Copilot CLI and Claude CLI. For Claude, tool names are automatically converted (`shell` → `Bash`, `write` → `Write`).

**Modes:**

- **dangerouslyAllowAll**: Bypasses ALL restrictions, ignores deny list (Copilot: `--allow-all-tools` only, Claude: `--dangerously-skip-permissions`)
- **allowAll**: Auto-grants all tools but respects deny list (Copilot: `--allow-all-tools` + denies, Claude: `--tools "default"` + denies) - RECOMMENDED
- **custom**: Uses specific allow/deny patterns from `cliAllowedTools` and `cliDeniedTools`

**Common Use Cases:**

```json
// Most common: Allow all but deny destructive operations (RECOMMENDED)
{
  "flightpath.cliToolPermissions": "allowAll",
  "flightpath.cliDeniedTools": ["shell(rm:*)", "shell(git push:*)"]
}

// Allow git but prevent pushes
{
  "flightpath.cliToolPermissions": "custom",
  "flightpath.cliAllowedTools": ["shell(git:*)"],
  "flightpath.cliDeniedTools": ["shell(git push)", "shell(git push:*)"]
}

// Read-only mode (no file writing, no shell)
{
  "flightpath.cliToolPermissions": "allowAll",
  "flightpath.cliDeniedTools": ["write", "shell"]
}

// Only allow specific MCP tools
{
  "flightpath.cliToolPermissions": "custom",
  "flightpath.cliAllowedTools": ["github(search_repositories)", "github(get_file_contents)"]
}

// Maximum freedom (no restrictions, use with caution)
{
  "flightpath.cliToolPermissions": "dangerouslyAllowAll"
}
```

### 2. ✅ Logging Configuration

**Goal:** Allow users to customize log directory and enable debug logging for troubleshooting.

**Settings (`package.json`):**

```json
{
  "flightpath.copilotCliLogDir": "/path/to/custom/logs",
  "flightpath.copilotCliLogLevel": "debug"
}
```

**Implementation details:**

- `initializeLogDirectory()` checks the setting first, falls back to OS temp
- `getLogLevelArgs()` adds `--log-level` flag when non-default
- Both are applied during CLI argument building in `sendPrompt()`

---

## Future Enhancements

### 1. MCP Server Configuration (MEDIUM PRIORITY)

**Goal:** Allow users to add custom MCP servers for enhanced capabilities.

**Schema Changes:**

```json
{
  "mcpConfig": {
    "type": "object",
    "properties": {
      "servers": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "properties": {
            "command": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } },
            "env": { "type": "object" }
          }
        }
      },
      "disableBuiltins": { "type": "boolean" },
      "disabledServers": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

**Settings:**

```json
{
  "flightpath.copilotCliMcpConfig": {
    "type": "string",
    "default": "",
    "description": "Path to MCP config JSON file or inline JSON"
  },
  "flightpath.copilotCliDisableBuiltinMcps": {
    "type": "boolean",
    "default": false
  }
}
```

### 2. Parallel Tool Execution Control (LOW PRIORITY)

**Goal:** Allow disabling parallel tool execution for debugging or specific workflows.

**Schema:**

```json
{
  "disableParallelTools": {
    "type": "boolean",
    "description": "Execute tools sequentially instead of in parallel"
  }
}
```

### 3. Custom Instructions Control (LOW PRIORITY)

**Goal:** Allow disabling automatic instruction loading per-prompt.

**Schema:**

```json
{
  "noCustomInstructions": {
    "type": "boolean",
    "description": "Disable loading AGENTS.md and instruction files"
  }
}
```

---

## Implementation Notes

### Current Code Structure

```typescript
// src/types/CopilotTypes.ts

interface CopilotCliOptions {
  addDirs?: string[];
  model?: string;
  agent?: string;
  resumeSession?: string;
  // Tool permissions (per-prompt override)
  allowedTools?: string[];
  deniedTools?: string[];
  // Logging (per-prompt override)
  logLevel?: string;
  logDir?: string;
  // Advanced options (future use)
  mcpConfig?: string;
  disableParallelTools?: boolean;
  noCustomInstructions?: boolean;
}
```

### CLI Argument Building

The implementation builds args incrementally in `sendPrompt()`:

```typescript
const args: string[] = [];

// Tool permissions (allowAll or custom with allow/deny patterns)
const toolPermissions = this.getToolPermissionArgs();
args.push(...toolPermissions);

// Path access
if (this.shouldAllowAllPaths()) {
  args.push("--allow-all-paths");
}

// Logging
if (this.logDirectory) {
  args.push("--log-dir", this.logDirectory);
}
// Log level (if non-default)
const logLevelArgs = this.getLogLevelArgs();
args.push(...logLevelArgs);

// Directories
if (options.addDirs && options.addDirs.length > 0) {
  options.addDirs.forEach((dir) => {
    args.push("--add-dir", dir);
  });
}

// Model
if (options.model) {
  args.push("--model", options.model);
}

// Agent (requires -p flag)
if (options.agent) {
  const agentName = options.agent.endsWith(".agent")
    ? options.agent
    : `${options.agent}.agent`;
  args.push("--agent", agentName);
  args.push("-p", JSON.stringify(promptText));
}

// Session resume
if (options.resumeSession) {
  args.push("--resume", options.resumeSession);
}
```

### Security Considerations

1. **Tool denial precedence:** `--deny-tool` always takes precedence over `--allow-tool` and `--allow-all-tools`
2. **Path restrictions:** Consider disabling `--allow-all-paths` in security-sensitive environments
3. **Temp directory:** Use `--disallow-temp-dir` to prevent temp file manipulation
4. **Shell commands:** Carefully scope shell permissions with patterns like `shell(npm:*)` instead of `shell`

---

## Implementation Tasks for Agents

This section provides a clear checklist for implementing the remaining planned enhancements.

### ✅ Completed Tasks

| Task                      | Status  | Files Modified                                                                |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| Log Directory Setting     | ✅ Done | `package.json`, `CopilotCommandLineIntegration.ts`, `copilot-instructions.md` |
| Log Level Setting         | ✅ Done | `package.json`, `CopilotCommandLineIntegration.ts`                            |
| Granular Tool Permissions | ✅ Done | `package.json`, `CopilotCommandLineIntegration.ts`                            |
| Update CopilotCliOptions  | ✅ Done | `src/types/CopilotTypes.ts`                                                   |

### Remaining Tasks

| Task                     | Priority | Effort | Notes                          |
| ------------------------ | -------- | ------ | ------------------------------ |
| MCP Server Configuration | Medium   | Medium | Add custom MCP server support  |
| Parallel Tool Execution  | Low      | Small  | Add `--disable-parallel-tools` |
| Custom Instructions      | Low      | Small  | Add `--no-custom-instructions` |

---

## Related Documentation

- [CLAUDE_CLI_DESIGN.md](./CLAUDE_CLI_DESIGN.md) - Claude Code CLI reference (parallel document)
- [AGENT_SUPPORT_IMPLEMENTATION.md](./AGENT_SUPPORT_IMPLEMENTATION.md) - Agent discovery and usage
- [CHAT_MODE_LIMITATIONS.md](./CHAT_MODE_LIMITATIONS.md) - Why CLI is preferred over Chat
- [END_CONDITIONS.md](./END_CONDITIONS.md) - Validation script execution

## Context Attachment Behavior

### File Reference Syntax: `@pathFromRoot`

Both Copilot and Claude CLI use identical `@pathFromRoot` syntax to reference files in prompts:

- **Format**: `@path\to\file.md` (Windows) or `@path/to/file.md` (Unix)
- **Important**: Omit the root directory name and leading slash
- **Example**: For `c:\dev\FlightPath\docs\COPILOT_SYSTEM_PROMPT_SONNET4.5.md`, use `@docs\COPILOT_SYSTEM_PROMPT_SONNET4.5.md`
- **Platform**: Both CLIs accept forward or backslashes (normalized internally)

### Automatic Context from Custom Instructions

When you invoke the Copilot CLI, custom instructions are automatically discovered and loaded:

- `.github/copilot-instructions.md` (project-level, always included)
- `.github/instructions/*.instructions.md` (folder-level, when referenced files match front matter)
- These are automatically attached without explicit CLI flags

**To trigger folder-level instructions:**

- Reference a file matching the instruction's `applyTo` pattern using `@pathFromRoot` syntax

**Example:**

```markdown
Improve error handling in @src/flightpath/base/CopilotIntegration.ts
```

This automatically attaches `.github/instructions/flightpath-base.instructions.md` because it has:

```yaml
---
applyTo: "src/flightpath/base/**"
---
```

### Important: Copilot CLI Does Not Auto-Attach File Content

**Key difference from Claude CLI:**

- When you reference files with `@path` syntax, Copilot CLI does **NOT** automatically include file content
- The Copilot CLI agent must explicitly read files using available tools (`shell`, `read`, MCP tools)
- This is a security feature—files are only accessed when the agent explicitly requests them

**Comparison:**

| Aspect              | Copilot CLI                                              | Claude CLI                                               |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| File content        | **NOT** auto-attached, requires explicit tool calls      | **Auto-attached** with `@path` syntax                    |
| Custom instructions | `.github/copilot-instructions.md` + folder-level pattern | **Only** `CLAUDE.md` (root + per-folder)                 |
| Instruction mapping | Requires `@filepath` references to trigger folder-level  | No conditional mapping (only fixed `CLAUDE.md` files)    |
| Line ranges         | Not supported natively (FlightPath implements via XML)   | Not supported natively (FlightPath implements via XML)   |
| Directory context   | Not supported natively (Chat only, FlightPath can add)   | Not supported natively (Chat only, FlightPath can add)   |
| Symbol context      | Not supported natively (Chat only, FlightPath can add)   | Not supported natively (Chat only, FlightPath can add)   |
| File reference      | `@path` (native) or `#file:path` (FlightPath convention) | `@path` (native) or `#file:path` (FlightPath convention) |

### FlightPath Implementation for Copilot CLI

**Current behavior (needs optimization):**

- FlightPath uses `#file:path` syntax (user-facing convention)
- `processPromptAttachments()` converts to XML `<attachment>` blocks
- **Issue**: Copilot doesn't receive file content OR custom instructions from `#file:path`

**Proposed optimization:**

- Convert `#file:path` → `@path` reference (triggers custom instructions)
- **Also** include XML attachment for file content (Copilot needs explicit content)
- Keep XML attachments for line ranges (`#file:path:10-20`)

### Line Range Support

Neither Copilot nor Claude CLI natively support line ranges. FlightPath implements this feature for both:

- **Format**: `#file:path:startLine-endLine`
- **Implementation**: Extract lines and include in XML `<attachment>` block
- **Behavior**: Works consistently across both CLI integrations

**Example:**

```markdown
Analyze the error handling in #file:src/extension.ts:45-67
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

When used in VS Code Chat, referencing a directory with `#file:` provides the directory structure:

```markdown
Explain the structure of #file:src/ui
```

**What VS Code attaches:**

- Complete directory tree (files and subdirectories)
- File names only (not file contents)
- Useful for understanding project organization

**CLI Support**: ❌ Not natively supported by Copilot or Claude CLI

**FlightPath implementation**: Not yet implemented

- Could read directory structure and format as XML attachment
- Useful for "analyze this module" or "explain folder structure" prompts
- Lower priority than file/symbol support

### Symbol Context Inclusion

**VS Code Chat Feature**: `#sym:symbolName`

When used in VS Code Chat, referencing a symbol provides targeted code context:

```markdown
Refactor #sym:cancelImplementation to improve error handling
```

**What VS Code attaches:**

- Specific function/method/class definition
- Precise line range for that symbol only
- Much more targeted than full file attachment

**CLI Support**: ❌ Not natively supported by Copilot or Claude CLI

**FlightPath implementation**: Not yet implemented

- Would require symbol resolution via VS Code Language Server
- Could use `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider')` to find symbols
- Extract symbol location and convert to line range attachment
- **High value**: Very useful for focused refactoring prompts

**Proposed FlightPath syntax extension:**

```json
{
  "prompt": "Refactor #sym:cancelImplementation in #file:src/flightpath/cli/BaseCliIntegration.ts"
}
```

FlightPath would:

1. Parse `#sym:symbolName` from prompt
2. Resolve symbol location using VS Code API
3. Convert to `#file:path:startLine-endLine` format
4. Process as line range attachment (existing implementation)

**Implementation priority**: Medium (symbol resolution adds complexity but high user value)

## Version Compatibility

This documentation is based on Copilot CLI as of November 2025. Run `copilot --version` to check your installed version and `copilot --help` for the latest options.

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

| Aspect               | Copilot CLI                         | Claude CLI                                   |
| -------------------- | ----------------------------------- | -------------------------------------------- |
| Command              | `copilot`                           | `claude`                                     |
| Tool permission flag | `--allow-all-tools`                 | `--dangerously-skip-permissions`             |
| Shell tool name      | `shell`                             | `Bash`                                       |
| Write tool name      | `write`                             | `Write` (create) + `Edit` (modify)           |
| Model flag           | `--model claude-sonnet-4.5`         | `--model claude-sonnet-4-5-20250929`         |
| Session resume       | `--resume <id>`                     | `-r <id>` or `-c` (most recent)              |
| Output format        | Mixed text + stats                  | `--output-format json/text/stream-json`      |
| Prompt input         | `-p "<prompt>"` or `--agent` + `-p` | `-p` (stdin) or `--print` (non-interactive)  |
| File attachment      | `@path` (no auto-content)           | `@path` (auto-attaches content)              |
| Thinking mode        | Not applicable                      | **NOT AVAILABLE** via CLI (model-controlled) |
| Structured output    | Not available                       | `--json-schema` (validates response format)  |

## Current Implementation Status

### ✅ Implemented Flags

| CLI Flag                         | FlightPath Setting/Schema                            | Implementation                                                                               |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--model <model>`                | `flightpath.claudeCliModel`, `prompt.model`          | Full support - aliases (sonnet/opus/haiku) or full names                                     |
| `--add-dir <directory>`          | Auto-includes workspace folders                      | Full support - workspace folders auto-included                                               |
| `--tools "default"`              | `flightpath.cliToolPermissions: allowAll`            | Full support - default mode (safe automation)                                                |
| `--dangerously-skip-permissions` | `flightpath.cliToolPermissions: dangerouslyAllowAll` | Full support - bypasses all checks (use with caution)                                        |
| `--allowedTools <pattern>`       | `flightpath.cliAllowedTools` (shared)                | Full support - auto-converted from Copilot format                                            |
| `--disallowedTools <pattern>`    | `flightpath.cliDeniedTools` (shared)                 | Full support - auto-converted from Copilot format, always applied except dangerouslyAllowAll |
| `--output-format stream-json`    | Hardcoded                                            | Full support - always uses stream-json for real-time output                                  |
| `--verbose`                      | Auto-added for stream-json                           | Full support - required for stream-json format                                               |
| `-r, --resume <sessionId>`       | `prompt.newChatSession: false` + session ID          | Full support                                                                                 |
| `-c`                             | `prompt.newChatSession: false` (no session ID)       | Full support - continues most recent session                                                 |
| Prompt via stdin                 | Prompt text passed to process                        | Full support - current implementation sends via stdin                                        |

### ❌ Not Implemented Flags

**High Priority (Automation-Relevant):**

| CLI Flag                    | Priority | Notes                                                                              |
| --------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `--json-schema <schema>`    | **HIGH** | JSON Schema for structured output validation - **CRITICAL**                        |
| `--permission-mode <mode>`  | **HIGH** | Granular permission modes (acceptEdits, bypassPermissions, default, dontAsk, plan) |
| `--system-prompt <prompt>`  | MEDIUM   | Complete system prompt override (not just append)                                  |
| `--fallback-model <model>`  | MEDIUM   | Auto-fallback when primary model is overloaded                                     |
| `--tools <tools...>`        | MEDIUM   | Specify built-in tools from predefined set (only with --print)                     |
| `--fork-session`            | MEDIUM   | Create new session ID when resuming (use with -r or -c)                            |
| `--mcp-config <configs...>` | MEDIUM   | Load MCP servers from JSON files/strings (space-separated)                         |

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
| `--settings <file-or-json>`       | LOW      | Load settings from file path or JSON string             |
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

- Session ID extracted from Claude JSON response (`session_id` field)
- `prompt.newChatSession: false` with stored session ID uses `-r <sessionId>`
- `prompt.newChatSession: false` without session ID uses `-c` (most recent)
- `prompt.newChatSession: true` or undefined starts fresh session (no flags)

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
  timeoutSec: 300, // 5 minutes
  onStdout: (chunk) => this.streamingChunkEmitter.fire(chunk),
});
```

---

## Future Enhancements

| Enhancement                  | Priority   | CLI Flag                 | Notes                                                 |
| ---------------------------- | ---------- | ------------------------ | ----------------------------------------------------- |
| Structured output validation | **HIGH**   | `--json-schema`          | Critical for reliable automation and response parsing |
| Permission modes             | **HIGH**   | `--permission-mode`      | Granular control (acceptEdits, plan, etc.)            |
| System prompt customization  | **MEDIUM** | `--append-system-prompt` | Workflow-specific instructions                        |
| Model fallback               | **MEDIUM** | `--fallback-model`       | Handle overload situations gracefully                 |
| MCP server configuration     | **MEDIUM** | `--mcp-config`           | Custom MCP servers for enhanced capabilities          |
| Session forking              | MEDIUM     | `--fork-session`         | Branch conversation trees                             |
| Agent support                | MEDIUM     | `--agents`               | Custom agent definitions via JSON                     |
| Tool specification           | LOW        | `--tools`                | Limit to specific built-in tools                      |
| Debug mode                   | LOW        | `-d, --debug`            | Category filtering for troubleshooting                |

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
- Keep XML attachments only for line ranges (`#file:path:10-20`)
- Let Claude's native attachment handle full files (more efficient)
- **Note**: Custom instructions limited to `CLAUDE.md` files only

### Line Range Support

Neither Copilot nor Claude CLI natively support line ranges. FlightPath implements this feature for both:

- **Format**: `#file:path:startLine-endLine`
- **Implementation**: Extract lines and include in XML `<attachment>` block
- **Behavior**: Works consistently across both CLI integrations

**Example:**

```markdown
Analyze the error handling in #file:src/extension.ts:45-67
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
- `src/cli.ts`, `src/cli/**` → `@.github/instructions/flightpath-cli-binary.instructions.md`
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
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall FlightPath architecture
- [CHAT_MODE_LIMITATIONS.md](./CHAT_MODE_LIMITATIONS.md) - Why CLI is preferred over Chat
- [END_CONDITIONS.md](./END_CONDITIONS.md) - Validation script execution

## Version Compatibility

This documentation is based on Claude Code CLI as of November 2025. Run `claude --version` to check your installed version and `claude --help` for the latest options.

# CLI Prompt Passing Architecture

## Implementation Status: ✅ COMPLETE

**Implemented December 2025**

## Quick Reference

| CLI         | Headless Mode                 | Interactive Mode                    |
| ----------- | ----------------------------- | ----------------------------------- |
| **Copilot** | spawn + stdin (no `-p`)       | TUI + `executeCommand` + `sendText` |
| **Claude**  | spawn + stdin (requires `-p`) | TUI + `executeCommand` + `sendText` |

## Architecture

### Two Modes, Two Methods

| Mode            | Method                            | Output Streaming    | Completion Detection          |
| --------------- | --------------------------------- | ------------------- | ----------------------------- |
| **Headless**    | `spawn()` + `stdin.write()`       | `child.stdout` pipe | Process exit                  |
| **Interactive** | `executeCommand()` + `sendText()` | `execution.read()`  | Escape indicator disappearing |

**Key Principle**: Each mode uses ONE method that works for **any prompt size**. No conditional logic based on prompt length.

## Headless Mode

Uses Node.js `spawn()` with stdin pipe:

```typescript
const child = spawn(cliName, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false, // No shell escaping issues
});
child.stdin.write(promptText);
child.stdin.end();
```

**CLI-specific behavior:**

- **Copilot**: No `-p` flag needed - reads from stdin automatically when not a TTY
- **Claude**: REQUIRES `-p` flag (Ink TUI crashes without it due to `setRawMode()` requirement)

## Interactive Mode

Uses VS Code Shell Integration + sendText injection:

### Flow

1. **Start CLI via `executeCommand()`**: Gets execution object for `read()` streaming
2. **Wait for TUI ready**: Stream output via `execution.read()`, detect ready indicators
3. **Send prompt via `sendText()`**: Inject prompt as "keyboard input" (no length limit!)
4. **Wait for paste to complete**: Dynamic detection with verification (see below)
5. **Submit with Enter key (`\r`)**: In raw terminal mode, Enter = carriage return
6. **Detect completion**: Watch for escape indicator to disappear from output

### Key Implementation Details

**Race condition fix**: Originally used `executeCommand()` then immediately `sendText()`, but `executeCommand()` has internal queuing while `sendText()` is immediate. Solution: Wait for TUI output before sending prompt.

**Dynamic paste detection with verification**: Large prompts can take a while to paste, but different CLIs handle this differently:

- **Claude**: Shows the full prompt text as it pastes (streaming updates)
- **Copilot**: Shows nothing until paste completes, then displays `[Paste #1 - 2987 lines]`

We use a two-phase approach:

1. **Wait for 1 second of terminal silence** (fast for small prompts)
2. **Verify the paste actually happened** before submitting by checking for:
   - The last 50 characters of the prompt in terminal output (works for Claude)
   - The `[Paste #N - X lines]` pattern (works for Copilot)

This prevents false positives from initial silence before any paste begins, while keeping the automation responsive.

**Prompt submission**: Copilot CLI uses the Ink TUI framework which operates in raw terminal mode. In raw mode, the Enter key sends `\r` (carriage return), not `\n` (newline):

```typescript
terminal.sendText(promptText, false); // Send text WITHOUT newline
// ... wait for paste to complete (5s silence detection) ...
terminal.sendText("\r"); // Enter key (carriage return) to submit
```

**About multiline input**: The `/terminal-setup` command maps Shift+Enter and Ctrl+Enter to `\n` for inserting newlines without submitting. Regular Enter (which is `\r`) still submits the input. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264) for details on Ink's raw mode input handling.

**Case-insensitive matching**: All indicator detection uses `.toLowerCase()` to handle varying capitalization in TUI output.

### TUI Ready Detection

TUI readiness is detected when the first complete screen is parsed from the buffer. This happens when the CLI-specific screen end pattern (see below) first matches - indicating the TUI has fully rendered and is ready for input.

No separate "ready indicators" are needed - if `extractScreensFromBuffer()` returns a complete screen, the TUI is ready.

### Screen Buffer Parsing

TUI apps redraw the entire screen each frame. However, `execution.read()` returns **chunks of arbitrary size** that don't align with screen boundaries. A single chunk might contain 0-3 complete screens plus a partial screen.

**Screen boundary detection**: Each CLI has its own screen end pattern (implemented via `getScreenEndPattern()`):

- **Copilot**: `Ctrl+c Exit · Ctrl+r Expand recent` (status bar at bottom)
- **Claude**: Line of `─` characters followed by `> ` prompt

**Buffer accumulation algorithm**:

1. Accumulate raw chunks into a buffer
2. Use `extractScreensFromBuffer()` to find complete screens (delimited by status bar)
3. Keep the remainder (partial screen) in buffer for next chunk
4. Process each complete screen for indicator detection and content extraction

### Completion Detection

We check **each complete screen** for the escape indicator:

- **Copilot**: `"Esc to cancel"` (appears during generation)
- **Claude**: `"esc to interrupt"` (appears during generation)

**Three-phase detection logic**:

1. **Wait for indicator to appear**: After sending prompt, the CLI starts processing and shows the indicator (e.g., "∙ Thinking (Esc to cancel)")
2. **Track indicator presence**: Set `indicatorEverSeen = true` when first detected
3. **Count consecutive absences**: Only after indicator has been seen, count screens without it. Require 2+ consecutive screens without indicator to confirm completion.

**Why this matters**: Initial loading screens (welcome box, status bar) don't have the indicator. Without tracking `indicatorEverSeen`, we'd falsely detect completion before the CLI even started processing.

This avoids false positives from:

- Partial screen updates
- Brief indicator disappearance between redraws
- End-of-stream coinciding with indicator still visible

### TUI Output Diffing

To avoid spamming the dashboard with repeated TUI redraws, we track emitted content and extract only the **delta** (new content):

1. Split screen into lines
2. Filter out TUI chrome (borders, prompts, status bars, spinner characters)
3. Track emitted lines in a Set
4. Only emit lines not previously emitted
5. This prevents duplicate output as screens accumulate content

## Code Structure

### BaseCliIntegration.ts

**Key methods:**

| Method                       | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `executeInTerminal()`        | Entry point for interactive mode                                    |
| `waitForTuiAndExecute()`     | Streams output, detects TUI ready, sends prompt, detects completion |
| `extractScreensFromBuffer()` | Parses buffer into complete screens by boundary pattern             |
| `extractNewContent()`        | Extracts meaningful new lines for dashboard (deduplicates)          |
| `isTuiChromeLine()`          | Filters out TUI borders, prompts, status bars                       |
| `executeHeadlessWithStdin()` | Entry point for headless mode                                       |
| `spawnWithStdin()`           | Spawns process with stdin pipe                                      |
| `spawnSimpleCommand()`       | For simple commands like `--version` checks                         |

**Abstract methods (implemented by subclasses):**

| Method                         | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `getCliName()`                 | Returns `"copilot"` or `"claude"`               |
| `getEscapeIndicator()`         | Returns the escape indicator pattern            |
| `getScreenEndPattern()`        | Returns regex for TUI screen boundary detection |
| `buildHeadlessArgs()`          | Build args for headless mode (stdin)            |
| `buildInteractiveTuiCommand()` | Build command to start interactive TUI          |

### CopilotCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"Esc to cancel"`
- `getScreenEndPattern()` returns `/Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi`
- `buildHeadlessArgs()` - NO `-p` flag (Copilot reads stdin in non-TTY)
- `buildInteractiveTuiCommand()` - Returns `copilot [args]` (no prompt)

### ClaudeCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"esc to interrupt"`
- `getScreenEndPattern()` returns `/─{20,}\r?\n>\s*/g` (dashes + prompt)
- `buildHeadlessArgs()` - REQUIRES `-p` flag (Ink TUI crashes without it)
- `buildInteractiveTuiCommand()` - Returns `claude [args]` (no prompt)

## Known Issues & Solutions

### Issue: executeCommand vs sendText Race Condition

**Problem**: `shellIntegration.executeCommand()` queues internally, while `terminal.sendText()` executes immediately. This caused prompts to appear before the CLI command.

**Solution**: Use `executeCommand()` for the CLI (to get execution object), then stream with `execution.read()` and wait for TUI ready indicators before calling `sendText()`.

### Issue: Multi-line Prompt Submission

**Problem**: Copilot CLI uses Ink TUI framework which operates in raw terminal mode. In raw mode, Enter sends `\r` (carriage return), not `\n` (newline).

**Solution**: Send prompt text, wait for paste to complete, then send carriage return to submit:

```typescript
terminal.sendText(promptText, false); // Send without trailing newline
// Dynamic paste detection: wait for 5s of terminal silence
startSubmissionTimer(); // Resets on each chunk received
// Timer callback when paste is complete:
terminal.sendText("\r"); // Enter key in raw mode = carriage return
```

**Note**: The `/terminal-setup` command maps Shift+Enter to `\n` for inserting newlines. Regular Enter (`\r`) submits. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264).

### Issue: Large Prompts Taking Long to Paste (FIXED)

**Problem**: Very large prompts (8k+ lines with file attachments) can take a while to paste. The old approach of waiting for 5 seconds of silence was too slow, and a simple 1-second timeout caused false positives before any paste began.

**Additional complexity**: Different CLIs handle paste differently:

- **Copilot**: Shows nothing during paste, then displays `[Paste #1 - 2987 lines]` when complete
- **Claude**: Streams the text as it pastes, showing full content

**Solution**: Two-phase detection with verification:

```typescript
const PASTE_SILENCE_THRESHOLD_MS = 1000; // 1 second for responsiveness
const PROMPT_TAIL_LENGTH = 50;
const promptTail = promptText.slice(-PROMPT_TAIL_LENGTH).toLowerCase();
// Matches both: [Paste #1 - 2987 lines] and [Pasted text #2 +2124 lines]
const PASTE_INDICATOR_PATTERN =
  /\[Paste[d]?\s*(?:text\s*)?#?\d*\s*[-+]?\s*\d*\s*lines?\]/i;

const isPasteComplete = (): boolean => {
  // Check for CLI paste indicator (works for both Copilot and Claude)
  if (PASTE_INDICATOR_PATTERN.test(pasteVerificationBuffer)) return true;
  // Check for the tail of the prompt (fallback)
  if (bufferLower.includes(promptTail)) return true;
  return false;
};

const startSubmissionTimer = () => {
  clearTimeout(submissionTimeoutId);
  submissionTimeoutId = setTimeout(() => {
    if (isPasteComplete()) {
      terminal.sendText("\r", true); // Submit
    }
    // If not verified, keep waiting for more output
  }, PASTE_SILENCE_THRESHOLD_MS);
};
```

This approach is both fast (1s detection) and reliable (verified before submit).

### Issue: Case-sensitive Indicator Matching

**Problem**: TUI output has varying capitalization (`"Esc to cancel"` vs `"esc to cancel"`).

**Solution**: Normalize all comparisons to lowercase:

```typescript
const escapeIndicator = this.getEscapeIndicator().toLowerCase();
const recentOutputLower = recentOutput.toLowerCase();
const indicatorVisible = recentOutputLower.includes(escapeIndicator);
```

## Permission Handling

| Mode        | Without --allow-all-tools | With --allow-all-tools |
| ----------- | ------------------------- | ---------------------- |
| Headless    | Auto-denies permissions   | ✅ All tools allowed   |
| Interactive | User can respond (Y/n)    | ✅ All tools allowed   |

## Future Improvements

1. **Session continuity**: Reuse terminal for multi-step workflows without `--resume`
2. **Streaming to dashboard**: Currently streams to Output panel, could enhance dashboard display
3. **Timeout configuration**: Make TUI ready/completion timeouts configurable

## References

- VS Code Terminal API: https://code.visualstudio.com/api/references/vscode-api#Terminal
- VS Code Shell Integration: https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration
- Node.js child_process: https://nodejs.org/api/child_process.html

Here is the entire contents of #sym:src/flightpath/cli/BaseCliIntegration.ts:BaseCliIntegration:55-55

If you got all of that then the test passed. respond with "test passed" and summarize the info above.
