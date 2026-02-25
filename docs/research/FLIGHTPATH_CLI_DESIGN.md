# FlightPath CLI Design

**Document Status**: Active Planning
**Last Updated**: 2026-02-25

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
3. Watch mode (re-run on file changes)
4. Parallel execution
5. TUI Dashboard (ink/blessed)
6. IntelliSense/completions

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
  init             Create a new .flightpath.json file interactively
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
  --allow-dynamic-extension  Allow the AI to extend the workflow queue

  Note: --harness and --model are especially useful for .prompt.md files, which
  cannot embed these settings in the file format itself.

Execution Mode:
  --interactive    Force interactive mode (PTY, user can respond to prompts)
  --headless       Force headless mode (CI/CD, no user interaction)

Tool Permissions (Copilot CLI):
  --allow-all-tools          Allow all tools without prompting
  --allow-tool <pattern>     Allow specific tool pattern (can repeat)
  --deny-tool <pattern>      Deny specific tool pattern (can repeat)
  --add-dir <path>           Add directory to allowed paths (can repeat)

Tool Permissions (Claude CLI):
  --skip-permissions         Skip all permission prompts (dangerous)
  --allowed-tools <list>     Comma-separated list of allowed tools

Output Control:
  --json                     Output as JSON
  --quiet, -q                Only show errors
  --verbose                  Show debug information
  --no-color                 Disable colored output
  --output, -o <file>        Write output to file
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

Located in:

1. Current directory
2. Home directory (`~/.flightpathrc.json`)
3. XDG config (`~/.config/flightpath/config.json`)

```json
{
  "harness": "copilot-cli",
  "model": "claude-sonnet-4.5",
  "timeout": 3600,
  "scriptTimeout": 30000,
  "permissions": {
    "copilot": {
      "allowAllTools": false,
      "allowedTools": ["shell(git:*)"],
      "deniedTools": ["shell(rm:*)"],
      "allowedDirs": ["."]
    },
    "claude": {
      "skipPermissions": false,
      "allowedTools": ["Bash", "Read", "Write"]
    }
  },
  "output": {
    "color": true,
    "timestamps": true,
    "verbose": false
  }
}
```

### Environment Variables

```bash
FLIGHTPATH_HARNESS=copilot-cli|claude-cli|codex-cli
FLIGHTPATH_MODEL=claude-sonnet-4.5
FLIGHTPATH_TIMEOUT=3600
FLIGHTPATH_SCRIPT_TIMEOUT=30000
FLIGHTPATH_ALLOW_ALL_TOOLS=true|false
FLIGHTPATH_VERBOSE=true|false
FLIGHTPATH_JSON_OUTPUT=true|false
FLIGHTPATH_NO_COLOR=true|false
```

---

## Architecture

### VS Code Compatibility Guarantee

**The VS Code extension is the primary product. The CLI adds a new entry point — it does not modify the existing VS Code code paths.**

The `PlatformAdapter` pattern is a **wrapping** pattern, not a replacement:

- `VsCodeAdapter` wraps the same `vscode.*` calls that exist today — behavior of the extension is **unchanged**
- `CliAdapter` provides a new implementation for the same interface points
- Shared code calls `platform.createInteractiveTerminal()` instead of `vscode.window.createTerminal()` directly — but when the platform is `VsCodeAdapter`, it calls `vscode.window.createTerminal()` internally, exactly as before
- All `vscode.window.show*Message()`, `vscode.workspace.getConfiguration()`, `vscode.workspace.workspaceFolders`, terminal creation — all preserved in `VsCodeAdapter` with identical behavior

The refactoring is strictly additive. Every `vscode.*` call that exists today either:
1. Moves into `VsCodeAdapter` where it continues to be called identically, or
2. Stays in VS Code-only files (`FlightPathManager`, `WorkflowOrchestrator`, `ui/`, `chat/`) that the CLI build never touches

The test for success: **zero behavior change** in the VS Code extension after any Platform Abstraction refactoring step. The extension must work identically before and after each individual change.

