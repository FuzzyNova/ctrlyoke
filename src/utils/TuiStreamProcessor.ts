import * as vscode from "vscode";
import { PromptItem } from "../types/FlightPathTypes";
import { Log } from "./Log";

/**
 * Configuration for TUI stream processing
 */
export interface TuiStreamConfig {
  // CLI-specific patterns (from abstract methods)
  escapeIndicator: string; // e.g., "(esc to cancel)"
  screenEndPattern: RegExp; // e.g., /Ctrl\+c Exit/
  tuiChromePattern: RegExp; // e.g., /Ctrl\+c Exit/

  // Event emitters for communication
  streamingEmitter: vscode.EventEmitter<string>;
  responseCompleteEmitter: vscode.EventEmitter<string>;

  // Optional configuration
  fileSilenceMs?: number; // Default: 1000ms
  maxConsecutiveBlankLines?: number; // Default: 2
}

/**
 * Optional workflow context for temp file naming
 */
export interface WorkflowContext {
  promptIndex: number;
  allPrompts: PromptItem[];
  filePath?: string;
}

/**
 * Configuration constants for TUI processing
 */
const DEFAULT_FILE_SILENCE_MS = 1000;
const DEFAULT_MAX_BLANK_LINES = 2;
const TUI_READY_DELAY_MS = 500;

/**
 * Processes TUI output streams from CLI tools.
 *
 * Responsibilities:
 * - Stream TUI output from TerminalShellExecution.read()
 * - Detect TUI readiness (first complete screen)
 * - Parse TUI screens from buffer
 * - Extract new content deltas (deduplication)
 * - Detect completion (escape indicator disappearing)
 * - Handle CLI errors in output
 */
export class TuiStreamProcessor {
  private fileSilenceMs: number;
  private maxConsecutiveBlankLines: number;

  constructor(private config: TuiStreamConfig) {
    this.fileSilenceMs = config.fileSilenceMs || DEFAULT_FILE_SILENCE_MS;
    this.maxConsecutiveBlankLines =
      config.maxConsecutiveBlankLines || DEFAULT_MAX_BLANK_LINES;
  }

