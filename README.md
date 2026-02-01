# FlightPath 🚀

**Universal AI CLI Automation Platform for VS Code**

FlightPath is a VS Code extension that transforms AI assistants into automated agents through structured YAML/JSON workflows. Execute multi-step AI workflows with validation, session management, and dynamic task planning across multiple AI providers. Built the prompt queue yourself or have AI build it for you.

## 🤖 Multi-Provider AI Support

**One workflow format, multiple AI providers** - FlightPath works seamlessly with:

| Provider               | Model Options                         | Execution Mode           |
| ---------------------- | ------------------------------------- | ------------------------ |
| **GitHub Copilot CLI** | Claude Sonnet 4.5/4, Haiku 4.5, GPT-5 | CLI (Default)            |
| **Claude Code CLI**    | Sonnet, Sonnet[1m], Opus, Haiku       | CLI                      |
| **Codex CLI**          | GPT-5.2, GPT-5.1 Codex variants       | CLI                      |
| **Copilot Chat**       | All Copilot models (22+)              | UI Automation (Fallback) |

**Zero core changes architecture**: Adding new providers requires NO modifications to FlightPath's core - each provider is completely isolated with its own response parser, completion detection, and tool permission mapping.

## 🎯 Zero-Interaction Automation

**Press "Take Off" and walk away** - FlightPath features proven, zero-interaction automation across all providers:

- ✅ **Automatic Execution**: Prompts sent and processed without user interaction
- ✅ **Smart Completion Detection**: Provider-specific detection (logs, hooks, events)
- ✅ **Context Awareness**: Full support for `@workspace`, `#file`, slash commands
- ✅ **Real-Time Progress**: Live status updates and CLI output streaming
- ✅ **Session Continuity**: Resume conversations across prompts and restarts

📚 **[Quick Start Guide](./QUICK_START.md)** | 📖 **[CLI Integration Docs](./docs/COPILOT_CLI_DESIGN.md)** | ✨ **[XML Prompting Guidelines](./docs/XML_PROMPTING_GUIDELINES.md)**

## ✨ Features

### Multi-Provider Architecture

- **🔌 Provider Flexibility**: Switch between Copilot CLI, Claude CLI, Codex CLI, or Copilot Chat
- **🏗️ Composition-Based Design**: Single generic integration class works with all providers via interface
- **📦 Zero Core Changes**: Add new AI providers without modifying FlightPath's core code
- **🔄 Automatic Tool Mapping**: Unified permission system auto-converts to provider-specific formats
- **📊 Provider-Specific Features**: Hook-based detection (Claude), JSONL events (Codex), log parsing (Copilot)

### Core Workflow Automation

