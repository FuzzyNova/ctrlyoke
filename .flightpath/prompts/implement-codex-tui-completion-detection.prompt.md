# Implement Codex CLI Time-Based TUI Completion Detection

## Overview

Implement the time-based TUI completion detection system for Codex CLI, which uses cursor-based rendering fundamentally different from Claude/Copilot's line-based output. This requires two key changes:

1. **Time-Based Text Extraction** - Skip screen parsing, emit chunks with deduplication
2. **Log File Completion Detection** - Monitor `~/.codex/log/codex-tui.log` for definitive completion indicators

**Context:** See #file:CODEX_CLI_INTEGRATION.md lines 1030-1356 for complete research findings and implementation plan.

## Critical Discovery (Dec 18, 2025)

Codex TUI uses **cursor-based rendering** with ANSI positioning codes (`\x1b[<line>;<col>H`), fundamentally different from Claude/Copilot's line-based output that appends new lines sequentially.

**Key Symptoms:**

- 73-second delay before first post-submission data chunk
- Massive chunks (414KB+) in single burst instead of incremental updates
- False "screens" - pattern matching finds 37+ tiny "screens" in animation frames
- Output dominated by `• Working (Xs)` repetitions, not actual response text
- Terminal updates cursor position and redraws in-place (no natural screen boundaries)

**Why Screen-Based Parsing Fails:**

- Claude/Copilot: Append new lines → Natural screen boundaries via prompt indicators
- Codex: Update cursor position → Overwrites same area, no natural boundaries
- Pattern matching issue: `›` and `% context left` appear throughout animation, not just at boundaries

## Implementation Requirements

### Phase 1: Refactor TuiStreamProcessor for Mode-Based Processing

**File:** `src/utils/TuiStreamProcessor.ts`

**Changes Required:**

1. **Add configuration flag to `TuiStreamConfig` interface:**

```typescript
export interface TuiStreamConfig {
  // Processing mode (NEW)
  useTimeBasedExtraction?: boolean; // Default: false (screen-based mode)

  // CLI-specific patterns (used in screen-based mode)
  escapeIndicator: string;
  screenEndPattern: RegExp;
  tuiChromePattern: RegExp;

  // Event emitters for communication
  streamingEmitter: vscode.EventEmitter<string>;
  responseCompleteEmitter: vscode.EventEmitter<string>;

  // Optional configuration
  fileSilenceMs?: number;
  maxConsecutiveBlankLines?: number;
}
```

2. **Add private field for deduplication buffer:**

```typescript
export class TuiStreamProcessor {
  private fileSilenceMs: number;
  private maxConsecutiveBlankLines: number;
  private recentLinesBuffer: Set<string> = new Set(); // NEW: For time-based deduplication

  constructor(private config: TuiStreamConfig) {
    this.fileSilenceMs = config.fileSilenceMs || DEFAULT_FILE_SILENCE_MS;
    this.maxConsecutiveBlankLines =
      config.maxConsecutiveBlankLines || DEFAULT_MAX_BLANK_LINES;
  }
  // ...
}
```

3. **Add mode-based routing in `processStream()` method:**

Find the main data processing loop inside `processStream()` (around line 165, inside the `for await (const data of execution.read())` loop) and add routing logic:

```typescript
// Inside the for await loop, after receiving each data chunk:
for await (const data of execution.read()) {
  // Add routing based on processing mode
  if (this.config.useTimeBasedExtraction) {
    // Time-based extraction path (for Codex)
    await this.processTimeBasedChunk(
      data /* ... pass necessary state vars ... */
    );
  } else {
    // Screen-based extraction path (existing logic for Claude/Copilot)
    await this.processScreenBasedChunk(
      data /* ... pass necessary state vars ... */
    );
  }

  // Continue with timeout checks, completion detection, etc.
}
```

**Important:** The existing logic in `processStream()` should be refactored to call either `processTimeBasedChunk()` or `processScreenBasedChunk()` based on the config flag. The screen-based logic currently in `processStream()` should be extracted into `processScreenBasedChunk()`.

4. **Implement `processTimeBasedChunk()` method:**

