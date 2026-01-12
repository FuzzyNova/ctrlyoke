# CLI Prompt Passing Architecture

## Implementation Status: ✅ COMPLETE

**Updated January 2026**

## Quick Reference

| CLI         | Headless Mode                          | Interactive Mode                    |
| ----------- | -------------------------------------- | ----------------------------------- |
| **Copilot** | spawn + temp file (`--prompt "@file"`) | TUI + `executeCommand` + `sendText` |
| **Claude**  | spawn + temp file (`"@file" -p`)       | TUI + `executeCommand` + `sendText` |
| **Codex**   | spawn + temp file (positional)         | TUI + `executeCommand` + `sendText` |

## Architecture

### Two Modes, Two Methods

| Mode            | Method                            | Output Streaming    | Completion Detection          |
| --------------- | --------------------------------- | ------------------- | ----------------------------- |
| **Headless**    | `spawn()` + temp file reference   | `child.stdout` pipe | Process exit                  |
| **Interactive** | `executeCommand()` + `sendText()` | `execution.read()`  | Escape indicator disappearing |

**Key Principle**: Each mode uses ONE method that works for **any prompt size**. Simple prompts (≤300 chars) can be passed directly; complex prompts use temp files.

## Headless Mode

Uses temp file references with Node.js `spawn()`:

```typescript
// Complex prompts: write to temp file
const tempFilePath = await tempMgr.createPromptFile(
  promptText,
  filePath,
  index
);
const fileReference = `@${relativeFilePath}`;
const headlessArgs = this.buildHeadlessArgs(
  baseArgs,
  `Follow instructions in ${fileReference} `
);

// Simple prompts (≤300 chars): pass directly
const headlessArgs = this.buildHeadlessArgsWithDirectPrompt(
  baseArgs,
  promptText
);

// Spawn process (no stdin needed)
const result = await this.processManager.spawn(cliName, headlessArgs, options);
```

**CLI-specific behavior:**

- **Copilot**: Uses `--prompt "@file"` or `--prompt "text"` flag
- **Claude**: Uses `"@file" -p` or `"text" -p` (prompt FIRST, then flags due to variadic args)
- **Codex**: Uses positional argument with custom file format (no `@` prefix support)

## Interactive Mode

Uses VS Code Shell Integration + sendText injection:

### Flow

1. **Start CLI via `executeCommand()`**: Gets execution object for `read()` streaming
2. **Wait for TUI ready**: Stream output via `execution.read()`, detect first complete screen
3. **Send file reference via `sendText()`**: Send `@path/to/file` as "keyboard input" (no length limit!)
4. **Wait for file echo**: Detect the file reference in terminal output
5. **Wait for silence**: After echo detected, wait for terminal output to settle
6. **Submit with Enter key (`\r`)**: In raw terminal mode, Enter = carriage return
7. **Detect completion**: Watch for escape indicator to disappear from output

### Key Implementation Details

**Race condition fix**: Originally used `executeCommand()` then immediately `sendText()`, but `executeCommand()` has internal queuing while `sendText()` is immediate. Solution: Wait for TUI output before sending prompt.

**File reference echo detection**: After sending `@path/to/file`, wait for the CLI to echo it back:

```typescript
const isFileReferenceEchoed = (): boolean => {
  const filePath = prompt.substring(atIndex + 1).trim();
  // Remove all whitespace for comparison (TUIs wrap paths)
  const filePathNoSpaces = filePath.toLowerCase().replace(/\s+/g, "");
  const bufferNoSpaces = fileEchoBuffer.toLowerCase().replace(/\s+/g, "");
  return bufferNoSpaces.includes(filePathNoSpaces);
};
```

**Silence-based submission**: Once the file reference is echoed, start a silence timer. Submit when no new output arrives for 1 second:

```typescript
const startSubmissionTimer = () => {
  clearTimeout(submissionTimeoutId);
  submissionTimeoutId = setTimeout(() => {
    if (promptTextSent && !promptSubmitted && fileEchoDetected) {
      terminal.sendText("\r", true); // Enter key to submit
      promptSubmitted = true;
    }
  }, fileSilenceMs); // Default: 1000ms
};
```

**Prompt submission**: Copilot/Claude CLIs use Ink TUI framework which operates in raw terminal mode. In raw mode, the Enter key sends `\r` (carriage return), not `\n` (newline).

**About multiline input**: The `/terminal-setup` command maps Shift+Enter and Ctrl+Enter to `\n` for inserting newlines without submitting. Regular Enter (which is `\r`) still submits the input. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264) for details on Ink's raw mode input handling.

**Case-insensitive matching**: All indicator detection uses `.toLowerCase()` to handle varying capitalization in TUI output.

### TUI Ready Detection

TUI readiness is detected when the first complete screen is parsed from the buffer. This happens when the CLI-specific screen end pattern first matches - indicating the TUI has fully rendered and is ready for input.

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
3. Track emitted lines in a Map (with occurrence counts)
4. Only emit lines not previously emitted
5. This prevents duplicate output as screens accumulate content

## Code Structure

### BaseCliIntegration.ts

**Key methods:**

| Method                            | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `executeInTerminal()`             | Entry point for interactive mode                           |
| `withInteractiveTuiExecution()`   | Sets up terminal, execution, temp file, and TUI processor  |
| `executeHeadlessWithPromptFile()` | Entry point for headless mode with temp file               |
| `spawnProcess()`                  | Spawns process with temp file reference                    |
| `spawnSimpleCommand()`            | For simple commands like `--version` checks                |
| `createPromptFileWithReference()` | Creates temp file and returns instructional prompt         |
| `isSimplePrompt()`                | Determines if prompt can be passed directly (no temp file) |

