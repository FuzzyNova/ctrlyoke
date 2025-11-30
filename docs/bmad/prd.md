# FlightPath - Claude Code CLI Integration PRD

**Author:** Nathan
**Date:** 2025-11-28
**Version:** 1.0

---

## Executive Summary

FlightPath currently supports GitHub Copilot CLI as its primary AI integration, enabling automated prompt workflows with deterministic completion detection. This PRD defines the addition of **Claude Code CLI** as a second integration option, giving users choice between the two leading AI coding assistants.

The goal is to provide **feature parity** with the existing `CopilotCommandLineIntegration`, allowing users to leverage Claude Code's agentic capabilities through the same FlightPath workflow automation system.

### What Makes This Special

**User Choice Between Best-in-Class AI Providers:** After extensive evaluation of AI coding assistants, Copilot and Claude Code stand out as the best options. FlightPath becomes the only workflow automation tool that supports both, letting users choose based on their preferences, enterprise requirements, or specific task strengths.

**Same Workflow, Different Brain:** Users can switch between Copilot and Claude Code without changing their `.flightpath.json` workflows - just change a setting.

---

## Project Classification

**Technical Type:** Developer Tool (VS Code Extension)
**Domain:** General Software Development
**Complexity:** Low (standard software practices apply)

This is a **brownfield enhancement** to an existing VS Code extension. The integration follows established patterns already proven with `CopilotCommandLineIntegration.ts`.

---

## Success Criteria

1. **Feature Parity**: All capabilities of `CopilotCommandLineIntegration` work identically with Claude Code CLI
2. **Seamless Switching**: Users can switch between Copilot and Claude Code via a single setting change
3. **Zero Workflow Changes**: Existing `.flightpath.json` files work without modification
4. **Same User Experience**: Dashboard, status bar, output channel all work identically
5. **Reliable Detection**: Claude Code CLI availability detection works cross-platform (Windows, macOS, Linux)

---

## Product Scope

### MVP - Minimum Viable Product

Feature parity with `CopilotCommandLineIntegration.ts`:

1. **CLI Detection & Initialization**
   - Detect Claude Code CLI availability (`claude --version`)
   - Cross-platform support (Windows, macOS, Linux)
   - Status reporting (Ready, Unavailable, Initializing)

2. **Prompt Execution**
   - Send prompts via `-p` flag (print mode, non-interactive)
   - Stdin support for prompt text
   - Streaming output support with real-time chunk emission

3. **Model Selection**
   - Support Claude models: `sonnet`, `opus`, `haiku` (aliases)
   - Full model names: `claude-sonnet-4-5-20250929`, etc.
   - Configurable default model via settings

4. **Session Management**
   - Session continuation via `-c` flag
   - Session resume via `-r <session-id>` flag
   - New session per workflow option

5. **Directory Access**
   - `--add-dir` support for workspace directories
   - Configurable additional directories

6. **Tool Permissions**
   - `--dangerously-skip-permissions` for fully automated execution
   - `--allowedTools` / `--disallowedTools` for fine-grained control

7. **Output Handling**
   - Parse response from stdout
   - Support `--output-format json` for structured parsing
   - Token/usage statistics extraction
   - Error handling with helpful messages

8. **Integration Events**
   - Status change events
   - Response complete events
   - Streaming chunk events
   - Prompt ready events

9. **Cancellation Support**
   - Process termination on cancel
   - Clean state reset

### Growth Features (Post-MVP)

1. **JSON Schema Validation**: Leverage `--json-schema` for validated structured outputs
2. **Max Turns Control**: Use `--max-turns` for safety limits on agentic behavior
3. **Custom System Prompts**: Support `--append-system-prompt` for workflow-specific instructions
4. **Verbose Logging**: `--verbose` flag for debugging
5. **Subagents**: Dynamic agent definition via `--agents` JSON
6. **Extended Thinking**: Leverage Claude's extended thinking for complex reasoning tasks

### Vision (Future)

1. **Multi-Provider Workflows**: Single workflow that uses different providers for different steps
2. **Provider Fallback**: Automatic fallback if primary provider unavailable
3. **Cost Optimization**: Route prompts to most cost-effective provider based on complexity
4. **Provider-Specific Features**: Expose unique capabilities of each provider

---

## Developer Tool Specific Requirements

### CLI Command Mapping

