# FlightPath CLI Design

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

1. **Execute prompt files**: `.flightpath.json`, `.prompt.json`, `.prompt.md`
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

# Specify provider explicitly
flightpath run workflow.json --provider copilot
flightpath run workflow.json --provider claude

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
  file             Path to .flightpath.json, .prompt.json, or .prompt.md

Options:
  --provider, -p   AI provider: 'copilot' or 'claude' (default: copilot)
  --model, -m      Model to use (overrides file and config)
  --cwd, -d        Working directory (default: directory of prompt file)
  --config, -c     Path to config file (default: .flightpathrc.json)
  --timeout, -t    Global timeout in seconds (default: 3600)
  --resume, -r     Resume session with given ID
  --new-session    Force new session (ignore resume)

Tool Permissions (Copilot):
  --allow-all-tools          Allow all tools without prompting
  --allow-tool <pattern>     Allow specific tool pattern (can repeat)
  --deny-tool <pattern>      Deny specific tool pattern (can repeat)
  --add-dir <path>           Add directory to allowed paths (can repeat)

Tool Permissions (Claude):
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
flightpath run my-workflow.flightpath.json

# CI/CD usage with JSON output
flightpath run ci-checks.flightpath.json --json --quiet > results.json

# Claude with specific model
flightpath run refactor.prompt.md --provider claude --model opus

# Copilot with restricted permissions
flightpath run deploy.flightpath.json \
  --provider copilot \
  --allow-tool 'shell(git:*)' \
  --deny-tool 'shell(rm:*)'

# Resume previous session
flightpath run continue.prompt.md --resume abc123

# Validate without running
flightpath validate workflow.flightpath.json
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
  "provider": "copilot",
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
FLIGHTPATH_PROVIDER=copilot|claude
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

### Code Sharing Strategy

The key insight: **Most FlightPath code is already platform-agnostic**. Only a thin layer touches VS Code APIs.

