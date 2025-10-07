# FlightPath - VS Code Extension Quick Start

## Welcome to FlightPath Development

FlightPath is a VS Code extension that automates GitHub Copilot through structured prompt workflows. This guide will help you get started with development.

## What's in the folder

### Core Files
* `package.json` - Extension manifest declaring commands, configuration, and activation events
* `src/extension.ts` - Extension entry point with command registration and lifecycle management
* `tsconfig.json` - TypeScript compiler configuration with strict mode enabled
* `esbuild.js` - Fast bundler for development and production builds

### Source Code Structure
* `src/flightpath/` - Core business logic
  * `FlightPathManager.ts` - Main orchestration controller
  * `PromptQueue.ts` - Sequential prompt execution engine
  * `CopilotIntegration.ts` - Copilot Chat automation with background polling
  * `PromptFileParser.ts` - JSON validation and parsing
  * `EndConditionEvaluator.ts` - Script execution for workflow conditions
* `src/ui/` - User interface components
  * `StatusBarManager.ts` - Status bar integration
* `src/utils/` - Utility functions
* `src/types/` - TypeScript type definitions
* `src/schemas/` - JSON schemas for prompt files

### Documentation
* `docs/` - Architecture and implementation documentation
  * `ARCHITECTURE.md` - System architecture and design decisions
  * `COPILOT_INTEGRATION.md` - Copilot Chat automation details
  * `POLLING_IMPLEMENTATION.md` - Background polling approach
* `QUICK_START.md` - User-facing quick start guide
* `README.md` - Project overview and features

## Development Setup

### Prerequisites
* VS Code 1.85.0 or higher
* Node.js 18+ (project uses v22.17.0)
* GitHub Copilot Chat extension (for testing automation)

### Install Dependencies
```bash
npm install
```

### Recommended Extensions
Install these VS Code extensions for the best development experience:
* `amodio.tsl-problem-matcher` - TypeScript problem matcher
* `ms-vscode.extension-test-runner` - Test runner integration
* `dbaeumer.vscode-eslint` - ESLint integrationour VS Code Extension

## What's in the folder

* This folder contains all of the files necessary for your extension.
* `package.json` - this is the manifest file in which you declare your extension and command.
  * The sample plugin registers a command and defines its title and command name. With this information VS Code can show the command in the command palette. It doesn’t yet need to load the plugin.
* `src/extension.ts` - this is the main file where you will provide the implementation of your command.
  * The file exports one function, `activate`, which is called the very first time your extension is activated (in this case by executing the command). Inside the `activate` function we call `registerCommand`.
  * We pass the function containing the implementation of the command as the second parameter to `registerCommand`.

## Setup

* install the recommended extensions (amodio.tsl-problem-matcher, ms-vscode.extension-test-runner, and dbaeumer.vscode-eslint)


## Development Workflow

### 1. Start Development Mode

**Option A: Press F5**
* Opens Extension Development Host window with FlightPath loaded
* Automatic debugging with breakpoint support
* Hot reload on file changes (with watch task)

**Option B: Run Watch Task**
```bash
npm run watch
```
* Continuous compilation with esbuild
* Fast incremental builds
* Automatic recompilation on file save

### 2. Test Your Changes

**Try FlightPath Commands:**
1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "FlightPath" to see all commands:
   * `FlightPath: Take Off` - Execute a workflow
   * `FlightPath: Show Copilot Integration Status` - Check automation status
   * `FlightPath: Test Automation` - Test Copilot Chat automation
   * `FlightPath: Retry Copilot Detection` - Manually restart polling

**Set Breakpoints:**
* Add breakpoints in any TypeScript file
* Execution will pause for inspection
* Use Debug Console to evaluate expressions

**View Logs:**
* Debug Console - Shows console.log output with emoji indicators
* Output Panel - Select "FlightPath" channel for structured logs
* Developer Tools Console - Help → Toggle Developer Tools

### 3. Make Changes

**While Debugging:**
* Modify TypeScript files
* Press `Ctrl+R` (Windows/Linux) or `Cmd+R` (Mac) to reload Extension Development Host
* Changes will take effect immediately

