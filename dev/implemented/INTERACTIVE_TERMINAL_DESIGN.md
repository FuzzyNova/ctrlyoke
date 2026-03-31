# Interactive Terminal Mode Design

> **STATUS**: This document reflects the **implemented architecture** as of January 2026. Originally a design document, it has been updated to match the actual implementation.

## Overview

FlightPath's CLI integrations (`CopilotCommandLineIntegration`, `ClaudeCommandLineIntegration`, `CodexCommandLineIntegration`) use VS Code's interactive terminal by default instead of headless process spawning. This allows users to interact with CLI tools for approvals while still streaming output to the dashboard.

## Prompt Passing Strategy

**Prompts use adaptive passing based on complexity:**

- **Simple prompts** (≤300 chars, no XML, no backticks): Passed directly on command line
- **Complex prompts**: Written to temp file and referenced via `@filepath` syntax

```typescript
// Simple prompts: direct passing
args = ["--prompt", `"${promptText}"`];

// Complex prompts: file reference with instruction
const tempFile = await createPromptFile(promptText);
const promptWithInstruction = `Follow instructions in @${tempFile} `;
```

**Why file-based passing for complex prompts?**

1. **Terminal API limitation**: VS Code's `TerminalShellIntegration.executeCommand()` doesn't support stdin
2. **Shell escaping**: Complex prompts with XML, backticks, or newlines are difficult to escape correctly
3. **Debugging**: Temp files can be inspected for troubleshooting
4. **Cross-CLI support**: Same approach works for Copilot, Claude, and Codex CLIs

**Why "Follow instructions in" prefix?**

- Helps LLMs (especially GPT-5) understand the file contains prompt instructions
- Matches GitHub Copilot's `/prompt.md` syntax behavior
- Trailing space prevents TUI file picker from activating

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
│  (src/flightpath/cli/BaseCliIntegration.ts)                      │
│                                                                  │
│  Properties:                                                     │
│  - processManager: CliProcessManager                             │
│  - currentExecution?: TerminalShellExecution                     │
│  - sessionId?: string                                            │
│                                                                  │
│  Terminal Methods:                                               │
│  - createFreshTerminal(): Create VS Code terminal                │
│  - waitForShellIntegration(): Wait for shell integration         │
│  - executeInTerminal(): Interactive TUI with file-based prompt   │
│  - executeHeadlessWithPromptFile(): Headless with file reference │
│                                                                  │
│  Abstract Methods (CLI-specific):                                │
│  - getCliName(): string                                          │
│  - getEscapeIndicator(): string                                  │
│  - getScreenEndPattern(): RegExp                                 │
│  - getTuiChromePatterns(): RegExp[]                              │
│  - buildInteractiveTuiCommand(): string                          │
│  - buildHeadlessArgs(): string[]                                 │
│  - hasFullPermissions(): boolean                                 │
└─────────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CopilotCommand  │ │ ClaudeCommand   │ │ CodexCommand    │
│ LineIntegration │ │ LineIntegration │ │ LineIntegration │
│                 │ │                 │ │                 │
│ - Copilot CLI   │ │ - Claude CLI    │ │ - Codex CLI     │
│ - --prompt flag │ │ - -p flag       │ │ - Direct prompt │
│ - Log directory │ │ - JSON stream   │ │ - JSONL events  │
└─────────────────┘ └─────────────────┘ └─────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      CliProcessManager                           │
│  (src/utils/CliProcessManager.ts)                                │
│                                                                  │
│  Responsibilities:                                               │
│  - Spawn CLI processes (spawn, spawnSimple)                      │
│  - Create/dispose VS Code terminals                              │
│  - Wait for shell integration                                    │
│  - Graceful cancellation (SIGTERM → SIGKILL)                     │
│  - Terminal cancellation (Ctrl+C × 2, then dispose)              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      TuiStreamProcessor                          │
│  (src/utils/TuiStreamProcessor.ts)                               │
│                                                                  │
│  Responsibilities:                                               │
│  - Process TUI output via execution.read()                       │
│  - Detect TUI readiness and send prompt                          │
│  - Strip ANSI codes for clean output                             │
│  - Deduplicate content across TUI screen redraws                 │
│  - Detect completion (escape indicator disappears)               │
│  - Handle CLI errors in output                                   │
└─────────────────────────────────────────────────────────────────┘
```

### No New Providers Needed

The existing providers remain:

- `copilot-cli` - Uses `CopilotCommandLineIntegration`
- `claude-cli` - Uses `ClaudeCommandLineIntegration`
- `codex-cli` - Uses `CodexCommandLineIntegration`
- `copilot-chat` - Unchanged

Each CLI integration supports both interactive and headless execution modes internally.

## Implementation Details

This section describes the key implementation details. For the full source code, see the files referenced above.

### Execution Mode Routing

`BaseCliIntegration.sendPrompt()` routes execution based on the `cliExecutionMode` setting:

```typescript
// Simplified from actual implementation
const mode = this.getExecutionMode();
const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

