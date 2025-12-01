# Interactive Terminal Mode Design

## Overview

This document outlines a refactor of FlightPath's CLI integrations (`CopilotCommandLineIntegration`, `ClaudeCommandLineIntegration`) to use VS Code's interactive terminal instead of headless process spawning. This allows users to interact with CLI tools for approvals while still streaming output to the dashboard.

## Problem Statement

FlightPath's current CLI integrations use headless mode with `--allow-all-tools` or `--dangerously-skip-permissions` for full automation. However:

1. **Guardrails matter** - Many users don't want to allow all tools/directories
2. **Approval workflow** - Users need to review and approve tool usage
3. **Unexpected prompts** - Even with full permissions, CLIs may prompt for other reasons
4. **No interaction** - Headless mode can't handle any user input

## Solution: Refactor CLI Integrations to Use VS Code Terminal

Instead of creating a new integration, **refactor the existing CLI integrations** to use VS Code's Shell Integration API by default.

VS Code provides a Shell Integration API that allows extensions to:

1. Create and show a terminal (user can see and interact)
2. Execute commands programmatically
3. **Stream output** back to the extension via `execution.read()`
4. Detect command completion with exit codes

This gives us the best of both worlds: interactive terminal + dashboard streaming.

## Architecture

### Execution Mode Setting

Replace the current `--allow-all-tools` behavior with a mode setting:

```typescript
// package.json - new setting per CLI provider
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "default": "interactive",
  "description": "How to execute CLI commands. 'interactive' opens a VS Code terminal for user interaction. 'headless' runs in background (requires allowAllTools)."
}
```

**Behavior:**

| Mode                    | Terminal Visible | User Interaction | Streaming to Dashboard         |
| ----------------------- | ---------------- | ---------------- | ------------------------------ |
| `interactive` (default) | ✅ Yes           | ✅ Yes           | ✅ Yes (via shell integration) |
| `headless`              | ❌ No            | ❌ No            | ✅ Yes (via stdout)            |

**Headless mode constraints:**

- Only allowed when `allowAllTools` / `dangerouslySkipPermissions` is enabled
- Shows warning if enabled without full permissions
- Falls back to interactive if CLI prompts unexpectedly

### Refactored Component Design

```
┌─────────────────────────────────────────────────────────────────┐
│                      BaseCliIntegration                          │
│  (existing abstract base class)                                  │
│                                                                  │
│  NEW Properties:                                                 │
│  - terminal?: vscode.Terminal                                    │
│  - shellIntegration?: TerminalShellIntegration                   │
│  - executionMode: 'interactive' | 'headless'                     │
│                                                                  │
│  NEW Methods:                                                    │
│  - createTerminal(): Create/reuse VS Code terminal               │
│  - waitForShellIntegration(): Wait for shell integration         │
│  - executeInTerminal(): Run command via shell integration        │
│  - executeHeadless(): Run command via spawn (existing logic)     │
│                                                                  │
│  MODIFIED Methods:                                               │
│  - sendPrompt(): Route to terminal or headless based on mode     │
└─────────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│ CopilotCommandLine      │   │ ClaudeCommandLine       │
│ Integration             │   │ Integration             │
│                         │   │                         │
│ - buildCopilotCommand() │   │ - buildClaudeCommand()  │
│ - copilot-specific args │   │ - claude-specific args  │
└─────────────────────────┘   └─────────────────────────┘
```

### No New Providers Needed

The existing providers remain:

- `copilot-cli` - Uses `CopilotCommandLineIntegration` (refactored)
- `claude-cli` - Uses `ClaudeCommandLineIntegration` (refactored)
- `copilot-chat` - Unchanged

Each CLI integration now supports both interactive and headless execution modes internally.

## Implementation Plan

### Phase 1: Refactor BaseCliIntegration

Add terminal management to `BaseCliIntegration.ts`:

