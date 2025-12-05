# CLI Prompt Passing Architecture

## Implementation Status: ✅ COMPLETE

**Implemented December 2025**

## Quick Reference

| CLI         | Headless Mode                 | Interactive Mode                    |
| ----------- | ----------------------------- | ----------------------------------- |
| **Copilot** | spawn + stdin (no `-p`)       | TUI + `executeCommand` + `sendText` |
| **Claude**  | spawn + stdin (requires `-p`) | TUI + `executeCommand` + `sendText` |

## Architecture

### Two Modes, Two Methods

| Mode            | Method                            | Output Streaming    | Completion Detection          |
| --------------- | --------------------------------- | ------------------- | ----------------------------- |
| **Headless**    | `spawn()` + `stdin.write()`       | `child.stdout` pipe | Process exit                  |
| **Interactive** | `executeCommand()` + `sendText()` | `execution.read()`  | Escape indicator disappearing |

**Key Principle**: Each mode uses ONE method that works for **any prompt size**. No conditional logic based on prompt length.

## Headless Mode

Uses Node.js `spawn()` with stdin pipe:

```typescript
const child = spawn(cliName, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false, // No shell escaping issues
});
child.stdin.write(promptText);
child.stdin.end();
```

**CLI-specific behavior:**

- **Copilot**: No `-p` flag needed - reads from stdin automatically when not a TTY
- **Claude**: REQUIRES `-p` flag (Ink TUI crashes without it due to `setRawMode()` requirement)

## Interactive Mode

Uses VS Code Shell Integration + sendText injection:

### Flow

1. **Start CLI via `executeCommand()`**: Gets execution object for `read()` streaming
2. **Wait for TUI ready**: Stream output via `execution.read()`, detect ready indicators
3. **Send prompt via `sendText()`**: Inject prompt as "keyboard input" (no length limit!)
4. **Submit with Enter key (`\r`)**: In raw terminal mode, Enter = carriage return
5. **Detect completion**: Watch for escape indicator to disappear from output

### Key Implementation Details

**Race condition fix**: Originally used `executeCommand()` then immediately `sendText()`, but `executeCommand()` has internal queuing while `sendText()` is immediate. Solution: Wait for TUI output before sending prompt.

**Prompt submission**: Copilot CLI uses the Ink TUI framework which operates in raw terminal mode. In raw mode, the Enter key sends `\r` (carriage return), not `\n` (newline):

```typescript
terminal.sendText(promptText, false); // Send text WITHOUT newline
terminal.sendText("\r"); // Enter key (carriage return) to submit
```

**About multiline input**: The `/terminal-setup` command maps Shift+Enter and Ctrl+Enter to `\n` for inserting newlines without submitting. Regular Enter (which is `\r`) still submits the input. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264) for details on Ink's raw mode input handling.

**Case-insensitive matching**: All indicator detection uses `.toLowerCase()` to handle varying capitalization in TUI output.

### TUI Ready Detection

TUI readiness is detected when the first complete screen is parsed from the buffer. This happens when the CLI-specific screen end pattern (see below) first matches - indicating the TUI has fully rendered and is ready for input.

No separate "ready indicators" are needed - if `extractScreensFromBuffer()` returns a complete screen, the TUI is ready.

### Screen Buffer Parsing

TUI apps redraw the entire screen each frame. However, `execution.read()` returns **chunks of arbitrary size** that don't align with screen boundaries. A single chunk might contain 0-3 complete screens plus a partial screen.

**Screen boundary detection**: Each CLI has its own screen end pattern (implemented via `getScreenEndPattern()`):

- **Copilot**: `Ctrl+c Exit · Ctrl+r Expand recent` (status bar at bottom)
- **Claude**: Line of `─` characters followed by `> ` prompt

**Buffer accumulation algorithm**:

1. Accumulate raw chunks into a buffer
2. Use `extractScreensFromBuffer()` to find complete screens (delimited by status bar)
3. Keep the remainder (partial screen) in buffer for next chunk
4. Process each complete screen for indicator detection and content extraction

### Completion Detection

We check **each complete screen** for the escape indicator:

- **Copilot**: `"Esc to cancel"` (appears during generation)
- **Claude**: `"esc to interrupt"` (appears during generation)

**Three-phase detection logic**:

1. **Wait for indicator to appear**: After sending prompt, the CLI starts processing and shows the indicator (e.g., "∙ Thinking (Esc to cancel)")
2. **Track indicator presence**: Set `indicatorEverSeen = true` when first detected
3. **Count consecutive absences**: Only after indicator has been seen, count screens without it. Require 2+ consecutive screens without indicator to confirm completion.

**Why this matters**: Initial loading screens (welcome box, status bar) don't have the indicator. Without tracking `indicatorEverSeen`, we'd falsely detect completion before the CLI even started processing.

