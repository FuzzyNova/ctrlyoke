# Stdin-Based Prompt Passing Plan

## Quick Reference

| CLI         | Headless Mode                 | Interactive Mode             |
| ----------- | ----------------------------- | ---------------------------- |
| **Copilot** | spawn + stdin (no `-p`)       | TUI + `sendText()` injection |
| **Claude**  | spawn + stdin (requires `-p`) | TUI + `sendText()` injection |

## Recommended Architecture

### Two Modes, Two Methods (No Size Splitting)

| Mode            | Method             | Output Streaming                 | Completion Detection   |
| --------------- | ------------------ | -------------------------------- | ---------------------- |
| **Headless**    | spawn + stdin      | `child.stdout`                   | Process exit           |
| **Interactive** | TUI + `sendText()` | Logs or `onDidWriteTerminalData` | Log patterns / silence |

**Key Principle**: Each mode uses ONE method that works for **any prompt size**. No conditional logic based on prompt length.

### Key Insight: TUI Input Injection

Instead of passing prompts on the command line or via stdin pipe, **start the CLI in interactive TUI mode and inject prompts as "keyboard input"**:

```typescript
// Start CLI in interactive mode (gets real TTY)
terminal.sendText("copilot");

// Wait for TUI ready...

// Send prompt of ANY length as "keystrokes"
terminal.sendText(veryLongPrompt); // No limit!
```

**Why this works**:

- `terminal.sendText()` sends text as keyboard input, not command-line args
- No 32KB Windows command-line limit
- TUI runs normally with all features (permissions, context, etc.)
- Same terminal can be reused for entire multi-step workflow

## Overview

This document outlines the plan to migrate FlightPath's CLI integrations from temp-file-based prompt passing to stdin-based prompt passing. This approach eliminates Windows command-line length limits and simplifies the architecture.

## Current State

### How Prompts Are Currently Passed

1. **Temp File Approach** (current implementation):
   - Write prompt to temp file
   - Build shell command that reads file: `copilot -p (Get-Content -Raw "tempfile.txt")`
   - Execute via VS Code terminal or spawn
   - **Problem**: PowerShell expands the file content into the command line, hitting Windows limits for large prompts (32KB+)

2. **Windows Command-Line Limits**:
   - CreateProcess API limit: ~32,768 characters
   - Practical limit often lower due to environment variables
   - Prompts with context injection easily exceed 40KB+

## Proposed Solution: Stdin-Based Prompt Passing

### Key Findings from Prototyping (December 2025)

| Scenario                            | Works? | Notes                                          |
| ----------------------------------- | ------ | ---------------------------------------------- |
| Headless spawn + stdin (no -p flag) | ✅     | Copilot reads from stdin when not a TTY        |
| Headless spawn + stdin for Claude   | ✅     | Claude supports `echo "prompt" \| claude -p -` |
| PowerShell window + pipe            | ✅     | `echo "prompt" \| copilot` works perfectly!    |
| VS Code terminal + pipe             | ❌     | Launches interactive TUI, ignores stdin        |
| Large prompts (50KB+) via stdin     | ✅     | Verified with headless spawn                   |

### The VS Code Terminal Mystery

**Critical Discovery**: `echo "just say test" | copilot` works in:

- ✅ Native PowerShell window
- ✅ Native pwsh window outside VS Code
- ❌ VS Code integrated terminal (launches interactive TUI instead)

**Hypothesis**: VS Code's integrated terminal may be:

1. Setting different TTY/pty flags that Copilot detects
2. Handling stdin differently through its terminal emulator
3. Using a pseudo-TTY that makes stdin appear as keyboard input

**Investigation Needed**:

- Check `$Host.UI.RawUI` differences between native PS and VS Code
- Check if VS Code terminal sets `TERM` or other env vars differently
- Look at Copilot CLI source to see how it detects TTY vs pipe
- Test with `[Console]::IsInputRedirected` in both environments

### Claude CLI Stdin Issue

**Error when piping to Claude without `-p` flag:**

```
ERROR  Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.
       Read about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported
```