  /**
   * Process TUI stream from terminal execution.
   *
   * Flow:
   * 1. Wait for TUI ready (screen end pattern appears)
   * 2. Send prompt via @file reference
   * 3. Wait for file echo (prompt has been read)
   * 4. Submit prompt (send \r)
   * 5. Stream output and detect completion
   *
   * Completion detection:
   * - Escape indicator appears (CLI generating)
   * - Escape indicator disappears for 2+ screens (complete)
   *
   * @param prompt The prompt with @file reference to send when TUI is ready (e.g., "Follow instructions in @.flightpath/temp/prompt-1.txt")
   * @returns true if completed successfully, false on timeout/error
   */
  async processStream(
    execution: vscode.TerminalShellExecution,
    terminal: vscode.Terminal,
    prompt: string,
    timeoutMs: number,
    lastSanitizedPrompt?: string,
    shouldShowOutput?: boolean
  ): Promise<boolean> {
    let tuiReady = false;
    let promptTextSent = false;
    let promptSubmitted = false;
    let completed = false;
    let errorDetected = false;
    let errorMessage = "";

    let chunkCount = 0;
    let totalBytes = 0;

    // TUI screen buffer - chunks can contain multiple screens or partial screens
    let screenBuffer = "";
    let fileEchoBuffer = ""; // Track terminal output for file reference echo detection
    let rawPasteBuffer = ""; // RAW buffer with ANSI codes for error detection
    let lastEmittedContent = new Map<string, number>(); // Track line occurrence counts from previous screen
    let indicatorEverSeen = false; // Must see indicator before counting its absence
    let consecutiveNoIndicatorScreens = 0; // Require 2+ screens without indicator

    const escapeIndicator = this.config.escapeIndicator.toLowerCase();

    // Check if file reference has been echoed back by the CLI
    const isFileReferenceEchoed = (): boolean => {
      if (!prompt) {
        return false;
      }

      const bufferLower = fileEchoBuffer.toLowerCase();
      const fileRefLower = prompt.toLowerCase();

      if (bufferLower.includes(fileRefLower)) {
        Log.debug(
          `🔍 File reference verified: found "${prompt}" in terminal echo`
        );
        return true;
      }

      return false;
    };

    // Dynamic paste completion detection - submit prompt after terminal output settles
    let submissionTimeoutId: NodeJS.Timeout | undefined;
    const startSubmissionTimer = () => {
      if (submissionTimeoutId) {
        clearTimeout(submissionTimeoutId);
      }
      submissionTimeoutId = setTimeout(() => {
        if (promptTextSent && !promptSubmitted) {
          // Verify file reference was echoed before submitting
          if (isFileReferenceEchoed()) {
            Log.info(
              `📤 ✅ File read verified (${this.fileSilenceMs / 1000}s silence + verified). Sending carriage return (\\r) to submit...`
            );
            // Copilot CLI uses Ink TUI framework which expects raw terminal mode input
            terminal.sendText("\r", true);
            promptSubmitted = true;
            Log.info(
              `📤 ✅ Carriage return (\\r) sent to terminal. Waiting for response...`
            );
          }
        }
      }, this.fileSilenceMs);
    };

    // Create abort controller for timeout/cancellation
    const abortController = new AbortController();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      Log.error("⏱️ TUI execution timed out");
      abortController.abort();
    }, timeoutMs);

    try {
      Log.info("📺 Starting terminal output streaming via read()...");
      Log.info(`🔍 Waiting for TUI ready (screen end pattern to appear)...`);

      for await (const data of execution.read()) {
        // Check for abort
        if (abortController.signal.aborted) {
          break;
        }

        chunkCount++;
        totalBytes += data.length;

        // Clean the ANSI codes and add to buffer
        const cleanData = this.stripAnsiCodes(data);
        screenBuffer += cleanData;

        // Accumulate output for file reference echo detection (only while waiting to submit)
        if (promptTextSent && !promptSubmitted) {
          fileEchoBuffer += cleanData;
          rawPasteBuffer += data; // Also keep raw buffer for error detection
        }

        // Check for CLI errors (TUI crash detection)
        if (!errorDetected && this.detectCliError(data)) {
          errorDetected = true;
          errorMessage = this.extractErrorMessage(data);
          Log.error(
            `❌ [ERROR ABORT] CLI error detected in output - aborting immediately`
          );
          abortController.abort();
          break;
        }

        // Extract complete screens from buffer
        const { screens, remainder } =
          this.extractScreensFromBuffer(screenBuffer);
        screenBuffer = remainder;

        // Process each complete screen
        for (const screen of screens) {
          const screenLower = screen.toLowerCase();

          // Phase 1: First complete screen means TUI is ready - send file reference
          if (!tuiReady) {
            Log.info("✅ TUI is ready (first complete screen detected)");
            tuiReady = true;

            // Small delay to ensure TUI is fully interactive
            await this.delay(TUI_READY_DELAY_MS);

            // Send @file reference to CLI (instant, no chunking!)
            Log.info(`📁 Sending file reference: ${prompt}`);
            terminal.sendText(prompt, false);
            promptTextSent = true;

            Log.info(
              `📁 ✅ File reference sent. Waiting for CLI to read file...`
            );
            Log.debug(
              `⏳ Entering file read detection phase. Will submit after ${this.fileSilenceMs}ms of silence.`
            );
            startSubmissionTimer();
          }

          // Reset submission timer on each chunk while waiting for file to be processed
          if (promptTextSent && !promptSubmitted) {
            startSubmissionTimer();
          }

          // Phase 2: After prompt submitted, detect completion and emit deltas
          if (promptSubmitted) {
            const delta = this.extractNewContent(
              screen,
              lastEmittedContent,
              lastSanitizedPrompt
            );
            if (delta.trim().length > 0) {
              this.config.streamingEmitter.fire(delta);
              if (shouldShowOutput) {
                Log.append(delta);
              }
            }

            // Check for escape indicator in this screen
            const hasIndicator = screenLower.includes(escapeIndicator);

            if (hasIndicator) {
              if (!indicatorEverSeen) {
                Log.debug(
                  `🔍 [Screen] First indicator seen - CLI is now processing`
                );
              }
              indicatorEverSeen = true;
              consecutiveNoIndicatorScreens = 0;
            } else if (indicatorEverSeen) {
              consecutiveNoIndicatorScreens++;
              Log.debug(
                `🔍 [Screen] No indicator, consecutiveNoIndicator=${consecutiveNoIndicatorScreens}`
              );

              // Require 2+ consecutive complete screens without indicator
              if (consecutiveNoIndicatorScreens >= 2) {
                Log.info(
                  `✅ Response complete (no indicator for ${consecutiveNoIndicatorScreens} consecutive screens)`
                );
                completed = true;
                break;
              }
            }
          }
        }

        if (completed) {
          break;
        }
      }

      // Clear the submission timer if still pending
      if (submissionTimeoutId) {
        clearTimeout(submissionTimeoutId);
      }
      clearTimeout(timeoutId);

      // Process any remaining content in the buffer
      if (promptSubmitted && screenBuffer.trim().length > 0) {
        const delta = this.extractNewContent(
          screenBuffer,
          lastEmittedContent,
          lastSanitizedPrompt
        );
        if (delta.trim().length > 0) {
          this.config.streamingEmitter.fire(delta);
        }
      }

      Log.info(
        `📺 Streaming complete: ${chunkCount} chunks, ${totalBytes} bytes | completed=${completed}, errorDetected=${errorDetected}`
      );

      // Handle CLI errors
      if (errorDetected) {
        this.config.streamingEmitter.fire(
          `\n❌ CLI Error Detected:\n\n${errorMessage}\n\n` +
            "The CLI crashed during execution.\n"
        );
        this.config.responseCompleteEmitter.fire("CLI error");
        return false;
      }

      if (completed) {
        this.config.responseCompleteEmitter.fire("Response complete");
        return true;
      } else if (promptSubmitted) {
        this.config.responseCompleteEmitter.fire(
          "Stream ended (treated as success)"
        );
        return true;
      } else {
        this.config.responseCompleteEmitter.fire(
          "Stream ended (no prompt submission)"
        );
        return false;
      }
    } catch (error) {
      Log.error(`Error during TUI streaming`, error);
      this.config.responseCompleteEmitter.fire("Error during streaming");
      return false;
    }
  }

  /**
   * Extract complete TUI screens from accumulated buffer.
   * Uses CLI-specific screen end pattern to detect boundaries.
   */
  extractScreensFromBuffer(buffer: string): {
    screens: string[];
    remainder: string;
  } {
    const screens: string[] = [];
    const screenEndPattern = this.config.screenEndPattern;

    let lastIndex = 0;
    let match;

    // Find all complete screens (ending with the status bar)
    while ((match = screenEndPattern.exec(buffer)) !== null) {
      const screenEnd = match.index + match[0].length;
      const screen = buffer.substring(lastIndex, screenEnd);

      if (screen.trim().length > 0) {
        screens.push(screen);
      }

      lastIndex = screenEnd;
    }

    // Everything after the last complete screen is the remainder
    const remainder = buffer.substring(lastIndex);

    return { screens, remainder };
  }

  /**
   * Extract new content from a screen that hasn't been emitted yet.
   *
   * Challenge: Claude progressively updates screens, not just appends.
   * Example:
   *   Screen 1: "● Read(file1.ts)"
   *   Screen 2: "● Read(file1.ts)\n  ⎿ Read 10 lines"
   *
   * Strategy: Track line occurrence counts between screens.
   * - If a line appears MORE times in current screen than previous → emit the delta
   * - Preserves identical lines in different contexts (e.g., multiple "⎿ Read 10 lines")
   * - Handles progressive updates where annotations get added under existing lines
   *
   * @param screen The current screen content
   * @param emittedContent Map tracking line counts from previous screen
   * @param promptToFilter Lines from the prompt to filter out
   */
  extractNewContent(
    screen: string,
    emittedContent: Map<string, number>,
    promptToFilter?: string
  ): string {
    const lines = screen.split(/\r?\n/);
    const newLines: string[] = [];
    let consecutiveBlankLines = 0;

    // Build set of prompt lines for efficient filtering
    const promptLines = new Set<string>();
    if (promptToFilter) {
      promptToFilter.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          promptLines.add(trimmed);
        }
      });
    }

    // Track line counts in CURRENT screen (Map<content, count>)
    const currentScreenCounts = new Map<string, number>();

    // First pass: count occurrences in current screen
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        currentScreenCounts.set(
          trimmed,
          (currentScreenCounts.get(trimmed) || 0) + 1
        );
      }
    }

    // Previous screen's line counts (already a Map)
    const prevScreenCounts = new Map(emittedContent);

    // Second pass: emit lines that are NEW or appear MORE times than before
    const emittedInCurrentPass = new Map<string, number>();
    for (const line of lines) {
      const trimmed = line.trim();

      // Skip TUI chrome (but not empty lines - they're important for formatting)
      if (trimmed.length > 0 && this.isTuiChromeLine(line)) {
        continue;
      }

      // Skip prompt echo lines
      if (trimmed.length > 0 && promptLines.has(trimmed)) {
        continue;
      }

      // Handle blank line collapsing (max 2 consecutive blank lines)
      if (trimmed.length === 0) {
        consecutiveBlankLines++;
        if (consecutiveBlankLines <= this.maxConsecutiveBlankLines) {
          newLines.push(line);
        }
        continue;
      } else {
        consecutiveBlankLines = 0;
      }

      // Check if we've already emitted this line in this pass
      const emittedCount = emittedInCurrentPass.get(trimmed) || 0;
      const prevCount = prevScreenCounts.get(trimmed) || 0;

      // Emit if: this is a NEW occurrence beyond what was in previous screen
      if (
        emittedCount < currentScreenCounts.get(trimmed)! &&
        emittedCount >= prevCount
      ) {
        newLines.push(line);
        emittedInCurrentPass.set(trimmed, emittedCount + 1);
      }
    }

    // Update emittedContent for next screen comparison
    // Replace with current screen's line counts
    emittedContent.clear();
    currentScreenCounts.forEach((count, line) => {
      emittedContent.set(line, count);
    });

    if (newLines.length === 0) {
      return "";
    }

    // Trim leading/trailing blank lines to prevent accumulation across screens
    // But preserve ONE trailing blank line if it existed (for natural paragraph breaks)
    let startIdx = 0;
    let endIdx = newLines.length - 1;
    let hadTrailingBlank = false;

    // Trim all leading blank lines
    while (
      startIdx < newLines.length &&
      newLines[startIdx].trim().length === 0
    ) {
      startIdx++;
    }

    // Trim trailing blank lines but remember if we had any
    while (endIdx >= startIdx && newLines[endIdx].trim().length === 0) {
      hadTrailingBlank = true;
      endIdx--;
    }

    if (startIdx > endIdx) {
      return ""; // All blank lines
    }

    const trimmedLines = newLines.slice(startIdx, endIdx + 1);
    const result = trimmedLines.join("\n") + "\n";

    // Add back one blank line if there was trailing whitespace
    return hadTrailingBlank ? result + "\n" : result;
  }

  /**
   * Check if a line is TUI chrome that should be filtered.
   * Matches specific TUI patterns without catching content.
   *
   * Strategy:
   * - Filter lines ending with "(Esc to cancel)" or "(esc to interrupt)" - these are status indicators
   * - Filter spinner-only lines or lines that are pure UI chrome
   * - Use SYMBOLS to identify loading indicators, not words (LLMs choose different words each time)
   * - Preserve output lines even if they contain spinners (e.g., "● Read(file.ts)" is content, not chrome)
   */
  isTuiChromeLine(line: string): boolean {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return false;
    }

    const chromPatterns = [
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing only
      /^[─═]{20,}$/, // Long horizontal separators (lenient)
      /Ctrl\+[a-z]\s+\w+.*Ctrl\+/i, // Multiple keyboard shortcuts
      /^Enter @ to mention/i, // Copilot prompt hint
      /^\(Esc to cancel\)\s*$/i, // Copilot thinking indicator (standalone, line-end)
      /^\(Esc to interrupt\)\s*$/i, // Claude thinking indicator (standalone, line-end)
      /^>\s*$/, // Empty prompt only
      /^>\s+.+[↵⧉⎆⏎]\s+\w+\s*$/i, // Prompt lines ending with directional arrow + command (e.g., "↵ send", "⧉ In")
      /^[✻✽✢✶·◉◎●]\s*$/, // Spinner alone (no other content)
      /^Thinking\s*\([^)]*\)\s*$/i, // Complete thinking status line
      /^⎇\s+\w+\*?\s*[│|]\s*gpt-/i, // Git branch + model
      /^\d+x\)\s*$/, // Token multiplier pattern
      /^Welcome to (GitHub Copilot|Claude)/i, // Welcome messages
      /\(Esc to cancel\)\s*$/i, // Any line ENDING with "(Esc to cancel)" (catches all loading spinners too)
      /\(esc to interrupt[^)]*\)\s*$/i, // Any line ENDING with "(esc to interrupt...)" (catches all loading spinners too)
      /^⏵⏵/, // Edit mode indicator (double chevron prefix)
    ];

    return chromPatterns.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Strip ANSI escape codes and terminal control sequences.
   * Preserves all printable characters including markdown.
   */
  stripAnsiCodes(text: string): string {
    return (
      text
        // OSC sequences
        .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
        // CSI sequences
        .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
        // Other escape sequences
        .replace(/\x1B[@-Z\\-_]/g, "")
        // Standalone BEL character
        .replace(/\x07/g, "")
        // Clean up excessive newlines but preserve paragraph breaks
        .replace(/\n{4,}/g, "\n\n\n")
    );
  }

  /**
   * Detect CLI errors in raw TUI output.
   * Distinguishes real errors from pasted prompt content.
   *
   * Strategy:
   * - Real errors: TUI chrome BEFORE, no chrome AFTER
   * - False positives: TUI chrome BEFORE and AFTER (pasted content)
   */
  private detectCliError(rawBuffer: string): boolean {
    const tuiChromePattern = this.config.tuiChromePattern;

    const errorPatterns = [
      /Error: Minified React error #\d+/i, // React errors
      /Error:.*\n\s+at\s+/s, // Error with stack trace
      /TypeError:.*\n\s+at\s+/s, // TypeError with stack trace
      /ReferenceError:.*\n\s+at\s+/s, // ReferenceError with stack trace
      /Uncaught Exception:/i, // Uncaught exceptions
    ];

    for (const pattern of errorPatterns) {
      const errorMatch = rawBuffer.match(pattern);
      if (errorMatch) {
        const errorStartIndex = errorMatch.index!;

        // Find the last occurrence of TUI chrome BEFORE the error
        const beforeError = rawBuffer.substring(0, errorStartIndex);
        const chromeBeforeMatch = beforeError.match(tuiChromePattern);

        if (!chromeBeforeMatch) {
          continue;
        }

        // Check if there's TUI chrome AFTER the error
        const afterError = rawBuffer.substring(
          errorStartIndex + errorMatch[0].length
        );
        const chromeAfterMatch = afterError.match(tuiChromePattern);

        if (chromeAfterMatch) {
          // Error is inside TUI (prompt echo)
          continue;
        }

        // Real error: chrome before, no chrome after
        return true;
      }
    }
    return false;
  }

  /**
   * Extract error message from raw buffer
   */
  private extractErrorMessage(rawBuffer: string): string {
    // Try to extract full error with stack trace
    const errorWithStack = /Error:[^\n]+(?:\n\s+at\s+[^\n]+)*/i.exec(rawBuffer);
    if (errorWithStack) {
      return this.stripAnsiCodes(errorWithStack[0]);
    }

    // Fallback: just get the error line
    const errorLineMatch = /Error:[^\n]+/.exec(rawBuffer);
    if (errorLineMatch) {
      return this.stripAnsiCodes(errorLineMatch[0]);
    }

    return "Unknown error";
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
