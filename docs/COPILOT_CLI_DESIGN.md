# Copilot CLI Integration Design

This document details FlightPath's integration with the GitHub Copilot CLI, including all available options, current implementation status, and planned enhancements.

## Overview

FlightPath uses the GitHub Copilot CLI (`copilot`) as the default integration mode for executing prompts. CLI mode provides deterministic completion detection, structured output, and better reliability compared to Chat window automation.

**Key file:** `src/flightpath/cli/CopilotCommandLineIntegration.ts`

## Current Implementation Status

### ✅ Implemented Flags

| CLI Flag                | FlightPath Setting/Schema                    | Implementation                                                                          |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--model <model>`       | `flightpath.copilotCliModel`, `prompt.model` | Full support - validates against CLI-supported models                                   |
| `--add-dir <directory>` | `flightpath.copilotCliAllowedDirs`           | Full support - workspace folders auto-included                                          |
| `--allow-all-tools`     | `flightpath.cliToolPermissions`              | Full support - "dangerouslyAllowAll", "allowAll", "custom" modes                        |
| `--allow-tool`          | `flightpath.cliAllowedTools`                 | Full support - pattern-based tool permissions                                           |
| `--deny-tool`           | `flightpath.cliDeniedTools`                  | Full support - deny patterns (takes precedence)                                         |
| `--allow-all-paths`     | `flightpath.copilotCliAllowAllPaths`         | Full support                                                                            |
| `--log-level <level>`   | _(hardcoded to `debug`)_                     | Always `debug` level (required for session ID extraction)                               |
| `--resume [sessionId]`  | `prompt.resumeSession`                       | Full support                                                                            |
| `-p, --prompt <text>`   | Prompt text                                  | Full support (always uses `--prompt` flag)                                              |
| `--agent <agent>`       | `prompt.agent`                               | **No longer used** - agent content prepended into prompt via `<agentInstructions>` tags |

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

- Session ID extracted from session event log files in `~/.copilot/session-state/`
- Session discovery uses prompt content matching in JSONL event logs
- `prompt.newChatSession: false` uses `--resume <sessionId>`
- `--continue` not implemented (we track explicit session IDs)

### Agent Selection

**Current behavior:**

- Agent content is prepended directly into the prompt using `<agentInstructions>` XML tags
- The `--agent` CLI flag is **no longer used**
- Works with all providers (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat)
- Agents discovered from `.github/agents/`, `.claude/agents/`, or user prompts directory

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
--log-level <level>      # none, error, warning, info, debug, all, default
```

**Log levels:**

- `none` - No logging
- `error` - Only errors
- `warning` - Errors and warnings
- `info`/`default` - Errors, warnings, and info
- `debug`/`all` - Everything including debug

**Current behavior:**

- `--log-level` **hardcoded to `debug`** (Copilot CLI creates logs in `~/.copilot/session-state/`)
- FlightPath monitors these log files for session discovery and completion detection
- Session IDs discovered by matching prompt content in event logs

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

**Goal:** Copilot CLI automatically manages its own logging.

**Implementation details:**

- `--log-level` is **hardcoded to `debug`** to ensure session event logging (required for session discovery)
- Copilot CLI writes logs to `~/.copilot/session-state/` (managed by CLI itself)
- FlightPath monitors these logs for session IDs and completion events using log file parsers

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
// Log level (hardcoded to debug for session resumption)
const logLevelArgs = this.getLogLevelArgs();
args.push(...logLevelArgs); // Always adds --log-level debug

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

// Agent: content is prepended into the prompt via <agentInstructions> tags
// The --agent CLI flag is no longer used; agent handling is done in buildPromptWithInstructions()

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

This documentation is based on Copilot CLI as of January 2026. Run `copilot --version` to check your installed version and `copilot --help` for the latest options.

**Log Format Change (v0.0.377+):** Session IDs are now logged in process log files (`process-{timestamp}-{pid}.log`) at DEBUG level only, requiring FlightPath to hardcode `--log-level debug`.
