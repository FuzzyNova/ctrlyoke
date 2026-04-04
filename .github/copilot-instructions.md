# FlightPath VS Code Extension

<projectPurpose>
Automate AI coding assistants (GitHub Copilot, Claude Code, Codex, OpenCode, Qwen, Gemini) through structured YAML/JSON-based prompt workflows with sequential execution, script-based validation, pause/resume support, and context awareness. The extension wraps AI CLI tools and the Copilot Chat UI, turning them into a programmable automation harness. Also ships as a standalone CLI binary (`flightpath`) for headless/CI usage.
</projectPurpose>

<technicalStack>
- **TypeScript 5.x** (strict mode throughout)
- **Node.js 22.17.0**
- **VS Code Extension API** — Language Model Tool API, Chat integration, completion providers
- **esbuild** — Extension bundling with dead-code elimination for dev/prod modes
- **js-yaml** + **AJV** — Prompt file parsing and JSON Schema validation
- **React 19 + Vite** — Webview dashboard UI (compiled separately)
- **Zustand** — Webview state management
- **Tailwind CSS + CodeMirror 6** — Webview styling and prompt editor
- **Mocha** — Test suite (~20,000 lines across ~64 test files)
- **@modelcontextprotocol/sdk** — MCP server for external queue management
</technicalStack>

<architecture>

## Harness Model

FlightPath supports seven **harnesses** (execution strategies for AI interactions):

| Harness ID     | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| `copilot-cli`  | GitHub Copilot CLI (default) — log file monitoring, session resumption        |
| `claude-cli`   | Anthropic Claude Code CLI — JSON streaming, hook-based completion             |
| `codex-cli`    | OpenAI Codex CLI — JSONL events, notify hook                                  |
| `opencode-cli` | OpenCode CLI — JSONL events, plugin-based completion, config-file permissions |
| `qwen-cli`     | Qwen Code CLI — JSONL events, log-based session discovery, hook completion    |
| `gemini-cli`   | Google Gemini CLI — JSON streaming, hook-based completion, MCP config support |
| `copilot-chat` | Copilot Chat window — session file monitoring, UI automation fallback         |

> **Critical terminology:** Always say **harness** (not "provider"). The term "provider" is reserved for VS Code API class names (`CompletionItemProvider`, `WebviewViewProvider`).

## Core Execution Flow

```
User loads workflow (.flightpath.yaml/.json/.prompt.md)
    → PromptFileParser (AJV schema validation)
    → WorkflowOrchestrator (singleton registry, harness lifecycle)
        → WorkflowInstance (per-workflow execution state)
            → WorkflowStateMachine (sole owner of runtime status transitions)
            → PromptQueue (prompt list + hash-based deduplication)
            → WorkflowExecutor (sequential execution loop, two-phase: queue → finalPrompt)
                → PropertyResolver (3-tier: prompt > workflow > settings)
                → HarnessIntegration (abstract base, 7 concrete implementations)
                    → CliIntegration / CopilotChatIntegration
                → EndConditionHandler (retry orchestration)
                    → EndConditionEvaluator (isolated child process)
            → OutputCaptureBuffer (per-step output buffering for replay)
    → DashboardBroadcastHub (fan-out hub → FlightPathWebviewProvider + other sinks)
```

## CLI Composition Architecture

`CliIntegration` is a **generic class** that works with all CLI harnesses via composition. Each harness lives in its own directory with 6 required files implementing clear interfaces:

```
src/flightpath/harness/
├── CliIntegration.ts          ← Generic, never modified for new harnesses
├── shared/interfaces/         ← ICliProvider, IResponseParser, INotificationMonitor, IToolPermissionMapper, ILogParser
├── shared/                    ← CliNotificationMonitor, CliOutputFormatter, CliResponseParser, CliToolPermissionMapper,
│                                 CliMcpConfigGenerator, CliProviderUtils, BaseLogParser, CliLogMonitor
│                                 + coordinator layer: CliTransportCoordinator, CliExecutionRunner, CliPromptPreparer,
│                                   CliResponseCollector, CliInteractiveStartupCoordinator, CliSessionResolverAdapter,
│                                   CliResponseTextExtractor, CliPromptRuntimeCoordinator
├── copilot/                   ← CopilotCliProvider + 5 supporting classes
├── claude/                    ← ClaudeCliProvider + 5 supporting classes
├── codex/                     ← CodexCliProvider + 5 supporting classes
├── opencode/                  ← OpenCodeCliProvider + 5 supporting classes
├── qwen/                      ← QwenCliProvider + 5 supporting classes
└── gemini/                    ← GeminiCliProvider + 5 supporting classes
```

