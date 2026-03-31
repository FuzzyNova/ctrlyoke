# FlightPath CLI Design

**Document Status**: Implemented — All phases complete
**Last Updated**: 2026-03-07

## Overview

FlightPath CLI is a standalone command-line tool that executes FlightPath prompt workflows without requiring VS Code. It **shares core code** with the VS Code extension, providing the same AI-powered workflow automation through Copilot CLI and Claude CLI integrations, but runs directly in any terminal environment.

### Design Principles

1. **Maximum Code Reuse**: Share as much code as possible with the VS Code extension via a platform abstraction layer
2. **Interactive by Default**: Support interactive CLI mode for tool approvals (not headless-only)
3. **Platform Abstraction**: Create thin adapters for VS Code vs Node.js runtime differences

### Motivation

1. **CI/CD Integration**: Run FlightPath workflows in build pipelines, GitHub Actions, or other automation systems
2. **Editor Agnostic**: Use FlightPath with any editor or without an editor at all
3. **Server/Remote Execution**: Execute workflows on remote servers without VS Code
4. **Scripting**: Chain FlightPath into larger shell scripts or automation workflows
5. **Code Sharing**: Single source of truth for core logic reduces maintenance burden

### Relationship to VS Code Extension

FlightPath CLI is a **sibling product** sharing core code:

| Feature          | VS Code Extension     | FlightPath CLI                  |
| ---------------- | --------------------- | ------------------------------- |
| Chat Integration | ✅ Full support       | ❌ Not supported                |
| CLI Integration  | ✅ Copilot + Claude   | ✅ Copilot + Claude             |
| Interactive Mode | ✅ VS Code terminal   | ✅ Native terminal (PTY)        |
| Headless Mode    | ✅ Background process | ✅ Background process           |
| Dashboard UI     | ✅ WebView panel      | ❌ Terminal output (TUI future) |
| IntelliSense     | ✅ Completions        | ❌ None                         |
| Settings         | VS Code settings      | Config file + flags             |
| **Shared Core**  | ✅ Same codebase      | ✅ Same codebase                |

---

## Design Decisions

The following decisions have been made for FlightPath CLI:

### 1. Distribution: npm Package

```bash
npm install -g @flightpath/cli
# or
npx @flightpath/cli run workflow.flightpath.json
```

**Rationale**: Node.js is already required for Copilot/Claude CLIs. npm provides simple distribution and updates. Consider standalone binary (pkg/nexe/bun) for v2.

### 2. Package Structure: Single Repo with Conditional Build

Same repository, esbuild creates separate bundles:

- `out/extension.js` - VS Code extension bundle
- `out/mcp-server.js` - MCP server binary (already exists)
- `out/cli.js` - CLI bundle (Node.js entry point)

**Rationale**: True code sharing without monorepo complexity. Same files, different entry points. Some VS Code-specific code may need to be extracted to separate files, but core logic stays shared.

### 3. Interactive Mode: Hybrid Approach

```typescript
function getExecutionMode(options: CliOptions): "interactive" | "headless" {
  if (options.headless) return "headless";
  if (options.interactive) return "interactive";

  // Auto-detect: TTY = interactive, piped = headless
  return process.stdout.isTTY && process.stdin.isTTY
    ? "interactive"
    : "headless";
}
```

**Rationale**: Users in terminals get interactive mode for tool approvals. CI/CD pipelines (piped I/O) automatically get headless mode. Explicit flags available for override.

### 4. Configuration Priority

```
CLI Flags > Environment Variables > Config File > Defaults
```

**Rationale**: Standard for CLI tools. Enables CI/CD flexibility with environment variables while allowing project-specific config files.

---

## MVP Scope

### In Scope ✅

1. **Execute prompt files**: `.flightpath.json`, `.flightpath.yaml`, `.prompt.md`
2. **CLI integrations**: Copilot CLI and Claude CLI (shared code with extension)
3. **Execution modes**:
   - **Interactive mode** (default): Full PTY for tool approvals and user interaction
   - **Headless mode** (`--headless`): For CI/CD, no user interaction
4. **Sequential execution**: One prompt at a time, in order
5. **Streaming output**: Real-time CLI output to terminal
6. **End conditions**: Script-based validation with timeout (shared code)
7. **Exit codes**: Standard success/failure reporting
8. **Configuration**: CLI flags, config file, environment variables
9. **Session management**: Multi-turn conversations with `--resume`

### Out of Scope (Future) ❌

1. Chat window integration (VS Code only - requires VS Code APIs)
2. Dynamic queue extension (v2)
3. Watch mode / `--close-on-completion` (auto-advance between prompts while user watches; requires per-harness exit command handling)
4. File watch mode (re-run on file changes)
5. Parallel execution
6. TUI Dashboard (ink/blessed)
7. IntelliSense/completions
8. `init` command (interactive workflow scaffolding)

---

## CLI Interface Design

### Basic Usage

```bash
# Run a workflow file
flightpath run workflow.flightpath.json

# Run a single prompt
flightpath run prompt.prompt.md

# Specify harness explicitly
flightpath run workflow.yaml --harness copilot-cli
flightpath run workflow.yaml --harness claude-cli

# Override model
flightpath run workflow.json --model claude-sonnet-4.5

# Specify working directory
flightpath run workflow.json --cwd /path/to/project
```

### Command Structure

```
flightpath <command> [options]

Commands:
  run <file>       Execute a prompt or workflow file
  validate <file>  Validate a prompt file without executing
  version          Show version information

Global Options:
  --help, -h       Show help
  --version, -v    Show version
  --quiet, -q      Suppress all output except errors
  --verbose        Show detailed debug output
  --json           Output results as JSON (for scripting)
```

### Run Command Options

```
flightpath run <file> [options]

Positional:
  file             Path to .flightpath.json, .flightpath.yaml, or .prompt.md

Workflow Options (override file-level and config settings):
  --harness, -H    AI harness: 'copilot-cli', 'claude-cli', 'codex-cli' (default: copilot-cli)
  --model, -m      Model to use (overrides file and config)
  --cwd, -d        Working directory (default: directory of prompt file)
  --config, -c     Path to config file (default: .flightpathrc.json)
  --timeout, -t    Global timeout in seconds (default: 3600)
  --resume, -r     Resume session with given ID
  --new-session    Force new session (ignore resume)

  Note: --harness and --model are especially useful for .prompt.md files, which
  cannot embed these settings in the file format itself.

Execution Mode:
  --interactive              Force interactive mode (PTY, user can respond to prompts)
  --headless                 Force headless mode (CI/CD, no user interaction)

Tool Permissions:
  --allow-all-tools          Allow all tools without prompting (auto-applied in headless)
  --allow-tool <pattern>     Allow specific tool pattern (can repeat; auto-converted per harness)
  --deny-tool <pattern>      Deny specific tool pattern (can repeat)
  --add-dir <path>           Add directory to Copilot CLI allowed paths (can repeat)

Output Control:
  --json                     Output as JSON
  --quiet, -q                Only show errors
  --verbose                  Show debug information
  --no-color                 Disable colored output
```

### Examples

```bash
# Basic workflow execution
flightpath run my-workflow.flightpath.yaml

# Single prompt file with harness and model (required for .prompt.md)
flightpath run refactor.prompt.md --harness claude-cli --model opus

# CI/CD usage with JSON output
flightpath run ci-checks.flightpath.json --json --quiet > results.json

# Copilot CLI with restricted permissions
flightpath run deploy.flightpath.yaml \
  --harness copilot-cli \
  --allow-tool 'shell(git:*)' \
  --deny-tool 'shell(rm:*)'

# Codex CLI with specific model
flightpath run analyze.flightpath.yaml --harness codex-cli --model gpt-5.1-codex

# Resume previous session
flightpath run continue.prompt.md --resume abc123 --harness claude-cli

# Validate without running
flightpath validate workflow.flightpath.yaml
```