| Copilot CLI              | Claude Code CLI                     | Notes                            |
| ------------------------ | ----------------------------------- | -------------------------------- |
| `copilot`                | `claude`                            | Base command                     |
| `--version`              | `--version`                         | Availability check               |
| stdin for prompt         | `-p "prompt"`                       | Print mode (non-interactive)     |
| `--model <name>`         | `--model <alias or name>`           | Model selection                  |
| `--resume <id>`          | `-r <session-id>`                   | Resume specific session          |
| N/A                      | `-c`                                | Continue most recent session     |
| `--add-dir <path>`       | `--add-dir <path>`                  | Directory access                 |
| `--allow-all-tools`      | `--dangerously-skip-permissions`    | Skip all permission prompts      |
| `--allow-tool <pattern>` | `--allowedTools <pattern>`          | Allow specific tools             |
| `--deny-tool <pattern>`  | `--disallowedTools <pattern>`       | Deny specific tools              |
| `--allow-all-paths`      | N/A (implied with skip-permissions) | Path access                      |
| `--log-dir <path>`       | N/A                                 | Log directory (Copilot-specific) |
| `--log-level <level>`    | `--verbose`                         | Logging verbosity                |
| `--agent <name>`         | `--agents <json>`                   | Custom agents                    |
| N/A                      | `--output-format json`              | Structured JSON output           |
| N/A                      | `--max-turns <n>`                   | Limit agentic turns              |
| N/A                      | `--append-system-prompt`            | Custom system prompt             |

### Output Parsing Strategy

**Copilot CLI**: Delimiter-based parsing

- Response text before `Total usage est:` marker
- Statistics after the marker

**Claude Code CLI**: JSON output parsing (recommended)

- Use `--output-format json` for structured response
- Parse JSON for response content and metadata
- Fallback to text parsing if JSON unavailable

### Model Constants

New model constants file needed for Claude Code:

```typescript
// Claude Code CLI supported model aliases
export const CLAUDE_CLI_MODEL_ALIASES = ["sonnet", "opus", "haiku"] as const;

// Full model names (as of Nov 2025)
export const CLAUDE_CLI_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514",
  "claude-haiku-4-20250514",
] as const;
```

### Configuration Settings (New)

| Setting                               | Type     | Default     | Description                                             |
| ------------------------------------- | -------- | ----------- | ------------------------------------------------------- |
| `flightpath.claudeCliModel`           | enum     | `"sonnet"`  | Default model for Claude Code CLI                       |
| `flightpath.claudeCliToolPermissions` | enum     | `"skipAll"` | Permission mode                                         |
| `flightpath.cliAllowedTools`          | string[] | `[]`        | Shared tool patterns (Copilot format, auto-converted)   |
| `flightpath.cliDeniedTools`           | string[] | `[]`        | Shared denied patterns (Copilot format, auto-converted) |
| `flightpath.claudeCliOutputFormat`    | enum     | `"json"`    | Output format preference                                |

**Note:** Tool permission settings (`cliAllowedTools`, `cliDeniedTools`) are shared between Copilot and Claude CLI. They use Copilot CLI format and are automatically converted for Claude (`shell` → `Bash`, `write` → `Write`).

### Integration Mode Extension

Current setting `flightpath.provider` supports: `"cli"` | `"chat"`

**Proposed extension:**

- `"copilot-cli"` - GitHub Copilot CLI (current default)
- `"claude-cli"` - Claude Code CLI (new)
- `"copilot-chat"` - Copilot Chat window (existing)

Or alternatively, add new setting:

- `flightpath.cliProvider`: `"copilot"` | `"claude"` (when mode is `"cli"`)

---

## Functional Requirements

### Core Integration

- **FR1**: System can detect if Claude Code CLI is installed by running `claude --version`
- **FR2**: System reports Claude CLI availability status (Ready, Unavailable, Initializing)
- **FR3**: System can send prompts to Claude Code using `-p` flag for non-interactive execution
- **FR4**: System receives complete response when Claude Code CLI command exits
- **FR5**: System can stream response chunks in real-time during execution

### Model Selection

- **FR6**: Users can configure default Claude model via VS Code settings
- **FR7**: Prompts can override model on a per-prompt basis via `model` field
- **FR8**: System validates model against supported models and warns on unsupported
- **FR9**: System supports both model aliases (`sonnet`) and full names (`claude-sonnet-4-5-20250929`)

### Session Management

- **FR10**: System can start new conversation sessions
- **FR11**: System can continue most recent session using `-c` flag
- **FR12**: System can resume specific session by ID using `-r` flag
- **FR13**: `newChatSession: true` in prompt starts fresh session
- **FR14**: `newChatSession: false` continues existing session

### Directory & Tool Permissions