This avoids false positives from:

- Partial screen updates
- Brief indicator disappearance between redraws
- End-of-stream coinciding with indicator still visible

### TUI Output Diffing

To avoid spamming the dashboard with repeated TUI redraws, we track emitted content and extract only the **delta** (new content):

1. Split screen into lines
2. Filter out TUI chrome (borders, prompts, status bars, spinner characters)
3. Track emitted lines in a Set
4. Only emit lines not previously emitted
5. This prevents duplicate output as screens accumulate content

## Code Structure

### BaseCliIntegration.ts

**Key methods:**

| Method                       | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `executeInTerminal()`        | Entry point for interactive mode                                    |
| `waitForTuiAndExecute()`     | Streams output, detects TUI ready, sends prompt, detects completion |
| `extractScreensFromBuffer()` | Parses buffer into complete screens by boundary pattern             |
| `extractNewContent()`        | Extracts meaningful new lines for dashboard (deduplicates)          |
| `isTuiChromeLine()`          | Filters out TUI borders, prompts, status bars                       |
| `executeHeadlessWithStdin()` | Entry point for headless mode                                       |
| `spawnWithStdin()`           | Spawns process with stdin pipe                                      |
| `spawnSimpleCommand()`       | For simple commands like `--version` checks                         |

**Abstract methods (implemented by subclasses):**

| Method                         | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `getCliName()`                 | Returns `"copilot"` or `"claude"`               |
| `getEscapeIndicator()`         | Returns the escape indicator pattern            |
| `getScreenEndPattern()`        | Returns regex for TUI screen boundary detection |
| `buildHeadlessArgs()`          | Build args for headless mode (stdin)            |
| `buildInteractiveTuiCommand()` | Build command to start interactive TUI          |

### CopilotCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"Esc to cancel"`
- `getScreenEndPattern()` returns `/Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi`
- `buildHeadlessArgs()` - NO `-p` flag (Copilot reads stdin in non-TTY)
- `buildInteractiveTuiCommand()` - Returns `copilot [args]` (no prompt)

### ClaudeCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"esc to interrupt"`
- `getScreenEndPattern()` returns `/─{20,}\r?\n>\s*/g` (dashes + prompt)
- `buildHeadlessArgs()` - REQUIRES `-p` flag (Ink TUI crashes without it)
- `buildInteractiveTuiCommand()` - Returns `claude [args]` (no prompt)

## Known Issues & Solutions

### Issue: executeCommand vs sendText Race Condition

**Problem**: `shellIntegration.executeCommand()` queues internally, while `terminal.sendText()` executes immediately. This caused prompts to appear before the CLI command.

**Solution**: Use `executeCommand()` for the CLI (to get execution object), then stream with `execution.read()` and wait for TUI ready indicators before calling `sendText()`.

### Issue: Multi-line Prompt Submission

**Problem**: Copilot CLI uses Ink TUI framework which operates in raw terminal mode. In raw mode, Enter sends `\r` (carriage return), not `\n` (newline).

**Solution**: Send prompt text, then send carriage return to submit:

```typescript
terminal.sendText(promptText, false); // Send without trailing newline
await this.delay(1000); // Allow TUI to process input
terminal.sendText("\r"); // Enter key in raw mode = carriage return
```

**Note**: The `/terminal-setup` command maps Shift+Enter to `\n` for inserting newlines. Regular Enter (`\r`) submits. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264).

### Issue: Case-sensitive Indicator Matching

**Problem**: TUI output has varying capitalization (`"Esc to cancel"` vs `"esc to cancel"`).

**Solution**: Normalize all comparisons to lowercase:

```typescript
const escapeIndicator = this.getEscapeIndicator().toLowerCase();
const recentOutputLower = recentOutput.toLowerCase();
const indicatorVisible = recentOutputLower.includes(escapeIndicator);
```

## Permission Handling

| Mode        | Without --allow-all-tools | With --allow-all-tools |
| ----------- | ------------------------- | ---------------------- |
| Headless    | Auto-denies permissions   | ✅ All tools allowed   |
| Interactive | User can respond (Y/n)    | ✅ All tools allowed   |

## Future Improvements

1. **Session continuity**: Reuse terminal for multi-step workflows without `--resume`
2. **Streaming to dashboard**: Currently streams to Output panel, could enhance dashboard display
3. **Timeout configuration**: Make TUI ready/completion timeouts configurable

## References

- VS Code Terminal API: https://code.visualstudio.com/api/references/vscode-api#Terminal
- VS Code Shell Integration: https://code.visualstudio.com/api/references/vscode-api#TerminalShellIntegration
- Node.js child_process: https://nodejs.org/api/child_process.html
