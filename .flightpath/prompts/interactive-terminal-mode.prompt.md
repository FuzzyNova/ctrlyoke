# Implement Interactive Terminal Mode for CLI Integrations

## Overview

Refactor FlightPath's CLI integrations to support running in VS Code's interactive terminal instead of only headless process spawning. This allows users to see output in real-time, press Ctrl+C to abort immediately, and respond to permission prompts when needed.

## Design Reference

Full design rationale in `@docs/INTERACTIVE_TERMINAL_DESIGN.md`.

## Key Concepts

**Execution mode and permission settings are independent:**

- **Execution Mode** (`interactive` | `headless`) - Where the CLI runs
- **Permission Settings** - What the CLI is allowed to do (unchanged)

Users can combine any execution mode with any permission setting. Headless without full permissions will auto-deny prompts (CLI doesn't hang, just can't act).

## Implementation Tasks

### 1. Add New Setting

**File: `package.json`**

Add under `contributes.configuration.properties`:

```json
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "enumDescriptions": [
    "Opens a VS Code terminal where you can see output, interact if needed, and press Ctrl+C to stop immediately (recommended)",
    "Runs in background process without visible terminal"
  ],
  "default": "interactive",
  "description": "Where CLI commands execute. Interactive provides visibility and immediate abort via Ctrl+C. Headless runs silently in background."
}
```

### 2. Add Terminal Management to BaseCliIntegration

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

Add new properties:

```typescript
protected terminal?: vscode.Terminal;
protected shellIntegration?: vscode.TerminalShellIntegration;
protected currentExecution?: vscode.TerminalShellExecution;
```

Add new methods:

```typescript
protected getExecutionMode(): 'interactive' | 'headless' {
  return vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('cliExecutionMode', 'interactive') as 'interactive' | 'headless';
}

protected async getOrCreateTerminal(): Promise<vscode.Terminal> {
  if (this.terminal && !this.isTerminalClosed()) {
    return this.terminal;
  }

  this.terminal = vscode.window.createTerminal({
    name: `FlightPath: ${this.getCliName()}`,
    cwd: this.getWorkspaceRoot(),
  });

  return this.terminal;
}

private isTerminalClosed(): boolean {
  return !this.terminal || this.terminal.exitStatus !== undefined;
}

protected async waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number = 5000
): Promise<vscode.TerminalShellIntegration> {
  // If already available, return immediately
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  // Wait for shell integration to activate
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error('Shell integration not available'));
    }, timeoutMs);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) {
        clearTimeout(timeout);
        disposable.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}

// Abstract method for subclasses to implement
protected abstract getCliName(): string;

// Abstract method - subclasses check their specific permission settings
protected abstract hasFullPermissions(): boolean;
```

### 3. Refactor sendPrompt() Flow

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

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
    return this.executeInTerminal(prompt, workflowContext);
  }
}
```

### 4. Implement Interactive Terminal Execution

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

```typescript
protected async executeInTerminal(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // Build command (same as headless)
  const command = await this.buildCommand(prompt, workflowContext);

  // Get or create terminal
  const terminal = await this.getOrCreateTerminal();
  terminal.show();

  // Wait for shell integration (with fallback)
  let shellIntegration: vscode.TerminalShellIntegration;
  try {
    shellIntegration = await this.waitForShellIntegration(terminal);
  } catch {
    // Fallback: use sendText without streaming
    vscode.window.showWarningMessage(
      'Shell integration unavailable. Output streaming disabled.'
    );
    terminal.sendText(command);
    // Can't detect completion without shell integration
    // Return true and let user manage manually
    return true;
  }

  // Execute command
  const execution = shellIntegration.executeCommand(command);
  this.currentExecution = execution;

  // Fire prompt ready event
  this.promptReadyEmitter.fire({
    fullPrompt: prompt.prompt,
    cliCommand: command,
  });

  // Stream output to dashboard (don't await - runs in parallel)
  this.streamOutput(execution);

  // Wait for completion
  return this.waitForCompletion(execution);
}

private async streamOutput(execution: vscode.TerminalShellExecution): Promise<void> {
  try {
    for await (const data of execution.read()) {
      const cleanData = this.stripAnsiCodes(data);
      this.streamingChunkEmitter.fire(cleanData);
      this.outputChannel?.append(data);
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

private waitForCompletion(execution: vscode.TerminalShellExecution): Promise<boolean> {
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

private stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
```

### 5. Rename Existing Logic to executeHeadless

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

Rename the current `sendPrompt()` implementation to `executeHeadless()`:

```typescript
protected async executeHeadless(
  prompt: PromptItem,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // ... existing spawn-based implementation
}
```

### 6. Implement hasFullPermissions() in Subclasses

**File: `src/flightpath/cli/CopilotCommandLineIntegration.ts`**

```typescript
protected getCliName(): string {
  return 'copilot';
}

protected hasFullPermissions(): boolean {
  const toolMode = vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('copilotCliToolPermissions', 'allowAll');
  const allowAllPaths = vscode.workspace
    .getConfiguration('flightpath')
    .get<boolean>('copilotCliAllowAllPaths', true);

  return toolMode === 'allowAll' && allowAllPaths;
}
```

**File: `src/flightpath/cli/ClaudeCommandLineIntegration.ts`**

```typescript
protected getCliName(): string {
  return 'claude';
}

protected hasFullPermissions(): boolean {
  const toolMode = vscode.workspace
    .getConfiguration('flightpath')
    .get<string>('claudeCliToolPermissions', 'skipAll');

  return toolMode === 'skipAll';
}
```

### 7. Update Cancellation Logic

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

Update the cancel/stop method to handle terminal execution:

```typescript
public cancel(): void {
  if (this.currentExecution && this.terminal) {
    // Send Ctrl+C to terminal
    this.terminal.sendText('\x03');
  }
  // Also handle headless process cancellation (existing logic)
  // ...
}
```

### 8. Update dispose()

**File: `src/flightpath/cli/BaseCliIntegration.ts`**

```typescript
dispose(): void {
  if (this.terminal) {
    this.terminal.dispose();
    this.terminal = undefined;
  }
  // ... existing dispose logic
}
```

## Testing

1. Set `cliExecutionMode: interactive` (default)
   - Verify terminal opens and shows when running a workflow
   - Verify output streams to dashboard
   - Verify Ctrl+C in terminal stops execution
   - Verify FlightPath stop button sends Ctrl+C

2. Set `cliExecutionMode: headless`
   - Verify no terminal opens
   - Verify output still streams to dashboard
   - With `allowAll` permissions: should work normally
   - Without full permissions: should show warning

3. Multi-prompt workflows
   - Verify terminal is reused across prompts
   - Verify session management still works

4. Shell integration fallback
   - Test with shell integration disabled
   - Verify warning is shown
   - Verify command still executes via sendText