- **FR15**: System automatically adds workspace directories via `--add-dir`
- **FR16**: Users can configure additional allowed directories
- **FR17**: System can skip all permission prompts with `--dangerously-skip-permissions`
- **FR18**: Users can configure specific allowed/disallowed tool patterns
- **FR19**: Tool permission configuration mirrors Copilot CLI patterns

### Output & Response Handling

- **FR20**: System parses Claude response from stdout
- **FR21**: System can use JSON output format for structured parsing
- **FR22**: System extracts token usage statistics when available
- **FR23**: System provides response text to end condition evaluators
- **FR24**: System logs prompts and responses to Output channel (when enabled)

### Event System

- **FR25**: System fires status change events (Initializing → Ready/Unavailable)
- **FR26**: System fires response complete events with response text
- **FR27**: System fires streaming chunk events during execution
- **FR28**: System fires prompt ready events before execution starts

### Error Handling

- **FR29**: System handles Claude CLI not found gracefully
- **FR30**: System handles execution errors with user-friendly messages
- **FR31**: System handles timeout with configurable duration
- **FR32**: System provides enhanced error messages for common issues

### Cancellation

- **FR33**: Users can cancel running Claude CLI process
- **FR34**: Cancellation kills active process cleanly
- **FR35**: System resets state properly after cancellation

### Dashboard Integration

- **FR36**: Dashboard displays Claude CLI prompts and responses
- **FR37**: Dashboard shows token statistics when available
- **FR38**: Dashboard indicates which CLI provider is active
- **FR39**: Status bar reflects Claude CLI status

---

## Non-Functional Requirements

### Performance

- **NFR1**: CLI availability check completes within 5 seconds
- **NFR2**: Streaming chunks delivered to UI within 100ms of receipt
- **NFR3**: Process cancellation completes within 1 second

### Security

- **NFR4**: No credentials stored in extension state (relies on CLI authentication)
- **NFR5**: Tool permissions respect user configuration
- **NFR6**: Directory access limited to configured paths

### Compatibility

- **NFR7**: Works on Windows, macOS, and Linux
- **NFR8**: Supports Claude Code CLI installed via npm, curl, or homebrew
- **NFR9**: Compatible with VS Code 1.85.0+

### Maintainability

- **NFR10**: Implementation follows existing `CopilotIntegration` abstract class pattern
- **NFR11**: Shares common code via base class where possible
- **NFR12**: Configuration follows existing naming conventions

---

## Architecture Considerations

### Class Hierarchy

```
CopilotIntegration (abstract base)
├── CopilotCommandLineIntegration (existing)
├── CopilotChatIntegration (existing)
└── ClaudeCommandLineIntegration (new)
```

### Shared Functionality (via base class)

- Event emitters (status, response, streaming)
- Prompt building with dynamic queue instructions
- File attachment processing
- Cancellation flag management
- Workspace root detection

### Claude-Specific Implementation

- `claude` command execution
- Claude-specific argument building
- JSON output parsing
- Claude model validation
- Session management (different flags)

### Factory Pattern Update

`FlightPathManager` factory needs to support new integration mode:

```typescript
private createCopilotIntegration(): CopilotIntegration {
  const mode = this.getIntegrationMode();

  switch (mode) {
    case "claude-cli":
      return new ClaudeCommandLineIntegration(this.context, this.outputChannel);
    case "copilot-cli":
    case "cli":  // backward compatibility
      return new CopilotCommandLineIntegration(this.context, this.outputChannel);
    case "copilot-chat":
    case "chat":  // backward compatibility
      return new CopilotChatIntegration(this.context, ...);
  }
}
```

---

## Implementation Notes

### Files to Create

1. `src/flightpath/cli/ClaudeCommandLineIntegration.ts` - Main implementation
2. `src/types/ClaudeTypes.ts` - Claude-specific types (optional, may extend existing)

### Files to Modify

1. `src/types/ModelConstants.ts` - Add Claude model constants
2. `src/types/FlightPathTypes.ts` - Add `"claude-cli"` to integration mode enum
3. `src/flightpath/FlightPathManager.ts` - Update factory pattern
4. `package.json` - Add Claude-specific settings

### Testing Strategy

1. Unit tests mirroring `CopilotCommandLineIntegration.test.ts`
2. Manual testing with Claude Code CLI installed
3. Cross-platform verification (Windows priority, then macOS/Linux)

---

_This PRD captures the essence of FlightPath Claude Code Integration - giving developers choice between best-in-class AI coding assistants through a unified workflow automation system._

_Created through collaborative discovery between Nathan and AI facilitator._