---

## Configuration

### Priority Order

```
CLI Flags > Environment Variables > Config File > Defaults
```

### Config File (`.flightpathrc.json`)

Located in (highest to lowest priority):

1. Current directory — project-level, can be committed or gitignored
2. Home directory (`~/.flightpathrc.json`) — user defaults

Config keys mirror CLI flag names directly. Harness-specific permission translation (e.g. Copilot `shell(git:*)` format → Claude tool names) is handled by `IToolPermissionMapper`, not by the config author.

```json
{
  "harness": "copilot-cli",
  "model": "claude-sonnet-4.5",
  "timeout": 3600,
  "scriptTimeout": 30000,
  "allowedTools": ["shell(git:*)"],
  "deniedTools": ["shell(rm:*)"],
  "color": true,
  "verbose": false
}
```

### Environment Variables

```bash
FLIGHTPATH_HARNESS=copilot-cli|claude-cli|codex-cli
FLIGHTPATH_MODEL=claude-sonnet-4.5
FLIGHTPATH_TIMEOUT=3600
FLIGHTPATH_SCRIPT_TIMEOUT=30000
FLIGHTPATH_VERBOSE=true|false
FLIGHTPATH_JSON=true|false
FLIGHTPATH_NO_COLOR=true|false
```

---

## Architecture

### VS Code Compatibility Guarantee

**The VS Code extension is the primary product. The CLI adds a new entry point — it does not modify the existing VS Code code paths.**

The `PlatformAdapter` pattern is a **wrapping** pattern, not a replacement:

- `VsCodeAdapter` wraps the same `vscode.*` calls that exist today — behavior of the extension is **unchanged**
- `CliAdapter` provides a new implementation for the same interface points
- Shared code calls `platform.log()` instead of `vscode.window.showWarningMessage()` directly — but when the platform is `VsCodeAdapter`, it calls `vscode.window.showWarningMessage()` internally, exactly as before
- All `vscode.window.show*Message()`, `vscode.workspace.getConfiguration()`, `vscode.workspace.workspaceFolders`, terminal creation — all preserved in `VsCodeAdapter` with identical behavior

The refactoring is strictly additive. Every `vscode.*` call that exists today either:

1. Moves into `VsCodeAdapter` where it continues to be called identically, or
2. Stays in VS Code-only files (`WorkflowOrchestrator`, `ui/`, `chat/`) that the CLI build never touches

The test for success: **zero behavior change** in the VS Code extension after any Platform Abstraction refactoring step. The extension must work identically before and after each individual change.

---

### Current Architecture (Post-Parallel-Workflows)