Adding a new harness requires changes across multiple layers (harness directory, types, wiring, settings, UI). See `dev/implemented/ADDING_NEW_CLI_HARNESS.md` for the complete guide.

## Key Subsystems

- **WorkflowOrchestrator** — Singleton registry managing 7 harness integrations and cross-cutting resources (TemplateImporter, WorkflowCommandHandler, WorkspaceSessionManager)
- **WorkflowStateMachine** — Sole owner of runtime status transitions (idle → running → paused/completed/error); extracted from PromptQueue
- **DashboardBroadcastHub** — Fan-out hub implementing `IDashboardProvider` + `IDashboardSink`; decouples orchestrator from webview and other sinks
- **WorkflowInstance** — Per-workflow execution state container managing PromptQueue, WorkflowExecutor, EndConditionHandler, OutputHistoryManager, OutputCaptureBuffer
- **PromptQueue** — Prompt list with hash-based deduplication; WorkflowStateMachine owns status; WorkflowExecutor owns the execution loop
- **PropertyResolver** — Three-tier precedence: prompt-level → workflow-level → VS Code settings
- **SessionResolver** — Per-prompt session ID tracking with cross-harness validation
- **ContextExpander** — Expands `#selection:` and `@path` references before sending to AI
- **WorkingFileManager** — Extracted file I/O handler; atomic writes with file locking, disk merge for MCP-appended prompts
- **PlatformAdapter** — Abstract interface enabling core code to run in both VS Code extension and standalone CLI binary (VsCodeAdapter + CliAdapter)
- **PtyProcessManager** — Singleton managing node-pty sessions for embedded terminal display (kind: 'ai-cli' or 'shell')
- **User-Defined Hooks** — Cross-cutting feature in `ExecutionProperties.hooks` allowing pre/post execution hooks alongside agent/skills/mcpServers
- **SettingsJsonHooksTracker** — Manages `.github/hooks/*.json` registration for CLI harnesses; cleans up on deactivation
- **SettingsJsonMcpTracker** — Parallel-safe MCP server config management in VS Code settings; workspace `.vscode/mcp.json` support
- **McpDiscoveryUtils** — Discovers local MCP servers from `.vscode/mcp.json`, `.mcp.json`, VS Code config, `~/.claude.json`; registry pagination
- **MCP Server** (`src/mcp-server.ts`) — Standalone stdio server for queue management from CLI harnesses
- **LM Tools** — `flightpath_queue_status` and `flightpath_append_queue` for VS Code Chat integration
- **React Webview** — Dashboard with 5 Zustand stores, prompt editor (CodeMirror), output viewer, embedded terminal (xterm.js), settings panel; includes ContextQuickPicker and PermissionsQuickPicker footer controls

</architecture>

<navigationGuide>

## How to Navigate This Codebase

### Key Source Files (Quick Reference)

| File                                      | Role                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `src/extension.ts`                        | Entry point — activates harnesses, registers commands, LM tools, and providers |
| `src/mcp-server.ts`                       | Standalone MCP server binary (`flightpath-mcp`)                                |
| `src/cli.ts`                              | Standalone CLI binary entry point (`flightpath`)                               |
| `src/platform/PlatformAdapter.ts`         | Abstract interface for VS Code / CLI platform abstraction                      |
| `src/flightpath/WorkflowOrchestrator.ts`  | Singleton registry — harness lifecycle, cross-cutting resources                |
| `src/flightpath/WorkflowInstance.ts`      | Per-workflow execution state (queue, executor, history, output buffer)         |
| `src/flightpath/WorkflowStateMachine.ts`  | Sole owner of runtime status transitions                                       |
| `src/flightpath/HarnessIntegration.ts`    | Abstract base class for all harnesses                                          |
| `src/flightpath/PromptQueue.ts`           | Prompt list with hash-based deduplication                                      |
| `src/flightpath/WorkflowExecutor.ts`      | Sequential execution loop (two-phase: queue → finalPrompt)                     |
| `src/flightpath/PromptFileParser.ts`      | YAML/JSON parsing with AJV validation                                          |
| `src/flightpath/EndConditionEvaluator.ts` | Script validation in isolated child process                                    |
| `src/flightpath/IntegrationFactory.ts`    | Factory for creating harness-specific CliIntegration instances                 |
| `src/types/DashboardConstants.ts`         | **Single source of truth** for all shared constants (100+ message types)       |
| `src/types/FlightPathTypes.ts`            | Core workflow types (PromptItem, Harness enum, ExecutionProperties, etc.)      |
| `src/utils/ConfigurationUtils.ts`         | All VS Code settings access centralized here                                   |
| `src/utils/ModelConstants.ts`             | Single source of truth for model lists                                         |
| `src/utils/McpDiscoveryUtils.ts`          | Local and registry MCP server discovery                                        |
| `src/ui/DashboardBroadcastHub.ts`         | Fan-out hub — decouples orchestrator from webview and other dashboard sinks    |
| `src/ui/FlightPathWebviewProvider.ts`     | React webview lifecycle and message routing                                    |
| `/schemas/prompt-schema.json`             | JSON Schema for prompt files (source — never edit `out/schemas/`)              |

