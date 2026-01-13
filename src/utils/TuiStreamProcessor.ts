import * as vscode from "vscode";
import { PromptItem } from "../types/FlightPathTypes";
import { Log } from "./Log";

/**
 * Result from TUI stream processing
 */
export interface TuiProcessResult {
  success: boolean;
  errorMessage?: string;
}

/**
 * Configuration for TUI stream processing
 */
export interface TuiStreamConfig {
  // Processing mode: time-based (Codex) vs screen-based (Claude/Copilot)
  useTimeBasedExtraction?: boolean; // Default: false (screen-based mode)

  // CLI-specific patterns (from abstract methods)
  escapeIndicator: string; // e.g., "(esc to cancel)"
  screenEndPattern: RegExp; // e.g., /Ctrl\+c Exit/ - also used for error detection
  tuiChromePatterns: RegExp[]; // CLI-specific chrome filtering patterns

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
  private recentLinesBuffer: Set<string> = new Set();
  private consecutiveBlankLines: number = 0; // Persistent counter across chunks

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
   * @param abortController Optional external abort controller for cancellation (e.g., when log file detects completion)
   * @returns Object with success flag and optional error message
   */
  async processStream(
    execution: vscode.TerminalShellExecution,
    terminal: vscode.Terminal,
    prompt: string,
    timeoutMs: number,
    lastSanitizedPrompt?: string,
    abortController?: AbortController
  ): Promise<TuiProcessResult> {
    let tuiReady = false;
    let promptTextSent = false;
    let promptSubmitted = false;
    let completed = false;
    let errorDetected = false;
    let errorMessage = "";
    let fileEchoDetected = false; // Track when we first see the file echo

    let chunkCount = 0;
    let totalBytes = 0;

    // TUI screen buffer - chunks can contain multiple screens or partial screens
    let screenBuffer = "";
    let fileEchoBuffer = ""; // Track terminal output for file reference echo detection
    let rawPasteBuffer = ""; // RAW buffer with ANSI codes for error detection
    let lastEmittedContent = new Map<string, number>(); // Track line occurrence counts from previous screen
    let indicatorEverSeen = false; // Must see indicator before counting its absence
    let consecutiveNoIndicatorScreens = 0; // Require 2+ screens without indicator

    // Reset blank line counter for new stream
    this.consecutiveBlankLines = 0;

    const escapeIndicator = this.config.escapeIndicator.toLowerCase();

    // Check if file reference has been echoed back by the CLI
    const isFileReferenceEchoed = (): boolean => {
      if (!prompt) {
        return false;
      }

      // Extract the file path from the prompt (everything after the @ symbol)
      const atIndex = prompt.indexOf("@");
      if (atIndex === -1) {
        // No @ symbol, just check for the whole prompt (remove all whitespace for comparison)
        // TUIs may remove spaces in output, so we compare without any whitespace
        const normalizedPrompt = prompt.toLowerCase().replace(/\s+/g, "");
        const normalizedBuffer = fileEchoBuffer
          .toLowerCase()
          .replace(/\s+/g, "");
        if (normalizedBuffer.includes(normalizedPrompt)) {
          Log.debug(
            `🔍 File reference verified: found "${prompt}" in terminal echo`
          );
          return true;
        }
        return false;
      }

      // Extract just the file path part (after @)
      const filePath = prompt.substring(atIndex + 1).trim();

      // For file path matching, REMOVE all whitespace from both sides
      // TUIs line-wrap paths which inserts spaces where they shouldn't be
      // Example: "path/to/file.txt" may appear as "path/to/file.   \n  txt"
      const filePathNoSpaces = filePath.toLowerCase().replace(/\s+/g, "");
      const bufferNoSpaces = fileEchoBuffer.toLowerCase().replace(/\s+/g, "");

      Log.debug(
        `[File Echo Check] Looking for: "${filePath}" (${filePath.length} chars) in buffer (${fileEchoBuffer.length} chars)`
      );
      Log.debug(
        `[File Echo Check] Normalized search: "${filePathNoSpaces}" (${filePathNoSpaces.length} chars no-space)`
      );
      Log.debug(
        `[File Echo Check] Buffer content: "${fileEchoBuffer.substring(0, 200)}${fileEchoBuffer.length > 200 ? "..." : ""}"`
      );

      if (bufferNoSpaces.includes(filePathNoSpaces)) {
        Log.debug(
          `🔍 File reference verified: found file path "${filePath}" in terminal echo`
        );
        return true;
      }

      Log.debug(`[File Echo Check] NOT FOUND - file reference not yet echoed`);
      return false;
    };

    // Dynamic paste completion detection - submit prompt after terminal output settles
    let submissionTimeoutId: NodeJS.Timeout | undefined;
    const startSubmissionTimer = () => {
      if (submissionTimeoutId) {
        clearTimeout(submissionTimeoutId);
      }
      submissionTimeoutId = setTimeout(() => {
        Log.debug(
          `[Submission Timer] Silence timeout reached (${this.fileSilenceMs}ms). promptTextSent=${promptTextSent}, promptSubmitted=${promptSubmitted}, fileEchoDetected=${fileEchoDetected}`
        );
        if (promptTextSent && !promptSubmitted && fileEchoDetected) {
          // Timer only starts after echo detected, so we can submit immediately
          Log.info(
            `📤 ✅ File read complete (${this.fileSilenceMs}ms silence after echo). Sending carriage return (\\r) to submit...`
          );
          // CLI uses Ink TUI framework which expects raw terminal mode input
          terminal.sendText("\r", true);
          promptSubmitted = true;
          Log.info(
            `📤 ✅ Carriage return (\\r) sent to terminal. Waiting for response...`
          );
        }
      }, this.fileSilenceMs);
    };

    // Use provided abort controller or create new one for timeout/cancellation
    const controller = abortController || new AbortController();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      Log.error("⏱️ TUI execution timed out");
      controller.abort();
    }, timeoutMs);

    try {
      Log.info("📺 Starting terminal output streaming via read()...");
      Log.info(`🔍 Waiting for TUI ready (screen end pattern to appear)...`);

      // Create an async iterator wrapper that checks abort signal
      const iterator = execution.read()[Symbol.asyncIterator]();

      while (true) {
        // Race between reading next chunk and abort signal
        const abortPromise = new Promise<{ done: true; value: undefined }>(
          (resolve) => {
            if (controller.signal.aborted) {
              resolve({ done: true, value: undefined });
            } else {
              controller.signal.addEventListener(
                "abort",
                () => {
                  resolve({ done: true, value: undefined });
                },
                { once: true }
              );
            }
          }
        );

        const nextPromise = iterator.next();
        const result = await Promise.race([nextPromise, abortPromise]);

        // Check if aborted or iterator finished
        if (result.done || controller.signal.aborted) {
          if (controller.signal.aborted) {
            Log.info("🛑 TUI stream aborted by external controller");
          }
          break;
        }

        const data = result.value;

        chunkCount++;
        totalBytes += data.length;

        // Clean the ANSI codes and add to buffer
        const cleanData = this.stripAnsiCodes(data);
        screenBuffer += cleanData;

        // Accumulate output for file reference echo detection (only while waiting to submit)
        if (promptTextSent && !promptSubmitted) {
          fileEchoBuffer += cleanData;
          rawPasteBuffer += data; // Also keep raw buffer for error detection
          Log.debug(
            `[File Echo Buffer] Added ${cleanData.length} chars, total: ${fileEchoBuffer.length} chars`
          );
          if (cleanData.length > 0 && cleanData.length < 200) {
            Log.debug(`[File Echo Buffer] Content: "${cleanData}"`);
          }
        }

        // Check for CLI errors (TUI crash detection)
        if (!errorDetected && this.detectCliError(data)) {
          errorDetected = true;
          errorMessage = this.extractErrorMessage(data);
          Log.error(
            `❌ [ERROR ABORT] CLI error detected in output - aborting immediately`
          );
          controller.abort();
          break;
        }

        // Extract complete screens from buffer
        const { screens, remainder } =
          this.extractScreensFromBuffer(screenBuffer);
        screenBuffer = remainder;

        // Detect file echo and start/reset submission timer (check on EVERY chunk, not just complete screens)
        if (promptTextSent && !promptSubmitted) {
          if (!fileEchoDetected && isFileReferenceEchoed()) {
            // First time seeing the echo - start the silence timer
            fileEchoDetected = true;
            Log.info(
              `🔍 ✅ File reference echo detected! Starting ${this.fileSilenceMs}ms silence timer...`
            );
            startSubmissionTimer();
          } else if (fileEchoDetected) {
            // Echo already detected, just reset the timer on each new chunk
            startSubmissionTimer();
          }
        }

        // Mode-based processing: time-based (Codex) vs screen-based (Claude/Copilot)
        if (this.config.useTimeBasedExtraction) {
          // TIME-BASED EXTRACTION (Codex)
          // Process data chunks directly without screen parsing
          if (promptSubmitted) {
            this.processTimeBasedChunk(data, lastEmittedContent);
          }

          // For TUI readiness and prompt submission, still use screen detection
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
                `📁 ✅ File reference sent. Waiting for CLI to read and echo file reference...`
              );
              Log.debug(
                `⏳ Entering file read detection phase. Will start silence timer after echo detected.`
              );
            }

            // For time-based mode, we rely on log file for completion detection
            // No indicator-based completion checking here
          }
        } else {
          // SCREEN-BASED EXTRACTION (Claude/Copilot)
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
                `📁 ✅ File reference sent. Waiting for CLI to read and echo file reference...`
              );
              Log.debug(
                `⏳ Entering file read detection phase. Will start silence timer after echo detected.`
              );
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
        const fullError = `CLI Error: ${errorMessage}`;
        this.config.streamingEmitter.fire(
          `\n❌ ${fullError}\n\n` + "The CLI crashed during execution.\n"
        );
        this.config.responseCompleteEmitter.fire("CLI error");
        return { success: false, errorMessage: fullError };
      }

      if (completed) {
        this.config.responseCompleteEmitter.fire("Response complete");
        return { success: true };
      } else if (promptSubmitted) {
        this.config.responseCompleteEmitter.fire(
          "Stream ended (treated as success)"
        );
        return { success: true };
      } else {
        // Command failed before TUI started or prompt never sent
        // Include actual terminal output to help diagnose the issue
        const terminalOutput = screenBuffer.trim() || fileEchoBuffer.trim();
        const baseMsg = tuiReady
          ? "TUI started but prompt was never submitted (CLI may have crashed)"
          : "CLI command failed to start TUI";

        let errorMsg = baseMsg;
        if (terminalOutput) {
          // Truncate output if too long (keep first 500 chars)
          const truncatedOutput =
            terminalOutput.length > 500
              ? terminalOutput.substring(0, 500) + "..."
              : terminalOutput;
          errorMsg = `${baseMsg}. Terminal output:\n${truncatedOutput}`;

          // Also emit the full terminal output to dashboard for visibility
          this.config.streamingEmitter.fire(
            `\n❌ ${baseMsg}\n\n📋 Terminal output:\n${terminalOutput}\n`
          );
        } else {
          errorMsg = `${baseMsg} (no output captured)`;
          this.config.streamingEmitter.fire(`\n❌ ${errorMsg}\n`);
        }

        Log.error(errorMsg);
        this.config.responseCompleteEmitter.fire(
          "Stream ended (no prompt submission)"
        );
        return { success: false, errorMessage: errorMsg };
      }
    } catch (error) {
      const errorMsg = `Error during TUI streaming: ${error instanceof Error ? error.message : String(error)}`;
      Log.error(errorMsg, error);
      this.config.streamingEmitter.fire(`\n❌ ${errorMsg}\n`);
      this.config.responseCompleteEmitter.fire("Error during streaming");
      return { success: false, errorMessage: errorMsg };
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
    // Note: consecutiveBlankLines tracking uses the class-level persistent counter
    // (this.consecutiveBlankLines) to prevent accumulation across multiple screens

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
    const occurrenceInCurrentPass = new Map<string, number>(); // Track which occurrence number (1st, 2nd, 3rd...)
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
        this.consecutiveBlankLines++;
        if (this.consecutiveBlankLines <= this.maxConsecutiveBlankLines) {
          newLines.push(line);
        }
        continue;
      } else {
        this.consecutiveBlankLines = 0;
      }

      // Track occurrence number (which instance of this line we're seeing: 1st, 2nd, 3rd...)
      const occurrenceNum = (occurrenceInCurrentPass.get(trimmed) || 0) + 1;
      occurrenceInCurrentPass.set(trimmed, occurrenceNum);

      const emittedCount = emittedInCurrentPass.get(trimmed) || 0;
      const prevCount = prevScreenCounts.get(trimmed) || 0;

      // Emit if: this occurrence is BEYOND what existed in the previous screen
      // Example: prevCount=1, currentCount=3 → emit occurrences 2 and 3 (occurrenceNum > prevCount)
      if (occurrenceNum > prevCount) {
        newLines.push(line);
        emittedInCurrentPass.set(trimmed, emittedCount + 1);
      }
    }

    // Update emittedContent for next screen comparison
    // ACCUMULATE counts across screens (don't clear existing counts!)
    // Keep the maximum count seen for each line across all screens
    currentScreenCounts.forEach((count, line) => {
      const prevCount = emittedContent.get(line) || 0;
      emittedContent.set(line, Math.max(prevCount, count));
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
   *
   * Uses CLI-specific patterns provided via config (getTuiChromePatterns() from each integration).
   */
  isTuiChromeLine(line: string): boolean {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return false;
    }

    // Use CLI-specific patterns from config
    return this.config.tuiChromePatterns.some((pattern) =>
      pattern.test(trimmed)
    );
  }

  /**
   * Strip ANSI escape codes and terminal control sequences.
   * Preserves all printable characters including markdown.
   * Note: Whitespace collapsing is handled in deduplicateContent()
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
        // Zero-width characters (U+200B-U+200F: ZWSP, ZWNJ, ZWJ, LRM, RLM, etc.)
        .replace(/[\u200B-\u200F]/g, "")
      // Note: Excessive whitespace is collapsed in deduplicateContent() instead
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
    const tuiChromePattern = this.config.screenEndPattern;

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
   * Deduplicate content using circular buffer tracking.
   *
   * Strategy:
   * - Collapse excessive whitespace within chunks (3+ blank lines → 2)
   * - Track last 100 unique lines in recentLinesBuffer
   * - Only emit lines not in recent history
   * - Maintain buffer size limit (remove oldest when > 100)
   * - Limit consecutive blank lines across chunks using instance variable
   *
   * This filters repeated animation frames while preserving
   * actual response text and natural formatting.
   */
  private deduplicateContent(text: string): string {
    // First, collapse runs of 3+ blank lines within the chunk to 2 blank lines
    // After trimEnd(), blank lines are truly empty, so just match consecutive newlines
    // Handle both \n and \r\n line endings

    const inputNewlineCount = (text.match(/\n/g) || []).length;

    // Normalize line endings to \n first
    const normalized = text.replace(/\r\n/g, "\n");

    // Check what the regex WOULD match before replacing
    const blankRunMatches = normalized.match(/\n\n\n+/g);
    if (blankRunMatches && blankRunMatches.length > 0) {
      Log.debug(
        `[deduplicateContent] 🔍 Collapsing ${blankRunMatches.length} runs of 3+ newlines (input: ${inputNewlineCount} newlines)`
      );
    }

    // Now actually collapse
    const collapsedText = normalized.replace(/\n\n\n+/g, "\n\n");

    const lines = collapsedText.split(/\r?\n/);
    const newLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        // Keep empty lines for formatting, but limit consecutive blank lines
        this.consecutiveBlankLines++;
        if (this.consecutiveBlankLines <= this.maxConsecutiveBlankLines) {
          newLines.push(line);
        } else {
          // Log when we skip excessive blank lines
          Log.debug(
            `[deduplicateContent] 🚫 Skipping blank line (counter: ${this.consecutiveBlankLines}, max: ${this.maxConsecutiveBlankLines})`
          );
        }
        continue;
      }

      // Check if line already seen in recent history
      if (!this.recentLinesBuffer.has(trimmed)) {
        // Reset blank line counter ONLY when we EMIT a non-blank line
        // (not when we skip a duplicate non-blank line)
        this.consecutiveBlankLines = 0;

        newLines.push(line);
        this.recentLinesBuffer.add(trimmed);

        // Keep buffer size limited (last 100 lines)
        if (this.recentLinesBuffer.size > 100) {
          // Remove oldest line (first in set)
          const firstLine = this.recentLinesBuffer.values().next().value;
          if (firstLine !== undefined) {
            this.recentLinesBuffer.delete(firstLine);
          }
        }
      }
      // If line is a duplicate, DON'T reset the counter
      // This prevents blank lines from accumulating between duplicate content
    }

    const result = newLines.join("\n");
    const finalNewlineCount = (result.match(/\n/g) || []).length;

    // Check if output STILL has 3+ newlines (would indicate collapse failed)
    const outputBlankRuns = result.match(/\n\n\n+/g);
    if (outputBlankRuns && outputBlankRuns.length > 0) {
      Log.debug(
        `[deduplicateContent] ⚠️ WARNING: Output STILL has ${outputBlankRuns.length} runs of 3+ newlines after collapse!`
      );
      outputBlankRuns.forEach((match, idx) => {
        Log.debug(`  Output run ${idx + 1}: ${match.length} newlines`);
      });
      // Show preview when validation fails
      Log.debug(
        `[deduplicateContent] Output preview:\n"${result.substring(0, 500)}"`
      );
    }

    Log.debug(
      `[deduplicateContent] 🔄 Final: ${finalNewlineCount} newlines, ${newLines.length} lines, blank counter: ${this.consecutiveBlankLines}`
    );

    return result;
  }

  /**
   * Filter TUI chrome from a chunk of text.
   * Uses existing isTuiChromeLine() method for pattern detection.
   */
  private filterTuiChromeFromChunk(text: string): string {
    const lines = text.split(/\r?\n/);
    const filteredLines: string[] = [];
    const removedLines: string[] = [];

    for (const line of lines) {
      // Use existing isTuiChromeLine() method
      if (!this.isTuiChromeLine(line)) {
        filteredLines.push(line);
      } else {
        removedLines.push(line);
      }
    }

    if (removedLines.length > 0) {
      Log.debug(
        `[filterTuiChrome] Removed ${removedLines.length} TUI chrome lines`
      );
    }

    return filteredLines.join("\n");
  }

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
  private processTimeBasedChunk(
    data: string,
    emittedContent: Map<string, number>
  ): void {
    // Phase 1: Strip ANSI codes
    const cleaned = this.stripAnsiCodes(data);

    // Phase 1.5: Strip trailing whitespace from each line (TUI adds padding to terminal width)
    const trimmedLines = cleaned
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join("\n");

    // Phase 2: Filter TUI chrome
    const filtered = this.filterTuiChromeFromChunk(trimmedLines);

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

  /**
   * Process TUI chunk using screen-based extraction (for Claude/Copilot).
   *
   * This is the existing approach that works for line-based TUI output.
   */
  private processScreenBasedChunk(
    screens: string[],
    lastEmittedContent: Map<string, number>,
    lastSanitizedPrompt?: string
  ): void {
    for (const screen of screens) {
      const delta = this.extractNewContent(
        screen,
        lastEmittedContent,
        lastSanitizedPrompt
      );
      if (delta.trim().length > 0) {
        this.config.streamingEmitter.fire(delta);
      }
    }
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