// Warn if headless without full permissions
this.warnIfHeadlessWithoutPermissions();

// Build args and route to appropriate execution method
const args = await this.buildCliArgs(prompt, isInteractive);

if (isInteractive) {
  return await this.executeInTerminal(args, promptText, workflowContext);
} else {
  return await this.executeHeadless(args, promptText, workflowContext);
}
```

### Interactive Terminal Execution

The `executeInTerminal()` method handles interactive TUI execution:

```typescript
protected async executeInTerminal(
  args: string[],
  promptText: string,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // Check if simple prompt (≤300 chars, no XML, no backticks)
  const useDirectPrompt = this.isSimplePrompt(promptText);

  // Create fresh terminal and start TUI
  const terminal = await this.createFreshTerminal();
  terminal.show();
  const shellIntegration = await this.waitForShellIntegration(terminal);
  const execution = shellIntegration.executeCommand(tuiCommand);

  // Create temp file for complex prompts, or pass directly for simple ones
  let promptToSend: string;
  if (useDirectPrompt) {
    promptToSend = promptText;
  } else {
    const { promptWithInstruction } = await this.createPromptFileWithReference(promptText);
    promptToSend = promptWithInstruction;  // "Follow instructions in @.flightpath/temp/prompt-1.md "
  }

  // TuiStreamProcessor handles:
  // - Waiting for TUI ready state
  // - Sending prompt via terminal.sendText()
  // - Streaming output via execution.read()
  // - Detecting completion (escape indicator disappears)
  const tuiProcessor = new TuiStreamProcessor(config);
  return tuiProcessor.processStream(execution, terminal, promptToSend, timeoutMs);
}
```

### TUI Stream Processing

`TuiStreamProcessor` handles the complexities of TUI output processing:

```typescript
async processStream(
  execution: vscode.TerminalShellExecution,
  terminal: vscode.Terminal,
  prompt: string,
  timeoutMs: number
): Promise<TuiProcessResult> {
  // Process flow:
  // 1. Wait for TUI ready (screen end pattern appears)
  // 2. Send prompt via terminal.sendText(prompt + "\r")
  // 3. Wait for file echo (confirms CLI received the prompt)
  // 4. Stream output and detect completion
  //
  // Completion detection:
  // - Escape indicator appears (CLI is generating)
  // - Escape indicator disappears for 2+ screens (complete)
  //
  // Content processing:
  // - Strip ANSI codes for clean dashboard display
  // - Deduplicate content across TUI screen redraws
  // - Filter TUI chrome (box borders, status bars, etc.)
}
```

### Headless Execution

Headless mode uses file-based prompt passing with `spawn()`:

```typescript
protected async executeHeadlessWithPromptFile(
  args: string[],
  promptText: string,
  workflowContext?: WorkflowContext,
  executeCallback: (result: SpawnResult) => Promise<boolean>
): Promise<boolean> {
  // Check if simple prompt
  const useDirectPrompt = this.isSimplePrompt(promptText);

  if (useDirectPrompt) {
    // Simple: pass directly on command line
    headlessArgs = this.buildHeadlessArgsWithDirectPrompt(args, promptText);
  } else {
    // Complex: create temp file and reference it
    const { promptWithInstruction } = await this.createPromptFileWithReference(promptText);
    headlessArgs = this.buildHeadlessArgs(args, promptWithInstruction);
  }

  // Spawn process with optional streaming
  const result = await this.processManager.spawn(command, headlessArgs, options);
  return await executeCallback(result);
}
```

## Settings

### Execution Mode Setting

```json
"flightpath.cliExecutionMode": {
  "type": "string",
  "enum": ["interactive", "headless"],
  "enumDescriptions": [
    "Opens a VS Code terminal where you can see output, interact if needed, and press Ctrl+C to stop immediately (recommended)",
    "Runs in background process without visible terminal"
  ],
  "default": "interactive",
  "markdownDescription": "**CLI Modes Only.** Where CLI commands execute.\n\n- **Interactive** (default): Opens a VS Code terminal for visibility and immediate abort via Ctrl+C\n- **Headless**: Runs silently in background process\n\n**Note:** Headless mode without full permissions will auto-deny tool prompts, preventing the agent from acting."
}
```

### Existing Settings Behavior

**Permission settings work identically in both modes.** The only difference is whether you can see/interact with the terminal.

| Setting                                   | Interactive Mode               | Headless Mode                            |
| ----------------------------------------- | ------------------------------ | ---------------------------------------- |
| `cliAllowedTools`                         | Used in custom mode only       | Used in custom mode only                 |
| `cliDeniedTools`                          | Used in allowAll/custom modes  | Used in allowAll/custom modes            |
| `cliToolPermissions: dangerouslyAllowAll` | No restrictions (ignores deny) | No restrictions (ignores deny)           |
| `cliToolPermissions: allowAll`            | Auto-grants all + deny list    | Auto-grants all + deny list              |
| `cliToolPermissions: custom`              | Uses allow/deny patterns       | ⚠️ Auto-denies prompts (agent can't act) |

**Note:** The `cliToolPermissions` setting is shared between Copilot CLI and Claude CLI. Implementation details:

- **Copilot**: `dangerouslyAllowAll` uses `--allow-all-tools` without deny patterns
- **Claude**: `dangerouslyAllowAll` uses `--dangerously-skip-permissions`

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

## File Structure

```
src/flightpath/
├── base/
│   └── CopilotIntegration.ts          # Abstract base class
├── cli/
│   ├── BaseCliIntegration.ts          # Terminal & headless execution support
│   ├── CopilotCommandLineIntegration.ts  # GitHub Copilot CLI
│   ├── ClaudeCommandLineIntegration.ts   # Claude Code CLI
│   ├── CodexCommandLineIntegration.ts    # OpenAI Codex CLI
│   └── shared/
│       ├── CliResponseParser.ts       # Multi-format response parsing
│       ├── CliToolPermissionMapper.ts # Cross-CLI tool mapping
│       ├── CliMcpConfigGenerator.ts   # MCP config generation
│       └── CliNotificationMonitor.ts  # Completion notification monitoring
└── chat/
    └── CopilotChatIntegration.ts      # Chat window automation