---

### Code Sharing Strategy

The key insight: **Most FlightPath code is already platform-agnostic**. Only a thin layer touches VS Code APIs.

**The enabling refactor**: The [Parallel Workflows Architecture](./PARALLEL_WORKFLOWS_ARCHITECTURE.md) plan extracts `WorkflowInstance` from `FlightPathManager` as a self-contained execution unit. Once that extraction happens, the CLI can directly instantiate a single `WorkflowInstance` without pulling in any VS Code orchestration (`WorkflowOrchestrator`, dashboard, status bar). The CLI build is a natural byproduct of making parallel workflows work cleanly.

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
│  • FlightPathManager.ts         │    WorkflowInstance only)     │
│  • ui/* (dashboard, webview)    │  • (terminal output only)     │
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
│  ├── WorkflowInstance.ts    # NEW (parallel workflows plan)     │
│  │                          # Self-contained execution unit;    │
│  │                          # THE key bridge for CLI           │
│  ├── PromptQueue.ts         # State machine (replace vscode.   │
│  │                          # EventEmitter with Node EventEmit) │
│  ├── WorkflowExecutor.ts    # Prompt execution loop            │
│  ├── PromptFileParser.ts    # JSON/YAML parsing (AJV)          │
│  ├── EndConditionEvaluator.ts  # Script execution, timeout     │
│  ├── EndConditionHandler.ts    # Retry logic                   │
│  ├── HarnessIntegration.ts  # Abstract interface               │
│  └── cli/                                                       │
│      ├── CliIntegration.ts  # Generic CLI class (all harnesses)│
│      ├── copilot/           # Copilot CLI provider             │
│      ├── claude/            # Claude CLI provider              │
│      ├── codex/             # Codex CLI provider               │
│      └── shared/            # Process mgmt, log parsing utils  │
│                                                                  │
│  src/flightpath/orchestration/                                   │
│  ├── WorkspaceSessionManager.ts  # Session persistence         │
│  ├── OutputHistoryManager.ts     # Run history                 │
│  ├── EndConditionHandler.ts      # Retry orchestration         │
│  └── PromptFileWatcher.ts        # Dynamic queue monitoring    │
│                                                                  │
│  src/types/                                                      │
│  ├── FlightPathTypes.ts     # All interfaces and types          │
│  └── DashboardConstants.ts  # Shared constants                  │
│                                                                  │
│  src/utils/                                                      │
│  ├── ModelConstants.ts      # Model definitions                 │
│  ├── ModelRegistry.ts       # Model validation                  │
│  └── PromptIdentity.ts      # Prompt hashing/tracking           │
│                                                                  │
│  schemas/                                                        │
│  └── prompt-schema.json     # JSON schema (shared)              │
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
  showChoice(message: string, ...options: string[]): Promise<string | undefined>;

  // File system (already uses Node fs — no abstraction needed)
  // Process execution (already uses child_process — no abstraction needed)

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
    return (this.config as Record<string, unknown>)[key] as T ?? defaultValue;
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  warn(message: string): void {
    console.warn(`⚠ ${message}`);
  }
  // ... etc
}
```

**What does NOT need abstraction** (already platform-agnostic):
- `fs/promises` — used identically in both contexts
- `child_process.spawn` — used identically in both contexts
- `PromptQueue` event emitter — replace `vscode.EventEmitter` with Node.js `EventEmitter` directly (VS Code runs on Node, both are available; the `.event` subscription pattern is VS Code-specific but only used in VS Code-specific subscribers)

### Refactoring Strategy

**The key challenge**: `FlightPathManager.ts` currently imports ALL integrations directly, including VS Code-only `CopilotChatIntegration`. This would break the CLI build. The solution is the `WorkflowInstance` extraction from the [Parallel Workflows plan](./PARALLEL_WORKFLOWS_ARCHITECTURE.md).

**Phase 1: WorkflowInstance Extraction (shared with parallel workflows work)**

This work happens as part of the parallel workflows refactor. Once `WorkflowInstance` is extracted:
- It owns `PromptQueue`, `WorkflowExecutor`, `CliIntegration`, `WorkspaceSessionManager`, etc.
- It communicates via events (not vscode APIs)
- The CLI can create a single `WorkflowInstance` directly, bypassing `WorkflowOrchestrator`

**Phase 2: Harness Factory (already partially designed in parallel workflows plan)**

```typescript
// src/flightpath/IntegrationFactory.ts (shared interface)
export interface IntegrationFactory {
  createIntegration(harness: Harness, adapter: PlatformAdapter): HarnessIntegration;
  getSupportedHarnesses(): Harness[];
}

// extension.ts - provides ALL harnesses (including VS Code Chat)
const vsCodeFactory: IntegrationFactory = {
  createIntegration(harness, adapter) {
    switch (harness) {
      case 'copilot-chat':
        return new CopilotChatIntegration(adapter); // VS Code only
      case 'copilot-cli':
        return new CliIntegration(new CopilotCliProvider(), adapter);
      case 'claude-cli':
        return new CliIntegration(new ClaudeCliProvider(), adapter);
      case 'codex-cli':
        return new CliIntegration(new CodexCliProvider(), adapter);
    }
  },
  getSupportedHarnesses: () => ['copilot-chat', 'copilot-cli', 'claude-cli', 'codex-cli'],
};

// cli.ts - only CLI harnesses (no vscode imports in tree!)
const cliFactory: IntegrationFactory = {
  createIntegration(harness, adapter) {
    switch (harness) {
      case 'copilot-cli':
        return new CliIntegration(new CopilotCliProvider(), adapter);
      case 'claude-cli':
        return new CliIntegration(new ClaudeCliProvider(), adapter);
      case 'codex-cli':
        return new CliIntegration(new CodexCliProvider(), adapter);
      default:
        throw new Error(`Harness "${harness}" requires VS Code. Use copilot-cli, claude-cli, or codex-cli.`);
    }
  },
  getSupportedHarnesses: () => ['copilot-cli', 'claude-cli', 'codex-cli'],
};
```

**esbuild tree-shaking handles the rest**: Since `cli.ts` never imports `CopilotChatIntegration` (directly or transitively), it won't be bundled.

**Phase 3: Platform Adapter Injection**

Replace direct `vscode.*` calls in shared files with `PlatformAdapter` method calls:

| File                   | Current VS Code Usage                                      | Solution                                |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `PromptQueue.ts`       | `vscode.EventEmitter`, `vscode.window.show*`               | Node `EventEmitter`, `platform.warn()`  |
| `WorkflowExecutor.ts`  | `vscode.commands.executeCommand`, `vscode.window.show*`    | No-op or `platform.log()` in CLI        |
| `CliIntegration.ts`    | `vscode.Terminal`, `vscode.ExtensionContext`, `getConfiguration` | `platform.createInteractiveTerminal()`, `platform.getConfig()` |
| `PromptFileParser.ts`  | `vscode.window.showErrorMessage`                           | `platform.error()`                      |
| `WorkspaceSessionManager.ts` | `vscode.workspace.workspaceFolders`                  | `platform.getWorkspaceRoot()`           |

Example — `CliIntegration.ts` (currently uses `vscode.workspace.getConfiguration`):

```typescript
// BEFORE (VS Code coupled)
import * as vscode from "vscode";

export class CliIntegration extends CopilotIntegration {
  private shouldShowOutput(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliOutput", true);
  }
}

// AFTER (Platform agnostic)
export class CliIntegration extends CopilotIntegration {
  constructor(
    private provider: ICliProvider,
    private platform: PlatformAdapter,
    // ... other params
  ) { super(); }

  private shouldShowOutput(): boolean {
    return this.platform.getConfig<boolean>("showCliOutput", true);
  }
}
```

### Project Structure (Shared Repo)

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
│   ├── WorkflowInstance.ts   # NEW (parallel workflows) — key CLI bridge
│   ├── FlightPathManager.ts  # VS Code orchestration (not shared)
│   ├── PromptQueue.ts        # Execution queue (replace vscode.EventEmitter)
│   ├── WorkflowExecutor.ts   # Execution loop (inject platform adapter)
│   ├── PromptFileParser.ts   # File parsing (remove vscode.window)
│   ├── EndConditionEvaluator.ts  # Script runner (no vscode deps)
│   ├── HarnessIntegration.ts  # Abstract interface (no vscode deps)
│   ├── base/
│   │   └── CopilotIntegration.ts  # Abstract base (inject adapter)
│   ├── cli/
│   │   ├── CliIntegration.ts      # Generic CLI (inject adapter)
│   │   ├── copilot/               # Copilot CLI provider
│   │   ├── claude/                # Claude CLI provider
│   │   ├── codex/                 # Codex CLI provider
│   │   └── shared/                # Process mgmt, log parsing
│   ├── chat/                  # VS Code only - NOT shared
│   │   └── CopilotChatIntegration.ts
│   └── orchestration/         # Partially shared
│       ├── WorkspaceSessionManager.ts  # Shared (inject platform)
│       ├── OutputHistoryManager.ts     # Shared (no vscode deps)
│       ├── EndConditionHandler.ts      # Shared (no vscode deps)
│       └── PromptFileWatcher.ts        # Shared (no vscode deps)
├── types/                    # SHARED - All types (no vscode deps)
├── utils/                    # SHARED - Utilities (mostly no vscode deps)
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

FlightPath CLI supports **interactive mode** by default, allowing users to respond to tool approval prompts from Copilot/Claude CLIs. This aligns with the VS Code extension's `INTERACTIVE_TERMINAL_DESIGN.md` work.

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

### Interactive Mode Implementation

For interactive mode, we need to:

1. **Pass-through stdin/stdout** - User can type responses to CLI prompts
2. **Stream output in real-time** - No buffering
3. **Handle ANSI escape codes** - Preserve colors and formatting

```typescript
// Interactive mode using inherit stdio
const child = spawn(command, args, {
  cwd: workingDirectory,
  stdio: "inherit", // Direct pass-through
  shell: true,
});

// Wait for completion
await new Promise<number>((resolve) => {
  child.on("close", (code) => resolve(code ?? 1));
});
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

### Default Output (TTY)

```
FlightPath CLI v1.0.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Running: my-workflow.flightpath.json
Provider: copilot (claude-sonnet-4.5)
Prompts: 3

─────────────────────────────────────────────────────
[1/3] Analyze codebase structure
─────────────────────────────────────────────────────

<streaming CLI output here>

✓ Prompt completed (12.3s)
✓ End condition passed

─────────────────────────────────────────────────────
[2/3] Implement feature
─────────────────────────────────────────────────────

<streaming CLI output here>

✓ Prompt completed (45.2s)

─────────────────────────────────────────────────────
[3/3] Write tests
─────────────────────────────────────────────────────

<streaming CLI output here>

✓ Prompt completed (23.1s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Workflow completed successfully

Results:
  Total prompts: 3
  Successful: 3
  Failed: 0
  Total time: 1m 20.6s

```

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

## Compatibility with Parallel Workflows Architecture

The [Parallel Workflows Architecture](./PARALLEL_WORKFLOWS_ARCHITECTURE.md) is the **enabling refactor** for the CLI. Both plans share the same foundational work:

| Parallel Workflows Need                     | CLI Need                                    | Shared Work                               |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Extract `WorkflowInstance` from Manager     | Single execution unit without VS Code deps  | Same extraction, same class               |
| `IntegrationFactory` pattern                | CLI-only factory without `CopilotChat`      | Same interface, different implementations |
| `WorkspaceSessionManager` per instance      | Session persistence in CLI context          | Same class, inject `platform.getRoot()`   |
| `PromptQueue` owns its own state            | Queue runs without VS Code EventEmitter     | Replace `vscode.EventEmitter` with Node   |
| `WorkflowExecutor` per instance             | Execution loop works outside VS Code        | Same class, inject `PlatformAdapter`      |

**Sequencing recommendation**: Do the parallel workflows extraction first (or concurrently). The `WorkflowInstance` extraction is the hard work — once it exists and uses `PlatformAdapter`, writing `src/cli.ts` is straightforward.

**CLI is a single-instance consumer**: The CLI creates one `WorkflowInstance` and runs it directly. The `WorkflowOrchestrator` (multi-instance manager) is VS Code-specific — it manages dashboard routing, background buffering, and message coordination. None of that is needed for CLI execution.

```typescript
// src/cli.ts — simplified execution flow
const adapter = new CliAdapter(resolvedConfig);
const factory = createCliIntegrationFactory(adapter);

const instance = new WorkflowInstance({ adapter, factory, filePath });
await instance.loadPromptFile(filePath);
await instance.execute();

process.exit(instance.status === 'completed' ? 0 : 1);
```

---

## Implementation Plan

### Phase 1: WorkflowInstance Extraction (prerequisite — shared with parallel workflows)

**Goal**: Extract `WorkflowInstance` from `FlightPathManager` with zero behavior change. This is the parallel workflows Phase 1.

1. Create `WorkflowInstance` class — move all per-workflow state and methods from `FlightPathManager`
2. Create `IntegrationFactory` interface and VS Code implementation
3. `FlightPathManager` delegates to single `WorkflowInstance`
4. All existing tests pass, behavior identical

### Phase 2: Platform Abstraction Layer

**Goal**: Add an abstraction layer so shared code can run without VS Code. **The VS Code extension behavior must remain identical after every step.**

1. **Create `PlatformAdapter` Interface**
   - `getConfig<T>()`, `getWorkspaceRoot()`, `log()`, `warn()`, `error()`, `showChoice()`
   - Keep minimal — only what's actually used in shared files

2. **Implement `VsCodeAdapter`** — *wrap existing calls, do not change behavior*
   - `VsCodeAdapter.getConfig()` calls `vscode.workspace.getConfiguration()` — same as today
   - `VsCodeAdapter.warn()` calls `vscode.window.showWarningMessage()` — same as today
   - `VsCodeAdapter.createInteractiveTerminal()` encapsulates the existing terminal creation + shell integration path — same behavior, just behind an interface
   - **Validation**: Run extension after each file change — behavior must be identical

3. **Refactor shared files to inject adapter** (in order of simplicity):
   - `PromptFileParser.ts` — call `platform.error()` instead of `vscode.window.showErrorMessage()` directly (VsCodeAdapter.error calls showErrorMessage — same behavior)
   - `PromptQueue.ts` — use Node.js `EventEmitter` instead of `vscode.EventEmitter` (VS Code runs on Node — the runtime behavior is identical; subscribers update to Node event pattern)
   - `WorkspaceSessionManager.ts` — call `platform.getWorkspaceRoot()` instead of `vscode.workspace.workspaceFolders` directly
   - `WorkflowExecutor.ts` — call `platform.warn()` / `platform.log()` instead of `vscode.window.*` directly; `platform.focusDashboard()` instead of `vscode.commands.executeCommand`
   - `CliIntegration.ts` — call `platform.createInteractiveTerminal()` for the interactive path (VsCodeAdapter wraps the existing terminal + shell integration code); call `platform.getConfig()` instead of `vscode.workspace.getConfiguration()`

### Phase 3: CLI Entry Point

**Goal**: Wire everything together for terminal execution

4. **Create `src/cli.ts`**
   - Commander.js argument parsing
   - Config loading (flags → env vars → `.flightpathrc.json` → defaults)
   - Instantiate `CliAdapter` with resolved config
   - Instantiate `WorkflowInstance` with CLI factory
   - Execute and stream output to terminal
   - Exit with appropriate code

5. **Implement `CliAdapter`**
   - `getConfig()` reads from resolved CLI config
   - `getWorkspaceRoot()` returns `--cwd` or `process.cwd()`
   - `log()`/`warn()`/`error()` write to console with optional color (chalk)
   - `createInteractiveTerminal()` spawns with `stdio: 'inherit'`

6. **Build Configuration**
   - Add CLI bundle to `esbuild.js` (follow MCP server pattern)
   - Add `flightpath` to `bin` in `package.json`
   - Verify no `vscode` imports leak into CLI bundle (build fails if they do)

### Phase 4: Interactive & Headless Modes

7. **Validate interactive mode end-to-end**
   - TTY auto-detection already designed
   - Test with Copilot CLI and Claude CLI tool approval prompts
   - Verify Ctrl+C handling (SIGINT → graceful stop)

8. **Validate headless mode**
   - Auto-add `--allow-all-tools` / `--dangerously-skip-permissions` flags
   - CI/CD JSON output (`--json`)
   - Timeout handling

### Phase 5: Polish

9. **Output & Reporting** — human-readable format, JSON mode, exit codes
10. **Error Messages** — user-friendly errors for missing files, missing CLIs, auth failures
11. **Testing** — unit tests for `CliAdapter`, integration tests with mock harnesses
12. **Documentation** — CLI README, config file reference, examples

### Files to Modify (Priority Order)

| File                                           | Changes                                          | Effort |
| ---------------------------------------------- | ------------------------------------------------ | ------ |
| `src/flightpath/WorkflowInstance.ts`           | NEW — extracted from FlightPathManager (Phase 1) | High   |
| `src/flightpath/IntegrationFactory.ts`         | NEW — factory interface (Phase 1)                | Low    |
| `src/platform/PlatformAdapter.ts`              | NEW — platform interface (Phase 2)               | Low    |
| `src/platform/VsCodeAdapter.ts`                | NEW — VS Code impl (Phase 2)                     | Low    |
| `src/platform/CliAdapter.ts`                   | NEW — Node.js CLI impl (Phase 3)                 | Medium |
| `src/cli.ts`                                   | NEW — CLI entry point (Phase 3)                  | Medium |
| `src/flightpath/PromptFileParser.ts`           | Remove `vscode.window` (1 call)                  | Low    |
| `src/flightpath/PromptQueue.ts`                | Replace `vscode.EventEmitter` → Node EventEmitter | Low   |
| `src/flightpath/orchestration/WorkspaceSessionManager.ts` | Inject `platform.getWorkspaceRoot()`  | Low    |
| `src/flightpath/WorkflowExecutor.ts`           | Inject adapter, remove `vscode.commands`         | Medium |
| `src/flightpath/cli/CliIntegration.ts`         | Inject adapter for config + terminal             | Medium |
| `src/flightpath/base/CopilotIntegration.ts`    | Inject adapter                                   | Low    |
| `src/extension.ts`                             | Pass `VsCodeAdapter` to `WorkflowInstance`       | Low    |
| `esbuild.js`                                   | Add CLI bundle (follow MCP server pattern)       | Low    |
| `package.json`                                 | Add `flightpath` to `bin`                        | Low    |

**Note on `CopilotChatIntegration.ts`**: Stays VS Code-only, no modifications needed. It's never imported by `cli.ts`, so esbuild tree-shaking excludes it automatically.

---

## Future Enhancements (Post-MVP)

### v1.1: Enhanced Features

- **Dynamic Queue**: Allow Copilot to extend workflows (shared with extension)
- **Watch Mode**: Re-run on file changes (`chokidar`)
- **Parallel Execution**: Run independent prompts concurrently

### v1.2: User Experience

- **TUI Dashboard**: Terminal UI using `ink` or `blessed`
- **Progress Bars**: Visual progress for multi-prompt workflows
- **Prompt Editor**: Interactive prompt editing before execution

### v1.3: Distribution

- **Standalone Binary**: Package with pkg/nexe/bun compile
- **Docker Image**: Containerized execution
- **GitHub Action**: First-party action for CI/CD

### v2.0: Advanced

- **Plugin System**: Extensible provider architecture
- **MCP Server Mode**: Run FlightPath as an MCP server
- **Remote Execution**: Distribute prompts across machines

---

## Dependencies

### New Dependencies (CLI-only)

```json
{
  "dependencies": {
    "commander": "^12.0.0", // CLI framework
    "chalk": "^5.3.0" // Terminal colors
  }
}
```

### Existing Dependencies (Shared)

These are already in the extension and will be shared:

```json
{
  "dependencies": {
    "ajv": "^8.12.0" // JSON schema validation (already used)
  }
}
```

### Optional Dependencies

```json
{
  "optionalDependencies": {
    "node-pty": "^1.0.0" // PTY for advanced interactive mode
  }
}
```

**Note**: `node-pty` is optional. Basic interactive mode works with `stdio: 'inherit'`. PTY is only needed for advanced terminal features (split output capture + interaction).

---

## Comparison with Similar Tools

| Feature               | FlightPath CLI              | Aider | Claude CLI | Copilot CLI |
| --------------------- | --------------------------- | ----- | ---------- | ----------- |
| Workflow Files        | ✅ YAML/JSON/MD             | ❌    | ❌         | ❌          |
| Multi-Prompt          | ✅ Sequential               | ❌    | ❌         | ❌          |
| End Conditions        | ✅ Scripts                  | ❌    | ❌         | ❌          |
| Multiple Harnesses    | ✅ Copilot+Claude+Codex CLI | ❌    | ❌         | ❌          |
| Session Resume        | ✅                          | ✅    | ✅         | ✅          |
| CI/CD Ready           | ✅ JSON output              | ⚠️    | ⚠️         | ⚠️          |
| Dynamic Queue         | ✅ (shared with extension)  | ❌    | ❌         | ❌          |

---

## Summary

FlightPath CLI brings structured AI workflow automation to any terminal environment **while sharing 90%+ of code with the VS Code extension**.

### Key Design Decisions

1. **WorkflowInstance is the bridge**: The parallel workflows refactor extracts `WorkflowInstance` as a self-contained execution unit. The CLI uses it directly — no VS Code orchestration needed.
2. **Shared Codebase**: Single repo with platform abstraction, not a rewrite
3. **Interactive by Default**: TTY detection enables tool approval workflows
4. **Minimal New Dependencies**: Only Commander.js and chalk for CLI-specific needs
5. **Incremental Refactoring**: Extension keeps working throughout migration
6. **Build-time safety**: No `vscode` in CLI externals — any leak causes build failure

### MVP Deliverables

1. **WorkflowInstance Extraction** — prerequisite, shared with parallel workflows work
2. **Platform Abstraction Layer** - `PlatformAdapter` interface + implementations
3. **CLI Entry Point** - `src/cli.ts` with Commander.js
4. **Interactive + Headless Modes** - TTY detection, permission flags
5. **Streaming Output** - Real-time CLI output with colors
6. **End Conditions** - Full support (shared code)
7. **JSON Output** - CI/CD integration

### Code Sharing Benefits

| Metric             | Rewrite Approach | Shared Code Approach |
| ------------------ | ---------------- | -------------------- |
| New code to write  | ~3000 lines      | ~300 lines           |
| Maintenance burden | 2x               | 1x (single source)   |
| Feature parity     | Manual sync      | Automatic            |
| Bug fixes          | Need in both     | Fix once             |
| Testing            | Separate suites  | Shared tests         |

The architecture is designed for maximum code reuse while allowing platform-specific optimizations where needed. All existing features (Dynamic Queue, session management, end conditions, all three CLI harnesses) work automatically in the CLI since they live in the shared `WorkflowInstance` layer.
