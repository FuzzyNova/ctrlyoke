# FlightPath VS Code Extension

<projectPurpose>
Automate GitHub Copilot Chat through structured YAML/JSON-based prompt workflows with automated execution, response detection, and context awareness.
</projectPurpose>

<technicalStack>
- TypeScript 5.x (strict mode)
- Node.js 22.17.0
- esbuild (bundling)
- VS Code Extension API (Language Model Tool API, Chat integration)
- YAML parsing (js-yaml) and JSON Schema validation (AJV)
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

- FlightPathManager: Orchestration and command handling, factory pattern for 4 providers
- PromptQueue: Sequential execution and state machine (idle → running → paused/completed/error)
- CopilotIntegration (abstract base): Defines integration contract
  - CliIntegration (generic CLI class): Works with ANY CLI provider via composition
    - CopilotCliProvider: Copilot CLI logic (implements ICliProvider)
    - ClaudeCliProvider: Claude Code CLI logic (implements ICliProvider)
    - CodexCliProvider: Codex CLI logic (implements ICliProvider)
  - CopilotChatIntegration: Chat window automation with UI interactions
- WorkflowExecutor: Prompt execution loop with pause/resume support
- EndConditionHandler: Retry orchestration and validation failure handling
- PromptFileParser: YAML/JSON parsing and schema validation
- EndConditionEvaluator: Script execution with timeout and process isolation
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
│   ├── PromptCompletionProvider.ts  # File/selection completions for prompt files
│   └── PromptLinkProvider.ts     # Clickable links for context references
├── dev/                          # Development-only code (stripped in production)
│   └── DevCommands.ts            # Dev commands (test functions, diagnostics)
├── flightpath/                   # Core logic
│   ├── base/
│   │   └── CopilotIntegration.ts # Abstract base class
│   ├── chat/
│   │   ├── CopilotChatIntegration.ts  # Chat window automation
│   │   ├── ChatLogMonitor.ts          # Log-based completion detection
│   │   └── NativeAttachmentHandler.ts # File attachment via native commands
│   ├── cli/
│   │   ├── CliIntegration.ts          # Generic integration class (works with all providers)
│   │   ├── copilot/                   # Copilot CLI provider
│   │   │   ├── CopilotCliProvider.ts
│   │   │   ├── CopilotResponseParser.ts
│   │   │   ├── CopilotNotificationMonitor.ts
│   │   │   ├── CopilotToolPermissionMapper.ts
│   │   │   └── CopilotLogParser.ts
│   │   ├── claude/                    # Claude CLI provider
│   │   │   ├── ClaudeCliProvider.ts
│   │   │   ├── ClaudeResponseParser.ts
│   │   │   ├── ClaudeNotificationMonitor.ts
│   │   │   ├── ClaudeToolPermissionMapper.ts
│   │   │   └── ClaudeLogParser.ts
│   │   ├── codex/                     # Codex CLI provider
│   │   │   ├── CodexCliProvider.ts
│   │   │   ├── CodexResponseParser.ts
│   │   │   ├── CodexNotificationMonitor.ts
│   │   │   ├── CodexToolPermissionMapper.ts
│   │   │   └── CodexLogParser.ts
│   │   └── shared/                    # Truly shared utilities (no provider-specific logic)
│   │       ├── interfaces/            # Provider contracts
│   │       │   ├── ICliProvider.ts
│   │       │   ├── IResponseParser.ts
│   │       │   ├── INotificationMonitor.ts
│   │       │   ├── IToolPermissionMapper.ts
│   │       │   └── ILogParser.ts
│   │       ├── CliProcessManager.ts   # Process/terminal management
│   │       ├── BaseLogParser.ts       # Base class for log file parsing
│   │       ├── CliMcpConfigGenerator.ts # MCP config generation
│   │       └── TempFileManager.ts     # Temp file utilities
│   ├── orchestration/             # Specialized orchestration classes
│   │   ├── EndConditionHandler.ts # Retry and validation logic
│   │   ├── WorkflowExecutor.ts    # Workflow execution loop
│   │   ├── TemplateImporter.ts    # Agent/template import
│   │   ├── WorkflowCommandHandler.ts  # File creation commands
│   │   └── WorkspaceSessionManager.ts # Session persistence
│   ├── FlightPathManager.ts       # Orchestration with factory pattern
│   ├── PromptQueue.ts             # Execution queue
│   ├── PromptFileParser.ts        # JSON/YAML parsing
│   ├── TemplateManager.ts         # Workflow template management
│   ├── QueueOperations.ts         # MCP/LM Tools integration utilities
│   └── EndConditionEvaluator.ts   # Script validation
├── templates/                    # Templates for scripts, agents, and workflows
│   ├── agents/                   # Custom agent templates
│   │   ├── manifest.json         # Agent metadata and descriptions
│   │   └── flightpath-orchestrator.agent.md  # Plan→Implement→Review workflow creator
│   ├── workflows/                # Workflow templates with {placeholder} variables
│   │   ├── manifest.json         # Workflow metadata and descriptions
│   │   ├── simple-feature.flightpath.yaml
│   │   ├── fix-tests.flightpath.yaml
│   │   ├── full-feature.flightpath.yaml
│   │   ├── simple-feature.flightpath.json  # JSON versions also available
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
│   ├── icons/                    # Custom SVG icons (source only, NOT copied to output)
│   │   ├── append.svg            # Icon source files
│   │   └── README.md             # Icon system documentation
│   └── webview/                  # Webview assets (copied to output)
│       ├── dashboard.html        # Dashboard template
│       ├── dashboard.scss        # Dashboard styles (compiled to CSS)
│       ├── dashboard.js          # Dashboard logic
│       ├── custom-icons.css      # Generated from icons/ (auto-created)
│       ├── settings.html         # Settings template
│       ├── settings.scss         # Settings styles (compiled to CSS)
│       └── settings.js           # Settings logic
├── utils/
│   ├── BuildConfig.ts            # Build-time constants (IS_DEV_MODE, BUILD_DATE)
│   ├── ModelConstants.ts         # Model definitions (single source of truth)
│   └── ModelRegistry.ts          # Runtime model discovery
└── test/                         # Tests
schemas/                          # Schemas (source)
├── prompt-schema.json            # Unified JSON schema (source of truth)
└── prompt-schema.yaml            # Auto-generated YAML version
scripts/
├── sync-models.mjs               # Sync ModelConstants.ts ↔ package.json ↔ prompt-schema.json
└── generate-yaml-schema.mjs      # Generate YAML schema from JSON
```

**Workspace Folder Structure** (`.flightpath/`):

```
.flightpath/
├── scripts/       # Validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # Workflow templates with {placeholder} variables
└── workflows/     # Ready-to-run workflows (*.flightpath.yaml, *.flightpath.json, *.prompt.md)
```

**Build Output**:

- Templates copied from `src/templates/` to `out/templates/` during build
- Schemas copied from `schemas/` to `out/schemas/` during build
- YAML schema auto-generated from JSON schema via `npm run generate-schema`
- Single source of truth: `/schemas/prompt-schema.json` used for both VS Code IntelliSense and runtime validation
- **Dev code stripped**: In production builds, `IS_DEV_MODE=false` enables dead code elimination

<coreComponents>

Core orchestration and execution logic. See `.github/instructions/` for detailed implementation notes.

## FlightPathManager

Orchestrates workflow execution. Coordinates PromptQueue and CopilotIntegration. Factory pattern selects CLI vs Chat mode.

## PromptQueue

Sequential execution with pause/resume/cancel. State machine tracks progress. Response detection delegated to FlightPathManager.

## CopilotIntegration

Abstract base with four concrete implementations:

- **CLI Integrations** (composition-based architecture as of January 2026):
  - **Copilot CLI** (default): GitHub Copilot CLI with log file monitoring
  - **Claude CLI**: Anthropic's Claude Code CLI with JSON streaming and log file monitoring
  - **Codex CLI**: OpenAI's Codex CLI with JSONL events and notify hook
  - **Architecture**: Single generic `CliIntegration` class works with all providers via `ICliProvider` interface
  - **Provider isolation**: Each provider in separate directory (copilot/, claude/, codex/) with 5 required files
  - **Zero core changes**: Adding new providers requires NO modifications to CliIntegration or shared utilities
  - **Shared features**: Adaptive prompt passing (simple ≤300 chars direct, complex via temp files), two execution modes (interactive terminal or headless background), session continuity, token parsing
  - **Shared utilities**: CliProcessManager (process/terminal), CliMcpConfigGenerator (MCP config), BaseLogParser (log file monitoring)
  - **See**: `docs/ADDING_NEW_CLI_PROVIDER.md` for complete guide to adding new providers
- **Chat** (fallback): UI automation with log-based completion detection
  - **Components**: CopilotChatIntegration (orchestration), ChatLogMonitor (log polling), NativeAttachmentHandler (file attachments)
  - **Completion detection**: Two-tier log discovery (derived from context.logUri + fallback search)

All integrations support automatic file attachment for `@file` and `#file:path` references via unified ContextExpander utility.