src/utils/
├── CliProcessManager.ts               # Process spawning & terminal management
├── TuiStreamProcessor.ts              # TUI output processing & completion detection
├── TempFileManager.ts                 # Temp file creation for prompts
└── ConfigurationUtils.ts              # Settings access
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
   - Headless mode without full permissions → warning shown
   - Headless mode with full permissions → runs in background

## Summary

FlightPath's CLI integrations support two execution modes:

| Mode          | Description                                      |
| ------------- | ------------------------------------------------ |
| `interactive` | Runs in VS Code terminal (visible, Ctrl+C works) |
| `headless`    | Runs in background process                       |

**Key insight: Execution mode and permission settings are orthogonal.**

- A user with `cliToolPermissions: allowAll` might still want `interactive` mode for visibility and immediate abort
- A user with custom permissions should use `interactive` mode (headless auto-denies prompts)

Permission flags (`--allow-all-tools`, `--allow-tool`, etc.) are applied identically in both modes - only the execution context differs.

## References

- [VS Code Terminal API](https://code.visualstudio.com/api/references/vscode-api#Terminal)
- [Shell Integration Documentation](https://code.visualstudio.com/docs/terminal/shell-integration)
- [TerminalShellIntegration API](https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration)
- [BaseCliIntegration.ts](../src/flightpath/cli/BaseCliIntegration.ts)
- [CliProcessManager.ts](../src/utils/CliProcessManager.ts)
- [TuiStreamProcessor.ts](../src/utils/TuiStreamProcessor.ts)
