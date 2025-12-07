# Interactive Terminal Mode Design

## Overview

This document outlines a refactor of FlightPath's CLI integrations (`CopilotCommandLineIntegration`, `ClaudeCommandLineIntegration`) to use VS Code's interactive terminal instead of headless process spawning. This allows users to interact with CLI tools for approvals while still streaming output to the dashboard.

## Prompt Passing Strategy

**All prompts use `-p` flag with `JSON.stringify()` escaping.**

We standardized on passing prompts via command-line argument rather than stdin for consistency:

```typescript
// Both interactive and headless modes use the same approach
args.push("-p", JSON.stringify(promptText));
```

**Why not stdin?**

1. **Terminal API limitation**: VS Code's `TerminalShellIntegration.executeCommand()` doesn't support stdin
2. **Consistency**: Using the same approach in both modes simplifies the codebase
3. **Debugging**: Easy to see the exact command being executed
4. **JSON.stringify escaping**: Handles special characters, quotes, and newlines reliably

**Why JSON.stringify?**

- Properly escapes all special characters (quotes, newlines, backslashes)
- Works cross-platform (Windows/macOS/Linux)
- CLI tools interpret the escaped JSON string correctly

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

Add a new setting to control where CLI commands execute:

```typescript
// package.json - new setting
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "default": "interactive",
  "description": "How to execute CLI commands. 'interactive' opens a VS Code terminal for visibility and user interaction. 'headless' runs in background process."
}
```

**Key Insight: Execution mode and permission settings are independent concerns.**

- **Execution Mode** controls _where_ the CLI runs (visible terminal vs background process)
- **Permission Settings** control _what_ the CLI is allowed to do (tools, directories, etc.)

**Behavior Matrix:**

| Mode          | Terminal Visible | User Can Ctrl+C   | Streaming to Dashboard         |
| ------------- | ---------------- | ----------------- | ------------------------------ |
| `interactive` | ✅ Yes           | ✅ Immediate      | ✅ Yes (via shell integration) |
| `headless`    | ❌ No            | ⏳ Via FlightPath | ✅ Yes (via stdout)            |

**Why users want interactive mode even with full permissions:**

1. **Immediate abort** - Press Ctrl+C directly instead of waiting for FlightPath's stop button
2. **Real-time visibility** - See exactly what the CLI is doing as it happens
3. **Debugging** - Easier to troubleshoot when you can see the terminal
4. **Trust but verify** - Full permissions granted, but want to monitor execution

**Headless mode warning:**

- If `headless` mode is selected without full permissions, the CLI will auto-deny permission prompts (safe default). This means the agent may be unable to use tools or edit files. FlightPath will show a warning to help users understand why their workflow isn't making progress.

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

  if (mode === 'headless') {
    // Warn if headless will auto-deny permission prompts
    if (!this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        'Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress.'
      );
    }
    return this.executeHeadless(prompt, workflowContext);
  } else {
    // Interactive mode - works with any permission setting
    return this.executeInTerminal(prompt, workflowContext);
  }
}