```typescript
// New properties
protected terminal?: vscode.Terminal;
protected shellIntegration?: vscode.TerminalShellIntegration;
protected currentExecution?: vscode.TerminalShellExecution;

// Get execution mode from settings
protected getExecutionMode(): 'interactive' | 'headless' {
  return vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('cliExecutionMode', 'interactive') as 'interactive' | 'headless';
}

// Create or reuse terminal
protected async getOrCreateTerminal(): Promise<vscode.Terminal> {
  if (this.terminal && !this.isTerminalClosed()) {
    return this.terminal;
  }

  this.terminal = vscode.window.createTerminal({
    name: `FlightPath: ${this.getCliCommand()}`,
    cwd: this.getWorkspaceRoot(),
  });

  return this.terminal;
}

// Wait for shell integration
protected async waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number = 5000
): Promise<vscode.TerminalShellIntegration> {
  // ... implementation
}
```

### Phase 2: Refactor sendPrompt() Flow

Modify `sendPrompt()` to route based on execution mode:

```typescript
async sendPrompt(
  prompt: PromptItem,
  needsCompletionDetection: boolean = true,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  const mode = this.getExecutionMode();

  if (mode === 'headless' && this.canRunHeadless()) {
    return this.executeHeadless(prompt, workflowContext);
  } else {
    return this.executeInTerminal(prompt, workflowContext);
  }
}

// Check if headless mode is safe
protected canRunHeadless(): boolean {
  // Only allow headless if full permissions are granted
  // Subclasses override with provider-specific checks
  return false;
}
```

### Phase 3: Interactive Terminal Execution

New method in `BaseCliIntegration`:

```typescript
protected async executeInTerminal(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // 1. Build the command (without auto-approve flags)
  const command = await this.buildInteractiveCommand(prompt, workflowContext);

  // 2. Get or create terminal
  const terminal = await this.getOrCreateTerminal();
  terminal.show(); // Make visible for user interaction

  // 3. Wait for shell integration
  const shellIntegration = await this.waitForShellIntegration(terminal);

  // 4. Execute command
  const execution = shellIntegration.executeCommand(command);
  this.currentExecution = execution;

  // 5. Fire prompt ready event
  this.promptReadyEmitter.fire({
    fullPrompt: prompt.prompt,
    cliCommand: command,
  });

  // 6. Stream output to dashboard
  this.streamOutput(execution);

  // 7. Wait for completion
  return this.waitForCompletion(execution);
}

private async streamOutput(execution: vscode.TerminalShellExecution): Promise<void> {
  try {
    for await (const data of execution.read()) {
      // Strip ANSI codes for clean dashboard display
      const cleanData = this.stripAnsiCodes(data);
      this.streamingChunkEmitter.fire(cleanData);

      // Also log to output channel with ANSI codes
      this.outputChannel?.append(data);
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

private waitForCompletion(
  execution: vscode.TerminalShellExecution
): Promise<boolean> {
  return new Promise((resolve) => {
    const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.execution === execution) {
        disposable.dispose();
        this.currentExecution = undefined;

        const success = event.exitCode === 0;
        this.responseCompleteEmitter.fire(
          success ? 'Command completed successfully' : `Command failed with exit code ${event.exitCode}`
        );
        resolve(success);
      }
    });
  });
}
```

### Phase 4: Provider-Specific Command Building

Each CLI integration builds commands differently for interactive mode:

**CopilotCommandLineIntegration:**

```typescript
protected async buildInteractiveCommand(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<string> {
  const promptText = await this.buildPromptText(prompt);
  const args: string[] = [];

  // Prompt via stdin doesn't work in terminal, use -p
  args.push('-p', this.escapeForShell(promptText));

  // Model selection
  if (prompt.model) {
    args.push('--model', prompt.model);
  }

  // Add workspace directories
  this.getWorkspaceDirs().forEach(dir => {
    args.push('--add-dir', this.escapeForShell(dir));
  });

  // NO --allow-all-tools (let user approve)
  // Add specific tool permissions from settings if configured
  const allowedTools = this.getAllowedTools();
  allowedTools.forEach(tool => args.push('--allow-tool', tool));

  const deniedTools = this.getDeniedTools();
  deniedTools.forEach(tool => args.push('--deny-tool', tool));

  // Session management
  if (prompt.newChatSession === false && this.sessionId) {
    args.push('--resume', this.sessionId);
  }

  return `copilot ${args.join(' ')}`;
}

protected canRunHeadless(): boolean {
  const toolMode = vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('copilotCliToolPermissions', 'allowAll');
  const allowAllPaths = vscode.workspace
    .getConfiguration('flightpath')
    .get<boolean>('copilotCliAllowAllPaths', true);

  return toolMode === 'allowAll' && allowAllPaths;
}
```

