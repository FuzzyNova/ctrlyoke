# FlightPath Source Tree Analysis

## Directory Structure Overview

```
c:\dev\FlightPath\
├── .bmad/                      # BMAD methodology configuration
├── .claude/                    # Claude AI configuration
├── .flightpath/                # Default prompts directory (user workflows)
├── .github/                    # GitHub configuration
│   ├── instructions/           # Copilot instruction files (per-directory)
│   └── copilot-instructions.md # Main project context for Copilot
├── .vscode/                    # VS Code workspace settings
├── docs/                       # Project documentation
│   └── bmad/                   # BMAD-generated documentation (output)
├── images/                     # Extension icons and images
├── logs/                       # Runtime logs (gitignored)
├── manual-test/                # Manual test files and fixtures
├── node_modules/               # Dependencies (gitignored)
├── out/                        # Compiled output (gitignored)
├── prompts/                    # Development prompts for building FlightPath
├── schemas/                    # JSON Schema source files
│   └── prompt-schema.json      # Unified schema for prompt files
└── src/                        # Source code root
    ├── completions/            # IntelliSense providers
    ├── flightpath/             # Core business logic
    │   ├── base/               # Abstract base classes
    │   ├── chat/               # Chat mode implementation
    │   └── cli/                # CLI mode implementation
    ├── templates/              # End condition script templates
    ├── test/                   # Test suites
    │   ├── fixtures/           # Test fixtures
    │   ├── integration/        # Integration tests
    │   └── suite/              # Test suite configuration
    ├── types/                  # TypeScript type definitions
    ├── ui/                     # UI components
    │   └── webview/            # Dashboard webview assets
    └── utils/                  # Utility functions
```

## Critical Directories

### Source Code (`src/`)

#### `src/extension.ts` - Entry Point

- Extension activation and deactivation
- Command registration (22 commands)
- Test command implementations
- Provider instantiation

#### `src/flightpath/` - Core Logic

| File                       | Responsibility                                               |
| -------------------------- | ------------------------------------------------------------ |
| `FlightPathManager.ts`     | Orchestration, factory pattern, lifecycle management         |
| `WorkflowExecutor.ts`      | Execution loop, response waiting, end condition coordination |
| `PromptQueue.ts`           | State machine, progress tracking, dynamic queue reload       |
| `PromptFileParser.ts`      | JSON parsing, schema validation, file resolution             |
| `EndConditionEvaluator.ts` | Script execution, timeout management, process spawn          |
| `EndConditionHandler.ts`   | Retry logic, failure handling, user decisions                |

#### `src/flightpath/base/` - Integration Base

| File                    | Responsibility                                    |
| ----------------------- | ------------------------------------------------- |
| `CopilotIntegration.ts` | Abstract base class defining integration contract |

#### `src/flightpath/cli/` - CLI Mode

| File                               | Responsibility                           |
| ---------------------------------- | ---------------------------------------- |
| `CopilotCommandLineIntegration.ts` | Copilot CLI spawning, session management |

#### `src/flightpath/chat/` - Chat Mode

| File                         | Responsibility                            |
| ---------------------------- | ----------------------------------------- |
| `CopilotChatIntegration.ts`  | UI automation, model switching            |
| `ChatLogMonitor.ts`          | Log-based response detection              |
| `NativeAttachmentHandler.ts` | File/selection attachment via VS Code API |

#### `src/types/` - Type Definitions

| File                    | Responsibility                                   |
| ----------------------- | ------------------------------------------------ |
| `FlightPathTypes.ts`    | Core domain types (PromptItem, QueueState, etc.) |
| `DashboardConstants.ts` | Message types, execution states, step status     |
| `ModelConstants.ts`     | Supported AI models (CLI and Chat)               |
| `CopilotTypes.ts`       | CLI-specific types (options, results)            |

#### `src/ui/` - User Interface

| File                             | Responsibility                 |
| -------------------------------- | ------------------------------ |
| `FlightPathDashboardProvider.ts` | WebView panel, message passing |
| `StatusBarManager.ts`            | Status bar item management     |

#### `src/ui/webview/` - Dashboard Assets

| File             | Responsibility         |
| ---------------- | ---------------------- |
| `dashboard.html` | WebView HTML template  |
| `dashboard.css`  | Dashboard styling      |
| `dashboard.js`   | Client-side JavaScript |

#### `src/utils/` - Utilities

| File                    | Responsibility                         |
| ----------------------- | -------------------------------------- |
| `ConfigurationUtils.ts` | VS Code settings access                |
| `PromptIdentity.ts`     | Prompt hashing and completion tracking |
| `LoggingUtils.ts`       | Logging utilities                      |
| `FileSystemUtils.ts`    | File system operations                 |
| `ValidationUtils.ts`    | Validation helpers                     |

#### `src/completions/` - IntelliSense

| File                          | Responsibility                        |
| ----------------------------- | ------------------------------------- |
| `PromptCompletionProvider.ts` | `#file:` and `#selection` completions |

#### `src/templates/` - Script Templates