**After Stopping:**
* Edit code in any file
* Press F5 again to start fresh debugging session

### 4. Architecture Understanding

**Key Entry Points:**
* `src/extension.ts` - `activate()` function is called on extension load
* `src/flightpath/FlightPathManager.ts` - `initialize()` starts background polling
* `src/flightpath/CopilotIntegration.ts` - `startBackgroundPolling()` begins availability detection

**Command Flow:**
```
User runs command → extension.ts registers it
                 → FlightPathManager method is called
                 → CopilotIntegration handles automation
                 → PromptQueue manages execution
                 → StatusBarManager updates UI
```

## Testing

### Run Unit Tests

**Install Test Runner Extension:**
[Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)

**Start Watch Mode:**
```bash
npm run watch
```
This must be running for tests to be discovered.

**Run Tests:**
* Open Testing view from Activity Bar (beaker icon)
* Click "Run Tests" button, or
* Use hotkey `Ctrl/Cmd + ; A`

**View Results:**
* Test Results view shows pass/fail status
* Debug Console shows detailed test output

**Test Files:**
* `src/test/extension.test.ts` - Extension lifecycle tests
* `src/test/flightpath.test.ts` - Core functionality tests
* Pattern: `*.test.ts` files are automatically discovered

### Create New Tests

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('My Test Suite', () => {
    test('My test case', () => {
        assert.strictEqual(1 + 1, 2);
    });
});
```

## Building & Packaging

### Development Build
```bash
npm run compile
```
* Creates `out/` directory with compiled JavaScript
* Source maps included for debugging

### Production Build
```bash
npm run package
```
* Minified bundle optimized for size
* Ready for distribution

### Package for Distribution
```bash
npm install -g @vscode/vsce
vsce package
```
* Creates `.vsix` file for installation
* See [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

## Debugging Tips

### Common Issues

**"Extension not activating"**
* Check `activationEvents` in `package.json`
* Verify command IDs match between manifest and registration
* Look for errors in Debug Console

**"Copilot automation not working"**
* Ensure GitHub Copilot Chat extension is installed
* Check status: Run "FlightPath: Show Copilot Integration Status"
* Watch for polling messages in console (look for 🔍 emoji)

**"Commands not appearing"**
* Reload Extension Development Host (`Ctrl+R` / `Cmd+R`)
* Check `contributes.commands` in `package.json`
* Verify command registration in `extension.ts`

### Best Practices

1. **Use TypeScript Strict Mode** - Catches errors at compile time
2. **Follow SOLID Principles** - Each class has single responsibility
3. **Add Comprehensive Logging** - Use emoji indicators for visual scanning
4. **Handle Errors Gracefully** - Show user-friendly error messages
5. **Test Background Operations** - Ensure polling and async operations work correctly

## VS Code Extension API

**Explore the API:**
* `node_modules/@types/vscode/index.d.ts` - Full API surface
* [VS Code API Documentation](https://code.visualstudio.com/api/references/vscode-api)
* [Extension Guides](https://code.visualstudio.com/api/extension-guides/overview)

**FlightPath Uses:**
* Command registration and execution
* Status bar items with progress indicators
* Quick pick menus for file selection
* File system watching for `.flightpath/` directory
* Extension activation API for Copilot Chat

## Contributing

When contributing to FlightPath:

1. **Read Architecture Docs** - Understand the design decisions
2. **Follow Code Style** - ESLint + Prettier enforce consistency
3. **Add Tests** - Cover new functionality with unit tests
4. **Update Documentation** - Keep docs in sync with code
5. **Test Thoroughly** - Verify automation works end-to-end

## Next Steps

* Read `docs/ARCHITECTURE.md` for system design
* Read `docs/COPILOT_INTEGRATION.md` for automation details
* Read `docs/POLLING_IMPLEMENTATION.md` for initialization approach
* Explore example workflows in `.flightpath/examples/`
* Run "FlightPath: Test Automation" to verify your environment

---

**Happy Coding!** 🚀

*FlightPath - Automate GitHub Copilot with structured prompt workflows*