**Abstract methods (implemented by subclasses):**

| Method                                | Purpose                                         |
| ------------------------------------- | ----------------------------------------------- |
| `getCliName()`                        | Returns `"copilot"`, `"claude"`, or `"codex"`   |
| `getEscapeIndicator()`                | Returns the escape indicator pattern            |
| `getScreenEndPattern()`               | Returns regex for TUI screen boundary detection |
| `getTuiChromePatterns()`              | Returns array of TUI chrome patterns to filter  |
| `buildHeadlessArgs()`                 | Build args for headless mode (with file ref)    |
| `buildHeadlessArgsWithDirectPrompt()` | Build args for direct prompt (no temp file)     |
| `buildInteractiveTuiCommand()`        | Build command to start interactive TUI          |

### TuiStreamProcessor.ts (src/utils/)

Handles all TUI stream processing (extracted from BaseCliIntegration):

| Method                       | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `processStream()`            | Main entry: streams output, sends prompt, detects completion |
| `extractScreensFromBuffer()` | Parses buffer into complete screens by boundary pattern      |
| `extractNewContent()`        | Extracts meaningful new lines for dashboard (deduplicates)   |
| `isTuiChromeLine()`          | Tests if a line matches TUI chrome patterns                  |
| `stripAnsiCodes()`           | Removes ANSI escape codes from terminal output               |

### CopilotCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"Esc to cancel"`
- `getScreenEndPattern()` returns `/Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi`
- `buildHeadlessArgs()` uses `--prompt "@file"` flag
- `buildInteractiveTuiCommand()` returns `copilot [args]` (no prompt)

### ClaudeCommandLineIntegration.ts

- `getEscapeIndicator()` returns `"esc to interrupt"`
- `getScreenEndPattern()` returns `/─{20,}\r?\n>\s*/g` (dashes + prompt)
- `buildHeadlessArgs()` puts prompt FIRST as positional argument (before `-p` flag)
- `buildInteractiveTuiCommand()` returns `claude [args]` (filters out `-p` flag)

## Known Issues & Solutions

### Issue: executeCommand vs sendText Race Condition

**Problem**: `shellIntegration.executeCommand()` queues internally, while `terminal.sendText()` executes immediately. This caused prompts to appear before the CLI command.

**Solution**: Use `executeCommand()` for the CLI (to get execution object), then stream with `execution.read()` and wait for TUI ready indicators before calling `sendText()`.

### Issue: Multi-line Prompt Submission

**Problem**: CLI tools using Ink TUI framework operate in raw terminal mode. In raw mode, Enter sends `\r` (carriage return), not `\n` (newline).

**Solution**: Send file reference, wait for echo detection + silence period, then send carriage return to submit:

```typescript
terminal.sendText(promptFileRef, false); // Send file reference without trailing newline
// Wait for file echo detection + 1 second of terminal silence
terminal.sendText("\r", true); // Enter key in raw mode = carriage return to submit
```

**Note**: The `/terminal-setup` command maps Shift+Enter to `\n` for inserting newlines. Regular Enter (`\r`) submits. See [Ghostty issue #9264](https://github.com/ghostty-org/ghostty/discussions/9264).

### Issue: File Reference Detection with Line Wrapping (FIXED)

**Problem**: Terminal output wraps long file paths, inserting whitespace where there shouldn't be any. A path like `path/to/long/file.txt` might appear as `path/to/long/file.   \n  txt`.

**Solution**: Strip ALL whitespace when comparing file references:

```typescript
const filePathNoSpaces = filePath.toLowerCase().replace(/\s+/g, "");
const bufferNoSpaces = fileEchoBuffer.toLowerCase().replace(/\s+/g, "");
if (bufferNoSpaces.includes(filePathNoSpaces)) {
  fileEchoDetected = true;
  startSubmissionTimer();
}
```

This handles any line-wrapping behavior while still reliably detecting when the CLI has acknowledged the file reference.

### Issue: Case-sensitive Indicator Matching

**Problem**: TUI output has varying capitalization (`"Esc to cancel"` vs `"esc to cancel"`).

**Solution**: Normalize all comparisons to lowercase:

```typescript
const escapeIndicator = this.getEscapeIndicator().toLowerCase();
const screenLower = screen.toLowerCase();
const indicatorVisible = screenLower.includes(escapeIndicator);
```

## Simple vs Complex Prompts

The implementation distinguishes between simple and complex prompts:

**Simple prompts** (passed directly, no temp file overhead):

- ≤300 characters
- No `<criticalInstruction>` XML tags (dynamic queue)
- No backticks (which could cause shell issues)

**Complex prompts** (use temp file):

- Long prompts with file attachments
- Prompts with dynamic queue instructions
- Multi-line structured prompts

```typescript
protected isSimplePrompt(finalPromptText: string): boolean {
  const MAX_SIMPLE_PROMPT_LENGTH = 300;
  if (finalPromptText.length > MAX_SIMPLE_PROMPT_LENGTH) return false;
  if (finalPromptText.includes("<criticalInstruction>")) return false;
  if (finalPromptText.includes("`")) return false;
  return true;
}
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