</navigationGuide>

<keyPrinciples>

## Principles That Apply Everywhere

### SOLID + DRY

- **Single Responsibility:** Each class has one job. WorkflowOrchestrator manages lifecycle; WorkflowExecutor runs the loop; EndConditionHandler retries.
- **Open/Closed:** Add new harnesses without touching `CliIntegration` (composition pattern).
- **DRY:** If a string, constant, or logic appears in more than one _file_, it **must** be extracted to a single source of truth.

### No Hardcoded Strings

All shared string literals (message types, execution states, harness IDs, step statuses) **must** be defined in `src/types/DashboardConstants.ts`. Never duplicate across files.

```typescript
// ✅ Correct
import { EXECUTION_STATES, MESSAGE_TYPES, HARNESS_IDS } from "../types/DashboardConstants";
if (state.status === EXECUTION_STATES.RUNNING) { ... }

// ❌ Wrong
if (state.status === "running") { ... }
```

The single source of truth for **inline strings that are acceptable**: CSS class names or UI labels used in only one file, HTML attributes, one-off display text.

### TypeScript Strict Mode

Use `ExecutionState`, `StepStatus`, `HarnessId`, `MessageType` type helpers from `DashboardConstants`. Use the `Harness` enum from `FlightPathTypes`. Avoid `any` except in boundary code (VS Code API surfaces).

### Harness Terminology

- ✅ **harness** — the AI execution framework (copilot-cli, claude-cli, codex-cli, opencode-cli, qwen-cli, gemini-cli, copilot-chat)
- ✅ **integration** — a `HarnessIntegration` subclass implementing harness behavior
- ✅ **model** — the AI model within a harness (claude-sonnet-4.5, gpt-5, etc.)
- ❌ ~~provider~~ — deprecated, only valid for VS Code API class names

### Security

- Scripts: workspace-only paths, process isolation, configurable timeout
- File system: workspace-scoped operations only
- Validation: strict JSON schema enforcement via AJV

</keyPrinciples>

<projectStructure>

## Directory Layout