## PromptFileParser

JSON schema validation with AJV. Validates both `.flightpath.yaml`, `.flightpath.yml`, `.flightpath.json`, and `.prompt.md` formats using unified schema.

## PromptCompletionProvider

IntelliSense for FlightPath prompt files:

- `@file` and `#file:` references with workspace files and current selections
- Dynamic model completions (models queried from Copilot API at activation)

## PromptLinkProvider

Clickable links (Ctrl+Click) for context references in prompt files:

- `@path/to/file.ts` → Opens file
- `@path/to/dir/` → Reveals directory in Explorer
- `#file:path:10-20` → Opens file with line selection
- `#sym:path:symbol:42` → Opens file at symbol line
- Bidirectional navigation between prompts and source code

## ModelRegistry

Queries available Copilot models via `vscode.lm.selectChatModels({ vendor: "copilot" })` at extension activation. Provides:

- Runtime model discovery (different users may have different models)
- Fallback to static list if API fails
- CLI support detection for each model

## EndConditionEvaluator

Executes validation scripts with timeout and process isolation. Template system for creating sample scripts.

## Session Management

**Per-prompt session tracking** enables different prompts to resume different CLI sessions:

- **PromptSessionResolver**: Resolves session IDs using three-tier precedence (prompt > workflow > global settings)
- **Three session ID formats**:
  - Numeric references: `sessionId: 1` → Reuse session from prompt 1
  - Exact session IDs: `sessionId: "550e8400-e29b-41d4-a716-446655440000"` → Resume specific session
  - Auto-resume: `newChatSession: false` → Continue from previous prompt