**Refactoring Reality**: Some VS Code-specific code will inevitably need to move to separate files. This is actually beneficial - it clarifies boundaries and makes the codebase cleaner. The goal isn't to avoid all refactoring, but to minimize it while maintaining clean separation.

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
│  • ui/* (dashboard, webview)    │  • (terminal output only)     │
│  • completions/* (IntelliSense) │  • (none)                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SHARED CORE (Platform-Agnostic)               │
│  (90%+ of the code - imports PlatformAdapter, not vscode)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  src/flightpath/                                                 │
│  ├── PromptQueue.ts         # State machine, execution logic    │
│  ├── PromptFileParser.ts    # JSON parsing, validation (AJV)    │
│  ├── EndConditionEvaluator.ts  # Script execution, timeout      │
│  ├── EndConditionHandler.ts    # Retry logic                    │
│  └── cli/                                                        │
│      ├── BaseCliIntegration.ts  # Process spawning, streaming   │
│      ├── CopilotCommandLineIntegration.ts                       │
│      └── ClaudeCommandLineIntegration.ts                        │
│                                                                  │
│  src/types/                                                      │
│  ├── FlightPathTypes.ts     # All interfaces and types          │
│  ├── CopilotTypes.ts        # CLI result types                  │
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

Create a simple interface that both platforms implement:

```typescript
// src/platform/PlatformAdapter.ts

export interface PlatformAdapter {
  // Configuration
  getConfig<T>(key: string, defaultValue: T): T;

  // Logging/Output
  log(message: string): void;
  error(message: string): void;
  showProgress(message: string): void;

  // Events (unified interface)
  createEventEmitter<T>(): EventEmitter<T>;

  // File system (already uses Node fs)
  // No abstraction needed - both use fs/promises

  // Process execution
  spawnProcess(
    command: string,
    args: string[],
    options: SpawnOptions
  ): ChildProcess;

  // Interactive terminal (for tool approvals)
  createInteractiveTerminal?(name: string): InteractiveTerminal;
}

// VS Code implementation
// src/platform/VsCodeAdapter.ts
export class VsCodeAdapter implements PlatformAdapter {
  getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get(key, defaultValue);
  }
  // ... etc
}

// CLI implementation
// src/platform/CliAdapter.ts
export class CliAdapter implements PlatformAdapter {
  constructor(private config: CliConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    return this.config[key] ?? defaultValue;
  }
  // ... etc
}
```

### Refactoring Strategy

**Phase 1: Extract Platform Dependencies**

1. Identify all `import * as vscode from 'vscode'` statements
2. Create `PlatformAdapter` interface for each usage pattern
3. Inject adapter via constructor instead of importing vscode directly

**Phase 2: Dependency Injection for Integrations**

The key challenge: `FlightPathManager.ts` currently imports ALL integrations directly, including VS Code-only `CopilotChatIntegration`. This would break the CLI build.

**Solution**: Use dependency injection so each entry point provides only its supported integrations:

```typescript
// src/flightpath/IntegrationFactory.ts (NEW - shared interface)
export interface IntegrationFactory {
  createIntegration(provider: Provider, context: any): CopilotIntegration;
  getSupportedProviders(): Provider[];
}

// extension.ts - provides ALL integrations
import { CopilotChatIntegration } from "./flightpath/chat/CopilotChatIntegration";
import { CopilotCommandLineIntegration } from "./flightpath/cli/CopilotCommandLineIntegration";
import { ClaudeCommandLineIntegration } from "./flightpath/cli/ClaudeCommandLineIntegration";

const vsCodeFactory: IntegrationFactory = {
  createIntegration(provider, context) {
    switch (provider) {
      case Provider.CopilotChat:
        return new CopilotChatIntegration(context); // VS Code only
      case Provider.CopilotCli:
        return new CopilotCommandLineIntegration(context, outputChannel);
      case Provider.ClaudeCli:
        return new ClaudeCommandLineIntegration(context, outputChannel);
    }
  },
  getSupportedProviders: () => [
    Provider.CopilotChat,
    Provider.CopilotCli,
    Provider.ClaudeCli,
  ],
};

// cli.ts - provides ONLY CLI integrations (no vscode imports in tree!)
import { CopilotCommandLineIntegration } from "./flightpath/cli/CopilotCommandLineIntegration";
import { ClaudeCommandLineIntegration } from "./flightpath/cli/ClaudeCommandLineIntegration";

const cliFactory: IntegrationFactory = {
  createIntegration(provider, context) {
    switch (provider) {
      case Provider.CopilotCli:
        return new CopilotCommandLineIntegration(context);
      case Provider.ClaudeCli:
        return new ClaudeCommandLineIntegration(context);
      default:
        throw new Error(
          `Provider "${provider}" requires VS Code. Use copilot or claude.`
        );
    }
  },
  getSupportedProviders: () => [Provider.CopilotCli, Provider.ClaudeCli],
};
```

**esbuild tree-shaking handles the rest**: Since `cli.ts` never imports `CopilotChatIntegration` (directly or transitively), it won't be bundled. No special esbuild configuration needed.

**Files that need VS Code extraction:**

| File                    | Current Issue                                        | Solution                             |
| ----------------------- | ---------------------------------------------------- | ------------------------------------ |
| `FlightPathManager.ts`  | Imports CopilotChatIntegration, Dashboard, StatusBar | Inject via factory                   |
| `CopilotIntegration.ts` | Uses vscode.ExtensionContext, vscode.EventEmitter    | Inject PlatformAdapter               |
| `BaseCliIntegration.ts` | Uses vscode.OutputChannel, vscode.workspace          | Inject PlatformAdapter               |
| `PromptFileParser.ts`   | Uses vscode.window.showErrorMessage                  | Use platform.error()                 |
| `PromptQueue.ts`        | Uses vscode.EventEmitter, vscode.workspace           | Use Node EventEmitter, inject config |

**Phase 3: Minimal Changes to Existing Code**

Example refactoring of `BaseCliIntegration.ts`:

```typescript
// BEFORE (VS Code coupled)
import * as vscode from "vscode";

export abstract class BaseCliIntegration {
  protected outputChannel?: vscode.OutputChannel;

  protected shouldShowOutput(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliOutput", true);
  }
}

// AFTER (Platform agnostic)
import { PlatformAdapter } from "../platform/PlatformAdapter";

export abstract class BaseCliIntegration {
  constructor(
    protected platform: PlatformAdapter
    // ... other params
  ) {}

  protected shouldShowOutput(): boolean {
    return this.platform.getConfig<boolean>("showCliOutput", true);
  }

  protected log(message: string): void {
    if (this.shouldShowOutput()) {
      this.platform.log(message);
    }
  }
}
```

### Project Structure (Shared Repo)

```
src/
├── extension.ts              # VS Code entry point
├── cli.ts                    # CLI entry point (NEW)
├── platform/                 # Platform abstraction (NEW)
│   ├── PlatformAdapter.ts    # Interface definition
│   ├── VsCodeAdapter.ts      # VS Code implementation
│   └── CliAdapter.ts         # Node.js CLI implementation
├── flightpath/               # SHARED - Core logic
│   ├── FlightPathManager.ts  # Orchestration (needs adapter injection)
│   ├── PromptQueue.ts        # Execution queue (minimal changes)
│   ├── PromptFileParser.ts   # File parsing (remove vscode.window)
│   ├── EndConditionEvaluator.ts  # Script runner (no vscode deps)
│   ├── EndConditionHandler.ts    # Retry logic (no vscode deps)
│   ├── base/
│   │   └── CopilotIntegration.ts  # Abstract base (needs adapter)
│   └── cli/
│       ├── BaseCliIntegration.ts      # Process spawning (needs adapter)
│       ├── CopilotCommandLineIntegration.ts
│       └── ClaudeCommandLineIntegration.ts
├── types/                    # SHARED - All types (no vscode deps)
├── utils/                    # SHARED - Utilities (mostly no vscode deps)
└── ui/                       # VS Code only - not shared
    ├── FlightPathDashboardProvider.ts
    └── webview/
```

### Build Configuration

**esbuild.js** additions:

```javascript
// Extension bundle (existing)
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  // ...
});

// CLI bundle (NEW)
await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  outfile: "out/cli.js",
  platform: "node",
  banner: {
    js: "#!/usr/bin/env node", // Make executable
  },
  // No 'vscode' in external - we don't import it
});
```

**package.json** additions for CLI distribution:

```json
{
  "name": "flightpath",
  "bin": {
    "flightpath": "./out/cli.js"
  },
  "files": ["out/cli.js", "out/schemas/"]
}
```

**Note**: The extension and CLI share the same package.json. When publishing to npm for CLI use, only the `bin` and `files` entries matter. The VS Code extension is published separately via `vsce`.

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
  "provider": "copilot",
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
    ./workflow.prompt.json
    ./my-workflow.flightpath.json
```

```
Error: Copilot CLI not installed

  FlightPath requires the GitHub Copilot CLI to be installed.

  Install it with:
    npm install -g @anthropic/copilot-cli

  Or use Claude instead:
    flightpath run workflow.json --provider claude
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

### Phase 1: Platform Abstraction (Week 1)

**Goal**: Create abstraction layer without breaking VS Code extension

1. **Create PlatformAdapter Interface**
   - Define interface for all VS Code API touchpoints
   - Keep minimal - only what's actually used

2. **Implement VsCodeAdapter**
   - Wraps existing vscode.\* calls
   - Drop-in replacement - existing code keeps working

3. **Identify VS Code Dependencies**
   - Audit all files for `import * as vscode`
   - Categorize: essential vs. removable
   - Document in comments what needs abstraction

4. **Refactor BaseCliIntegration**
   - This is the main shared component
   - Inject PlatformAdapter via constructor
   - Test that VS Code extension still works

### Phase 2: CLI Entry Point (Week 1-2)

5. **Create cli.ts Entry Point**
   - Commander.js setup
   - Argument parsing
   - Config loading (file + env + flags)

6. **Implement CliAdapter**
   - Node.js implementations of PlatformAdapter
   - Configuration from file/env/flags
   - Console logging with chalk

7. **Build Configuration**
   - Add CLI bundle to esbuild.js
   - Test both bundles build correctly
   - Verify no vscode imports leak into CLI bundle

### Phase 3: Core Refactoring (Week 2)

8. **Refactor PromptFileParser**
   - Remove `vscode.window.showErrorMessage`
   - Use PlatformAdapter.error() instead
   - Test parsing works in both contexts

9. **Refactor PromptQueue**
   - Replace `vscode.EventEmitter` with Node.js EventEmitter
   - Or use a cross-platform event library
   - Test queue logic in both contexts

10. **Refactor FlightPathManager**
    - This is the orchestrator
    - Inject dependencies via constructor
    - May need to split VS Code-specific parts

### Phase 4: Interactive Mode (Week 2-3)

11. **Interactive Terminal Support**
    - Detect TTY vs piped
    - Implement stdio: 'inherit' mode
    - Test with both Copilot and Claude CLIs

12. **Headless Mode**
    - Output capture and streaming
    - Auto-add permission flags
    - Timeout handling

### Phase 5: Features & Polish (Week 3-4)

13. **End Conditions**
    - Already mostly platform-agnostic
    - Verify script execution works
    - Test retry logic

14. **Output & Reporting**
    - Human-readable terminal output
    - JSON output (`--json`)
    - Exit codes

15. **Error Handling**
    - User-friendly error messages
    - Graceful shutdown (Ctrl+C)
    - Help text

16. **Testing**
    - Unit tests for CliAdapter
    - Integration tests with mock CLIs
    - Manual testing matrix

17. **Documentation**
    - README for CLI
    - Config file reference
    - Examples

### Files to Modify (Priority Order)

| File                                        | Changes                                  | Effort |
| ------------------------------------------- | ---------------------------------------- | ------ |
| `src/flightpath/IntegrationFactory.ts`      | NEW - Factory interface                  | Low    |
| `src/platform/PlatformAdapter.ts`           | NEW - Platform interface                 | Low    |
| `src/platform/VsCodeAdapter.ts`             | NEW - VS Code impl                       | Low    |
| `src/platform/CliAdapter.ts`                | NEW - Node impl                          | Medium |
| `src/cli.ts`                                | NEW - Entry point with CLI factory       | Medium |
| `src/extension.ts`                          | Add VS Code factory, inject into manager | Low    |
| `src/flightpath/FlightPathManager.ts`       | Accept factory + adapter via constructor | High   |
| `src/flightpath/cli/BaseCliIntegration.ts`  | Inject adapter                           | Medium |
| `src/flightpath/PromptFileParser.ts`        | Remove vscode.window                     | Low    |
| `src/flightpath/PromptQueue.ts`             | Use Node EventEmitter                    | Low    |
| `src/flightpath/base/CopilotIntegration.ts` | Inject adapter                           | Medium |
| `esbuild.js`                                | Add CLI bundle                           | Low    |
| `package.json`                              | Add bin entry                            | Low    |

**Note on CopilotChatIntegration.ts**: This file stays VS Code-only and doesn't need modification. It's simply not imported by the CLI entry point, so esbuild's tree-shaking excludes it automatically.

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

| Feature            | FlightPath CLI    | Aider | Claude CLI | Copilot CLI |
| ------------------ | ----------------- | ----- | ---------- | ----------- |
| Workflow Files     | ✅ JSON/MD        | ❌    | ❌         | ❌          |
| Multi-Prompt       | ✅ Sequential     | ❌    | ❌         | ❌          |
| End Conditions     | ✅ Scripts        | ❌    | ❌         | ❌          |
| Multiple Providers | ✅ Copilot+Claude | ❌    | ❌         | ❌          |
| Session Resume     | ✅                | ✅    | ✅         | ✅          |
| CI/CD Ready        | ✅ JSON output    | ⚠️    | ⚠️         | ⚠️          |

---

## Summary

FlightPath CLI brings structured AI workflow automation to any terminal environment **while sharing 90%+ of code with the VS Code extension**.

### Key Design Decisions

1. **Shared Codebase**: Single repo with platform abstraction, not a rewrite
2. **Interactive by Default**: TTY detection enables tool approval workflows
3. **Minimal New Dependencies**: Only Commander.js and chalk for CLI-specific needs
4. **Incremental Refactoring**: Extension keeps working throughout migration

### MVP Deliverables

1. **Platform Abstraction Layer** - `PlatformAdapter` interface + implementations
2. **CLI Entry Point** - `src/cli.ts` with Commander.js
3. **Interactive + Headless Modes** - TTY detection, permission flags
4. **Streaming Output** - Real-time CLI output with colors
5. **End Conditions** - Full support (shared code)
6. **JSON Output** - CI/CD integration

### Code Sharing Benefits

| Metric             | Rewrite Approach | Shared Code Approach |
| ------------------ | ---------------- | -------------------- |
| New code to write  | ~3000 lines      | ~500 lines           |
| Maintenance burden | 2x               | 1x (single source)   |
| Feature parity     | Manual sync      | Automatic            |
| Bug fixes          | Need in both     | Fix once             |
| Testing            | Separate suites  | Shared tests         |

The architecture is designed for maximum code reuse while allowing platform-specific optimizations where needed. Future features like Dynamic Queue will automatically work in both CLI and extension.