```
src/
├── extension.ts                  # Entry point
├── cli.ts                        # Standalone CLI binary entry point
├── mcp-server.ts                 # Standalone MCP server binary
├── completions/                  # IntelliSense and document link providers
├── dev/                          # Dev-only commands (stripped in production)
├── platform/                     # PlatformAdapter, VsCodeAdapter, CliAdapter, vscode-shim
├── flightpath/                   # Core business logic
│   ├── HarnessIntegration.ts     # Abstract base for all harnesses
│   ├── WorkflowOrchestrator.ts   # Singleton registry, harness lifecycle
│   ├── WorkflowInstance.ts       # Per-workflow execution state
│   ├── WorkflowStateMachine.ts   # Runtime status transitions (extracted from PromptQueue)
│   ├── IntegrationFactory.ts     # Factory for harness-specific integrations
│   ├── PromptQueue.ts            # Prompt list + hash-based deduplication
│   ├── WorkflowExecutor.ts       # Sequential execution loop
│   ├── PromptFileParser.ts       # YAML/JSON parsing + validation
│   ├── EndConditionEvaluator.ts  # Script execution in child process
│   ├── EndConditionHandler.ts    # Retry orchestration
│   ├── TemplateManager.ts        # Workflow template management
│   ├── QueueOperations.ts        # Shared queue ops (MCP + LM Tools)
│   ├── WorkingFileManager.ts     # Atomic file I/O with file locking
│   ├── harness/                  # ALL harnesses: CliIntegration, 6 CLI providers, + chat/
│   │   ├── shared/               # CliNotificationMonitor, CliOutputFormatter, CliLogMonitor,
│   │   │                         # CliProviderUtils, coordinator classes (CliTransportCoordinator,
│   │   │                         # CliExecutionRunner, CliPromptPreparer, CliResponseCollector, etc.)
│   │   └── chat/                 # CopilotChatIntegration + session monitoring
│   └── orchestration/            # PromptFileLoader, PromptFileWatcher,
│                                 # TemplateImporter, WorkflowCommandHandler,
│                                 # WorkspaceSessionManager, OutputHistoryManager,
│                                 # CliWatchSession, WorkspaceInitializer
├── scripts/                      # Hook/notify scripts (6 JS scripts + 1 TypeScript OpenCode plugin)
├── templates/                    # Built-in workflow/agent templates
├── types/                        # Core types and shared constants (7 files)
├── ui/
│   ├── DashboardBroadcastHub.ts      # Fan-out hub implementing IDashboardProvider + IDashboardSink
│   ├── FlightPathWebviewProvider.ts  # Sidebar panel provider (delegates to 3 classes)
│   ├── StatusBarManager.ts           # Status bar integration
│   ├── FlightPathMcpServerProvider.ts # McpServerDefinitionProvider for copilot-chat
│   ├── icons/                        # SVG sources → auto-converted to CSS (7 harness icons)
│   └── webview-react/                # React dashboard (Vite bundle, 5 Zustand stores)
├── utils/                        # Shared utilities (26+ modules)
└── test/                         # Mocha test suite (~64 files, ~20,000 lines)

schemas/                          # Prompt schema source (JSON + auto-generated YAML)
scripts/                          # Build scripts (sync-models, generate-schema)
docs/                             # Design docs and implementation notes
```

### Workspace Runtime Folder (`.flightpath/`)

The extension creates and manages `.flightpath/` in each workspace:

```
.flightpath/
├── .queue/        # Working files (runtime state for active workflows)
├── .history/      # Per-run output history snapshots
├── scripts/       # User validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # User workflow templates
├── workflows/     # Ready-to-run workflows
├── agents/        # Custom agent files (*.agent.md)
├── skills/        # Custom skill files
├── temp/          # Temp files for prompt passing and hooks
└── logs/          # Hook/notify debug logs
```

</projectStructure>

<fileFormats>

## Prompt File Formats

All three formats use the same unified JSON Schema (`/schemas/prompt-schema.json`).

| Format   | Extension                              | Best For                                      |
| -------- | -------------------------------------- | --------------------------------------------- |
| YAML     | `.flightpath.yaml` / `.flightpath.yml` | Multi-step workflows, human editing (default) |
| JSON     | `.flightpath.json`                     | Programmatic generation, CI/CD                |
| Markdown | `.prompt.md`                           | Single prompts (simplest, no schema fields)   |

### YAML Multi-Step Workflow (Recommended)

```yaml
# Workflow-level defaults (three-tier precedence: prompt > workflow > settings)
harness: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"

prompts:
  - name: analyze
    prompt: |
      Analyze the architecture and suggest improvements.

  - name: implement
    prompt: |
      Implement the suggested improvements.
    resumeSession: true # Continue conversation from previous prompt
    endCondition:
      script: verify_changes.py
      returns: "true"
      maxRetries: 2
      retryPrompt: |
        Validation failed: {error}
        Please fix the issues.
```

### Key Schema Fields

- **`prompt`**: Inline text, or path to `.prompt.md`/`.md`/`.txt` (absolute, workspace-relative, or `.flightpath/`-relative)
- **`resumeSession`**: Continue conversation from previous prompt (bool)
- **`sessionId`**: Resume by GUID/thread ID, or reference prior prompt by number (`sessionId: 1`)
- **`harness`**: Per-prompt harness override
- **`model`**: Per-prompt model override
- **`agent`**: Path to `.agent.md` custom agent file
- **`mcpServers`**: MCP servers to attach (e.g., `["flightpath"]` to enable dynamic queue extension)
- **`hooks`**: User-defined hooks for pre/post execution (alongside agent/skills/mcpServers in ExecutionProperties)
- **`endCondition`**: `{ script, returns, timeout?, maxRetries?, retryPrompt? }`