// Check if full permissions are granted (no prompts will occur)
protected hasFullPermissions(): boolean {
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
  // 1. Build the command (same command as headless, just different execution context)
  const command = await this.buildCommand(prompt, workflowContext);

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

Each CLI integration builds commands based on user's permission settings. The same permission flags are used for both interactive and headless modes - the only difference is _where_ the command runs.

**CopilotCommandLineIntegration:**

```typescript
private buildCliArgs(prompt: PromptItem, promptText: string): string[] {
  const args: string[] = [];

  // Always use -p with JSON.stringify for prompt
  // Works identically for both interactive and headless modes
  args.push('-p', JSON.stringify(promptText));

  // Model selection
  const model = this.validateAndGetModel(prompt.model);
  if (model) {
    args.push('--model', model);
  }

  // Add workspace directories
  this.getWorkspaceDirs().forEach(dir => {
    args.push('--add-dir', dir);
  });

  // Apply permission settings (same for both interactive and headless)
  const toolMode = this.getToolPermissionMode();
  if (toolMode === 'allowAll') {
    args.push('--allow-all-tools');
  } else {
    // Custom mode: use specific allow/deny patterns
    const allowedTools = this.getAllowedTools();
    allowedTools.forEach(tool => args.push('--allow-tool', tool));

    const deniedTools = this.getDeniedTools();
    deniedTools.forEach(tool => args.push('--deny-tool', tool));
  }

  // Session management
  if (prompt.newChatSession === false && this.sessionId) {
    args.push('--resume', this.sessionId);
  }

  return args;
}

protected hasFullPermissions(): boolean {
  // Check if all permissions are pre-granted (no prompts will occur)
  const toolMode = this.getToolPermissionMode();
  const allowAllPaths = this.getAllowAllPaths();

  return toolMode === 'allowAll' && allowAllPaths;
}
```

**ClaudeCommandLineIntegration:**

```typescript
private buildCliArgs(prompt: PromptItem, promptText: string): string[] {
  const args: string[] = [];

  // Always use -p with JSON.stringify for prompt
  // Works identically for both interactive and headless modes
  args.push('-p', JSON.stringify(promptText));

  // Apply permission settings (same for both interactive and headless)
  const toolMode = this.getToolPermissionMode();
  if (toolMode === 'dangerouslySkipAll') {
    args.push('--dangerously-skip-permissions');
  } else if (toolMode === 'allowAll') {
    // Allow all tools but apply deny list
    args.push('--tools', 'default');
    const deniedTools = this.getDeniedTools();
    deniedTools.forEach(tool => args.push('--disallowedTools', tool));
  } else {
    // Custom mode: use specific allow/deny patterns
    const allowedTools = this.getAllowedTools();
    allowedTools.forEach(tool => args.push('--allowedTools', tool));
    const deniedTools = this.getDeniedTools();
    deniedTools.forEach(tool => args.push('--disallowedTools', tool));
  }

  // Model selection
  const model = this.validateAndGetModel(prompt.model);
  args.push('--model', model);

  // Add workspace directories
  this.getWorkspaceDirs().forEach(dir => {
    args.push('--add-dir', dir);
  });

  return args;
}

protected hasFullPermissions(): boolean {
  // Check if all permissions are pre-granted (no prompts will occur)
  const toolMode = this.getToolPermissionMode();

  return toolMode === 'dangerouslySkipAll';
}
```

### Phase 5: Headless Execution (Preserved)

Keep existing headless logic as `executeHeadless()`:

```typescript
private async executeHeadless(
  args: string[],
  promptText: string
): Promise<boolean> {
  // Fire event with prompt and command ready
  this.promptReadyEmitter.fire({
    fullPrompt: promptText,
    cliCommand: this.lastCliCommand!,
  });

  // Execute CLI command (prompt is in args via -p flag)
  // Uses spawnProcess for background execution
  const result = await this.executeCopilotCommand(args);

  // ... handle result
}
```

## Settings Changes

### New Setting

```json
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "enumDescriptions": [
    "Opens a VS Code terminal where you can see output, interact if needed, and press Ctrl+C to stop immediately (recommended)",
    "Runs in background process without visible terminal. Requires full permissions to avoid hanging on prompts."
  ],
  "default": "interactive",
  "description": "Where CLI commands execute. Interactive provides visibility and immediate abort via Ctrl+C. Headless runs silently in background."
}
```

### Existing Settings Behavior

**Permission settings work identically in both modes.** The only difference is whether you can see/interact with the terminal.

| Setting                                        | Interactive Mode                          | Headless Mode                             |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `cliAllowedTools`                              | Used in custom mode only                  | Used in custom mode only                  |
| `cliDeniedTools`                               | ALWAYS used (all modes)                   | ALWAYS used (except dangerouslySkipAll)   |
| `copilotCliToolPermissions: allowAll`          | `--allow-all-tools` + deny list           | `--allow-all-tools` + deny list           |
| `copilotCliToolPermissions: custom`            | Uses allow/deny patterns                  | ⚠️ Auto-denies prompts (agent can't act)  |
| `claudeCliToolPermissions: dangerouslySkipAll` | `--dangerously-skip-perms` (ignores deny) | `--dangerously-skip-perms` (ignores deny) |
| `claudeCliToolPermissions: allowAll`           | `--tools "default"` + deny list           | `--tools "default"` + deny list           |
| `claudeCliToolPermissions: custom`             | Uses allow/deny patterns                  | ⚠️ Auto-denies prompts (agent can't act)  |

**Common use cases:**

| Want                                        | Mode          | Permissions |
| ------------------------------------------- | ------------- | ----------- |
| Full automation, don't need to see output   | `headless`    | `allowAll`  |
| Full automation, but want visibility/Ctrl+C | `interactive` | `allowAll`  |
| Review and approve each tool usage          | `interactive` | `custom`    |
| Automation with specific tool restrictions  | `interactive` | `custom`    |

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

### Output Streaming Limitations (Known Issue)

**The `execution.read()` API may not capture output on all platforms**, especially Windows with PowerShell. This is a known VS Code limitation documented in:

- [GitHub Issue #241592](https://github.com/microsoft/vscode/issues/241592)
- Roo/Kilo Code documentation on shell integration issues

**Symptoms:**

- Dashboard shows "No output captured via shell integration" message
- Export contains only the interactive mode header, not the actual CLI output
- Terminal shows output correctly, but it's not captured by the extension

**Workarounds implemented:**

1. Show informational message in dashboard explaining interactive mode
2. If no output captured, display clear warning with instructions
3. User should view terminal directly for full output
4. For export, the message explains the limitation

**Future improvements:**

- Consider adding terminal command delay setting (like Roo Code)
- Investigate platform-specific workarounds for PowerShell
- Document recommended shell (bash/zsh may be more reliable)

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
   - Headless mode without full permissions → warns, CLI auto-denies prompts
   - Headless mode with full permissions → runs in background

## Migration Path

### Breaking Changes

None - existing behavior preserved when:

- `cliExecutionMode` defaults to `interactive` (new behavior)
- Permission settings (`allowAllTools`, `allowedTools`, etc.) work exactly as before
- Users can set `cliExecutionMode: headless` to get the old invisible background behavior

### No Deprecation Needed

Permission settings and execution mode are independent:

- **Permission settings** control what the CLI can do
- **Execution mode** controls where the CLI runs

Both are useful and remain fully supported.

## Future Enhancements

1. **Terminal embedding** - Use xterm.js to embed terminal directly in dashboard (complex but better UX)
2. **Approval shortcuts** - Detect common approval patterns, add quick-approve buttons
3. **Approval history** - Remember approved tools for session
4. **Audit log** - Track all tool approvals for security review

## Summary

This refactor adds a new execution mode setting that controls where CLI commands run:

| Mode          | Description                                      |
| ------------- | ------------------------------------------------ |
| `interactive` | Runs in VS Code terminal (visible, Ctrl+C works) |
| `headless`    | Runs in background process (current behavior)    |

**Key insight: Execution mode and permission settings are orthogonal.**

- A user with `allowAllTools: true` might still want `interactive` mode for visibility and immediate abort
- A user with custom permissions must use `interactive` mode (headless would hang on prompts)

Permission flags (`--allow-all-tools`, `--allow-tool`, etc.) are applied identically in both modes - only the execution context differs.

## References

- [VS Code Terminal API](https://code.visualstudio.com/api/references/vscode-api#Terminal)
- [Shell Integration Documentation](https://code.visualstudio.com/docs/terminal/shell-integration)
- [TerminalShellIntegration API](https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration)