**Root Cause**: Claude CLI uses [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) for its interactive TUI. Ink requires `setRawMode()` on stdin for keyboard input handling. When stdin is piped (not a TTY), raw mode is not supported.

**Key Ink Documentation**:

> `isRawModeSupported`: A boolean flag determining if the current `stdin` supports `setRawMode`. A component using `setRawMode` might want to use `isRawModeSupported` to nicely fall back in environments where raw mode is not supported.

**Why Claude `-p` (print mode) works with pipes**: The `-p` flag tells Claude to run in "print mode" (headless), which bypasses the Ink TUI entirely. That's why `echo "test" | claude -p` works.

**Implications for FlightPath**:

- Claude CLI REQUIRES `-p` flag when using stdin for prompts
- There's no way to get interactive Claude CLI with piped stdin (Ink limitation)
- This is different from Copilot, which can detect stdin and run non-interactively

**Claude CLI Stdin Options**:
| Command | Works? | Mode |
|---------|--------|------|
| `echo "prompt" \| claude -p` | ✅ | Headless (print mode) |
| `echo "prompt" \| claude -p -` | ✅ | Headless, explicit stdin |
| `echo "prompt" \| claude` | ❌ | Ink raw mode error |
| `claude` (no pipe) | ✅ | Interactive TUI |

## Implementation Plan

### Phase 1: Headless Mode (High Priority)

Update `BaseCliIntegration.ts` to use stdin for headless spawn:

```typescript
// Current approach (temp file with shell expansion)
const child = spawn(command, argsWithFileRead, { shell: true });

// New approach (stdin)
const child = spawn("node", [copilotEntryPath, ...args], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: workspaceRoot,
});
child.stdin.write(prompt);
child.stdin.end();
```

**Benefits**:

- No temp file management
- No shell escaping issues
- Works for any prompt size
- Simpler code

**Changes Required**:

1. `CopilotCommandLineIntegration.ts`:
   - Remove `buildPromptCommand()` temp file logic for headless
   - Add direct node spawn with stdin
   - Remove `-p` flag for stdin mode (Copilot reads stdin automatically in non-TTY)