**ClaudeCommandLineIntegration:**

```typescript
protected async buildInteractiveCommand(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<string> {
  const promptText = await this.buildPromptText(prompt);
  const args: string[] = [];

  args.push('-p', this.escapeForShell(promptText));

  // Use default permission mode (prompts for approval)
  args.push('--permission-mode', 'default');

  // Model selection
  if (prompt.model) {
    args.push('--model', prompt.model);
  }

  // Add workspace directories
  this.getWorkspaceDirs().forEach(dir => {
    args.push('--add-dir', this.escapeForShell(dir));
  });

  // Add specific tool permissions from settings if configured
  const allowedTools = this.getAllowedTools();
  allowedTools.forEach(tool => args.push('--allowedTools', tool));

  return `claude ${args.join(' ')}`;
}

protected canRunHeadless(): boolean {
  const toolMode = vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('claudeCliToolPermissions', 'skipAll');

  return toolMode === 'skipAll';
}
```

### Phase 5: Headless Execution (Preserved)

Keep existing headless logic as `executeHeadless()`:

```typescript
protected async executeHeadless(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // Existing spawnProcess-based implementation
  // This is the current behavior - runs in background with no terminal

  const promptText = workflowContext
    ? await this.buildPromptWithInstructions(...)
    : await this.buildPromptText(prompt);

  // ... existing spawn logic with --allow-all-tools etc.
}
```

## Settings Changes

### New Setting

```json
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "enumDescriptions": [
    "Opens a VS Code terminal where you can see output and respond to prompts (recommended)",
    "Runs in background without terminal. Only works with full tool permissions enabled."
  ],
  "default": "interactive",
  "description": "How to execute CLI commands."
}
```

### Existing Settings Behavior

| Setting                               | Interactive Mode            | Headless Mode                            |
| ------------------------------------- | --------------------------- | ---------------------------------------- |
| `cliAllowedTools`                     | Used as `--allow-tool` args | Used as `--allow-tool` args              |
| `cliDeniedTools`                      | Used as `--deny-tool` args  | Used as `--deny-tool` args               |
| `copilotCliToolPermissions: allowAll` | Ignored (user approves)     | Enables `--allow-all-tools`              |
| `claudeCliToolPermissions: skipAll`   | Ignored (user approves)     | Enables `--dangerously-skip-permissions` |

## API Reference

### VS Code Shell Integration API

```typescript
// Create terminal
const terminal = vscode.window.createTerminal({
  name: "FlightPath: claude",
  cwd: workspaceRoot,
});
terminal.show();

// Wait for shell integration
const shellIntegration = terminal.shellIntegration; // May be undefined initially

// Execute command
const execution = shellIntegration.executeCommand('claude -p "Hello"');

// Stream output
for await (const data of execution.read()) {
  console.log(data); // Raw terminal output including ANSI codes
}

// Listen for completion
vscode.window.onDidEndTerminalShellExecution((event) => {
  if (event.execution === execution) {
    console.log("Exit code:", event.exitCode);
  }
});
```

### Key Events

| Event                                 | Description                                |
| ------------------------------------- | ------------------------------------------ |
| `onDidChangeTerminalShellIntegration` | Fires when shell integration activates     |
| `onDidStartTerminalShellExecution`    | Fires when a command starts                |
| `onDidEndTerminalShellExecution`      | Fires when a command ends (with exit code) |

## Considerations

### Shell Integration Availability

Shell integration requires:

- VS Code's shell integration feature enabled (default: on)
- A supported shell (bash, zsh, PowerShell, fish)
- Terminal to be initialized

**Fallback strategy**: If shell integration isn't available within 3-5 seconds, fall back to `terminal.sendText()` with a warning that streaming won't work.