The parallel workflows implementation extracted `WorkflowInstance` from the former `FlightPathManager` (which no longer exists). The current architecture is:

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS CODE EXTENSION                             │
│  extension.ts → WorkflowOrchestrator → WorkflowInstance(s)      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  WorkflowOrchestrator.ts                                         │
│  ├── Map<id, WorkflowInstance>  (running/paused workflows)       │
│  ├── 4x detector singletons     (status checks, pre-flight)      │
│  ├── IntegrationFactory         (creates per-run integrations)   │
│  ├── StatusBarManager                                            │
│  └── FlightPathWebviewProvider (ref, for dashboard routing)      │
│                                                                  │
│  WorkflowInstance.ts (self-contained execution unit ✅)          │
│  ├── PromptQueue (state machine)                                 │
│  ├── WorkflowExecutor (sequential loop)                          │
│  ├── EndConditionHandler / EndConditionEvaluator                 │
│  ├── PromptFileLoader / PromptFileWatcher                        │
│  ├── OutputHistoryManager                                        │
│  └── activeIntegration (set during execution)                    │
│                                                                  │
│  IntegrationFactory.ts ✅                                        │
│  ├── createCopilotCli() / createClaudeCli() / createCodexCli()  │
│  ├── createCopilotChat()                                         │
│  └── createForExecution(harness) — isolated, per-run            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Target Architecture (CLI-Ready)

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLATFORM-SPECIFIC LAYER                       │
│  (Separate files per platform)                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  VS Code Extension              │  FlightPath CLI               │
│  ─────────────────              │  ──────────────               │
│  • extension.ts (entry)         │  • cli.ts (entry)             │
│  • VsCodeAdapter.ts             │  • CliAdapter.ts              │
│  • WorkflowOrchestrator.ts      │  • (not used — single         │
│  • ui/* (dashboard, webview)    │    WorkflowInstance only)     │
│  • chat/* (VS Code Chat API)    │  • (not supported)            │
│  • completions/* (IntelliSense) │  • (not supported)            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SHARED CORE (Platform-Agnostic)               │
│  (imports PlatformAdapter, not vscode directly)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  src/flightpath/                                                 │
│  ├── WorkflowInstance.ts    # Self-contained execution unit ✅  │
│  │                          # Needs: replace ExtensionContext    │
│  │                          # with PlatformAdapter              │
│  ├── PromptQueue.ts         # State machine                     │
│  │                          # Needs: Node EventEmitter          │
│  ├── WorkflowExecutor.ts    # Prompt execution loop             │
│  │                          # Needs: platform.warn() etc.       │
│  ├── PromptFileParser.ts    # JSON/YAML parsing (AJV)           │
│  │                          # Needs: Node fs, not vscode.fs     │
│  ├── EndConditionEvaluator.ts  # Script execution (clean ✅)    │
│  ├── EndConditionHandler.ts    # Retry logic (clean ✅)         │
│  ├── HarnessIntegration.ts  # Abstract base                     │
│  │                          # Needs: Node EventEmitter x5       │
│  ├── IntegrationFactory.ts  # Factory ✅                        │
│  │                          # Needs: replace ExtensionContext    │
│  └── cli/                                                       │
│      ├── CliIntegration.ts  # Generic CLI class (all harnesses) │
│      │                      # Needs: platform.createTerminal()  │
│      │                      # replace ExtensionContext          │
│      ├── copilot/           # Copilot CLI provider ✅           │
│      ├── claude/            # Claude CLI provider ✅            │
│      ├── codex/             # Codex CLI provider ✅             │
│      └── shared/            # Process mgmt, log parsing ✅      │
│                                                                  │
│  src/flightpath/orchestration/                                   │
│  ├── WorkspaceSessionManager.ts  # Session persistence          │
│  │                               # Needs: platform.getRoot()    │
│  ├── OutputHistoryManager.ts     # Run history (clean ✅)       │
│  ├── EndConditionHandler.ts      # Retry orchestration (✅)     │
│  └── PromptFileWatcher.ts        # Dynamic queue monitoring (✅) │
│                                                                  │
│  src/types/                 # All interfaces (clean ✅)          │
│  src/utils/                 # Shared utilities (mostly clean ✅) │
│  schemas/                   # JSON schema (clean ✅)             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Platform Abstraction Interface

Create a simple interface that both platforms implement. This replaces direct `vscode.*` usage in the shared core.

```typescript
// src/platform/PlatformAdapter.ts

export interface PlatformAdapter {
  // Configuration (replaces vscode.workspace.getConfiguration)
  getConfig<T>(key: string, defaultValue: T): T;

  // Workspace root (replaces vscode.workspace.workspaceFolders)
  getWorkspaceRoot(): string;

  // Logging/Output (replaces vscode.window.show*Message)
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  showProgress(message: string): void;

  // User prompts (replaces vscode.window.showWarningMessage with buttons)
  // Returns the chosen option or undefined if dismissed
  showChoice(
    message: string,
    ...options: string[]
  ): Promise<string | undefined>;

  // Interactive terminal for tool approvals
  // VS Code: creates a vscode.Terminal with shell integration
  // CLI: spawns with stdio:'inherit' (PTY pass-through)
  createInteractiveTerminal?(name: string): InteractiveTerminal;
}

// VS Code implementation — wraps existing vscode.* calls, behavior UNCHANGED
// src/platform/VsCodeAdapter.ts
export class VsCodeAdapter implements PlatformAdapter {
  constructor(private context: vscode.ExtensionContext) {}

  // Same call as today, just behind an interface
  getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get(key, defaultValue);
  }

  // Same as vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  // Same as vscode.window.showWarningMessage()
  warn(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  // Exposes the ExtensionContext for VS Code-only code that still needs it
  // (WorkflowOrchestrator, CliIntegration interactive terminal, etc.)
  getExtensionContext(): vscode.ExtensionContext {
    return this.context;
  }

  // Same as vscode.window.createTerminal() + shellIntegration.executeCommand()
  // This is the EXISTING interactive terminal path — nothing changes
  createInteractiveTerminal(name: string): InteractiveTerminal {
    return new VsCodeInteractiveTerminal(name, this.context);
  }
}

// CLI implementation
// src/platform/CliAdapter.ts
export class CliAdapter implements PlatformAdapter {
  constructor(private config: ResolvedCliConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    return ((this.config as Record<string, unknown>)[key] as T) ?? defaultValue;
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  warn(message: string): void {
    console.warn(`⚠ ${message}`);
  }

  createInteractiveTerminal(name: string): InteractiveTerminal {
    // Spawns with stdio:'inherit' — user's terminal IS the process
    return new CliInteractiveTerminal(name);
  }
  // ... etc
}
```

**What does NOT need abstraction** (already platform-agnostic):

- `fs/promises` — used identically in both contexts
- `child_process.spawn` — used identically in both contexts

---

### vscode Coupling: File-by-File Audit

Every file in the shared core that uses vscode APIs, with specific details:

#### `HarnessIntegration.ts` — 5x vscode.EventEmitter

```typescript
// Current (vscode-coupled):
protected statusChangeEmitter = new vscode.EventEmitter<HarnessStatus>();
public readonly onDidChangeStatus = this.statusChangeEmitter.event;
protected responseCompleteEmitter = new vscode.EventEmitter<string>();
protected streamingChunkEmitter = new vscode.EventEmitter<string>();
protected streamingEventsEmitter = new vscode.EventEmitter<CliEvent[]>();
protected promptReadyEmitter = new vscode.EventEmitter<{...}>();

// Target (Node.js EventEmitter):
import { EventEmitter } from "events";
// Replace vscode.EventEmitter<T> with a typed wrapper around Node EventEmitter
// All 5 emitters use the same pattern: emit(eventName, payload) / on(eventName, handler)
```

**Impact**: High. HarnessIntegration is the base class for ALL harness integrations. Changing its emitter type affects every subscriber — primarily WorkflowInstance and WorkflowExecutor. The `vscode.Event<T>` subscription pattern (`.event` property returning a function) must be replaced with Node.js `.on()` / `.once()`.

**Strategy**: Create a thin `TypedEmitter<T>` helper using Node's EventEmitter that preserves type safety and a similar subscription API, or just use Node's `EventEmitter` directly and update all call sites.

#### `PromptQueue.ts` — 1x vscode.EventEmitter

```typescript
// Current (line ~85):
private onStateChanged: vscode.EventEmitter<QueueState> = new vscode.EventEmitter<QueueState>();
public readonly onDidChangeState: vscode.Event<QueueState> = this.onStateChanged.event;
```

**Impact**: Medium. PromptQueue is used by WorkflowInstance and WorkflowExecutor which subscribe to `onDidChangeState`. Replace with Node EventEmitter and update the 2-3 subscriber call sites.

#### `CliIntegration.ts` — ExtensionContext + vscode.Terminal

```typescript
// Current constructor:
constructor(
  cliProvider: ICliProvider,
  context: vscode.ExtensionContext,   // <-- vscode coupled
  registerWithContext: boolean = true
)

// Uses ExtensionContext for:
// 1. Registering disposables: context.subscriptions.push(...)
// 2. Passing to CliProcessManager for terminal creation
// 3. Passing to TempFileManager for workspace paths

// vscode.Terminal is used in interactive mode (created by CliProcessManager)
```

**Impact**: High. CliIntegration is the core of all CLI harness execution.

**Strategy**: Replace `vscode.ExtensionContext` with `PlatformAdapter`. The `registerWithContext: boolean` flag was introduced for per-run integrations — in CLI context, registration is always false (no accumulation concern). Terminal creation delegates to `platform.createInteractiveTerminal()`.

#### `IntegrationFactory.ts` — ExtensionContext only

```typescript
// Current constructor:
constructor(private readonly context: vscode.ExtensionContext) {}

// Uses context only to pass to CliIntegration and CopilotChatIntegration constructors
```

**Impact**: Low. Once CliIntegration accepts PlatformAdapter, factory takes PlatformAdapter instead. CopilotChat is VS Code-only and goes in a separate `VsCodeIntegrationFactory`.

**Strategy**:

- `IntegrationFactory` becomes platform-agnostic, takes `PlatformAdapter`
- Split into `IntegrationFactory` (CLI harnesses only) and a VS Code subclass/variant that adds CopilotChat
- Or: keep `IntegrationFactory` but have CLI build use a separate factory that excludes CopilotChat

#### `WorkflowInstance.ts` — ExtensionContext + WebviewProvider + WorkspaceFolder

```typescript
// Current constructor:
constructor(
  private readonly context: vscode.ExtensionContext,         // <-- vscode
  private readonly dashboardProvider: FlightPathWebviewProvider | undefined, // <-- vscode UI
  private readonly integrationFactory: IntegrationFactory,
  private readonly getDetectorIntegration: (harnessOverride?: Harness) => HarnessIntegration,
  private readonly onWorkflowNameChange: (name: string | undefined) => void,
  private readonly onStatusBarUpdate: () => void,
  private readonly workflowFolder: vscode.WorkspaceFolder | undefined // <-- vscode
)
```

**Impact**: High. This is the key class the CLI must instantiate.

**Strategy**:

- Replace `vscode.ExtensionContext` with `PlatformAdapter` — WorkflowInstance passes it to sub-classes
- Replace `FlightPathWebviewProvider | undefined` with a `IDashboardSink | undefined` interface:
  ```typescript
  interface IDashboardSink {
    postMessage(message: unknown): void;
  }
  // VsCodeAdapter implements this by delegating to FlightPathWebviewProvider.postMessage()
  // CLI: pass undefined (no dashboard)
  ```
- Replace `vscode.WorkspaceFolder | undefined` with `string | undefined` (just the path) — the WorkspaceFolder is only used for `.uri.fsPath`, so pass the path directly

#### `WorkflowExecutor.ts` — vscode.window + vscode.commands

```typescript
// Uses:
vscode.window.showWarningMessage(...)      → platform.warn(...)
vscode.window.showInformationMessage(...)  → platform.log(...)
vscode.commands.executeCommand("flightpath.focusDashboard")  → remove from WorkflowExecutor
                                           // Dashboard focus is a VS Code UI concern only.
                                           // WorkflowOrchestrator handles it post-execution.
```

**Impact**: Low-Medium. Straightforward substitution, no structural changes needed.

#### `PromptFileParser.ts` — vscode.workspace.fs + vscode.Uri

```typescript
// Uses:
vscode.workspace.fs.stat(vscode.Uri.file(path))  → fs.stat(path)
vscode.workspace.fs.readFile(uri)               → fs.readFile(path)
vscode.window.showErrorMessage(...)             → platform.error(...)
```

**Impact**: Low. The vscode.workspace.fs API is functionally identical to Node.js fs/promises. Replace with direct `fs.stat()` and `fs.readFile()` calls.

**Note**: `PromptFileParser` currently uses `vscode.workspace.fs` for file existence checks. This was probably done for VS Code virtual file system support, but `.flightpath` workflows always live on disk, so Node.js fs is correct.

#### `WorkspaceSessionManager.ts` — vscode.workspace.workspaceFolders

```typescript
// Uses:
vscode.workspace.workspaceFolders?.[0]?.uri.fsPath  → platform.getWorkspaceRoot()
vscode.workspace.fs.readFile/writeFile              → Node.js fs/promises
```

**Impact**: Low. Two substitutions.

---

### Refactoring Strategy

**All phases are COMPLETE**: `WorkflowInstance` has been extracted, `IntegrationFactory` is implemented, `WorkflowOrchestrator` manages the multi-workflow registry, the `PlatformAdapter` abstraction is in place, and the CLI binary is live at `src/cli.ts`.

#### IntegrationFactory for CLI

The factory currently includes `CopilotChatIntegration` which requires VS Code APIs. The CLI needs a factory that only creates CLI harnesses.

**Option A: Split factory** (recommended):

```typescript
// src/flightpath/IntegrationFactory.ts — CLI harnesses only (platform-agnostic)
export class IntegrationFactory {
  constructor(private readonly platform: PlatformAdapter) {}

  createCopilotCli(registerWithContext?: boolean): CliIntegration { ... }
  createClaudeCli(registerWithContext?: boolean): CliIntegration { ... }
  createCodexCli(registerWithContext?: boolean): CliIntegration { ... }

  createForHarness(harness: CliHarness, ...): HarnessIntegration { ... }
  createForExecution(harness: CliHarness): HarnessIntegration { ... }
}

// src/flightpath/VsCodeIntegrationFactory.ts — extends with chat harness
export class VsCodeIntegrationFactory extends IntegrationFactory {
  createCopilotChat(registerWithContext?: boolean): CopilotChatIntegration { ... }

  // Override to handle all 4 harnesses including CopilotChat
  createForHarness(harness: Harness, ...): HarnessIntegration { ... }
}
```

**esbuild tree-shaking handles the rest**: Since `cli.ts` never imports `CopilotChatIntegration` (directly or transitively), it won't be bundled.

#### Simplified CLI Execution Flow

```typescript
// src/cli.ts — simplified execution flow (after Platform Abstraction)
const adapter = new CliAdapter(resolvedConfig);
const factory = new IntegrationFactory(adapter);

const instance = new WorkflowInstance({
  platform: adapter,
  integrationFactory: factory,
  getDetectorIntegration: (harness?) =>
    factory.createForExecution(harness ?? defaultHarness),
  // No dashboardProvider — no UI
  // No onWorkflowNameChange — no tab management
  // No onStatusBarUpdate — no status bar
});

await instance.loadPromptFile(filePath);
await instance.execute();

process.exit(
  instance.promptQueue.getState().status === EXECUTION_STATES.COMPLETED ? 0 : 1
);
```

---

### Project Structure (Current)

```
src/
├── extension.ts              # VS Code entry point
├── cli.ts                    # CLI entry point (NEW)
├── mcp-server.ts             # MCP server entry point (already exists)
├── platform/                 # Platform abstraction (NEW)
│   ├── PlatformAdapter.ts    # Interface definition
│   ├── VsCodeAdapter.ts      # VS Code implementation
│   └── CliAdapter.ts         # Node.js CLI implementation
├── flightpath/               # SHARED - Core logic
│   ├── WorkflowInstance.ts   # Self-contained execution unit ✅ (needs decoupling)
│   ├── IntegrationFactory.ts # Factory ✅ (needs ExtensionContext → PlatformAdapter)
│   ├── VsCodeIntegrationFactory.ts  # VS Code-only (adds CopilotChat) (NEW)
│   ├── WorkflowOrchestrator.ts      # VS Code multi-workflow registry (VS Code only)
│   ├── PromptQueue.ts        # State machine (replace vscode.EventEmitter)
│   ├── WorkflowExecutor.ts   # Execution loop (inject platform adapter)
│   ├── PromptFileParser.ts   # File parsing (remove vscode.workspace.fs)
│   ├── HarnessIntegration.ts # Abstract base (replace 5x vscode.EventEmitter)
│   ├── EndConditionEvaluator.ts  # Script runner (no vscode deps ✅)
│   ├── EndConditionHandler.ts    # Retry logic (no vscode deps ✅)
│   ├── cli/
│   │   ├── CliIntegration.ts      # Generic CLI (replace ExtensionContext)
│   │   ├── copilot/               # Copilot CLI provider ✅
│   │   ├── claude/                # Claude CLI provider ✅
│   │   ├── codex/                 # Codex CLI provider ✅
│   │   └── shared/                # Process mgmt, log parsing ✅
│   ├── chat/                  # VS Code only - NOT shared
│   │   └── CopilotChatIntegration.ts
│   └── orchestration/         # Partially shared
│       ├── WorkspaceSessionManager.ts  # Shared (inject platform)
│       ├── OutputHistoryManager.ts     # Shared (no vscode deps ✅)
│       ├── EndConditionHandler.ts      # Shared (no vscode deps ✅)
│       └── PromptFileWatcher.ts        # Shared (no vscode deps ✅)
├── types/                    # SHARED - All types (no vscode deps ✅)
├── utils/                    # SHARED - Utilities (mostly no vscode deps ✅)
└── ui/                       # VS Code only - not shared
    ├── FlightPathWebviewProvider.ts
    ├── StatusBarManager.ts
    └── webview-react/
```

### Build Configuration

The MCP server build already establishes the precedent for a second entry point alongside the extension. The CLI follows the same pattern.

**esbuild.js** additions (follow the existing MCP server build pattern):

```javascript
// Extension bundle (existing)
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  // ..existing plugins..
});

// MCP server bundle (already exists)
await esbuild.build({
  entryPoints: ["src/mcp-server.ts"],
  bundle: true,
  outfile: "out/mcp-server.js",
  external: ["@modelcontextprotocol/sdk"],
  platform: "node",
});

// CLI bundle (NEW — same pattern as MCP server)
await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  outfile: "out/cli.js",
  platform: "node",
  banner: {
    js: "#!/usr/bin/env node", // Make executable
  },
  // No 'vscode' in external — if vscode leaks in, the build will fail (good!)
});
```

**package.json** — add CLI to existing `bin` entry (MCP server already has one):

```json
{
  "bin": {
    "flightpath-mcp": "./out/mcp-server.js",
    "flightpath": "./out/cli.js"
  }
}
```

**Note**: The extension and CLI share the same package.json. The VS Code extension is published via `vsce`. If vscode is accidentally imported in the CLI build tree, esbuild will fail (since vscode is not in externals) — this acts as a build-time guard against leaking VS Code dependencies.

---

## Interactive Terminal Mode

### Overview

FlightPath CLI supports **interactive mode** by default, allowing users to respond to tool approval prompts from Copilot/Claude CLIs. This aligns with the VS Code extension's interactive terminal work.

### Execution Mode Detection

```typescript
// src/cli.ts

function getExecutionMode(options: CliOptions): "interactive" | "headless" {
  // Explicit flag takes precedence
  if (options.headless) return "headless";
  if (options.interactive) return "interactive";

  // Auto-detect based on terminal
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return "interactive";
  }

  // Piped input/output = headless (CI/CD)
  return "headless";
}
```

### Completion Detection via Hooks (All Modes)

All three harnesses already implement `INotificationMonitor` in the extension — they write JSON notification files to `.flightpath/temp/` when a prompt completes, and FlightPath polls for those files in parallel with the running process. This mechanism works identically in the standalone CLI since it only requires filesystem access, not VS Code APIs.

| Harness     | Hook event        | Notification file             |
| ----------- | ----------------- | ----------------------------- |
| Claude CLI  | `Stop` hook       | `{sessionId}-stop.json`       |
| Copilot CLI | `sessionEnd` hook | `sessionEnd-{timestamp}.json` |
| Codex CLI   | `Notify` hook     | `{threadId}.json`             |

FlightPath runs `INotificationMonitor.monitorForCompletion()` in a parallel Promise alongside the spawned AI CLI process. When the hook fires and the notification file appears, FlightPath knows the AI has finished responding to the current prompt and can advance.

### Two Execution Modes

The CLI supports two modes based on `stdio` configuration:

| Mode                             | `stdio`                  | User can type | Session ends            | Output                 |
| -------------------------------- | ------------------------ | ------------- | ----------------------- | ---------------------- |
| **interactive** (default in TTY) | `'inherit'`              | ✅ Yes        | Manually (user exits)   | Raw AI CLI passthrough |
| **headless** (default in CI/CD)  | `['pipe','pipe','pipe']` | ❌ No         | Auto when process exits | Chalk-formatted events |

> **Future (v2)**: Watch mode (`--close-on-completion`) — `stdio: ['pipe', 'inherit', 'inherit']` — user sees output but cannot type; FlightPath auto-advances when the hook fires. Deferred because it requires per-harness exit command handling (`/exit\n` for Claude, EOF for Copilot/Codex).

### Full-Interactive Mode (default in TTY)

`stdio: 'inherit'` — all three file descriptors pass through to the user's terminal. The AI CLI runs as if the user launched it directly:

- User can answer questions Claude asks mid-session
- User can approve or deny tool permission prompts
- User can type follow-up messages to steer the response
- All normal keyboard shortcuts work (Ctrl+C cancels the current action, etc.)

The hook still fires when the AI finishes responding — FlightPath can use it to signal the user that the current prompt is done (e.g., print a status line). But FlightPath waits for the user to end the session (`/exit`, Ctrl+D) before advancing to the next prompt.

```typescript
// Full-interactive: user has complete control, hook used for status only
const child = spawn(command, args, { stdio: "inherit" });
await Promise.race([
  new Promise<void>((resolve) => child.on("close", resolve)), // user exits
  // hook notification used for status display only, not to close session
]);
```

**Limitations**: No output capture (no `CliEvent[]`, no history), session ID must be noted manually for `--resume`.

### Headless Mode (default when not TTY)

`stdio: ['pipe', 'pipe', 'pipe']` — fully captured. The AI CLI output is captured and parsed into `CliEvent[]` by the log parsers. FlightPath formats and streams these events to the terminal with chalk via `CliTerminalFormatter`. Session ends when the process exits (hook notification + process exit or timeout).

```typescript
// Interactive mode implementation (for VS Code extension context)
// In the extension, interactive terminal uses vscode.Terminal
// In the CLI, the same monitorForCompletion() runs in parallel
const [, notificationResult] = await Promise.all([
  this.spawnAndCapture(command, args, workingDirectory),
  this.provider.notificationMonitor.monitorForCompletion(
    { directory: notifyDir, timeoutMs: config.timeout },
    sessionId,
    startTime,
    () => this.isCancelling
  ),
]);
```

### Headless Mode Implementation

For headless mode (CI/CD, piped):

1. **Use --allow-all-tools / --skip-permissions** - No prompts
2. **Capture output** - For JSON reporting
3. **Handle timeouts** - No user to respond

```typescript
// Headless mode capturing output
const child = spawn(command, args, {
  cwd: workingDirectory,
  stdio: ["pipe", "pipe", "pipe"],
  shell: true,
});

let stdout = "";
child.stdout.on("data", (data) => {
  const chunk = data.toString();
  stdout += chunk;

  // Still stream to console if not --quiet
  if (!options.quiet) {
    process.stdout.write(chunk);
  }
});
```

### Tool Permission Flags

| Mode        | Copilot CLI           | Claude CLI                       |
| ----------- | --------------------- | -------------------------------- |
| Interactive | No auto-approve flags | `--permission-mode default`      |
| Headless    | `--allow-all-tools`   | `--dangerously-skip-permissions` |

### CLI Flags for Mode Control

```bash
# Force interactive (even if piped)
flightpath run workflow.json --interactive

# Force headless (even in TTY)
flightpath run workflow.json --headless

# Headless with specific permissions
flightpath run workflow.json --headless --allow-tool 'shell(git:*)'
```

---

## Execution Flow

### Sequence Diagram

```
User                 CLI                 PromptQueue         Provider
  │                   │                      │                  │
  │── run file.json ─▶│                      │                  │
  │                   │── parse & validate ─▶│                  │
  │                   │                      │                  │
  │                   │◀── prompts[] ────────│                  │
  │                   │                      │                  │
  │                   │── loadPrompts() ────▶│                  │
  │                   │                      │                  │
  │                   │── start() ──────────▶│                  │
  │                   │                      │                  │
  │                   │                      │── getNext() ────▶│
  │                   │                      │                  │
  │                   │◀─ stream output ─────│◀── execute ──────│
  │◀─ terminal out ───│                      │                  │
  │                   │                      │                  │
  │                   │                      │── endCondition? ─│
  │                   │                      │     │            │
  │                   │                      │     │── script ──▶│
  │                   │                      │     │◀── result ──│
  │                   │                      │                  │
  │                   │                      │── next prompt ───▶│
  │                   │                      │      (repeat)     │
  │                   │                      │                  │
  │◀─ exit code ──────│◀── complete ────────│                  │
```

### State Machine

```
                    ┌─────────┐
                    │  IDLE   │
                    └────┬────┘
                         │ loadPrompts()
                         ▼
                    ┌─────────┐
                    │ LOADED  │
                    └────┬────┘
                         │ start()
                         ▼
                ┌────────────────┐
         ┌─────▶│   EXECUTING    │◀──────┐
         │      └───────┬────────┘       │
         │              │                │
         │   success    │    failure     │ next prompt
         │              ▼                │
         │      ┌───────────────┐        │
         │      │ END_CONDITION │────────┘
         │      │   (if any)    │
         │      └───────┬───────┘
         │              │
         │   pass       │    fail + retry
         │              ▼
         │      ┌───────────────┐
         └──────│    RETRY      │
                └───────────────┘
                         │
              no more    │    max retries
              prompts    ▼    exceeded
                ┌────────────────┐
                │   COMPLETED    │
                │   or FAILED    │
                └────────────────┘
```

---

## Output & Logging

### Interactive vs Headless Output Strategy

The two execution modes have fundamentally different output stories:

**Interactive mode** (`stdio: 'inherit'`, default in TTY):

- The AI CLI (claude, gh copilot) runs directly in the user's terminal
- The AI CLI produces its own rich output: colors, diffs, tool call formatting, etc.
- FlightPath only adds workflow-level framing (prompt headers, completion status)
- **No chalk rendering of events needed** — the raw CLI output is already beautiful

**Headless mode** (`stdio: 'pipe'`, default in CI/CD):

- The AI CLI output is captured and parsed into `CliEvent[]` by our log parsers
- FlightPath is solely responsible for rendering output to the terminal
- Requires a chalk-based `CliTerminalFormatter` to render events readably
- Output streams in real-time by subscribing to `onStreamingEvents`

### FlightPath Workflow Framing (Both Modes)

FlightPath adds this wrapper around each prompt in both modes:

```
FlightPath CLI v1.0.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running: my-workflow.flightpath.json
Harness: copilot-cli (claude-sonnet-4.5)
Prompts: 3

─────────────────────────────────────────────────────
[1/3] Analyze codebase structure
─────────────────────────────────────────────────────

<AI CLI output here — raw passthrough in interactive, chalk-formatted in headless>

✓ Prompt completed (12.3s)
✓ End condition passed

─────────────────────────────────────────────────────
[2/3] Implement feature
─────────────────────────────────────────────────────

...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Workflow completed successfully

Results:
  Total prompts: 3
  Successful: 3
  Failed: 0
  Total time: 1m 20.6s

```

### CliTerminalFormatter (Headless Mode)

**File**: `src/flightpath/cli/shared/CliTerminalFormatter.ts`

A chalk-based formatter that mirrors `CliOutput.tsx` for terminal rendering. This is a new class — separate from the existing `CliOutputFormatter` (which produces plain text for the VS Code Output panel and must remain chalk-free to avoid adding it to the extension bundle).

Renders each `CliEvent` type as it arrives via `onStreamingEvents`:

```
TEXT event:
  Plain text output, printed as-is

THINKING event:
  chalk.dim("● Thinking")
  chalk.dim("  " + text)   ← indented, dimmed

BASH_COMMAND event:
  chalk.yellow("$ " + command)
  output text (if any)
  chalk.green("✓") or chalk.red("✗ exit " + exitCode)

FILE_EDIT event:
  chalk.cyan("~ " + path)
  Diff rendered from structuredPatch:
    chalk.green("+ " + line)   for additions
    chalk.red("- " + line)     for removals
    chalk.dim("  " + line)     for context
    chalk.cyan("@@ ... @@")    for hunk headers

FILE_WRITE event:
  chalk.green("+ " + path)

FILE_READ event:
  chalk.dim("  " + path)

FILE_DELETE event:
  chalk.red("- " + path)

MCP_TOOL_CALL event:
  chalk.magenta("⚙ " + server + ":" + tool)

WEB_SEARCH event:
  chalk.blue("⌕ " + query)

TOOL_CALL event (generic):
  chalk.yellow("⚙ " + name) + truncated params

TOOL_RESULT event:
  chalk.dim("  ⎿  ") + truncated output (100 chars, matching webview)
  chalk.red on failure
```

Stats footer per prompt (matching `CliOutput.tsx` renderStats):

```
chalk.dim("Session: " + sessionId.slice(0,8) + " | Model: " + model + " | " + tokens + " | " + elapsed + "s")
```

**Streaming**: The `CliAdapter` subscribes to `integration.onStreamingEvents` and calls `CliTerminalFormatter.renderEvents(events)` immediately for each batch — same real-time feedback as interactive mode, just chalk-formatted.

**Note on existing `CliOutputFormatter`**: The existing `toPlainText()` method handles only `TEXT`, `TOOL_CALL`, `THINKING`, and `TOOL_RESULT` events. It's used for the VS Code Output panel (no colors) and should remain unchanged. `CliTerminalFormatter` is the CLI-specific complement that handles all event types with full chalk formatting.

### JSON Output (`--json`)

```json
{
  "version": "1.0.0",
  "file": "my-workflow.flightpath.json",
  "harness": "copilot-cli",
  "model": "claude-sonnet-4.5",
  "status": "completed",
  "results": [
    {
      "index": 0,
      "prompt": "Analyze codebase structure",
      "status": "success",
      "duration_ms": 12345,
      "endCondition": {
        "script": "check.js",
        "passed": true
      }
    },
    {
      "index": 1,
      "prompt": "Implement feature",
      "status": "success",
      "duration_ms": 45234
    },
    {
      "index": 2,
      "prompt": "Write tests",
      "status": "success",
      "duration_ms": 23123
    }
  ],
  "summary": {
    "total": 3,
    "successful": 3,
    "failed": 0,
    "duration_ms": 80702
  }
}
```

### Exit Codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | All prompts completed successfully              |
| 1    | One or more prompts failed                      |
| 2    | Invalid prompt file or configuration            |
| 3    | Provider error (CLI not installed, auth failed) |
| 4    | Timeout exceeded                                |
| 5    | User interrupt (Ctrl+C)                         |

---

## Error Handling

### User-Friendly Error Messages

```
Error: Prompt file not found
  Path: /path/to/workflow.flightpath.json

  Did you mean one of these?
    ./workflow.flightpath.yaml
    ./my-workflow.flightpath.json
```

```
Error: Copilot CLI not installed

  FlightPath requires the GitHub Copilot CLI to be installed.

  Install it with:
    npm install -g @anthropic/copilot-cli

  Or use Claude instead:
    flightpath run workflow.yaml --harness claude-cli
```

```
Error: End condition failed after 3 retries

  Script: check_tests.js
  Expected: "true"
  Received: "false"

  Last output:
    Tests failed: 2 assertions
```

### Graceful Shutdown

- **Ctrl+C (SIGINT)**: Cancel current prompt, show partial results, exit with code 5
- **SIGTERM**: Same as Ctrl+C
- Cleanup: Kill any running child processes

---

## Implementation Plan

### Phase 1: WorkflowInstance Extraction ✅ COMPLETE

The parallel workflows implementation extracted `WorkflowInstance` from the former `FlightPathManager` (which no longer exists). `IntegrationFactory` is implemented. `WorkflowOrchestrator` manages the multi-workflow registry.

---

### Phase 2: Platform Abstraction Layer ✅ COMPLETE

**Goal**: Add an abstraction layer so shared code can run without VS Code. **The VS Code extension behavior must remain identical after every step.**

Work is done in order of dependency (each step does not break the prior):

#### Step 2.1: Replace vscode.EventEmitter in HarnessIntegration (foundation)

`HarnessIntegration` is the base class for everything. Replace its 5 event emitters first — everything downstream becomes easier once this is done.

- Create a thin `TypedEmitter<T>` helper (or just use Node's `EventEmitter` directly)
- Replace the 5 `vscode.EventEmitter<T>` fields with typed Node.js equivalents
- Update the `vscode.Event<T>` subscription pattern to Node's `.on()` / `.once()`
- Update all call sites in `WorkflowInstance`, `WorkflowExecutor`, `WorkflowOrchestrator`
- **VsCodeAdapter consideration**: `vscode.EventEmitter` is available in VS Code because it runs on Node.js — the runtime behavior is identical. So this is a safe swap.

#### Step 2.2: Replace vscode.EventEmitter in PromptQueue

- Replace `private onStateChanged: vscode.EventEmitter<QueueState>` with Node.js EventEmitter
- Update 2-3 subscriber call sites

#### Step 2.3: Create PlatformAdapter interface + VsCodeAdapter

- Create `src/platform/PlatformAdapter.ts` — the interface
- Create `src/platform/VsCodeAdapter.ts` — wraps existing vscode calls identically
  - `getConfig()` → `vscode.workspace.getConfiguration("flightpath").get()`
  - `getWorkspaceRoot()` → `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()`
  - `warn()` → `vscode.window.showWarningMessage()`
  - `error()` → `vscode.window.showErrorMessage()`
  - `log()` → `vscode.window.showInformationMessage()`
  - `createInteractiveTerminal()` → existing terminal creation path (unchanged behavior)
  - `getExtensionContext()` → returns `vscode.ExtensionContext` (needed by VS Code-only code)
- **Validation**: Extension must work identically after this step — `VsCodeAdapter` is not yet used by anything

#### Step 2.4: Refactor PromptFileParser (remove vscode.workspace.fs)

- Replace `vscode.workspace.fs.stat(vscode.Uri.file(p))` with `fs.stat(p)`
- Replace `vscode.workspace.fs.readFile(uri)` with `fs.readFile(p)`
- Replace `vscode.window.showErrorMessage()` with `platform.error()`
- Inject `PlatformAdapter` (or just use Node.js fs directly since no vscode.URI needed)

#### Step 2.5: Refactor WorkspaceSessionManager

- Replace `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` with `platform.getWorkspaceRoot()`
- Replace `vscode.workspace.fs.*` with Node.js `fs/promises`
- Inject `PlatformAdapter`

#### Step 2.6: Refactor WorkflowExecutor

- Replace `vscode.window.showWarningMessage()` with `platform.warn()`
- Replace `vscode.window.showInformationMessage()` with `platform.log()`
- Replace `vscode.commands.executeCommand("flightpath.focusDashboard")` with `platform.focusDashboard?.()` (optional method, no-op in CLI)
- Inject `PlatformAdapter` (update constructor)

#### Step 2.7: Refactor CliIntegration (remove ExtensionContext)

- Replace constructor param `context: vscode.ExtensionContext` with `platform: PlatformAdapter`
- Pass `platform` to `CliProcessManager` instead of `context`
- `CliProcessManager` uses `platform.createInteractiveTerminal()` in interactive mode
- `CliProcessManager` uses `platform.getWorkspaceRoot()` for temp file paths
- Update `IntegrationFactory` to pass `PlatformAdapter` instead of `ExtensionContext`

#### Step 2.8: Refactor IntegrationFactory + split for CopilotChat

- Change factory constructor: `ExtensionContext` → `PlatformAdapter`
- Move `createCopilotChat()` to new `VsCodeIntegrationFactory extends IntegrationFactory`
- `VsCodeIntegrationFactory.createForHarness()` handles all 4 harnesses
- `IntegrationFactory.createForHarness()` handles 3 CLI harnesses only
- `extension.ts` uses `VsCodeIntegrationFactory`; `cli.ts` uses `IntegrationFactory`

#### Step 2.9: Refactor WorkflowInstance (decouple from vscode)

- Change constructor to accept `PlatformAdapter` instead of `vscode.ExtensionContext`
- Replace `vscode.WorkspaceFolder` param with `string` (just the workspace path)
- Replace `FlightPathWebviewProvider` param with `IDashboardSink | undefined`:
  ```typescript
  interface IDashboardSink {
    postMessage(type: string, payload: unknown): void;
  }
  ```

  - `VsCodeAdapter` implements `IDashboardSink` by delegating to `FlightPathWebviewProvider`
  - CLI passes `undefined`
- All dashboard `postMessage` calls become `this.dashboardSink?.postMessage(...)`
- Status bar callbacks (`onStatusBarUpdate`, `onWorkflowNameChange`) — keep as optional callbacks, CLI passes no-op functions

**After Phase 2**: The shared core has zero `vscode` imports. Every file either uses `PlatformAdapter` or has no platform dependency at all. The extension works identically because `VsCodeAdapter` calls the same vscode APIs as before.

---

### Phase 3: CLI Entry Point ✅ COMPLETE

**Goal**: Wire everything together for terminal execution.

#### Step 3.1: Add dependencies

```bash
npm install commander chalk
```

#### Step 3.2: Create src/platform/CliAdapter.ts

```typescript
export class CliAdapter implements PlatformAdapter {
  constructor(private config: ResolvedCliConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    return ((this.config as Record<string, unknown>)[key] as T) ?? defaultValue;
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  log(message: string): void {
    if (!this.config.quiet) console.log(message);
  }

  warn(message: string): void {
    console.warn(chalk.yellow(`⚠ ${message}`));
  }

  error(message: string): void {
    console.error(chalk.red(`✗ ${message}`));
  }

  showProgress(message: string): void {
    if (!this.config.quiet) process.stdout.write(`  ${message}\r`);
  }

  async showChoice(
    message: string,
    ...options: string[]
  ): Promise<string | undefined> {
    // For headless mode: return first option (or undefined)
    // For interactive mode: could prompt with readline
    return options[0];
  }

  createInteractiveTerminal(name: string): InteractiveTerminal {
    return new CliInteractiveTerminal(name); // stdio: 'inherit'
  }
}
```

#### Step 3.3: Create src/cli.ts

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { CliAdapter } from "./platform/CliAdapter";
import { IntegrationFactory } from "./flightpath/IntegrationFactory";
import { WorkflowInstance } from "./flightpath/WorkflowInstance";
import { EXECUTION_STATES } from "./types/FlightPathTypes";

const program = new Command();

program
  .name("flightpath")
  .description("Execute FlightPath AI workflow automation")
  .version(VERSION); // injected by esbuild

program
  .command("run <file>")
  .description("Execute a prompt or workflow file")
  .option(
    "-H, --harness <harness>",
    "AI harness: copilot-cli, claude-cli, codex-cli",
    "copilot-cli"
  )
  .option("-m, --model <model>", "Model to use")
  .option("-d, --cwd <path>", "Working directory")
  .option("--headless", "Force headless mode")
  .option("--interactive", "Force interactive mode")
  .option("--allow-all-tools", "Allow all tools without prompting")
  .option(
    "--allow-tool <pattern>",
    "Allow specific tool pattern (repeatable)",
    collect,
    []
  )
  .option(
    "--deny-tool <pattern>",
    "Deny specific tool pattern (repeatable)",
    collect,
    []
  )
  .option("-q, --quiet", "Only show errors")
  .option("--verbose", "Show debug output")
  .option("--json", "Output results as JSON")
  .action(async (file, options) => {
    const config = resolveConfig(file, options);
    const adapter = new CliAdapter(config);
    const factory = new IntegrationFactory(adapter);

    const instance = new WorkflowInstance({
      platform: adapter,
      integrationFactory: factory,
      getDetectorIntegration: (harness?) =>
        factory.createForExecution(harness ?? config.harness),
      onWorkflowNameChange: () => {},
      onStatusBarUpdate: () => {},
    });

    process.on("SIGINT", () => {
      instance.stop();
      process.exit(5);
    });

    try {
      await instance.loadPromptFile(file);
      await instance.execute();

      const state = instance.promptQueue.getState();
      if (options.json) {
        console.log(JSON.stringify(buildJsonResult(state, config)));
      }

      process.exit(state.status === EXECUTION_STATES.COMPLETED ? 0 : 1);
    } catch (err) {
      adapter.error(String(err));
      process.exit(1);
    }
  });

program.parse();
```

#### Step 3.4: Update esbuild.js

Add CLI bundle following the existing MCP server pattern. No `vscode` in externals — build fails if vscode leaks in.

#### Step 3.5: Update package.json

Add `"flightpath": "./out/cli.js"` to the `bin` section.

---

### Phase 4: Validate End-to-End

#### Step 4.1: Validate interactive mode

- TTY auto-detection (`process.stdout.isTTY && process.stdin.isTTY`)
- Test with Copilot CLI and Claude CLI tool approval prompts
- Verify Ctrl+C handling (SIGINT → `instance.stop()`, exit code 5)

#### Step 4.2: Validate headless mode

- Auto-apply `--allow-all-tools` (Copilot) / `--dangerously-skip-permissions` (Claude) in headless
- CI/CD JSON output (`--json`)
- Timeout handling (exit code 4)

---

### Phase 5: Polish

1. **Output & Reporting** — human-readable format (chalk colors), JSON mode, exit codes
2. **Error Messages** — user-friendly errors for missing files, missing CLIs, auth failures
3. **Testing** — unit tests for `CliAdapter`, integration tests with mock harnesses
4. **Documentation** — CLI README, config file reference, examples
5. **Watch mode** — `--close-on-completion` flag (auto-advance prompts while user watches output)

---

### Files to Create / Modify

| File                                                      | Action | Phase | Effort |
| --------------------------------------------------------- | ------ | ----- | ------ |
| `src/platform/PlatformAdapter.ts`                         | CREATE | 2.3   | Low    |
| `src/platform/VsCodeAdapter.ts`                           | CREATE | 2.3   | Low    |
| `src/platform/CliAdapter.ts`                              | CREATE | 3.2   | Medium |
| `src/cli.ts`                                              | CREATE | 3.3   | Medium |
| `src/flightpath/VsCodeIntegrationFactory.ts`              | CREATE | 2.8   | Low    |
| `src/flightpath/cli/shared/CliTerminalFormatter.ts`       | CREATE | 3.3   | Medium |
| `src/flightpath/HarnessIntegration.ts`                    | MODIFY | 2.1   | Medium |
| `src/flightpath/PromptQueue.ts`                           | MODIFY | 2.2   | Low    |
| `src/flightpath/PromptFileParser.ts`                      | MODIFY | 2.4   | Low    |
| `src/flightpath/orchestration/WorkspaceSessionManager.ts` | MODIFY | 2.5   | Low    |
| `src/flightpath/WorkflowExecutor.ts`                      | MODIFY | 2.6   | Low    |
| `src/flightpath/cli/CliIntegration.ts`                    | MODIFY | 2.7   | Medium |
| `src/flightpath/IntegrationFactory.ts`                    | MODIFY | 2.8   | Low    |
| `src/flightpath/WorkflowInstance.ts`                      | MODIFY | 2.9   | Medium |
| `src/extension.ts`                                        | MODIFY | 2.9   | Low    |
| `src/flightpath/WorkflowOrchestrator.ts`                  | MODIFY | 2.9   | Low    |
| `esbuild.js`                                              | MODIFY | 3.4   | Low    |
| `package.json`                                            | MODIFY | 3.5   | Low    |

**Not modified**: `CopilotChatIntegration.ts` (VS Code-only, untouched), all provider implementations, all types, all utilities.

---

## Pre-Work Checklist Before Starting

The following should be confirmed before beginning Phase 2:

- [ ] Confirm no existing subscribers of `HarnessIntegration` events use vscode-specific subscription patterns that cannot be easily migrated
- [ ] Confirm `CliProcessManager` only uses `vscode.ExtensionContext` for terminal creation and temp file paths (both replaceable via `PlatformAdapter`)
- [ ] Confirm `TempFileManager` does not have deep vscode dependencies beyond path resolution
- [ ] Confirm `ConfigurationUtils` can be called from both contexts (it uses `vscode.workspace.getConfiguration` — CLI would use `CliAdapter.getConfig()` instead, so shared files should call `platform.getConfig()`, not `ConfigurationUtils` directly)
- [ ] Decide on `TypedEmitter<T>` strategy: thin wrapper vs. raw Node EventEmitter with explicit typing

---

## Dependencies

### New Dependencies (CLI-only)

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "chalk": "^5.3.0"
  }
}
```

### Existing Dependencies (Shared)

These are already in the extension and will be shared:

```json
{
  "dependencies": {
    "ajv": "^8.12.0",
    "js-yaml": "^4.1.0",
    "chokidar": "^5.0.0"
  }
}
```

### Optional Dependencies

```json
{
  "optionalDependencies": {
    "node-pty": "^1.0.0"
  }
}
```

**Note**: `node-pty` is optional. Basic interactive mode works with `stdio: 'inherit'`. PTY is only needed for advanced terminal features (split output capture + interaction).

---

## Comparison with Similar Tools

| Feature            | FlightPath CLI              | Aider | Claude CLI | Copilot CLI |
| ------------------ | --------------------------- | ----- | ---------- | ----------- |
| Workflow Files     | ✅ YAML/JSON/MD             | ❌    | ❌         | ❌          |
| Multi-Prompt       | ✅ Sequential               | ❌    | ❌         | ❌          |
| End Conditions     | ✅ Scripts                  | ❌    | ❌         | ❌          |
| Multiple Harnesses | ✅ Copilot+Claude+Codex CLI | ❌    | ❌         | ❌          |
| Session Resume     | ✅                          | ✅    | ✅         | ✅          |
| CI/CD Ready        | ✅ JSON output              | ⚠️    | ⚠️         | ⚠️          |
| Dynamic Queue      | ✅ (shared with extension)  | ❌    | ❌         | ❌          |

---

## Summary

FlightPath CLI brings structured AI workflow automation to any terminal environment **while sharing 90%+ of code with the VS Code extension**.

### Key Design Decisions

1. **WorkflowInstance is the bridge**: Already extracted (parallel workflows Phase 1 complete). The CLI uses it directly — no VS Code orchestration needed.
2. **Shared Codebase**: Single repo with platform abstraction, not a rewrite
3. **Interactive by Default**: TTY detection enables tool approval workflows
4. **Minimal New Dependencies**: Only Commander.js and chalk for CLI-specific needs
5. **Incremental Refactoring**: Extension keeps working throughout migration
6. **Build-time safety**: No `vscode` in CLI externals — any leak causes build failure

### MVP Deliverables

1. **Platform Abstraction Layer** - `PlatformAdapter` interface + implementations (primary remaining work)
2. **vscode Decoupling** - Replace EventEmitters + remove vscode.\* from 7 shared files
3. **CLI Entry Point** - `src/cli.ts` with Commander.js
4. **Interactive + Headless Modes** - TTY detection, permission flags
5. **Streaming Output** - Real-time CLI output with colors
6. **End Conditions** - Full support (shared code, already works)
7. **JSON Output** - CI/CD integration

### Code Sharing Benefits

| Metric             | Rewrite Approach | Shared Code Approach |
| ------------------ | ---------------- | -------------------- |
| New code to write  | ~3000 lines      | ~500 lines           |
| Maintenance burden | 2x               | 1x (single source)   |
| Feature parity     | Manual sync      | Automatic            |
| Bug fixes          | Need in both     | Fix once             |
| Testing            | Separate suites  | Shared tests         |

The architecture is designed for maximum code reuse while allowing platform-specific optimizations where needed. All MVP features (end conditions, session management, all three CLI harnesses, retries) work automatically in the CLI since they live in the shared `WorkflowInstance` layer.
