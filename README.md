# FlightPath 🚀

**Automate GitHub Copilot with structured prompt workflows**

FlightPath is a VS Code extension that enables developers to create automated, sequential workflows using GitHub Copilot through JSON-based prompt files with programmable end conditions.

## ✨ Features

### Core Functionality
- **Structured Prompt Sequences**: Define multi-step workflows using JSON files
- **End Condition Scripts**: Validate completion with Python, JavaScript, or shell scripts
- **Context-Aware Prompts**: Automatically include file content, selections, and workspace context
- **Queue Management**: Pause, resume, and monitor execution progress
- **Status Bar Integration**: Real-time workflow status and progress tracking

### File Format Support
- **`.prompt.json`**: Single prompt files for simple tasks
- **`.flightpath.json`**: Multi-prompt workflows for complex automation
- **JSON Schema Validation**: IntelliSense and validation in VS Code
- **Example Files**: Ready-to-use templates in `.flightpath/examples/`

### Safety & Control
- **Script Validation**: Path validation and security checks for end condition scripts
- **Timeout Management**: Configurable timeouts for script execution
- **Error Handling**: Comprehensive error reporting and recovery
- **Manual Fallback**: Copy prompts to clipboard when Copilot integration unavailable

## 📋 Requirements

- **VS Code**: Version 1.85.0 or higher
- **Node.js**: Version 18+ (for end condition scripts)
- **GitHub Copilot**: Recommended but not required (manual fallback available)

### Optional Dependencies
- **Python**: For Python-based end condition scripts
- **Git**: For workspace context and file operations

## 🚀 Getting Started

### 1. Create Your First Prompt File

Use the Command Palette (`Ctrl+Shift+P`) and run:
```
FlightPath: Create Prompt File
```

Or create a `.prompt.json` file manually:

```json
{
  "prompt": "Analyze the current file and suggest improvements",
  "context": {
    "includeCurrentFile": true,
    "includeSelection": false
  },
  "endCondition": {
    "script": "check_improvements.py",
    "returns": "true",
    "timeout": 30000
  }
}
```

### 2. Execute Your Workflow

- **Command Palette**: `FlightPath: Take Off`
- **Status Bar**: Click the FlightPath rocket icon
- **Keyboard**: Configure your own shortcut

### 3. Monitor Progress

Watch execution progress in:
- Status bar (real-time updates)
- Output panel (`FlightPath` channel)
- VS Code notifications

## 🔧 Configuration

FlightPath contributes the following settings:

- **`flightpath.promptsDirectory`**: Directory for prompt files (default: `.flightpath`)
- **`flightpath.scriptTimeout`**: Default timeout for end condition scripts (default: 30000ms)
- **`flightpath.enableContextAwareness`**: Enable automatic context inclusion (default: true)

## 🐛 Known Issues

- GitHub Copilot Chat API integration is currently a stub implementation
- End condition scripts run in separate processes (security limitation)
- Windows PowerShell execution policy may require manual configuration
- Large workspace file inclusion may impact performance

## 🛠️ Development Status

### ✅ Phase 2 Complete - Core Architecture
- [x] Extension structure and build system
- [x] JSON schema validation with IntelliSense
- [x] Core architecture implementation
- [x] Command registration and lifecycle management
- [x] Status bar integration
- [x] File system utilities and monitoring
- [x] End condition script execution
- [x] Basic unit tests

### 📋 Next Phase - Enhanced Features
- [ ] WebView UI panel for file selection
- [ ] Enhanced GitHub Copilot integration
- [ ] Advanced context awareness features
- [ ] Comprehensive test coverage

---

**Ready for takeoff? 🚀 Try the Command Palette: `FlightPath: Take Off`**

**Enjoy!**