> **Final-form storage**: Context references (`@workspace`, `#selection:path:N-N`) are included directly in prompt text — no runtime injection.

> **Schema source**: `/schemas/prompt-schema.json`. Never edit `out/schemas/` — auto-copied during build.

</fileFormats>

<extensionSettings>

## Key Extension Settings

All settings accessed via `src/utils/ConfigurationUtils.ts`. Prefix: `flightpath`.

| Setting                     | Default             | Description                                                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `harness`                   | `copilot-cli`       | Active harness: `copilot-cli`, `copilot-chat`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, `gemini-cli` |
| `cliExecutionMode`          | `interactive`       | `interactive` (terminal) or `headless` (background process)                                                        |
| `copilotCliModel`           | `claude-sonnet-4.5` | Default model for Copilot CLI                                                                                      |
| `claudeCliModel`            | `sonnet`            | Default model for Claude CLI                                                                                       |
| `codexCliModel`             | `gpt-5.2-codex`     | Default model for Codex CLI                                                                                        |
| `openCodeCliModel`          | (provider default)  | Default model for OpenCode CLI (provider/model format)                                                             |
| `qwenCliModel`              | `coder-model`       | Default model for Qwen Code CLI                                                                                    |
| `geminiCliModel`            | `gemini-2.5-pro`    | Default model for Gemini CLI                                                                                       |
| `cliToolPermissions`        | `allowAll`          | `dangerouslyAllowAll`, `allowAll`, or `custom`                                                                     |
| `cliAllowedTools`           | `[]`                | Tool allow patterns (Copilot format, auto-converted for Claude/Codex)                                              |
| `cliDeniedTools`            | `[]`                | Tool deny patterns (takes precedence over allow)                                                                   |
| `promptsDirectory`          | `.flightpath`       | Base directory for workflows and scripts                                                                           |
| `scriptTimeout`             | `30`                | End condition script timeout in seconds                                                                            |
| `autoAttachFiles`           | `true`              | Auto-expand `#selection:` references to inline content                                                             |
| `enableDynamicQueue`        | `false`             | Allow AI to extend the workflow queue                                                                              |
| `showCliOutput`             | `true`              | Show CLI output in the Output panel                                                                                |
| `chatInactivityTimeout`     | `300`               | Seconds before chat timeout (Chat harness only)                                                                    |
| `treatChatTimeoutAsSuccess` | `true`              | Treat chat inactivity timeout as completion                                                                        |

**Adding new settings:** Add to `package.json` → `contributes.configuration.properties`, then read via `ConfigurationUtils.get<T>("settingName", defaultValue)`. Use `enum` + `enumDescriptions` for dropdowns.

</extensionSettings>

<developmentGuidelines>

## Development

### Build Commands

```bash
npm run compile          # Dev build (IS_DEV_MODE=true)
npm run compile:prod     # Production build (IS_DEV_MODE=false, dead code eliminated)
npm run watch            # Watch mode for development
npm run build:webview    # Build React webview (Vite)
npm run package          # Full production VSIX package
npm test                 # Run Mocha test suite
```

**F5** in VS Code launches the Extension Development Host with the dev build.

### Dev Mode

`src/utils/BuildConfig.ts` exports `IS_DEV_MODE` (replaced at build time by esbuild). Dev-only commands in `src/dev/DevCommands.ts` are registered only when `IS_DEV_MODE = true`, never declared in `package.json`, and stripped entirely in production.

### Updating AI Models

1. Run extension (F5) → run **FlightPath: Export Discovered Models** command
2. `npm run sync-models -- --import` → updates `src/utils/ModelConstants.ts`
3. `npm run sync-models` → syncs `package.json` enums AND `schemas/prompt-schema.json`
4. `npm run generate-schema` → regenerates YAML schema from JSON
5. Commit all updated files

### Adding a New CLI Harness

See `dev/implemented/ADDING_NEW_CLI_HARNESS.md`. Creates files in `src/flightpath/harness/<name>/` plus required changes to types, wiring, settings, and UI layers.

### Adding a New Prompt Property