| File                  | Purpose                              |
| --------------------- | ------------------------------------ |
| `check_condition.py`  | Python end condition template        |
| `check_condition.js`  | JavaScript end condition template    |
| `check_condition.sh`  | Bash end condition template          |
| `check_condition.bat` | Windows batch end condition template |
| `check_condition.ps1` | PowerShell end condition template    |

#### `src/test/` - Test Suites

| File                            | Responsibility              |
| ------------------------------- | --------------------------- |
| `runTest.ts`                    | Test runner configuration   |
| `extension.test.ts`             | Extension activation tests  |
| `flightpath.test.ts`            | FlightPathManager tests     |
| `promptQueue.test.ts`           | PromptQueue tests           |
| `promptFileParser.test.ts`      | PromptFileParser tests      |
| `endConditionEvaluator.test.ts` | EndConditionEvaluator tests |
| `promptIdentity.test.ts`        | PromptIdentity tests        |
| `validationUtils.test.ts`       | ValidationUtils tests       |

### Configuration Files (Root)

| File                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `package.json`      | Extension manifest, commands, settings, dependencies |
| `tsconfig.json`     | TypeScript configuration (strict mode)               |
| `eslint.config.mjs` | ESLint configuration                                 |
| `.prettierrc.json`  | Prettier formatting rules                            |
| `esbuild.js`        | Build configuration                                  |
| `.vscode-test.mjs`  | Test runner configuration                            |

### Documentation (`docs/`)

| File                          | Content                      |
| ----------------------------- | ---------------------------- |
| `ARCHITECTURE.md`             | System architecture diagrams |
| `COPILOT_CLI_DESIGN.md`       | CLI integration reference    |
| `DYNAMIC_QUEUE_USAGE.md`      | Dynamic queue user guide     |
| `END_CONDITIONS.md`           | End condition documentation  |
| `XML_PROMPTING_GUIDELINES.md` | XML prompting best practices |
| `TESTING.md`                  | Test strategy                |
| `MANUAL_TESTING.md`           | Manual test procedures       |
| `RELEASE_GUIDE.md`            | Release process              |

### Schemas (`schemas/`)

| File                 | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `prompt-schema.json` | JSON Schema for `.prompt.json` and `.flightpath.json` files |

### Manual Test Files (`manual-test/`)

| File                                  | Purpose                         |
| ------------------------------------- | ------------------------------- |
| `dynamic-queue-*.flightpath.json`     | Dynamic queue test scenarios    |
| `retry-*.flightpath.json`             | End condition retry tests       |
| `file-reference-test.flightpath.json` | File reference resolution tests |
| `validate_*.js`                       | Validation script examples      |

## Entry Points

### Extension Activation

```
src/extension.ts::activate()
    └── FlightPathManager.initialize()
        ├── PromptFileParser (AJV schema loading)
        ├── CopilotCommandLineIntegration.initialize()
        ├── CopilotChatIntegration.initialize()
        ├── EndConditionEvaluator
        └── StatusBarManager
```

### Command Execution

```
Command: flightpath.takeOff
    └── FlightPathManager.takeOff()
        └── File selection → executePromptFile()
            └── WorkflowExecutor.execute()
```

### Dashboard Focus

```
Command: flightpath.dashboard.focus
    └── FlightPathDashboardProvider.resolveWebviewView()
        └── Load dashboard.html with CSP-compliant resources
```

## Build Output (`out/`)

After compilation, the structure mirrors `src/`:

```
out/
├── extension.js           # Bundled extension entry point
├── schemas/               # Copied from schemas/
│   └── prompt-schema.json
├── templates/             # Copied from src/templates/
│   ├── check_condition.py
│   ├── check_condition.js
│   └── ...
└── ui/
    └── webview/           # Copied from src/ui/webview/
        ├── dashboard.html
        ├── dashboard.css
        └── dashboard.js
```

## Key File Relationships

```
PromptFileParser
    ├── Uses: schemas/prompt-schema.json (AJV validation)
    └── Parses: *.prompt.json, *.flightpath.json, *.prompt.md

FlightPathManager
    ├── Creates: PromptQueue, WorkflowExecutor
    ├── Uses: CopilotIntegration (CLI or Chat)
    └── Updates: FlightPathDashboardProvider

WorkflowExecutor
    ├── Uses: PromptQueue (state management)
    ├── Uses: CopilotIntegration (prompt execution)
    ├── Uses: EndConditionHandler (validation)
    └── Updates: Dashboard (progress, CLI output)

CopilotIntegration
    ├── Base: CopilotIntegration.ts (abstract)
    ├── CLI: CopilotCommandLineIntegration.ts
    └── Chat: CopilotChatIntegration.ts
        ├── Uses: ChatLogMonitor.ts
        └── Uses: NativeAttachmentHandler.ts

DashboardConstants.ts
    └── Shared by: Extension TypeScript + Webview JavaScript
```

## Development Workflow Files

| File                                     | Purpose                                     |
| ---------------------------------------- | ------------------------------------------- |
| `.github/instructions/*.instructions.md` | Per-directory coding guidelines             |
| `.github/copilot-instructions.md`        | Project-wide Copilot context                |
| `prompts/*.prompt.md`                    | Development prompts for building FlightPath |