- **Runtime metadata**: `_runtime` tracks actual provider, model, and session ID used
- **Working file persistence**: Session IDs survive VS Code restarts (stored in `.flightpath/.working/`)
- **Provider-aware validation**: Prevents cross-provider session references (Copilot ↔ Claude ↔ Codex)
- **Session resolution algorithm**:
  1. Check `prompt.sessionId` (highest priority)
  2. Check `prompt.newChatSession`
  3. Check `workflow.newChatSession`
  4. Check global setting `flightpath.newChatSessionPerPrompt`
- **Integration**: CliIntegration uses resolved session IDs, passing to `provider.buildCliArgs()` for resume flags

See [docs/SESSION_MANAGEMENT.md](../docs/SESSION_MANAGEMENT.md) for complete user guide.

</coreComponents>

## File Formats & Schema

**Important: Prompts are stored in final-form format** - All context variables (@workspace, #file:path, slash commands) are included directly in the prompt text.

**Schema: All file types use the same unified schema (prompt-schema.json)**

FlightPath supports three file formats:

| Format       | Use Case                           | Extension                    |
| ------------ | ---------------------------------- | ---------------------------- |
| **Markdown** | Single prompts, simplest option    | `.prompt.md`                 |
| **YAML**     | Multi-step workflows, human-edited | `.flightpath.yaml` (DEFAULT) |
| **JSON**     | Programmatic generation, CI/CD     | `.flightpath.json`           |

### YAML Format (Recommended for Manual Editing)

YAML is the **default format** for user-created workflows. Use `|` (literal block scalar) for multi-line prompts to preserve line breaks exactly.

**Single Prompt Format:**

```yaml
prompt: |
  Analyze this codebase for potential bugs and code quality issues.

  Focus on:
  - Error handling
  - Type safety
  - Security concerns

model: claude-sonnet-4.5
endCondition:
  script: validate_improvements.py
  returns: "true"
  timeout: 30000
```

**Multi-Prompt Workflow Format:**

```yaml
prompts:
  - id: analyze
    prompt: |
      Analyze the FlightPath extension architecture.

      Focus on:
      - Separation of concerns
      - SOLID principles
      - Code maintainability
    model: claude-sonnet-4.5

  - id: implement
    prompt: |
      Based on the analysis, implement improvements.

      Follow SOLID principles and maintain consistency.
    newChatSession: false
    endCondition:
      script: verify_changes.py
      returns: "true"
      maxRetries: 2
      retryPrompt: |
        Validation failed: {error}

        Please fix the issues.
```

**File Path Reference (YAML):**

```yaml
prompt: ./prompts/analyze-code.prompt.md
model: claude-sonnet-4.5
```

### JSON Format (For Automation/CI/CD)

**Single Prompt Format:**

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

**Multiple Prompts Format:**

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

For simple single prompts, use `.prompt.md` files (no YAML/JSON needed):

```markdown
Analyze the FlightPath extension architecture and suggest improvements for better code organization. Focus on the separation of concerns between components.
```

**Markdown file handling**:

- `.prompt.md` files are read as plain text (entire file content becomes the prompt)
- No YAML/JSON parsing or schema validation needed
- Cannot include `model` override or `endCondition` (single prompt execution only)
- Supports same context variables: `@workspace`, `#file:path`, slash commands
- Use context menu (right-click) to execute: **Run with FlightPath** (or use the play icon in the editor title bar)

**File path resolution order** (for `prompt: path/to/file` references):

1. Absolute paths (used as-is)
2. Relative to the prompt file's directory
3. Relative to workspace root
4. Relative to `.flightpath` directory

**Supported file extensions:** `.prompt.md`, `.md`, `.txt`

**Optional Fields:**

- `model` - Override the AI model for a specific prompt.
  - **Dynamic discovery**: Models are queried at runtime via `vscode.lm.selectChatModels()`. Different users may have different models available.
  - **IntelliSense**: Use Ctrl+Space in prompt files to see available models with CLI support indicators.
  - **CLI-supported** (4 models): `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`
  - **Behavior**:
    - CLI mode: Validates against CLI_SUPPORTED_MODELS, warns and falls back to default if unsupported
    - Chat mode: Switches model using `workbench.action.chat.changeModel` before sending prompt
  - **Default**: If omitted, uses `flightpath.copilotCliModel` setting (CLI) or current chat model (Chat)

### Workflow-Level Properties

FlightPath supports **workflow-level properties** that provide default values for all prompts. This enables:

- **Reproducibility**: Workflows include their own defaults, ensuring consistent behavior
- **DRY Principle**: Define shared settings once instead of repeating per prompt
- **Common End Conditions**: Apply workflow-wide validation (e.g., "all prompts must pass tests")
- **Better Sharing**: Workflows with embedded defaults work consistently across users

**Three-Tier Precedence:**

```
Prompt-level properties (highest)
  ↓
Workflow-level properties
  ↓
VS Code global settings (fallback)
```

**Available Workflow Properties:**

- `provider` - AI provider for execution (`copilot-cli`, `copilot-chat`, `claude-cli`, `codex-cli`)
- `model` - AI model to use (provider-specific)
- `agent` - Custom agent file (`.agent.md`)
- `newChatSession` - Start new session per prompt (boolean)
- `allowDynamicExtension` - Allow dynamic queue extension (boolean)
- `endCondition` - Validation that applies to all prompts (can be overridden per prompt)

**YAML Example:**

```yaml
# Workflow-level defaults
provider: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"

prompts:
  - prompt: "Implement feature"
    # Inherits: copilot-cli, claude-sonnet-4.5, npm test validation

  - prompt: "Update docs"
    endCondition: null # Override: Skip validation for docs
```

**Property Resolution:**

When executing a prompt, FlightPath resolves each property by checking:

1. Prompt-level property (if defined) → **USE THIS**
2. Workflow-level property (if defined) → **USE THIS**
3. VS Code global setting → **FALLBACK**

The first defined value wins (highest priority takes precedence).

**Working File:**

- Provider and model **always saved** to working file (required for execution)
- Other properties saved when explicitly set by user
- Working file is single source of truth for both runtime state AND workflow configuration
- See [docs/WORKFLOW_PROPERTIES.md](../docs/WORKFLOW_PROPERTIES.md) for complete guide

**File naming conventions:**

- `.prompt.md` - Single markdown-based prompts (no YAML/JSON, simplest format)
- `.flightpath.yaml` / `.flightpath.yml` - Multi-step workflows (YAML format, recommended for manual editing)
- `.flightpath.json` - Multi-step workflows (JSON format, best for automation/CI/CD)

All formats support context menu execution (Run with FlightPath / Load in FlightPath).

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

Mocha-based with comprehensive unit test coverage (2,227 lines across 11 test files):

**High Priority - Fully Implemented:**

- ✅ PromptFileParser: JSON/YAML parsing, schema validation, file path resolution
- ✅ ValidationUtils: Security validation (directory traversal, shell injection)
- ✅ PromptQueue: State machine, lifecycle, dynamic queue extension
- ✅ EndConditionEvaluator: Script execution, timeout, retry with template variables
- ✅ PromptIdentity: Content hashing, duplicate detection, instruction injection logic

**Integration Tests:**

- ⚠️ CLI/Chat command registration and setup (partial coverage)
- ⚠️ Token parsing for Copilot/Claude CLI output

**Manual Testing:**

- AI-dependent features (workflow automation, real CLI responses)

See `.github/instructions/test.instructions.md` for complete test documentation.

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
- flightpath.defaultWorkflowFormat (enum: "yaml" | "json", default: "yaml")
  - **yaml**: YAML format (recommended for human editing with multi-line strings)
  - **json**: JSON format (best for programmatic generation and CI/CD)
  - **Usage**: Controls default file extension in createPromptFile command
- flightpath.autoAttachFiles (boolean, default: true) - Automatically process #file: references and attach file content
- flightpath.provider (enum: "copilot-cli" | "copilot-chat" | "claude-cli" | "codex-cli", default: "copilot-cli")
  - **copilot-cli**: GitHub Copilot CLI (default, best reliability)
  - **copilot-chat**: Copilot Chat window (UI automation, fallback)
  - **claude-cli**: Claude Code CLI (Anthropic's Claude with stream-json output)
  - **codex-cli**: Codex CLI (OpenAI's Codex with JSONL events)
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
- flightpath.cliToolPermissions (enum: "dangerouslyAllowAll" | "allowAll" | "custom", default: "allowAll") - **SHARED** between Copilot and Claude CLI
  - **dangerouslyAllowAll**: Bypasses ALL restrictions, ignores deny list (Copilot: `--allow-all-tools` only, Claude: `--dangerously-skip-permissions`)
  - **allowAll**: Auto-grants all tools but respects deny list (Copilot: `--allow-all-tools` + denies, Claude: `--tools "default"` + denies) - RECOMMENDED
  - **custom**: Uses specific allow/deny patterns from `cliAllowedTools` and `cliDeniedTools`
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
- flightpath.copilotCliLogDir (string, default: "") - Custom log directory (defaults to system temp)
  - **Note:** FlightPath always uses debug log level (hardcoded) to ensure session resumption works
  - As of CLI v0.0.377+, session IDs are only logged at DEBUG level in process log files CLI issues
- flightpath.showCliOutput (boolean, default: true) - Show CLI prompts/responses/statistics in Output panel
- flightpath.chatWindowLocation (enum: "chatPanel" | "newTab" | "newWindow", default: "chatPanel")
- flightpath.chatInactivityTimeout (number, default: 300, range: 30-3600) - Seconds to wait for log activity before timeout
- flightpath.treatChatTimeoutAsSuccess (boolean, default: true) - When true, inactivity timeouts are treated as completions (since Copilot may have finished)

**Claude Code CLI Settings** (when using `claude-cli` mode):

- flightpath.claudeCliModel (enum: "sonnet" | "opus" | "haiku", default: "sonnet")
  - **sonnet**: Best balance of speed and capability (recommended)
  - **opus**: Most capable, best for complex tasks
  - **haiku**: Fastest, best for simple tasks

**Note**: Claude CLI always uses `stream-json` output format for real-time streaming with full metadata. This is hardcoded and not configurable.

**Codex CLI Settings** (when using `codex-cli` mode):

- flightpath.codexCliModel (enum: "gpt-5.1-codex-max" | "gpt-5.1-codex" | "gpt-5.1-codex-mini" | "gpt-5.2" | "gpt-5.1", default: "gpt-5.1-codex")
  - **gpt-5.1-codex-max**: Maximum capability (slowest)
  - **gpt-5.1-codex**: Balanced performance (recommended)
  - **gpt-5.1-codex-mini**: Fastest, good for simple tasks
  - **gpt-5.2**: Latest model version
  - **gpt-5.1**: Previous stable version

**Note**: Codex CLI uses JSONL output format with notify hook for completion detection in interactive mode. Background process uses `{"type":"turn.completed"}` events.

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
4. Run: `npm run sync-models` (updates package.json AND prompt-schema.json)
5. Run: `npm run generate-schema` (regenerates YAML schema from JSON)
6. Commit all updated files

**Note:** The sync-models script now automatically updates BOTH package.json settings AND the prompt-schema.json model examples, ensuring autocomplete shows all available models across all providers (Copilot, Claude, Codex).

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
  - Codex CLI models (CODEX_CLI_MODELS)
  - Run `npm run sync-models` to sync package.json enums AND prompt-schema.json examples
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

- Structured automation via YAML/JSON configuration
- Script-based validation of AI outputs
- Fine-grained control over AI interaction sequences
- Seamless VS Code integration with context awareness
- Secure script execution with clear boundaries
- **Dynamic queue extension**: Copilot can autonomously extend workflows by modifying `.flightpath.yaml` or `.flightpath.json` files during execution

## Dynamic Queue Architecture

**Purpose**: Transform FlightPath from static workflow executor to adaptive autonomous agent framework.

**Status**: Fully implemented (opt-in via `flightpath.enableDynamicQueue` setting, default: `false`)

### Core Components

1. **PromptIdentity.ts**: Identity utilities for tracking completed prompts
   - `hashPromptContent()`: SHA-256 hash of normalized prompt text
   - `isPromptCompleted()`: Checks ID or content hash against completed set
   - `shouldInjectExtensionInstructions()`: Determines if prompt gets extension instructions

2. **PromptQueue.reloadAndMergeQueue()**: Reloads prompt file and merges new prompts
   - Validates YAML/JSON with PromptFileParser
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
- **Invalid YAML/JSON recovery**: Logs error and continues with current queue

### Settings

All in `package.json`:

- `enableDynamicQueue` (boolean, default: false)
- `dynamicExtensionOnLastPrompt` (boolean, default: true)
- `maxQueueSize` (number, default: 100, range: 1-1000)
- `maxExecutionTime` (number, default: 18000, range: 300-86400)
- `unlimitedMode` (boolean, default: false)
- `notifyOnQueueExtension` (boolean, default: true)

### Documentation

- **User guide & implementation**: `docs/QUEUE_APPEND_FEATURE.md`
- **Examples**: `manual-test/dynamic-queue-*.flightpath.json`
