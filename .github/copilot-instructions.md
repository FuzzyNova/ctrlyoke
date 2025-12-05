# FlightPath VS Code Extension

<projectPurpose>
Automate GitHub Copilot Chat through structured JSON-based prompt workflows with automated execution, response detection, and context awareness.
</projectPurpose>

<technicalStack>
- TypeScript 5.x (strict mode)
- Node.js 22.17.0
- esbuild (bundling)
- VS Code Extension API (Language Model Tool API, Chat integration)
- JSON Schema validation (AJV)
- Mocha (testing)
</technicalStack>

<architecturePrinciples>

<promptFormat>
**Final-form storage**: Prompts stored in JSON files are ready to send to Copilot with all context variables (@workspace, #file:path:line-line, slash commands) included directly in the text. No runtime context injection.

**XML structure**: FlightPath wraps automation instructions in XML tags:

- User prompt sent as-is (visible in chat history)
- FlightPath automation instructions wrapped in `<criticalInstruction>` tag (hidden in chat UI but processed correctly)

**Note**: Copilot Chat UI hides XML tags in the chat view but still processes them. This allows FlightPath to send automation instructions that Copilot follows without cluttering the user's chat history.
</promptFormat>

<solidPrinciples>
SOLID principles with strict separation of concerns:

- FlightPathManager: Orchestration and command handling
- PromptQueue: Sequential execution and state management
- CopilotIntegration (abstract base): Defines integration contract
  - CopilotChatIntegration: Chat window automation with UI interactions
  - CopilotCommandLineIntegration: CLI-based automation (default)
- PromptFileParser: JSON validation and parsing
- EndConditionEvaluator: Script execution and validation
  </solidPrinciples>

<codeQuality>
TypeScript strict mode, comprehensive error handling, no duplication.
</codeQuality>

</architecturePrinciples>

## Project Structure

```
src/
├── extension.ts                  # Entry point
├── completions/                  # IntelliSense providers
│   └── PromptCompletionProvider.ts  # File/selection completions for prompt files
├── dev/                          # Development-only code (stripped in production)
│   └── DevCommands.ts            # Dev commands (test functions, diagnostics)
├── flightpath/                   # Core logic
│   ├── base/
│   │   └── CopilotIntegration.ts # Abstract base class
│   ├── chat/
│   │   └── CopilotChatIntegration.ts  # Chat window automation
│   ├── cli/
│   │   ├── CopilotCommandLineIntegration.ts  # Copilot CLI automation (default)
│   │   └── ClaudeCommandLineIntegration.ts   # Claude Code CLI automation
│   ├── FlightPathManager.ts      # Orchestration with factory pattern
│   ├── PromptQueue.ts            # Execution queue
│   ├── PromptFileParser.ts       # JSON parsing
│   ├── TemplateManager.ts        # Workflow template management
│   └── EndConditionEvaluator.ts  # Script validation
├── templates/                    # Templates for scripts, agents, and workflows
│   ├── agents/                   # Custom agent templates
│   │   ├── manifest.json         # Agent metadata and descriptions
│   │   └── flightpath-orchestrator.agent.md  # Plan→Implement→Review workflow creator
│   ├── workflows/                # Workflow templates with {placeholder} variables
│   │   ├── manifest.json         # Workflow metadata and descriptions
│   │   ├── simple-feature.flightpath.json
│   │   ├── fix-tests.flightpath.json
│   │   └── full-feature.flightpath.json
│   ├── check_condition.py        # Python script template
│   ├── check_condition.js        # JavaScript script template
│   ├── check_condition.sh        # Bash script template
│   └── check_condition.bat       # Windows batch script template
├── types/                        # Type definitions
├── ui/                           # User interface
│   ├── FlightPathDashboardProvider.ts  # Dashboard webview provider
│   ├── FlightPathSettingsProvider.ts   # Settings webview provider
│   └── webview/                  # Webview assets
│       ├── dashboard.html        # Dashboard template
│       ├── dashboard.css         # Dashboard styles
│       ├── dashboard.js          # Dashboard logic
│       ├── settings.html         # Settings template
│       ├── settings.css          # Settings styles
│       └── settings.js           # Settings logic
├── utils/
│   ├── BuildConfig.ts            # Build-time constants (IS_DEV_MODE, BUILD_DATE)
│   ├── ModelConstants.ts         # Model definitions (single source of truth)
│   └── ModelRegistry.ts          # Runtime model discovery
└── test/                         # Tests
schemas/                          # JSON schemas (source)
└── prompt-schema.json            # Unified schema for both file types
scripts/
└── sync-models.mjs               # Sync ModelConstants.ts ↔ package.json
```

**Workspace Folder Structure** (`.flightpath/`):

```
.flightpath/
├── scripts/       # Validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # Workflow templates with {placeholder} variables
└── workflows/     # Ready-to-run workflows (*.flightpath.json, *.prompt.json)
```

**Build Output**:

- Templates copied from `src/templates/` to `out/templates/` during build
- Schemas copied from `schemas/` to `out/schemas/` during build
- Single source of truth: `/schemas/prompt-schema.json` used for both VS Code IntelliSense and runtime validation
- **Dev code stripped**: In production builds, `IS_DEV_MODE=false` enables dead code elimination

<coreComponents>

Core orchestration and execution logic. See `.github/instructions/` for detailed implementation notes.

## FlightPathManager

Orchestrates workflow execution. Coordinates PromptQueue and CopilotIntegration. Factory pattern selects CLI vs Chat mode.

## PromptQueue

Sequential execution with pause/resume/cancel. State machine tracks progress. Response detection delegated to FlightPathManager.

## CopilotIntegration

Abstract base with two implementations:

- **CLI** (default): Deterministic completion, structured output, no UI dependencies
- **Chat** (fallback): UI automation with hybrid response detection (Language Model Tool + clipboard polling)

Both support automatic file attachment for `#file:path` references.

## PromptFileParser

JSON schema validation with AJV. Validates both `.prompt.json` and `.flightpath.json` formats using unified schema.

## PromptCompletionProvider

IntelliSense for FlightPath prompt files:

- `#file:` references with workspace files and current selections
- Dynamic model completions (models queried from Copilot API at activation)

## ModelRegistry

Queries available Copilot models via `vscode.lm.selectChatModels({ vendor: "copilot" })` at extension activation. Provides:

- Runtime model discovery (different users may have different models)
- Fallback to static list if API fails
- CLI support detection for each model

## EndConditionEvaluator

Executes validation scripts with timeout and process isolation. Template system for creating sample scripts.

</coreComponents>

## File Formats & Schema

**Important: Prompts are stored in final-form format** - All context variables (@workspace, #file:path, slash commands) are included directly in the prompt text.

**Schema: Both file types use the same unified schema (prompt-schema.json)**

Both `.prompt.json` and `.flightpath.json` files support the same two formats:

### Single Prompt Format

```json
{
  "prompt": "/explain #file:src/extension.ts Analyze and improve this code",
  "model": "claude-haiku-4.5",
  "endCondition": {
    "script": "validate_improvements.py",
    "returns": "true",
    "timeout": 30000
  }
}
```

### File Path Reference Format

The `prompt` field can also be a path to an external file containing the prompt:

```json
{
  "prompt": "./prompts/analyze-code.prompt.md",
  "model": "claude-sonnet-4.5"
}
```

**File path resolution order:**

1. Absolute paths (used as-is)
2. Relative to the prompt file's directory
3. Relative to workspace root
4. Relative to `.flightpath` directory

**Supported file extensions:** `.prompt.md`, `.md`, `.txt`

This is useful for:

- Reusing prompts across multiple workflows
- Keeping complex prompts in separate, well-organized files
- Editing prompts with full editor support (syntax highlighting, etc.)

### Multiple Prompts Format

```json
{
  "prompts": [
    {
      "prompt": "/explain @workspace Step 1: Analyze code structure",
      "model": "claude-sonnet-4.5",
      "endCondition": { "script": "check_analysis.js", "returns": "true" }
    },
    {
      "prompt": "Step 2: Implement improvements",
      "endCondition": { "script": "verify_changes.py", "returns": "true" }
    }
  ]
}
```

### Markdown Prompt Format

For simple single prompts, use `.prompt.md` files (no JSON needed):

```markdown
Analyze the FlightPath extension architecture and suggest improvements for better code organization. Focus on the separation of concerns between components.
```

**Markdown file handling**:

- `.prompt.md` files are read as plain text (entire file content becomes the prompt)
- No JSON parsing or schema validation needed
- Cannot include `model` override or `endCondition` (single prompt execution only)
- Supports same context variables: `@workspace`, `#file:path`, slash commands
- Use context menu (right-click) to execute: **Send to CLI** or **Send to Chat**

**Optional Fields:**

- `model` - Override the AI model for a specific prompt.
  - **Dynamic discovery**: Models are queried at runtime via `vscode.lm.selectChatModels()`. Different users may have different models available.
  - **IntelliSense**: Use Ctrl+Space in prompt files to see available models with CLI support indicators.
  - **CLI-supported** (4 models): `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`
  - **Behavior**:
    - CLI mode: Validates against CLI_SUPPORTED_MODELS, warns and falls back to default if unsupported
    - Chat mode: Switches model using `workbench.action.chat.changeModel` before sending prompt
  - **Default**: If omitted, uses `flightpath.copilotCliModel` setting (CLI) or current chat model (Chat)

**File naming conventions:**

- `.prompt.md` - Single markdown-based prompts (no JSON, simplest format)
- `.prompt.json` - Typically for single prompts or simple workflows
- `.flightpath.json` - Typically for complex multi-step workflows

All three formats support context menu execution with mode override (Send to CLI / Send to Chat).

## Commands

15 registered commands:

- flightpath.takeOff: Start workflow
- flightpath.openPanel: Open panel
- flightpath.createPromptFile: Create file
- flightpath.createEndConditionScript: Create end condition script from templates
- flightpath.importAgents: Import FlightPath custom agents to .github/agents/
- flightpath.importWorkflowTemplates: Import workflow templates to .flightpath/templates/
- flightpath.createFromTemplate: Create workflow from template with variable substitution (planned)
- flightpath.pause/resume/stop: Execution control
- flightpath.debugState: Debug state
- flightpath.showCopilotStatus: Show status
- flightpath.testAutomation: Test automation
- flightpath.retryCopilotDetection: Retry polling

Status bar shows: Initializing, Waiting, Ready, Running, Paused, Setup Required

## Testing

Mocha-based with minimal coverage (pre-release). See `.github/instructions/test.instructions.md`.

## Security

- Scripts: Workspace-only, process isolation, timeout protection
- File system: Workspace-scoped operations
- Validation: Strict JSON schema enforcement

## Development

- F5 debugging, `npm run watch` compilation
- TypeScript strict mode, ESLint + Prettier

## Implementation Status

**Completed**: CLI/Chat integrations, file attachment, response detection, schema validation, command registration, status bar, WebView dashboard with HTML template, Settings panel with provider/model selection

**Planned**: Comprehensive end-to-end workflow tests, enhanced error recovery, multi-turn CLI sessions

## Extension Settings

- flightpath.promptsDirectory (string, default: ".flightpath")
- flightpath.scriptTimeout (number, default: 30) - End condition script timeout in seconds
- flightpath.autoAttachFiles (boolean, default: true) - Automatically process #file: references and attach file content
- flightpath.provider (enum: "copilot-cli" | "copilot-chat" | "claude-cli", default: "copilot-cli")
  - **cli**: Copilot CLI (default, best reliability)
  - **chat**: Copilot Chat window (UI automation)
  - **claude-cli**: Claude Code CLI (Anthropic's CLI)
- flightpath.cliExecutionMode (enum: "interactive" | "headless", default: "interactive")
  - **interactive**: Opens VS Code terminal for visibility, Ctrl+C abort, and user interaction (recommended)
  - **headless**: Runs silently in background process
  - **Note**: Headless mode without full permissions will auto-deny prompts, preventing agent actions
- flightpath.copilotCliModel (enum: "claude-sonnet-4.5" | "claude-sonnet-4" | "claude-haiku-4.5" | "gpt-5", default: "claude-sonnet-4.5")
  - **Purpose**: Default model for Copilot CLI mode only
  - **Note**: Prompts can override with any supported model (Chat superset includes 22 models)
  - **Fallback behavior**: If prompt specifies unsupported CLI model, falls back to this default with warning
- flightpath.copilotChatModel (enum: same as copilotCliModel, default: "claude-sonnet-4.5")
  - **Purpose**: Default model for Copilot Chat mode
  - **Behavior**: FlightPath always switches to this model before sending prompts (consistent with CLI modes)
  - **Graceful degradation**: If model switch fails, shows warning and continues with current model
- flightpath.copilotCliAllowedDirs (array of strings, default: [])
- flightpath.copilotCliToolPermissions (enum: "allowAll" | "custom", default: "allowAll")
  - **allowAll**: Uses `--allow-all-tools` flag (default, grants full access)
  - **custom**: Uses `cliAllowedTools` and `cliDeniedTools` patterns
- flightpath.cliAllowedTools (array of strings, default: []) - Shared tool patterns to allow in custom mode
  - Uses Copilot CLI format, automatically converted for Claude CLI
  - **Copilot tools**: `shell(command:*)`, `write`, `<mcp-server>(tool)`
  - **Claude tools** (use lowercase, auto-converted): `bash`, `read`, `write`, `edit`, `multiedit`, `glob`, `grep`, `ls`, `webfetch`
  - **Mappings**: `shell` → `Bash`, `write` → `Write`
  - Examples: `shell(git:*)`, `write`, `github`, `github(search_repositories)`
- flightpath.cliDeniedTools (array of strings, default: []) - Shared tool patterns to deny (takes precedence)
  - Uses Copilot CLI format, automatically converted for Claude CLI
  - Examples: `shell(git push)`, `shell(rm:*)`, `write`
- flightpath.copilotCliAllowAllPaths (boolean, default: true) - Allow CLI access to any file path
- flightpath.copilotCliLogDir (string, default: "") - Custom directory for Copilot CLI logs
  - Leave empty to use system temp directory (`os.tmpdir()/flightpath-copilot-logs`)
  - Logs are used for session ID tracking and debugging
- flightpath.copilotCliLogLevel (enum: "default" | "none" | "error" | "warning" | "info" | "debug" | "all", default: "default")
  - Use **debug** or **all** for troubleshooting CLI issues
- flightpath.showCliOutput (boolean, default: true) - Show CLI prompts/responses/statistics in Output panel
- flightpath.chatWindowLocation (enum: "chatPanel" | "newTab" | "newWindow", default: "chatPanel")
- flightpath.chatInactivityTimeout (number, default: 300, range: 30-3600) - Seconds to wait for log activity before timeout
- flightpath.treatChatTimeoutAsSuccess (boolean, default: true) - When true, inactivity timeouts are treated as completions (since Copilot may have finished)

**Claude Code CLI Settings** (when using `claude-cli` mode):

- flightpath.claudeCliModel (enum: "sonnet" | "opus" | "haiku", default: "sonnet")
  - **sonnet**: Best balance of speed and capability (recommended)
  - **opus**: Most capable, best for complex tasks
  - **haiku**: Fastest, best for simple tasks
- flightpath.claudeCliToolPermissions (enum: "skipAll" | "custom", default: "skipAll")
  - **skipAll**: Uses `--dangerously-skip-permissions` (default, non-interactive)
  - **custom**: Uses shared `cliAllowedTools` and `cliDeniedTools` (auto-converted to Claude format)
- flightpath.claudeCliOutputFormat (enum: "json" | "text", default: "json")

**CLI Integration**: See `docs/COPILOT_CLI_DESIGN.md` for complete CLI flag reference, tool permission patterns, and planned enhancements.

When adding settings:

1. Add to package.json under contributes.configuration.properties
2. Use enum with enumDescriptions for dropdowns
3. Set sensible defaults
4. Retrieve: vscode.workspace.getConfiguration("flightpath").get<Type>("settingName", defaultValue)

## Development Mode Architecture

**Build-time conditional compilation** strips dev commands from production builds:

```typescript
// src/utils/BuildConfig.ts
export const IS_DEV_MODE: boolean = __DEV_MODE__; // Replaced by esbuild

// src/extension.ts
if (IS_DEV_MODE) {
  const { registerDevCommands } = require("./dev/DevCommands");
  registerDevCommands(context);
}
```

**Build scripts:**

- `npm run compile` - Development build (IS_DEV_MODE = true)
- `npm run build:prod` - Production build (IS_DEV_MODE = false, minified)
- `npm run package` - Full production package

**Dev-only commands** (in `src/dev/DevCommands.ts`):

- `flightpath.test.*` - Various test commands for Copilot integration
- `flightpath.listChatCommands` - List all chat-related VS Code commands
- `flightpath.listAllCommands` - List all VS Code commands
- `flightpath.showLanguageId` - Debug language detection
- `flightpath.investigateChatLogs` - Debug chat logs
- `flightpath.exportDiscoveredModels` - Export models for sync-models.mjs

**Updating Chat Models** (workflow for discovering new models):

1. Run extension (F5 in dev mode)
2. Run command: `FlightPath: Export Discovered Models`
3. Run: `npm run sync-models:import` (updates ModelConstants.ts)
4. Run: `npm run sync-models` (updates package.json)
5. Commit both files

## Development Guidelines

**Project Status**: Pre-release - No backward compatibility required. Break things freely to improve architecture.

**NO HARDCODED STRINGS RULE**: If a string literal is used in more than one **file**, it MUST be defined as a constant in a single source of truth. This prevents typos, ensures consistency, and makes refactoring trivial.

**When to use constants:**

- ✅ Values shared across multiple files (MESSAGE_TYPES, EXECUTION_STATES, STEP_STATUS)
- ✅ Values requiring synchronization between components (extension ↔ webview communication)
- ✅ Business logic values that control program flow (status states, error codes)

**When inline strings are acceptable:**

- ✅ CSS class names used only in a single file (tightly coupled to CSS)
- ✅ UI labels/text used once in a single location
- ✅ HTML attributes and structure

**Single Source of Truth Locations:**

- Message types between extension and webview → `src/types/DashboardConstants.ts`
- Execution states and step statuses → `src/types/DashboardConstants.ts`
- PromptFile/QueueState types → `src/types/FlightPathTypes.ts`
- **Model definitions and display names** → `src/utils/ModelConstants.ts`
  - Copilot Chat models (COPILOT_MODELS) - full set with display names
  - Copilot CLI models (COPILOT_CLI_MODEL_IDS) - subset from `copilot help config`
  - Claude CLI model aliases (CLAUDE_CLI_MODELS)
  - Run `npm run sync-models` to sync package.json enums
  - Run `node scripts/sync-models.mjs --discover` to see current CLI models

**Single Source of Truth Principle**: Each shared constant must have exactly ONE definition. Import and reuse - never duplicate. When updating a constant value, you should only need to change it in ONE place.

When adding features:

1. Follow SOLID principles - single responsibility per component
2. Add TypeScript types - leverage strict mode for safety
3. Include error handling - comprehensive user feedback
4. Write tests first - TDD approach for reliability
5. Update schemas - maintain JSON validation for prompt files
6. Document changes - keep README and examples current

Code review focus:

- Type safety with strict mode
- Error boundaries for all external operations
- Security validation for script execution and file system access
- Performance: avoid blocking operations, use async/await
- User experience: clear feedback and status communication

**Breaking Changes**: Since this extension is not yet released, prioritize clean architecture over backward compatibility. Make bold improvements without hesitation.

## Extension Goals

FlightPath bridges manual AI assistance and full automation through:

- Structured automation via JSON configuration
- Script-based validation of AI outputs
- Fine-grained control over AI interaction sequences
- Seamless VS Code integration with context awareness
- Secure script execution with clear boundaries
- **Dynamic queue extension**: Copilot can autonomously extend workflows by modifying `.flightpath.json` files during execution

## Dynamic Queue Architecture

**Purpose**: Transform FlightPath from static workflow executor to adaptive autonomous agent framework.

**Status**: Fully implemented (opt-in via `flightpath.enableDynamicQueue` setting, default: `false`)

### Core Components

1. **PromptIdentity.ts**: Identity utilities for tracking completed prompts
   - `hashPromptContent()`: SHA-256 hash of normalized prompt text
   - `isPromptCompleted()`: Checks ID or content hash against completed set
   - `shouldInjectExtensionInstructions()`: Determines if prompt gets extension instructions

2. **PromptQueue.reloadAndMergeQueue()**: Reloads prompt file and merges new prompts
   - Validates JSON with PromptFileParser
   - Filters out completed prompts using identity system
   - Enforces queue size limits (unless unlimited mode)
   - Appends new prompts to current queue

3. **FlightPathManager**: Triggers reload after each prompt completion
   - Checks `enableDynamicQueue` setting
   - Passes maxQueueSize from config (or 0 for unlimited)
   - Shows notifications on extension
   - Updates dashboard with new totals

4. **CopilotIntegration.buildPromptWithInstructions()**: Selective instruction injection
   - Checks `allowDynamicExtension` flag per prompt
   - Defaults to last-prompt-only if no explicit flags
   - Wraps instructions in `<criticalInstruction>` XML tags
   - Includes file path, queue stats, time limits

### Instruction Injection Logic

```typescript
shouldInject =
  prompt.allowDynamicExtension === true OR
  (isLastPrompt AND noExplicitFlags AND dynamicExtensionOnLastPrompt)
```

### Safety Guardrails

- **maxQueueSize**: Default 100, range 1-1000, prevents infinite loops
- **maxExecutionTime**: Default 5 hours (18000s), range 5min-24hrs, prevents runaway execution
- **unlimitedMode**: Ignores both limits when `true` (may be gated in paid tier)
- **Pause-aware timing**: Excludes paused duration from execution time
- **Invalid JSON recovery**: Logs error and continues with current queue

### Settings

All in `package.json`:

- `enableDynamicQueue` (boolean, default: false)
- `dynamicExtensionOnLastPrompt` (boolean, default: true)
- `maxQueueSize` (number, default: 100, range: 1-1000)
- `maxExecutionTime` (number, default: 18000, range: 300-86400)
- `unlimitedMode` (boolean, default: false)
- `notifyOnQueueExtension` (boolean, default: true)

### Documentation

- **User guide**: `docs/DYNAMIC_QUEUE_USAGE.md`
- **Implementation plan**: `docs/DYNAMIC_QUEUE_IMPLEMENTATION.md`
- **Examples**: `manual-test/dynamic-queue-*.flightpath.json`