```typescript
/**
 * Process TUI chunk using time-based extraction (for Codex).
 *
 * Strategy:
 * - Strip ANSI codes
 * - Filter TUI chrome using existing patterns
 * - Deduplicate content (avoid repeated animation frames)
 * - Emit deltas
 *
 * This approach works with cursor-based rendering where chunks
 * arrive in large bursts after delays, rather than incrementally.
 */
private async processTimeBasedChunk(
  data: string,
  screenBuffer: string,
  emittedContent: Map<string, number>,
  // Add other necessary state parameters from processStream()
): Promise<void> {
  // Phase 1: Strip ANSI codes
  const cleaned = this.stripAnsiCodes(data);

  // Phase 2: Filter TUI chrome
  const filtered = this.filterTuiChromeFromChunk(cleaned);

  // Phase 3: Deduplicate content
  const newContent = this.deduplicateContent(filtered);

  // Phase 4: Emit deltas
  if (newContent.trim()) {
    this.config.streamingEmitter.fire(newContent);

    // Track emitted content (for consistency with screen-based approach)
    const lines = newContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        emittedContent.set(trimmed, (emittedContent.get(trimmed) || 0) + 1);
      }
    }
  }
}
```

5. **Implement `filterTuiChromeFromChunk()` helper:**

```typescript
/**
 * Filter TUI chrome from a chunk of text.
 * Uses existing isTuiChromeLine() method for pattern detection.
 */
private filterTuiChromeFromChunk(text: string): string {
  const lines = text.split(/\r?\n/);
  const filteredLines: string[] = [];

  for (const line of lines) {
    // Use existing isTuiChromeLine() method
    if (!this.isTuiChromeLine(line)) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join("\n");
}
```

6. **Implement `deduplicateContent()` method:**

```typescript
/**
 * Deduplicate content using circular buffer tracking.
 *
 * Strategy:
 * - Track last 100 unique lines in recentLinesBuffer
 * - Only emit lines not in recent history
 * - Maintain buffer size limit (remove oldest when > 100)
 *
 * This filters repeated animation frames while preserving
 * actual response text.
 */
private deduplicateContent(text: string): string {
  const lines = text.split(/\r?\n/);
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Keep empty lines for formatting
      newLines.push(line);
      continue;
    }

    // Check if line already seen in recent history
    if (!this.recentLinesBuffer.has(trimmed)) {
      newLines.push(line);
      this.recentLinesBuffer.add(trimmed);

      // Keep buffer size limited (last 100 lines)
      if (this.recentLinesBuffer.size > 100) {
        // Remove oldest line (first in set)
        const firstLine = this.recentLinesBuffer.values().next().value;
        this.recentLinesBuffer.delete(firstLine);
      }
    }
  }

  return newLines.join("\n");
}
```

7. **Extract existing screen-based logic into `processScreenBasedChunk()`:**

