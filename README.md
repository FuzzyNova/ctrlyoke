# FlightPath 🚀

**Automate GitHub Copilot with structured prompt workflows**

FlightPath is a VS Code extension that enables developers to create automated, sequential workflows using GitHub Copilot through JSON-based prompt files with programmable end conditions.

## 🎯 Zero-Interaction Automation

**Press "Take Off" and walk away** - FlightPath features proven, zero-interaction Copilot Chat automation:

- ✅ **Automatic Prompt Execution**: Prompts are typed and submitted automatically
- ✅ **Response Detection**: Language Model Tool API detects when Copilot finishes responding
- ✅ **Native Copilot Syntax**: Full support for `@workspace`, `#file`, slash commands
- ✅ **Real-Time Progress**: Watch workflows execute with live status updates

📚 **[Quick Start Guide](./QUICK_START.md)** | 📖 **[Full Documentation](./docs/COPILOT_INTEGRATION.md)** | ✨ **[XML Prompting Guidelines](./docs/XML_PROMPTING_GUIDELINES.md)**

## ✨ Features

### Core Functionality

- **🤖 Zero-Interaction Automation**: True "set-and-forget" Copilot Chat integration
- **📝 Structured Prompt Sequences**: Define multi-step workflows using JSON files
- **🎯 Final-Form Prompts**: Store prompts with context variables (@workspace, #file, slash commands) ready to send
- **✨ Intelligent Autocomplete**: File and selection completions for prompt files ([docs](./docs/ENHANCED_PROMPT_EDITING.md))
- **⏯️ Queue Management**: Pause, resume, and monitor execution progress
- **📊 Status Bar Integration**: Real-time workflow status and progress tracking

### Copilot Chat Automation

- **Direct Text Insertion**: Zero interaction - validated and proven approach
- **Response Detection**: Language Model Tool API detects completion automatically
- **Submit Verification**: Clipboard-based verification ensures prompts are sent
- **Streaming Detection**: Monitors chat stability before proceeding to next prompt
- **XML-Structured Prompts**: Uses XML tags for clarity and better AI comprehension (see [XML Guidelines](./docs/XML_PROMPTING_GUIDELINES.md))
- **Smart Context Formatting**: Automatic `@workspace`, `#file:path`, slash commands
- **Background Polling**: Detects Copilot availability on startup (5s intervals, 30s max)

### File Format Support

- **`.prompt.json`**: Single prompt files for simple tasks
- **`.flightpath.json`**: Multi-prompt workflows for complex automation
- **`.prompt.md`**: Markdown-based single prompts (no JSON needed)
- **Context Menu Integration**: Right-click any prompt file → Send to CLI or Send to Chat
- **JSON Schema Validation**: IntelliSense and validation in VS Code
- **Example Files**: Ready-to-use templates in `.flightpath/examples/`

### Safety & Control

- **Script Validation**: Path validation and security checks for end condition scripts
- **Timeout Management**: Configurable timeouts for script execution
- **Error Handling**: Comprehensive error reporting and recovery
- **Graceful Degradation**: Multi-level fallback system ensures workflows complete

## 📋 Requirements

- **VS Code**: Version 1.85.0 or higher
- **Node.js**: Version 18+ (for end condition scripts)
- **GitHub Copilot**: Recommended but not required (manual fallback available)

### Optional Dependencies

- **Python**: For Python-based end condition scripts
- **Git**: For workspace context and file operations

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

**Simple JSON Analysis** (`.prompt.json`):

```json
{
  "prompt": "/explain #file:src/extension.ts Analyze this code for potential improvements",
  "model": "claude-haiku-4.5"
}
```

**Multi-Step Workflow** (`.flightpath.json`):

```json
{
  "prompts": [
    {
      "prompt": "/explain #file:src/extension.ts Identify code smells in this file",
      "model": "claude-sonnet-4.5"
    },
    {
      "prompt": "/explain #file:src/extension.ts Suggest refactoring strategies"
    },
    {
      "prompt": "/new #file:src/extension.ts Show example implementation",
      "model": "gpt-5"
    }
  ]
}
```

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
- **Select File**: Choose your `.prompt.json`, `.flightpath.json`, or `.prompt.md`
- **Click "Take Off"**: Workflow executes automatically!

**Via Context Menu** (Right-click on any prompt file):

- **FlightPath: Send to CLI** - Execute using Copilot CLI (default, deterministic completion)
- **FlightPath: Send to Chat** - Execute using Copilot Chat (streaming with tool-based detection)

The context menu allows you to override your default integration mode for a specific execution, making it easy to test both CLI and Chat modes.

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
- **`flightpath.scriptTimeout`**: Default timeout for end condition scripts (default: 30000ms)
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
```

## 🎯 How Automation Works

FlightPath uses a proven single-strategy approach for reliable automation:

### Direct Text Insertion with Verification

- **Status**: Proven and validated through extensive testing
- **Experience**: Zero interaction required
- **Process**:
  1. **Background Polling**: Detects Copilot availability on startup
  2. **Focus Chat**: Opens Copilot Chat in configured location (panel/tab/window)
  3. **Clear Input**: Selects and clears any existing text
  4. **Type Prompt**: Types formatted prompt with context (@workspace, #file, etc.)
  5. **Submit & Verify**: Submits and verifies prompt appears in chat (with retry)
  6. **Wait for Tool**: Language Model Tool signals when Copilot finishes
  7. **Streaming Check**: Monitors chat stability before next prompt (3 consecutive stable checks)

### What If It Fails?

If Copilot Chat isn't available or automation fails, FlightPath shows a clear error message with:

- **Requirements**: What's needed for automation to work
- **Troubleshooting Steps**: How to resolve common issues
- **Manual Retry**: Option to restart detection

No silent fallbacks - you always know the system state!

## 🐛 Known Issues

- End condition scripts run in separate processes (security feature)
- Windows PowerShell execution policy may require configuration
- Large workspace file inclusion may impact performance
- Automation requires active GitHub Copilot Chat extension

## 🛠️ Current Features

### ✅ Implemented

- Zero-interaction Copilot Chat automation
- Language Model Tool API for response detection
- Clipboard-based submit verification with retry logic
- Streaming completion detection (monitors chat stability)
- Background polling for Copilot availability detection
- Copilot Chat syntax formatting (@workspace, #file, slash commands)
- Workflow progress tracking and status bar updates
- Configurable chat window location (panel/tab/window)
- JSON schema validation with IntelliSense
- Command registration and lifecycle management
- File system utilities and prompt file discovery

### � Planned Features

- End condition script execution and validation
- WebView UI panel for visual workflow management
- Advanced context awareness features
- Workflow templates and snippets
- Comprehensive test coverage
- Integration with VS Code notebooks

---

**Ready for takeoff? 🚀 Try the Command Palette: `FlightPath: Take Off`**

**Enjoy!**