### ANSI Escape Codes

Terminal output includes ANSI escape codes for colors, cursor positioning, etc. Options:

1. **Strip codes** - Clean output for dashboard (use `strip-ansi` package or regex)
2. **Render codes** - Use a terminal renderer in dashboard (complex)
3. **Pass through** - Let dashboard show raw text (may look messy)

**Recommendation**: Strip ANSI codes for dashboard display, keep raw in output channel.

```typescript
private stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
```

### Multi-Prompt Workflows

For workflows with multiple prompts:

1. **Reuse terminal** - Keep same terminal open for all prompts
2. **Session management** - Use `--resume` or `--continue` flags when supported
3. **Clear between prompts** - Optionally clear terminal between prompts

### Cancellation

To cancel a running command:

- User presses `Ctrl+C` in terminal
- Programmatically: `terminal.sendText('\x03')` (sends Ctrl+C)
- FlightPath's stop button should send Ctrl+C to terminal

### Terminal Lifecycle

```typescript
// Track terminal state
private isTerminalClosed(): boolean {
  return !this.terminal || this.terminal.exitStatus !== undefined;
}

// Dispose terminal on cleanup
dispose(): void {
  if (this.terminal) {
    this.terminal.dispose();
    this.terminal = undefined;
  }
}
```

## File Structure (Unchanged)

```
src/flightpath/
├── base/
│   └── CopilotIntegration.ts          # Abstract base (unchanged)
├── cli/
│   ├── BaseCliIntegration.ts          # MODIFIED: Add terminal support
│   ├── CopilotCommandLineIntegration.ts  # MODIFIED: Add interactive command builder
│   └── ClaudeCommandLineIntegration.ts   # MODIFIED: Add interactive command builder
└── chat/
    └── CopilotChatIntegration.ts      # Unchanged
```

## Dashboard Changes

The dashboard already handles streaming output. Minimal changes needed:

1. **Output display** - Strip ANSI codes before display
2. **Status indicator** - Show "Waiting for input..." when CLI is prompting
3. **Add "Focus Terminal" button** - Quick switch to terminal for interaction
4. **Mode indicator** - Show "Interactive" or "Headless" in header

## Testing Plan

1. **Manual testing**
   - Create prompt file with tool-requiring task
   - Run with `cliExecutionMode: interactive`
   - Verify terminal opens and shows
   - Verify output streams to dashboard
   - Approve tool usage in terminal
   - Verify completion detected
   - Run with `cliExecutionMode: headless` + full permissions
   - Verify runs without terminal

2. **Test cases**
   - Interactive mode → terminal opens, streams work
   - Shell integration unavailable → fallback to sendText with warning
   - User cancels in terminal → handled gracefully
   - Multi-prompt workflow → terminal reused
   - Exit code detection → success/failure reported
   - Headless mode without full permissions → falls back to interactive
   - Headless mode with full permissions → runs in background

## Migration Path

### Breaking Changes

None - existing behavior preserved when:

- `cliExecutionMode` defaults to `interactive`
- Users who had `allowAllTools` enabled get same headless behavior with `cliExecutionMode: headless`

### Deprecation

Consider deprecating direct control of `--allow-all-tools` flags in favor of the execution mode setting. The flags are still useful for fine-grained control but execution mode is the primary way to control visibility.

## Future Enhancements

1. **Terminal embedding** - Use xterm.js to embed terminal directly in dashboard (complex but better UX)
2. **Approval shortcuts** - Detect common approval patterns, add quick-approve buttons
3. **Approval history** - Remember approved tools for session
4. **Audit log** - Track all tool approvals for security review

## Summary

This refactor changes the default behavior from:

- **Before**: CLI runs headless in background, requires full permissions
- **After**: CLI runs in VS Code terminal, user can interact, output streams to dashboard

The headless mode is preserved for automation use cases where full permissions are acceptable.

## References

- [VS Code Terminal API](https://code.visualstudio.com/api/references/vscode-api#Terminal)
- [Shell Integration Documentation](https://code.visualstudio.com/docs/terminal/shell-integration)
- [TerminalShellIntegration API](https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration)
