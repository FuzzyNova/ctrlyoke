# FlightPath 🚀

**Automate GitHub Copilot with structured prompt workflows**

FlightPath is a VS Code extension that enables developers to create automated, sequential workflows using GitHub Copilot through JSON-based prompt files with programmable end conditions.

## 🎯 New: Zero-Interaction Automation! ✨

**Press "Take Off" and walk away** - FlightPath now features proven, zero-interaction Copilot Chat automation:

- ✅ **Automatic Prompt Execution**: Prompts are typed and submitted automatically
- ✅ **Multi-Strategy Fallback**: Graceful degradation ensures workflows always complete  
- ✅ **Native Copilot Syntax**: Full support for `@workspace`, `#file`, slash commands
- ✅ **Real-Time Progress**: Watch workflows execute with live status updates

📚 **[Quick Start Guide](./QUICK_START.md)** | 📖 **[Full Documentation](./COPILOT_INTEGRATION.md)** | 🎓 **[Implementation Details](./IMPLEMENTATION_SUMMARY.md)**

## ✨ Features

### Core Functionality
- **🤖 Zero-Interaction Automation**: True "set-and-forget" Copilot Chat integration
- **📝 Structured Prompt Sequences**: Define multi-step workflows using JSON files
- **✅ End Condition Scripts**: Validate completion with Python, JavaScript, or shell scripts
- **🎯 Context-Aware Prompts**: Automatically include file content, selections, and workspace context
- **⏯️ Queue Management**: Pause, resume, and monitor execution progress
- **📊 Status Bar Integration**: Real-time workflow status and progress tracking

### Copilot Chat Automation (NEW!)
- **Direct Text Insertion**: Zero interaction - validated and proven approach
- **Command Sequence**: Automated submission with minimal user interaction
- **Enhanced Clipboard**: Intelligent fallback with prompt preview
- **Smart Context Formatting**: Automatic `@workspace`, `#file:path`, slash commands
- **Multi-Strategy Detection**: Automatically selects best available automation method

### File Format Support
- **`.prompt.json`**: Single prompt files for simple tasks
- **`.flightpath.json`**: Multi-prompt workflows for complex automation
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

**Simple Analysis** (`.prompt.json`):
```json
{
  "prompt": "Analyze this code for potential improvements",
  "context": {
    "includeCurrentFile": true
  }
}
```

**Multi-Step Workflow** (`.flightpath.json`):
```json
{
  "prompts": [
    {
      "prompt": "Identify code smells in this file",
      "context": { "includeCurrentFile": true }
    },
    {
      "prompt": "Suggest refactoring strategies"
    },
    {
      "prompt": "Show example implementation"
    }
  ]
}
```

### Execute Workflows

- **Command Palette**: `FlightPath: Take Off`
- **Select File**: Choose your `.prompt.json` or `.flightpath.json`
- **Click "Take Off"**: Workflow executes automatically!

### Monitor Progress

- **Status Bar**: Real-time step counter (e.g., "Step 2/5")
- **Copilot Chat**: Watch prompts appear and execute
- **Notifications**: Progress updates and completion alerts

## � Available Commands

| Command | Description |
|---------|-------------|
| `FlightPath: Take Off` | Execute a prompt workflow |
| `FlightPath: Show Copilot Integration Status` | View automation capabilities |
| `FlightPath: Test Automation` | Test Copilot Chat automation |
| `FlightPath: Create Prompt File` | Create new workflow file |
| `FlightPath: Pause Execution` | Pause running workflow |
| `FlightPath: Resume Execution` | Resume paused workflow |
| `FlightPath: Stop Execution` | Stop and reset workflow |
| `FlightPath: Show Debug State` | View internal state |

## �🔧 Configuration

FlightPath contributes the following settings:

- **`flightpath.promptsDirectory`**: Directory for prompt files (default: `.flightpath`)
- **`flightpath.scriptTimeout`**: Default timeout for end condition scripts (default: 30000ms)
- **`flightpath.enableContextAwareness`**: Enable automatic context inclusion (default: true)

## 🎯 Automation Strategies

FlightPath uses a multi-strategy approach for maximum reliability:

### 1. Direct Text Insertion (Primary) ✅
- **Status**: Proven and validated
- **Experience**: Zero interaction required
- **How**: Types prompts directly using VS Code commands
- **Speed**: Fastest execution

### 2. Command Sequence (Secondary) ✅
- **Status**: Reliable fallback
- **Experience**: Minimal interaction
- **How**: Clipboard + automated paste + submit
- **Speed**: Fast execution

### 3. Enhanced Clipboard (Tertiary) ✅
- **Status**: Always available
- **Experience**: Manual paste required
- **How**: Clipboard with helpful instructions
- **Speed**: Depends on user

FlightPath automatically detects and uses the best available strategy!

## 🐛 Known Issues

- End condition scripts run in separate processes (security feature)
- Windows PowerShell execution policy may require configuration
- Large workspace file inclusion may impact performance
- Automation requires active GitHub Copilot Chat extension

## 🛠️ Development Status

### ✅ Phase 2.5 Complete - Copilot Chat Integration
- [x] Zero-interaction automation (PROVEN)
- [x] Multi-strategy fallback system
- [x] Copilot Chat syntax formatting
- [x] Workflow progress tracking
- [x] Capability detection system
- [x] Status and testing commands

### ✅ Phase 2 Complete - Core Architecture
- [x] Extension structure and build system
- [x] JSON schema validation with IntelliSense
- [x] Core architecture implementation
- [x] Command registration and lifecycle management
- [x] Status bar integration
- [x] File system utilities and monitoring
- [x] End condition script execution
- [x] Copilot automation feasibility testing
- [x] Basic unit tests

### 📋 Current Phase - Copilot Integration
- [x] Copilot Chat automation proof-of-concept
- [ ] Enhanced GitHub Copilot integration with multi-strategy automation
- [ ] Context-aware prompt formatting with @workspace syntax
- [ ] WebView UI panel for file selection
- [ ] Advanced context awareness features
- [ ] Comprehensive test coverage

---

**Ready for takeoff? 🚀 Try the Command Palette: `FlightPath: Take Off`**

**Enjoy!**