- **🤖 Zero-Interaction Execution**: True "set-and-forget" automation across all providers
- **📝 Structured Workflows**: Define multi-step sequences using YAML/JSON/Markdown files
- **🎯 Final-Form Prompts**: Prompts stored with context variables (@workspace, #file, slash commands) ready to send
- **➕ Dynamic Queue Extension**: AI agents can autonomously extend workflows via MCP tools ([docs](./docs/QUEUE_APPEND_FEATURE.md))
- **✨ Intelligent Autocomplete**: File and selection completions for prompt files ([docs](./docs/ENHANCED_PROMPT_EDITING.md))
- **⏯️ Execution Control**: Pause, resume, stop workflows with full state preservation
- **📊 WebView Dashboard**: Real-time visual tracking with live CLI output streaming ([docs](./docs/DASHBOARD_TESTING.md))
- **📊 Status Bar Integration**: Live workflow status and progress tracking

### Execution Modes & Integration

**CLI Mode** (Recommended - Default for all CLI providers):

- **Interactive Terminal**: Live output with TUI, Ctrl+C abort capability
- **Headless Background**: Silent execution for complete automation
- **Log-Based Detection**: Parses provider logs for session IDs and completion
- **Hook-Based Detection**: Native completion signals (Claude stop hook, Codex notify)
- **Event Streaming**: Structured JSONL/JSON events for real-time updates

**Chat Mode** (Copilot Chat UI - Fallback):

- **Direct Text Insertion**: Zero-interaction automation - validated approach
- **Language Model Tool API**: Detects completion automatically
- **Streaming Detection**: Monitors chat stability before proceeding
- **Submit Verification**: Clipboard-based verification ensures prompts sent

**Universal Features** (All Modes):

- **XML-Structured Instructions**: Clear separation of user prompts and automation directives ([XML Guidelines](./docs/XML_PROMPTING_GUIDELINES.md))
- **Smart Context Formatting**: Automatic `@workspace`, `#file:path`, slash commands
- **Availability Detection**: Background polling for provider readiness

### File Format Support

- **`.prompt.md`**: Markdown-based single prompts (simplest format, no YAML/JSON needed)
- **`.flightpath.yaml` / `.flightpath.yml`**: Multi-step workflows (YAML format, recommended for manual editing)
- **`.flightpath.json`**: Multi-step workflows (JSON format, best for automation/CI/CD)
- **Context Menu Integration**: Right-click any prompt file → **Run with FlightPath** or **Load in FlightPath**
- **JSON Schema Validation**: IntelliSense and validation in VS Code for both YAML and JSON
- **Example Files**: Ready-to-use YAML and JSON templates in `.flightpath/examples/`

### Workflow Properties

**Define defaults once, use everywhere** - Set provider, model, agent, and other execution settings at the workflow level:

- **Three-Tier Precedence**: Prompt > Workflow > Global Settings
- **Reproducibility**: Workflows include their own defaults, ensuring consistent behavior across team members
- **Workflow-Wide Validation**: Apply end conditions to all prompts with selective overrides
- **DRY Principle**: Define shared settings once instead of repeating for each prompt
- **Better Sharing**: Share workflows with embedded configuration, reducing setup required

**Quick Example:**

```yaml
# Workflow defaults apply to all prompts
provider: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"

prompts:
  - prompt: "Implement feature"
    # Inherits provider, model, and end condition

  - prompt: "Update docs"
    endCondition: null # Override: Skip tests for docs
```

📚 **[Complete Workflow Properties Guide](./docs/WORKFLOW_PROPERTIES.md)** | 📁 **[Example Workflows](./manual-test/workflow-properties-examples/)**

### Session Management

**Resume conversations across prompts** - Control which prompts share context and which start fresh:

- **Numeric References**: `sessionId: 1` reuses session from prompt 1
- **Auto-Resume**: `newChatSession: false` continues previous conversation
- **Exact Session IDs**: Resume specific sessions with UUID strings
- **Cross-Restart Persistence**: Sessions survive VS Code restarts (saved in working files)
- **Provider-Aware**: Validates session compatibility across Copilot CLI, Claude CLI, and Codex CLI

**Quick Example:**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze security issues"
    # Starts new session

  - id: implement
    prompt: "Fix the issues"
    sessionId: 1 # Continue from analyze session

  - id: verify
    prompt: "Verify fixes"
    newChatSession: true # Start fresh for independent review
```

📚 **[Complete Session Management Guide](./docs/SESSION_MANAGEMENT.md)** | 📁 **[Session Examples](./manual-test/session-examples/)**

### Safety & Control

- **Script Validation**: Path validation and security checks for end condition scripts
- **Timeout Management**: Configurable timeouts for script execution
- **Error Handling**: Comprehensive error reporting and recovery
- **Graceful Degradation**: Multi-level fallback system ensures workflows complete

## 📋 Requirements

### Core Requirements

- **VS Code**: Version 1.85.0 or higher
- **Node.js**: Version 18+ (for end condition scripts and MCP server)

### AI Provider Requirements (Choose One or More)

**GitHub Copilot CLI** (Recommended):

- Install: `npm install -g @github/copilot-cli`
- Requires: GitHub Copilot subscription
- Models: Claude Sonnet 4.5/4, Haiku 4.5, GPT-5

**Claude Code CLI**:

- Install: Follow [Claude Code installation guide](https://github.com/anthropics/claude-code)
- Requires: Anthropic API key
- Models: Sonnet, Sonnet[1m] (extended context), Opus, Haiku

**Codex CLI**:

- Install: Follow [Codex CLI installation guide](https://github.com/openai/codex-cli)
- Requires: OpenAI API key
- Models: GPT-5.2, GPT-5.1 Codex variants

**Copilot Chat** (Fallback):

- Install: GitHub Copilot extension in VS Code
- Requires: GitHub Copilot subscription
- Models: 22+ Copilot models

### Optional Dependencies

- **Python**: For Python-based end condition scripts
- **Git**: For workspace context and file operations
- **MCP Server**: Auto-started when dynamic queue enabled

## 🚀 Getting Started

### Quick Start (5 Minutes)

1. **Check Automation Status**

   ```
   Command Palette → FlightPath: Show Copilot Integration Status
   ```

2. **Test Automation (Recommended)**

   ```
   Command Palette → FlightPath: Test Automation
   ```

3. **Run Demo Workflow**

   ```
   Command Palette → FlightPath: Take Off
   Select: .flightpath/examples/zero-interaction-demo.flightpath.json
   ```

4. **Watch It Work!** 🎉
   - Copilot Chat opens automatically
   - Prompts are typed and submitted
   - Workflow progresses without interaction

📚 **See [QUICK_START.md](./QUICK_START.md) for detailed walkthrough**

### Create Your First Workflow

**Simple Markdown Prompt** (`.prompt.md`):

```markdown
Analyze the FlightPath extension architecture and suggest improvements for better code organization. Focus on the separation of concerns between components.
```

**Simple YAML Analysis** (`.flightpath.yaml`):

```yaml
prompt: |
  Analyze #file:src/extension.ts for potential improvements.

  Focus on:
  - Code organization
  - Type safety
  - Error handling

model: claude-sonnet-4.5
```

**Multi-Step Workflow** (`.flightpath.yaml`):

```yaml
prompts:
  - id: analyze
    prompt: |
      Analyze @workspace for security vulnerabilities.

      Focus on input validation and authentication.
    model: claude-sonnet-4.5

  - id: fix
    prompt: |
      Fix the issues identified in the analysis.
    endCondition:
      script: npm test
      returns: "true"
```

]
}

````

**Optional Fields**:

- `model` - Override AI model per prompt (`claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`)

**Using Context Variables**:

- `@workspace` - Include workspace-wide context
- `#file:path/to/file.ext` - Reference specific files
- `#file:path/to/file.ext:45-120` - Reference specific line ranges
- `#selection` - Reference current editor selection
- `/fix`, `/explain`, `/new`, `/tests` - Slash commands for specific tasks

### Execute Workflows

**Via Command Palette**:

- **Command Palette**: `FlightPath: Take Off`
- **Select File**: Choose your `.flightpath.yaml`, `.flightpath.json`, or `.prompt.md`
- **Click "Take Off"**: Workflow executes automatically!

**Via Context Menu** (Right-click on any prompt file):

- **FlightPath: Run with FlightPath** - Execute the workflow using your configured provider
- **FlightPath: Load in FlightPath** - Load the workflow into the dashboard without running

You can also click the play icon in the editor title bar to quickly run a prompt file.

### Monitor Progress

- **Status Bar**: Real-time step counter (e.g., "Step 2/5")
- **Copilot Chat**: Watch prompts appear and execute
- **Notifications**: Progress updates and completion alerts

## � Available Commands

| Command                                       | Description                  |
| --------------------------------------------- | ---------------------------- |
| `FlightPath: Take Off`                        | Execute a prompt workflow    |
| `FlightPath: Show Copilot Integration Status` | View automation capabilities |
| `FlightPath: Test Automation`                 | Test Copilot Chat automation |
| `FlightPath: Create Prompt File`              | Create new workflow file     |
| `FlightPath: Pause Execution`                 | Pause running workflow       |
| `FlightPath: Resume Execution`                | Resume paused workflow       |
| `FlightPath: Stop Execution`                  | Stop and reset workflow      |
| `FlightPath: Show Debug State`                | View internal state          |

## 🔧 Configuration

FlightPath contributes the following settings:

- **`flightpath.promptsDirectory`**: Directory for prompt files (default: `.flightpath`)
- **`flightpath.scriptTimeout`**: Timeout for end condition scripts in seconds (default: 30s)
- **`flightpath.chatWindowLocation`**: Choose where to open Copilot Chat for automation
  - `chatPanel` (default): Open in the Chat panel - recommended for most users
  - `newTab`: Open in an editor tab
  - `newWindow`: Open in a new window

### Configuring Chat Window Location

To change where FlightPath opens Copilot Chat:

1. Open VS Code Settings (File > Preferences > Settings)
2. Search for "FlightPath Chat Window"
3. Select your preferred location from the dropdown

Alternatively, edit your `settings.json`:

```json
{
  "flightpath.chatWindowLocation": "chatPanel"
}
````

## 🎯 How Automation Works

FlightPath uses **provider-specific strategies** optimized for each AI platform:

### CLI Mode (Copilot, Claude, Codex)

**Recommended approach** - Most reliable, fully deterministic:

1. **Provider Detection**: Checks CLI availability (`copilot`/`claude`/`codex` command)
2. **Session Resolution**: Determines new vs. resumed session per-prompt
3. **Tool Permissions**: Applies allow/deny patterns with provider-specific conversion
4. **Execution Launch**:
   - **Interactive**: Opens VS Code terminal with TUI (live output, Ctrl+C abort)
   - **Headless**: Silent background process (for complete automation)
5. **Prompt Delivery**:
   - Simple prompts (≤300 chars): Direct via command args
   - Complex prompts: Temporary file with `--prompt-file` flag
6. **Completion Detection**:
   - **Copilot**: Log file parsing for session IDs and completion markers
   - **Claude**: Stop hook callback (`--stop-hook`) for native completion signal
   - **Codex**: JSONL events + notify hook for structured turn completion
7. **Response Parsing**: Provider-specific parsers extract structured events (thinking, tokens, tool calls)
8. **Next Prompt**: Continues with resolved session ID for continuity

### Chat Mode (Copilot Chat UI - Fallback)

**When CLI unavailable** - Proven through extensive testing:

1. **Background Polling**: Detects Copilot Chat availability on startup
2. **Focus Chat**: Opens Copilot Chat in configured location (panel/tab/window)
3. **Clear Input**: Selects and clears any existing text
4. **Type Prompt**: Types formatted prompt with context (@workspace, #file, etc.)
5. **Submit & Verify**: Submits and verifies prompt appears in chat (with retry)
6. **Language Model Tool API**: Detects when Copilot finishes responding
7. **Log Monitoring**: Two-tier log discovery (context.logUri + fallback search)
8. **Streaming Check**: Monitors chat stability before next prompt (3 consecutive stable checks)

### Provider Auto-Selection

FlightPath automatically falls back through providers:

```
Preferred Provider (setting: flightpath.provider)
    ↓ (if unavailable)
Copilot Chat (if GitHub Copilot extension active)
    ↓ (if unavailable)
Error: No AI provider available
```

### What If It Fails?

FlightPath provides clear error messages with:

- **Provider Requirements**: What's needed for each mode
- **Troubleshooting Steps**: How to resolve common issues
- **Manual Retry**: Option to restart detection
- **Alternative Providers**: Suggestions for fallback options

No silent fallbacks - you always know the system state!

### Feature

- **CLI Mode** (Default): Deterministic Copilot automation via CLI with model selection
- **Chat Mode**: UI-based automation with Language Model Tool API response detection
- **Dynamic Queue**: Copilot can extend workflows autonomously with safety guardrails
- **End Conditions**: Script-based validation with automatic retry and template placeholders
- **WebView Dashboard**: Real-time workflow visualization with live CLI output streaming
- Zero-interaction Copilot Chat automation
- Clipboard-based submit verification with retry logic
- Streaming completion detection (monitors chat stability)
- Background polling for Copilot availability detection
- Copilot Chat syntax formatting (@workspace, #file, slash commands)
- Workflow progress tracking and status bar updates
- Configurable chat window location (panel/tab/window)
- JSON schema validation with IntelliSense
- Command registration and lifecycle management
- 215+ automated tests

---

**Enjoy!**