2. `ClaudeCommandLineIntegration.ts`:
   - **MUST keep `-p` flag** for stdin mode (Claude's Ink TUI crashes without it)
   - The `-p` means "print mode" (headless), not "prompt from stdin"
   - Pipe stdin content to `claude -p` command

3. `BaseCliIntegration.ts`:
   - Update `spawnProcess()` to accept optional stdin content
   - Remove temp file cleanup for headless mode

### Phase 2: Interactive Terminal Mode - TUI Input Injection

**New Approach**: Instead of piping prompts upfront, start the TUI first and inject prompts as keyboard input!

**Flow**:

1. Open VS Code terminal
2. Run `copilot` or `claude` (no flags, starts interactive TUI)
3. Wait for TUI to be ready (detect prompt indicator like `>` or similar)
4. Send prompt text via `terminal.sendText(prompt)`
5. Detect when CLI finishes responding (output patterns, silence detection)
6. Send next prompt OR send exit command (`/exit`, Ctrl+C, etc.)

**Benefits**:

- ✅ No command-line length limits (prompt sent as "keystrokes")
- ✅ Works in VS Code terminal (TUI gets proper TTY)
- ✅ Supports session continuity (multi-turn without `--resume`)
- ✅ User can interact with permission prompts (Y/n)
- ✅ No temp files, no shell escaping
- ✅ Same terminal can be reused for entire workflow

**Implementation**:

```typescript
// 1. Create/get terminal
const terminal = vscode.window.createTerminal("FlightPath: copilot");
terminal.show();

// 2. Start CLI in interactive mode
terminal.sendText("copilot --model claude-sonnet-4.5");

// 3. Wait for ready (TUI shows prompt indicator)
// Could use shell integration or output pattern detection

// 4. Send prompt as "keyboard input"
terminal.sendText(longPrompt); // No length limit!

// 5. Detect completion via output patterns or shell integration

// 6. Send next prompt or exit
terminal.sendText("/exit");
```

**Challenges to Solve**:

1. **Ready detection**: How to know when TUI is ready for input
   - Option A: Fixed delay (fragile)
   - Option B: Shell integration events
   - Option C: Output pattern matching (look for `>` or prompt indicator)

2. **Completion detection**: How to know when response is done
   - **Option A (RECOMMENDED)**: Watch for `(esc to cancel)` indicator disappearing
     - While Copilot is generating, `(esc to cancel)` is always visible in terminal
     - When response completes, this indicator disappears
     - Most reliable: direct UI state, not timing-based
   - Option B: Pattern matching for statistics line or prompt return
   - Option C: Output silence detection (no new output for X seconds) - fragile fallback
   - Option D: Shell integration `onDidEndTerminalShellExecution` (if TUI supports it)

3. **Multi-line prompts**: `terminal.sendText()` sends Enter at end
   - May need to escape newlines or send line-by-line
   - Or use a single-line JSON-encoded prompt

4. **Exit handling**: Clean session termination
   - Copilot: `/exit` command or Ctrl+C
   - Claude: `/exit` or Ctrl+C

**VS Code Terminal APIs Available**:

```typescript
// 1. SHELL INTEGRATION - for starting the CLI
terminal.shellIntegration?.executeCommand(commandLine)  // Start CLI command
window.onDidChangeTerminalShellIntegration(event)       // Shell ready detection

// 2. TEXT SENDING - for TUI prompt injection
terminal.sendText(text, addNewLine?: boolean)           // Send as keystrokes (ANY length!)

// 3. OUTPUT STREAMING - for completion detection
onDidWriteTerminalData                                  // Stream ANY terminal output (proposed API)
// OR: Log file watching via --log-dir                  // Copilot writes logs we can tail
```

### Output Streaming & Completion Detection

| Mode            | Output Streaming                 | Completion Detection   |
| --------------- | -------------------------------- | ---------------------- |
| **Headless**    | `child.stdout` pipe ✅           | Process exit ✅        |
| **Interactive** | `onDidWriteTerminalData` or logs | Log patterns / silence |

**For Interactive Mode**:

- **Primary**: `onDidWriteTerminalData` (proposed API) - streams ALL terminal output
- **Fallback**: Log file watching (Copilot: `--log-dir`, already have config)
- **Last resort**: Silence detection (no output for X seconds)

**Unified Execution Strategy**:

```typescript
async function executePrompt(prompt: string) {
  const mode = this.getExecutionMode(); // 'interactive' | 'headless'

  if (mode === "headless") {
    // Headless: spawn + stdin (works for ANY prompt size)
    return this.executeHeadlessWithStdin(prompt);
  } else {
    // Interactive: TUI + sendText (works for ANY prompt size)
    return this.executeWithTuiInjection(prompt);
  }
}
```

No prompt size checks. No conditional paths. Just two clean methods.

### Phase 3: Unified Architecture

After implementing both modes, the architecture becomes:

```
┌─────────────────────────────────────────────────────────────┐
│                    FlightPath Prompt Flow                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  HEADLESS MODE (background, no UI):                         │
│  ─────────────────────────────────────                       │
│  Prompt ──► spawn(cli) ──► stdin.write(prompt) ──► stdout   │
│                                                              │
│  INTERACTIVE MODE (visible, permissions OK):                 │
│  ────────────────────────────────────────────                │
│  Prompt ──► terminal.sendText(cli) ──► wait ready           │
│         ──► terminal.sendText(prompt) ──► detect complete   │
│                                                              │
│  Both modes: No temp files, no escaping, no length limits   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Changes Summary

| File                               | Headless Changes       | Interactive Changes          |
| ---------------------------------- | ---------------------- | ---------------------------- |
| `BaseCliIntegration.ts`            | Add `spawnWithStdin()` | Add `sendPromptToTui()`      |
| `CopilotCommandLineIntegration.ts` | Remove `-p` flag       | Reuse terminal, detect ready |
| `ClaudeCommandLineIntegration.ts`  | Keep `-p` flag         | Reuse terminal, detect ready |

**Code to Remove**:

- `writePromptToTempFile()` - No longer needed
- `cleanupTempPromptFile()` - No longer needed
- `buildPromptCommand()` - Simplified to just args
- Shell escaping logic - Not needed with stdin/sendText

**Code to Add**:

- `spawnWithStdin(args, prompt)` - For headless mode
- `sendPromptToTui(prompt)` - For interactive mode
- `waitForTuiReady()` - Detect CLI ready for input
- `detectCompletion()` - Detect response finished (logs or silence)

## Permission Handling

### Current Behavior

| Mode        | Without --allow-all-tools | With --allow-all-tools |
| ----------- | ------------------------- | ---------------------- |
| Headless    | Auto-denies permissions   | ✅ All tools allowed   |
| Interactive | User prompted (Y/n)       | ✅ All tools allowed   |

### Implications

- **Headless mode**: Must use `--allow-all-tools` for automation (no way to prompt user)
- **Interactive mode**: Can still prompt user for permissions
- **Future**: Could add dashboard-based permission UI if needed

## File Changes Summary

### Files to Modify

1. **`src/flightpath/cli/BaseCliIntegration.ts`**
   - Add `spawnWithStdin()` method
   - Update `executeHeadlessBase()` to use stdin
   - Optionally keep temp file fallback for VS Code terminal

2. **`src/flightpath/cli/CopilotCommandLineIntegration.ts`**
   - Remove `-p` flag for stdin mode
   - Direct node spawn with Copilot entry point path
   - Update args building

3. **`src/flightpath/cli/ClaudeCommandLineIntegration.ts`**
   - Use `-p -` flag for stdin mode
   - Similar spawn changes

4. **`src/utils/ConfigurationUtils.ts`** (optional)
   - Add setting for stdin vs temp file mode (for debugging)

### Files to Remove/Simplify

- Temp file creation/cleanup logic in `BaseCliIntegration.ts`
- Shell escaping utilities (if any)

## Testing Plan

1. **Unit Tests**:
   - Test stdin prompt passing with various sizes
   - Test special characters in prompts
   - Test Unicode/emoji handling

2. **Integration Tests**:
   - Small prompt (<1KB)
   - Medium prompt (~10KB)
   - Large prompt (~50KB)
   - Very large prompt (~100KB)

3. **Manual Tests**:
   - VS Code terminal behavior investigation
   - Native PowerShell comparison
   - Cross-platform (if applicable)

## Prototype Scripts

The following prototype scripts were created during investigation:

| Script                                 | Purpose                            |
| -------------------------------------- | ---------------------------------- |
| `scripts/test-stdin-interaction.mjs`   | Basic stdin test                   |
| `scripts/test-direct-node.mjs`         | Direct node spawn (proven working) |
| `scripts/test-final-prototype.mjs`     | Full demo with streaming           |
| `scripts/test-permission-headless.mjs` | Permission behavior testing        |

These can be deleted after implementation is complete.

## Open Questions

1. **Interactive output streaming**
   - `onDidWriteTerminalData` is proposed API only
   - Fallback: Copilot log file watching (already have `--log-dir` config)
   - Alternative: Silence detection (no output for X seconds)

2. **TUI ready detection**
   - How to know when CLI is ready for input after launch?
   - Options: Fixed delay, output pattern matching, shell integration events

3. **Multi-line prompt handling with sendText()**
   - `terminal.sendText()` adds Enter at end by default
   - May need `sendText(prompt, false)` to avoid premature submission
   - Test with multi-paragraph prompts

4. **Cross-platform considerations?**
   - Linux/Mac may behave differently
   - Need to test on other platforms

## Timeline

- **Phase 1 (Headless stdin)**: Ready to implement now - PROVEN WORKING
- **Phase 2 (Interactive TUI injection)**: Implement after Phase 1
- **Phase 3 (Polish)**: Output streaming, completion detection refinement

## References

- Windows CreateProcess limits: https://devblogs.microsoft.com/oldnewthing/20031210-00/?p=41553
- VS Code Terminal API: https://code.visualstudio.com/api/references/vscode-api#Terminal
- Node.js child_process: https://nodejs.org/api/child_process.html
- Claude Ink TUI: https://github.com/vadimdemedes/ink