Move the current screen buffer processing logic (that's directly in `processStream()`) into a dedicated method:

```typescript
/**
 * Process TUI chunk using screen-based extraction (for Claude/Copilot).
 *
 * This is the existing approach that works for line-based TUI output.
 */
private async processScreenBasedChunk(
  data: string,
  screenBuffer: string,
  emittedContent: Map<string, number>,
  promptToFilter?: string,
  // Add other necessary state parameters
): Promise<void> {
  // Keep existing extractScreensFromBuffer() logic
  screenBuffer += data;
  const { screens, remainder } = this.extractScreensFromBuffer(screenBuffer);
  screenBuffer = remainder;

  for (const screen of screens) {
    const content = this.extractNewContent(screen, emittedContent, promptToFilter);
    if (content) {
      this.config.streamingEmitter.fire(content);
    }
  }
}
```

8. **Update `isTuiChromeLine()` with Codex-specific patterns:**

Add Codex patterns to the existing method (around line 609):

```typescript
isTuiChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Codex-specific patterns
  if (/^[╭╰]─+[╮╯]$/.test(trimmed)) return true; // Box borders
  if (/^>\s+OpenAI Codex/i.test(trimmed)) return true; // Header
  if (/^•\s+Working\s+\(/i.test(trimmed)) return true; // Working indicator
  if (/\d+%\s+context\s+left/i.test(trimmed)) return true; // Context status
  if (/^Tip:/i.test(trimmed)) return true; // Tips

  // Existing patterns for Claude/Copilot...
  // (keep all existing patterns)
}
```

### Phase 2: Implement Log File Completion Detection

**File:** `src/flightpath/cli/CodexCommandLineIntegration.ts`

**Changes Required:**

1. **Add private field for log file path:**

```typescript
export class CodexCommandLineIntegration extends BaseCliIntegration {
  private cliVersion?: string;
  private streamBuffer: string = "";
  private accumulatedResponse: string = "";
  private logFilePath?: string; // NEW

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.initialize();
  }
  // ...
}
```

2. **Implement `getCodexLogPath()` helper:**

```typescript
/**
 * Get path to Codex TUI log file.
 *
 * Log file location:
 * - Windows: %USERPROFILE%\.codex\log\codex-tui.log
 * - macOS/Linux: ~/.codex/log/codex-tui.log
 */
private getCodexLogPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error("Cannot determine home directory for Codex log path");
  }

  const path = require("path");
  return path.join(home, ".codex", "log", "codex-tui.log");
}
```

3. **Implement `monitorLogFileForCompletion()` method:**

```typescript
/**
 * Monitor Codex log file for completion indicators.
 *
 * Completion Indicators:
 * - Success: "INFO run_task: close time.busy=..."
 * - Error: "Turn error:" or "stream disconnected" or "didn't complete gracefully"
 *
 * @param startTime Execution start time (for timeout calculation)
 * @param timeoutMs Maximum time to wait for completion
 * @returns Object with completed flag and optional error message
 */
private async monitorLogFileForCompletion(
  startTime: Date,
  timeoutMs: number
): Promise<{ completed: boolean; error?: string }> {
  const fs = require("fs");
  const logPath = this.getCodexLogPath();

  // Get initial file size to track new entries
  let lastPosition = 0;
  try {
    const stats = await fs.promises.stat(logPath);
    lastPosition = stats.size;
    Log.debug(`📋 Starting log monitoring from position ${lastPosition}`);
  } catch (error) {
    Log.warn(`Codex log file not found at ${logPath}, starting from position 0`);
  }

  // Poll log file for completion indicators
  while (Date.now() - startTime.getTime() < timeoutMs) {
    try {
      const stats = await fs.promises.stat(logPath);

      // Only read new content since last check
      if (stats.size > lastPosition) {
        const stream = fs.createReadStream(logPath, {
          start: lastPosition,
          encoding: "utf8",
        });

        let newContent = "";
        for await (const chunk of stream) {
          newContent += chunk;
        }

        lastPosition = stats.size;
        Log.debug(`📋 Read ${newContent.length} new bytes from log file`);

        // Check for completion indicator: "run_task: close" marks end of turn
        if (/INFO\s+run_task:\s+close\s+time\.busy=/i.test(newContent)) {
          Log.info("✅ Codex completion detected from log file");
          return { completed: true };
        }

        // Check for error patterns
        const errorMatch = newContent.match(/Turn error:\s*({.*?})/);
        if (errorMatch) {
          Log.error(`❌ Codex error detected in log: ${errorMatch[1]}`);
          return {
            completed: false,
            error: `Turn error: ${errorMatch[1]}`,
          };
        }

        // Check for warning patterns that indicate failures
        if (/stream disconnected|didn't complete gracefully/i.test(newContent)) {
          const warningMatch = newContent.match(/(stream disconnected[^\n]*|didn't complete gracefully[^\n]*)/i);
          const warningMsg = warningMatch ? warningMatch[1] : "Codex CLI warning detected";
          Log.warn(`⚠️ Codex warning in log: ${warningMsg}`);
          return {
            completed: false,
            error: warningMsg,
          };
        }
      }
    } catch (error) {
      // Log file may not exist yet, continue polling
      Log.debug(`Log file polling error (may not exist yet): ${error}`);
    }

    // Poll every 500ms
    await this.delay(500);
  }

  // Timeout reached
  Log.warn(`⏱️ Timeout waiting for Codex completion indicator in log file`);
  return { completed: false, error: "Timeout waiting for completion indicator" };
}

/**
 * Simple delay utility
 */
private delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

4. **Update `executeInTerminal()` to use dual monitoring:**

Find the `executeInTerminal()` method (inherited from BaseCliIntegration, around line 300-400 in BaseCliIntegration.ts) and override it in CodexCommandLineIntegration:

```typescript
/**
 * Execute Codex CLI in interactive terminal with dual monitoring:
 * - Time-based TUI output extraction
 * - Log file completion detection
 *
 * This overrides BaseCliIntegration's executeInTerminal to handle
 * Codex's unique cursor-based rendering and log-based completion.
 */
protected async executeInTerminal(
  args: string[],
  promptText: string,
  workflowContext?: {
    promptIndex: number;
    allPrompts: PromptItem[];
    filePath?: string;
  }
): Promise<boolean> {
  const tuiCommand = this.buildInteractiveTuiCommand(args);
  const displayCommand = `${this.getCliName()} [TUI mode] "<prompt>"`;

  Log.debug(`🎮 executeInTerminal called for Codex`);
  Log.debug(`🎮 tuiCommand: ${tuiCommand}`);
  Log.info(`📝 Prompt length: ${promptText.length} characters`);

  // Create fresh terminal
  const terminal = await this.createFreshTerminal();
  terminal.show();

  // Fire prompt ready event
  this.promptReadyEmitter.fire({
    fullPrompt: promptText,
    cliCommand: displayCommand,
  });

  this.streamingChunkEmitter.fire(
    "📺 Interactive TUI mode: Output is streaming to the VS Code terminal.\n" +
      "   View the terminal for real-time output.\n\n"
  );

  try {
    // Wait for shell integration
    const shellIntegration = await this.waitForShellIntegration(terminal);

    // Execute command
    const execution = shellIntegration.executeCommand(tuiCommand);
    this.currentExecution = execution;

    // Create temp file with instructional prompt
    let tempFilePath: string | undefined;

    try {
      const { tempFilePath: path, promptWithInstruction } =
        await this.createPromptFileWithReference(promptText, workflowContext);
      tempFilePath = path;

      this.lastSanitizedPrompt = promptText;

      // Create TUI processor with Codex-specific configuration
      const tuiConfig: TuiStreamConfig = {
        useTimeBasedExtraction: true, // NEW: Enable time-based processing for Codex
        escapeIndicator: this.getEscapeIndicator(),
        screenEndPattern: this.getScreenEndPattern(),
        tuiChromePattern: this.getTuiChromePattern(),
        streamingEmitter: this.streamingChunkEmitter,
        responseCompleteEmitter: this.responseCompleteEmitter,
      };

      const tuiProcessor = new TuiStreamProcessor(tuiConfig);

      // Start log monitoring BEFORE sending prompt
      const startTime = new Date();
      const completionPromise = this.monitorLogFileForCompletion(
        startTime,
        ConfigurationUtils.getCliExecutionTimeoutMs()
      );

      // Process TUI stream (time-based extraction)
      Log.info("⏳ Starting Codex TUI processing with log monitoring...");
      const tuiPromise = tuiProcessor.processStream(
        execution,
        terminal,
        promptWithInstruction,
        ConfigurationUtils.getCliExecutionTimeoutMs(),
        this.lastSanitizedPrompt,
        this.shouldShowOutput()
      );

      // Wait for EITHER TUI completion OR log file completion
      // Log file is the authoritative source, but TUI may detect errors first
      const [tuiResult, logResult] = await Promise.all([
        tuiPromise,
        completionPromise,
      ]);

      // Prioritize log file result for completion detection
      if (!logResult.completed) {
        this.lastFailureReason = logResult.error || "Completion detection failed";
        Log.error(`❌ Codex execution failed: ${this.lastFailureReason}`);
        return false;
      }

      // Check TUI result for any errors it may have caught
      if (!tuiResult.success && tuiResult.errorMessage) {
        this.lastFailureReason = tuiResult.errorMessage;
        Log.warn(`⚠️ TUI processor detected error: ${tuiResult.errorMessage}`);
        // Don't return false here - log file said success, trust it
      }

      Log.info("✅ Codex execution completed successfully");
      return true;

    } finally {
      // Clean up temp file if created
      if (tempFilePath) {
        await this.deleteTempFile(tempFilePath);
      }
    }
  } catch (error) {
    this.lastFailureReason = error instanceof Error ? error.message : String(error);
    Log.error(`❌ Codex execution error: ${this.lastFailureReason}`);
    return false;
  }
}
```

### Phase 3: Testing Strategy

**Test Cases Required:**

1. **Short Response (< 5s)**
   - Expected: Single large chunk after delay, log shows completion
   - Verify: Content extracted correctly, completion detected via log
   - Manual test file: Create `.flightpath/prompts/test-codex-short-response.prompt.md`

2. **Long Response with Tool Calls**
   - Expected: Multiple chunks, tool execution markers, final completion
   - Verify: Tool output captured, response text extracted, log completion accurate
   - Manual test file: Create `.flightpath/prompts/test-codex-long-with-tools.prompt.md`

3. **Error During Execution**
   - Expected: Error pattern in log, partial output in terminal
   - Verify: Error detected from log, appropriate error message shown
   - Test: Use invalid model name or broken command

4. **User Cancellation (ESC)**
   - Expected: Cancellation pattern in log or timeout
   - Verify: Graceful handling, workflow can continue
   - Test: Manually press ESC during execution

5. **73-Second Delay Handling**
   - Expected: No false timeouts, proper completion detection
   - Verify: Large delayed chunk handled correctly, log monitoring works throughout
   - Test: Use prompt that triggers long thinking time

6. **Response Text vs Animation Frames**
   - Expected: Only actual response text emitted, not "• Working (Xs)" repetitions
   - Verify: Deduplication filters animation, preserves content
   - Test: Compare output to actual Codex response

### Implementation Notes

**Key Design Decisions:**

1. **Mode-based routing via config flag** - Uses `useTimeBasedExtraction` flag instead of CLI type checking. This makes the processor CLI-agnostic and easier to test.

2. **Dual monitoring** - Both TUI output and log file are monitored simultaneously. Log file is the authoritative source for completion, TUI may catch errors first.

3. **Circular buffer deduplication** - Maintains last 100 unique lines to filter animation frames while preserving actual content.

4. **Preserve existing functionality** - Screen-based logic unchanged for Claude/Copilot. Provider-specific branches, not wholesale rewrite.

5. **Error handling priority** - Log file errors take precedence, but TUI errors are logged as warnings.

**Files to Modify:**

- ✅ `src/utils/TuiStreamProcessor.ts` - Add time-based processing mode
- ✅ `src/flightpath/cli/CodexCommandLineIntegration.ts` - Add log file monitoring
- ✅ `src/types/FlightPathTypes.ts` - No changes needed (TuiStreamConfig is local to TuiStreamProcessor)

**Files to Create:**

- Manual test prompts in `.flightpath/prompts/` for validation

## Success Criteria

1. **Time-based extraction working:**
   - Codex TUI output is processed without screen parsing
   - Animation frames filtered, actual content preserved
   - Large delayed chunks handled without timeouts

2. **Log file completion detection working:**
   - `run_task: close` pattern reliably detects completion
   - Error patterns correctly identified and reported
   - File polling doesn't cause performance issues

3. **Integration with existing system:**
   - Claude/Copilot screen-based processing unchanged
   - Settings UI shows Codex provider option
   - Dashboard displays Codex integration status

4. **Testing complete:**
   - All test cases pass
   - Manual validation shows correct output
   - No regressions in Claude/Copilot integrations

## Implementation Checklist

From #file:CODEX_CLI_INTEGRATION.md lines 2097-2175:

**TuiStreamProcessor Refactoring:**

- [ ] Add `useTimeBasedExtraction?: boolean` to `TuiStreamConfig` interface
- [ ] Add `recentLinesBuffer: Set<string>` private field
- [ ] Implement mode-based routing in `processStream()` method
- [ ] Implement `processTimeBasedChunk()` for time-based extraction
- [ ] Implement `filterTuiChromeFromChunk()` helper
- [ ] Implement `deduplicateContent()` with circular buffer
- [ ] Extract existing logic into `processScreenBasedChunk()`
- [ ] Update `isTuiChromeLine()` with Codex-specific patterns

**Log File Completion Detection:**

- [ ] Add `logFilePath?: string` private field to CodexCommandLineIntegration
- [ ] Implement `getCodexLogPath()` helper
- [ ] Implement `monitorLogFileForCompletion()` with file polling
- [ ] Implement `delay()` utility method
- [ ] Handle log file not found gracefully

**Interactive Execution Flow:**

- [ ] Override `executeInTerminal()` in CodexCommandLineIntegration
- [ ] Create TuiStreamConfig with `useTimeBasedExtraction: true`
- [ ] Start log monitoring before sending prompt
- [ ] Use Promise.all for dual monitoring
- [ ] Prioritize log result for completion, TUI for errors
- [ ] Handle cleanup and error cases

**Testing:**

- [ ] Test short responses (< 5s)
- [ ] Test long responses with tool calls
- [ ] Test error scenarios
- [ ] Test user cancellation (ESC)
- [ ] Test 73-second delay handling
- [ ] Verify response text vs animation filtering

## References

- #file:CODEX_CLI_INTEGRATION.md (complete research document)
- #file:TuiStreamProcessor.ts (current implementation)
- #file:CodexCommandLineIntegration.ts (Codex CLI integration)
- #file:BaseCliIntegration.ts (base class with executeInTerminal)