1. `src/types/FlightPathTypes.ts` — add to `PromptItem` interface
2. `schemas/prompt-schema.json` — add to schema properties
3. Run `npm run sync-models` if model-related
4. Update `FlightPathWebviewProvider.ts` message handling if needed
5. Update webview stores/components if the property should be editable in the dashboard

### Project Status

**Pre-release** — No backward compatibility constraints. Prioritize clean architecture. Bold improvements are encouraged.

### Testing

- `npm test` → `@vscode/test-electron` → Mocha discovers `**/**.test.js` (TDD style)
- ~20,000 lines across ~64 test files covering parsing, validation, state machines, CLI parsers, session management, tool permissions, hooks, orchestration, log parsers, coordinator classes
- AI-dependent features (real workflows) require manual testing only

</developmentGuidelines>

<singleSourcesOfTruth>

## Where Things Live (Single Sources of Truth)

| What                                                              | Location                            |
| ----------------------------------------------------------------- | ----------------------------------- |
| All shared string constants (message types, states, harness IDs)  | `src/types/DashboardConstants.ts`   |
| Core workflow types (`PromptItem`, `Harness` enum, `WorkingFile`) | `src/types/FlightPathTypes.ts`      |
| Universal CLI output types                                        | `src/types/CliOutputTypes.ts`       |
| Extension ↔ webview message contracts                             | `src/types/WebviewMessageTypes.ts`  |
| Workflow context for harness sendPrompt calls                     | `src/types/WorkflowContextTypes.ts` |
| Model lists and display names                                     | `src/utils/ModelConstants.ts`       |
| All VS Code settings access                                       | `src/utils/ConfigurationUtils.ts`   |
| Prompt file JSON schema                                           | `schemas/prompt-schema.json`        |
| Directory path name constants                                     | `ConfigurationUtils.PATH_CONSTANTS` |
| Platform abstraction contract                                     | `src/platform/PlatformAdapter.ts`   |

</singleSourcesOfTruth>

<instructionFiles>

## Detailed Instruction Files

The `.github/instructions/` directory contains detailed implementation guidelines scoped by file pattern. Read the relevant instruction file(s) before editing files in that area.

| File Pattern                           | Instruction File                        | Covers                                                                                                       |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/flightpath/*.ts` (top-level only) | `flightpath-core.instructions.md`       | WorkflowOrchestrator, WorkflowStateMachine, WorkflowInstance, PromptQueue, WorkflowExecutor, EndCondition    |
| `src/flightpath/harness/**`            | `harness-integrations.instructions.md`  | CliIntegration, all 6 CLI providers, shared coordinator layer, ICliProvider interface, PtyProcessManager     |
| `src/flightpath/harness/chat/**`       | `flightpath-chat.instructions.md`       | CopilotChatIntegration (UI automation fallback)                                                              |
| `src/platform/**`                      | `platform.instructions.md`              | PlatformAdapter, VsCodeAdapter, CliAdapter, vscode-shim                                                      |
| `src/cli.ts`, `src/cli/**`             | `flightpath-cli-binary.instructions.md` | FlightPath CLI binary, CliAdapter, CliTerminalFormatter                                                      |
| `src/ui/**` (excl. webview-react)      | `ui.instructions.md`                    | DashboardBroadcastHub, FlightPathWebviewProvider, StatusBar, McpServerProvider, message routing              |
| `src/ui/webview-react/**`              | `webview-react.instructions.md`         | React dashboard, 5 Zustand stores, CodeMirror editor, xterm.js terminal, ContextQuickPicker, PermissionsQuickPicker |
| `src/types/**`                         | `types.instructions.md`                 | 7 type files: FlightPathTypes, DashboardConstants, CliOutputTypes, etc.                                      |
| `src/utils/**`                         | `utils.instructions.md`                 | 26+ utilities: ConfigurationUtils, McpDiscoveryUtils, GitUtils, etc.                                         |
| `src/completions/**`                   | `completions.instructions.md`           | IntelliSense providers and document link navigation                                                          |
| `src/scripts/**`                       | `scripts.instructions.md`               | 6 JS hook scripts + 1 TypeScript OpenCode plugin                                                             |
| `src/templates/**`                     | `templates.instructions.md`             | End condition script templates                                                                               |
| `src/test/**`                          | `test.instructions.md`                  | ~64 test files, testing patterns and conventions                                                             |
| `src/dev/**`                           | `dev.instructions.md`                   | Dev-only commands (stripped in production)                                                                   |

</instructionFiles>
