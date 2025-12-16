import * as vscode from "vscode";
import { PromptItem } from "../types/FlightPathTypes";

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

  constructor(
    private config: TuiStreamConfig,
    private logger?: (msg: string) => void
  ) {
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
   * @returns true if completed successfully, false on timeout/error
   */
  async processStream(
    execution: vscode.TerminalShellExecution,
    terminal: vscode.Terminal,
    promptText: string,
    timeoutMs: number,
    fileReferenceSent: string,
    lastSanitizedPrompt?: string,
    shouldShowOutput?: boolean,
    outputChannel?: vscode.OutputChannel
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
    let lastEmittedContent = new Set<string>(); // Track what we've already sent to dashboard
    let indicatorEverSeen = false; // Must see indicator before counting its absence
    let consecutiveNoIndicatorScreens = 0; // Require 2+ screens without indicator

    const escapeIndicator = this.config.escapeIndicator.toLowerCase();

    // Check if file reference has been echoed back by the CLI
    const isFileReferenceEchoed = (): boolean => {
      if (!fileReferenceSent) {
        return false;
      }

      const bufferLower = fileEchoBuffer.toLowerCase();
      const fileRefLower = fileReferenceSent.toLowerCase();

      if (bufferLower.includes(fileRefLower)) {
        this.logger?.(
          `🔍 File reference verified: found "${fileReferenceSent}" in terminal echo`
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
            this.logger?.(
              `📤 ✅ File read verified (${this.fileSilenceMs / 1000}s silence + verified). Sending carriage return (\\r) to submit...`
            );
            // Copilot CLI uses Ink TUI framework which expects raw terminal mode input
            terminal.sendText("\r", true);
            promptSubmitted = true;
            this.logger?.(
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
      this.logger?.("⏱️ TUI execution timed out");
      abortController.abort();
    }, timeoutMs);

    try {
      this.logger?.("📺 Starting terminal output streaming via read()...");
      this.logger?.(
        `🔍 Waiting for TUI ready (screen end pattern to appear)...`
      );

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
          this.logger?.(
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

          // Phase 1: First complete screen means TUI is ready - mark as ready
          // (Caller is responsible for sending the file reference)
          if (!tuiReady) {
            this.logger?.("✅ TUI is ready (first complete screen detected)");
            tuiReady = true;
            await this.delay(TUI_READY_DELAY_MS);
            promptTextSent = true;
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
                outputChannel?.append(delta);
              }
            }

            // Check for escape indicator in this screen
            const hasIndicator = screenLower.includes(escapeIndicator);

            if (hasIndicator) {
              if (!indicatorEverSeen) {
                this.logger?.(
                  `🔍 [Screen] First indicator seen - CLI is now processing`
                );
              }
              indicatorEverSeen = true;
              consecutiveNoIndicatorScreens = 0;
            } else if (indicatorEverSeen) {
              consecutiveNoIndicatorScreens++;
              this.logger?.(
                `🔍 [Screen] No indicator, consecutiveNoIndicator=${consecutiveNoIndicatorScreens}`
              );

              // Require 2+ consecutive complete screens without indicator
              if (consecutiveNoIndicatorScreens >= 2) {
                this.logger?.(
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

      this.logger?.(
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
      this.logger?.(
        `❌ Error during TUI streaming: ${error instanceof Error ? error.message : String(error)}`
      );
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
   * Features:
   * - Filters TUI chrome (borders, status bars, prompts)
   * - Deduplicates content lines (tracks by trimmed content)
   * - Preserves formatting (indentation, empty lines)
   * - Filters prompt echo
   * - Collapses consecutive blank lines (max 2)
   */
  extractNewContent(
    screen: string,
    emittedContent: Set<string>,
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

      // For deduplication, use normalized (trimmed) version
      const dedupKey = trimmed;

      // Skip if we've already emitted this content line
      if (dedupKey.length > 0 && emittedContent.has(dedupKey)) {
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

      // New content - track it and preserve original line (with indentation)
      if (dedupKey.length > 0) {
        emittedContent.add(dedupKey);
      }
      newLines.push(line);
    }

    if (newLines.length === 0) {
      return "";
    }

    return newLines.join("\n") + "\n";
  }

  /**
   * Check if a line is TUI chrome that should be filtered.
   * Matches specific TUI patterns without catching content.
   */
  isTuiChromeLine(line: string): boolean {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return false;
    }

    const chromPatterns = [
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing only
      /Ctrl\+[a-z]\s+\w+.*Ctrl\+/i, // Multiple keyboard shortcuts
      /^Enter @ to mention/i, // Copilot prompt hint
      /^\(Esc to cancel\)/i, // Copilot thinking indicator
      /^\(Esc to interrupt\)/i, // Claude thinking indicator
      /^>\s*$/, // Empty prompt only
      /^[∙◉◎●]\s*$/, // Spinner alone
      /^Thinking\s*\([^)]*\)\s*$/i, // Complete thinking status line
      /^⎇\s+\w+\*?\s*[│|]\s*gpt-/i, // Git branch + model
      /^\d+x\)\s*$/, // Token multiplier pattern
      /^Welcome to (GitHub Copilot|Claude)/i, // Welcome messages
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
