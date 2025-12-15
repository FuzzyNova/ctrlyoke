import * as vscode from "vscode";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { PromptItem } from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { TempFileManager } from "../../utils/TempFileManager";

/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = "interactive" | "headless";

/**
 * Execution mode constants - single source of truth
 */
export const CLI_EXECUTION_MODE = {
  INTERACTIVE: "interactive" as const,
  HEADLESS: "headless" as const,
};

/**
 * Warning messages - single source of truth
 */
export const CLI_WARNING_MESSAGES = {
  HEADLESS_WITHOUT_PERMISSIONS:
    "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress.",
} as const;

/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI)
 *
 * **Architecture:**
 * Two execution modes with distinct prompt passing mechanisms:
 *
 * **Headless Mode (background process):**
 * - Uses spawn + stdin.write() for prompt passing
 * - No shell escaping issues, works for any prompt size
 * - Process exit = completion signal
 * - Copilot: No -p flag (reads from stdin when not a TTY)
 * - Claude: Requires -p flag (Ink TUI crashes without it)
 *
 * **Interactive Mode (file-based prompt passing):**
 * - Starts CLI in interactive TUI mode (no prompt flags)
 * - Writes fully-expanded prompt to .flightpath/temp/prompt-{uuid}.txt
 * - Sends @file reference via terminal.sendText() (instant, no chunking!)
 * - Detects completion by watching for escape indicator to disappear
 * - Copilot: "(esc to cancel)" disappears when response complete
 * - Claude: "(esc to interrupt)" disappears when response complete
 * - Benefits: No React error #185, works for any prompt size, instant
 *
 * **Context Expansion:**
 * All prompts are pre-processed to expand context references:
 * - @path/to/file → Full file content
 * - #file:path:line-line → Line range with header
 * - #sym:path:symbol → Symbol context
 * This ensures CLI @file references work correctly and fixes Copilot CLI bug
 * where @ references weren't expanded in paste mode.
 *
 * Subclasses implement CLI-specific logic:
 * - Command and argument building
 * - Output parsing (different formats)
 * - Model validation (different supported models)
 * - Tool permissions (different flag syntax)
 * - Escape indicator patterns
 */
export abstract class BaseCliIntegration extends CopilotIntegration {
  protected sessionId?: string;
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  protected outputChannel?: vscode.OutputChannel;
  protected lastResult?: CopilotCliResult;
  protected lastCliCommand?: string;
  protected lastFullPrompt?: string;
  protected currentProcess?: ChildProcess;

  // Interactive terminal mode properties
  protected terminal?: vscode.Terminal;
  protected shellIntegration?: vscode.TerminalShellIntegration;
  protected currentExecution?: vscode.TerminalShellExecution;

  // TUI completion detection - now using execution.read() instead of proposed API
  private readAbortController?: AbortController;

  // Track the file reference sent to terminal for paste detection
  private lastFileReference?: string;
  // Track the sanitized prompt sent to terminal for filtering echo in response
  private lastSanitizedPrompt?: string;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context);
    this.outputChannel = outputChannel;
  }

  // ============================================================
  // EXECUTION MODE HELPERS
  // ============================================================

  /**
   * Get the configured execution mode (interactive or headless)
   */
  protected getExecutionMode(): CliExecutionMode {
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Dispose the current terminal if it exists.
   * This does NOT clear the session ID - that's preserved for potential resume.
   *
   * Call this before starting a new CLI process in interactive mode to ensure
   * we get a fresh terminal. The old terminal output remains visible until
   * the user closes it or the new terminal opens.
   */
  protected disposeTerminalIfExists(): void {
    if (this.terminal) {
      this.log("🗑️ Disposing existing terminal for fresh CLI session");
      this.terminal.dispose();
      this.terminal = undefined;
      this.shellIntegration = undefined;
      this.currentExecution = undefined;
    }
  }

  /**
   * Create a fresh VS Code terminal for interactive execution.
   * Always creates a new terminal, disposing any existing one first.
   *
   * This ensures each CLI invocation starts fresh - the session resume flag
   * handles context continuity at the CLI level, not the terminal level.
   */
  protected async createFreshTerminal(): Promise<vscode.Terminal> {
    // Dispose any existing terminal first
    this.disposeTerminalIfExists();

    this.terminal = vscode.window.createTerminal({
      name: `FlightPath: ${this.getCliName()}`,
      cwd: this.getWorkspaceRoot(),
    });

    return this.terminal;
  }

  /**
   * Wait for shell integration to become available on a terminal
   * @param terminal The terminal to wait for
   * @param timeoutMs Maximum time to wait (default 5 seconds)
   */
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
        reject(new Error("Shell integration not available"));
      }, timeoutMs);

      const disposable = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal === terminal) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(event.shellIntegration);
          }
        }
      );
    });
  }

  /**
   * Wait for TUI to be ready, send prompt, then stream and detect completion.
   *
   * This method:
   * 1. Reads from execution.read() waiting for TUI readiness indicators
   * 2. Once TUI is ready, sends the prompt via sendText
   * 3. Continues reading to detect completion (escape indicator disappearing)
   *
   * TUI readiness is detected by looking for CLI-specific patterns:
   * - Copilot: "Welcome to GitHub Copilot" or the prompt input area
   * - Claude: Similar welcome message or input indicator
   *
   * @param terminal The terminal to send the prompt to
   * @param execution The shell execution to read from
   * @param promptText The prompt text to send once TUI is ready
   * @param timeoutMs Maximum time to wait for completion (defaults to configured CLI execution timeout)
   * @param workflowContext Optional workflow context for temp file naming
   */
  private async waitForTuiAndExecute(
    terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
    promptText: string,
    timeoutMs: number = ConfigurationUtils.getCliExecutionTimeoutMs(),
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    const escapeIndicator = this.getEscapeIndicator().toLowerCase();

    // File processing silence threshold - wait this long with no terminal activity
    // before checking if the file has been read. We use a short timeout (1s) for
    // responsiveness, but verify the file reference was echoed before submitting.
    const FILE_PROCESSING_SILENCE_MS = 1000;

    // File-based approach: Look for the file reference we sent in the terminal echo
    // The file reference is short (@.flightpath/temp/...) and will appear quickly
    let fileReferenceSent = ""; // Will be set after we send the @file reference

    let tuiReady = false;
    let promptTextSent = false; // True after sendText(@file reference) is called
    let promptSubmitted = false; // True after carriage return is sent to submit
    let completed = false;
    let tempFilePath: string | undefined; // Track temp file for cleanup
    let chunkCount = 0;
    let totalBytes = 0;
    let errorDetected = false; // True if CLI error detected in output
    let errorMessage = ""; // Store the detected error message

    // TUI screen buffer - chunks can contain multiple screens or partial screens
    // We accumulate into a buffer and extract complete screens by detecting boundaries
    let screenBuffer = "";
    // Accumulator to track terminal output for file reference echo detection
    let fileEchoBuffer = "";
    let rawPasteBuffer = ""; // RAW buffer with ANSI codes for error detection
    let lastEmittedContent = new Set<string>(); // Track what we've already sent to dashboard
    let indicatorEverSeen = false; // Must see indicator before counting its absence
    let consecutiveNoIndicatorScreens = 0; // Require 2+ screens without indicator

    // Check if file reference has been echoed back by the CLI
    // This confirms the CLI received and is processing the @file reference
    const isFileReferenceEchoed = (): boolean => {
      if (!fileReferenceSent) {
        return false;
      }

      const bufferLower = fileEchoBuffer.toLowerCase();
      const fileRefLower = fileReferenceSent.toLowerCase();

      if (bufferLower.includes(fileRefLower)) {
        this.log(
          `🔍 File reference verified: found "${fileReferenceSent}" in terminal echo`
        );
        return true;
      }

      return false;
    };

    // Check if CLI has crashed with an error in the output
    // We check the RAW buffer (with ANSI codes) to ensure we capture complete error text
    const detectCliError = (rawBuffer: string): boolean => {
      // TUI chrome pattern - CLI-specific pattern that marks the bottom of the TUI
      // Real errors appear AFTER this chrome with NO chrome following them
      // False positives (errors in pasted text) have chrome BOTH before AND after
      const tuiChromePattern = this.getTuiChromePattern();

      // Error patterns that indicate CLI crash
      const errorPatterns = [
        /Error: Minified React error #\d+/i, // React errors (Claude CLI)
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
            // No chrome before error - likely not a real CLI error (or very early in stream)
            this.log(
              `⚠️ [FALSE POSITIVE] Error pattern found but no TUI chrome before it - likely prompt echo`
            );
            continue;
          }

          // Check if there's TUI chrome AFTER the error
          const afterError = rawBuffer.substring(
            errorStartIndex + errorMatch[0].length
          );
          const chromeAfterMatch = afterError.match(tuiChromePattern);

          if (chromeAfterMatch) {
            // Chrome appears both before AND after - error is inside TUI (prompt echo)
            this.log(
              `⚠️ [FALSE POSITIVE] Error pattern surrounded by TUI chrome - this is pasted prompt content, not a real error`
            );
            continue;
          }

          // Real error: chrome before, no chrome after
          // Extract full error with complete stack trace from RAW output
          const errorWithStack = /Error:[^\n]+(?:\n\s+at\s+[^\n]+)*/i.exec(
            rawBuffer.substring(errorStartIndex)
          );

          if (errorWithStack) {
            // Strip ANSI codes from the captured error block for clean display
            const rawError = errorWithStack[0];
            errorMessage = this.stripAnsiCodes(rawError);
            this.log(
              `❌ [REAL ERROR DETECTED] CLI crashed after TUI chrome with no chrome following:`
            );
            this.log(errorMessage);
            return true;
          }

          // Fallback: if regex didn't capture stack, just get the error line
          const errorLineMatch = /Error:[^\n]+/.exec(
            rawBuffer.substring(errorStartIndex)
          );
          if (errorLineMatch) {
            errorMessage = this.stripAnsiCodes(errorLineMatch[0]);
            this.log(
              `❌ [REAL ERROR DETECTED] CLI crashed (no stack trace captured):`
            );
            this.log(errorMessage);
            return true;
          }
        }
      }
      return false;
    };

    // Dynamic paste completion detection - submit prompt after terminal output settles
    // AND we can verify the paste actually happened
    let submissionTimeoutId: NodeJS.Timeout | undefined;
    const startSubmissionTimer = () => {
      if (submissionTimeoutId) {
        this.log(
          `⏳ [SUBMISSION TIMER] Clearing previous timer (new chunk received, restarting ${FILE_PROCESSING_SILENCE_MS}ms silence counter)`
        );
        clearTimeout(submissionTimeoutId);
      } else {
        this.log(
          `⏳ [SUBMISSION TIMER] Starting new timer (${FILE_PROCESSING_SILENCE_MS}ms to submission)`
        );
      }
      submissionTimeoutId = setTimeout(() => {
        this.log(
          `⏳ [SUBMISSION TIMER] Fired! Checking file echo (promptTextSent=${promptTextSent}, promptSubmitted=${promptSubmitted}, echoBufferLen=${fileEchoBuffer.length})`
        );
        if (promptTextSent && !promptSubmitted) {
          // Verify file reference was echoed before submitting
          if (isFileReferenceEchoed()) {
            this.log(
              `📤 ✅ File read verified (${FILE_PROCESSING_SILENCE_MS / 1000}s silence + verified). Sending carriage return (\\r) to submit...`
            );
            // Copilot CLI uses Ink TUI framework which expects raw terminal mode input.
            // In raw mode, Enter key sends \r (carriage return), not \n (newline).
            terminal.sendText("\r", true);
            promptSubmitted = true;
            this.log(
              `📤 ✅ Carriage return (\\r) sent to terminal. Waiting for response...`
            );
          } else {
            // Silence detected but file reference echo not found yet - keep waiting
            this.log(
              `⏳ [FILE ECHO PENDING] Silence detected (${FILE_PROCESSING_SILENCE_MS}ms) but file reference not yet echoed. bufferLen=${fileEchoBuffer.length}`
            );
            this.log(
              `⏳ [FILE ECHO DEBUG] Looking for: "${fileReferenceSent}"`
            );
            this.log(
              `⏳ [FILE ECHO DEBUG] Last 150 chars: ${fileEchoBuffer.slice(-150).replace(/\n/g, "\\n")}`
            );
            this.log(
              `⏳ [FILE ECHO DEBUG] Waiting for next chunk to restart timer...`
            );
            // Don't restart timer here - we'll restart when next chunk arrives
          }
        }
      }, FILE_PROCESSING_SILENCE_MS);
    };

    // Create abort controller for timeout/cancellation
    this.readAbortController = new AbortController();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      this.log("⏱️ TUI execution timed out");
      this.readAbortController?.abort();
    }, timeoutMs);

    try {
      this.log("📺 Starting terminal output streaming via read()...");
      this.log(`🔍 Waiting for TUI ready (screen end pattern to appear)...`);

      for await (const data of execution.read()) {
        // Check for abort
        if (this.readAbortController?.signal.aborted) {
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
        // NOTE: This may trigger on prompt echo if attached files contain error strings
        // We'll log the raw data to identify patterns that distinguish real crashes
        if (!errorDetected && detectCliError(data)) {
          errorDetected = true;
          this.log(
            `❌ [ERROR ABORT] CLI error detected in output - aborting immediately`
          );
          this.log(
            `❌ [ERROR TRIGGER] Full raw data chunk that triggered detection:`
          );
          this.log(data); // Log entire triggering chunk for analysis
          // Abort the read stream immediately to stop processing
          this.readAbortController?.abort();
          break; // Exit the for-await loop
        }

        // Extract complete screens from buffer using CLI-specific screen end pattern
        // If we get any complete screens, the TUI is ready (screen end pattern matched)
        const { screens, remainder } =
          this.extractScreensFromBuffer(screenBuffer);
        screenBuffer = remainder;

        // Process each complete screen
        for (const screen of screens) {
          const screenLower = screen.toLowerCase();

          // Phase 1: First complete screen means TUI is ready - send prompt via @file reference
          if (!tuiReady) {
            this.log("✅ TUI is ready (first complete screen detected)");
            tuiReady = true;

            // Small delay to ensure TUI is fully interactive
            await this.delay(500);

            // File-based prompt passing - write to temp file and send @file reference
            // This eliminates React error #185 issues and is instant (no chunking delays)
            this.log(
              `📁 Sending prompt via @file reference (${promptText.length} chars)...`
            );

            // Write prompt to temp file (will be cleaned up in finally block)
            const workspaceRoot = this.getWorkspaceRoot();
            if (!workspaceRoot) {
              throw new Error("No workspace root available for temp file");
            }

            const tempMgr = new TempFileManager(workspaceRoot);
            tempFilePath = await tempMgr.createPromptFile(
              promptText,
              workflowContext?.filePath,
              workflowContext ? workflowContext.promptIndex + 1 : undefined
            );
            const relativeFilePath = tempMgr.getRelativePath(tempFilePath);

            this.log(`📁 Temp file created: ${relativeFilePath}`);

            // Send @file reference to CLI (instant, no chunking!)
            const fileReference = `@${relativeFilePath}`;
            terminal.sendText(fileReference, false);
            promptTextSent = true;

            // Store the file reference for verification
            fileReferenceSent = fileReference;
            this.lastFileReference = fileReference;
            this.log(
              `📁 ✅ File reference sent. Waiting for CLI to read file...`
            );

            // Start the submission timer to submit after file has been read
            // The timer will be reset on each chunk received while CLI processes the file
            this.log(
              `⏳ Entering file read detection phase. Will submit after ${FILE_PROCESSING_SILENCE_MS}ms of silence.`
            );
            startSubmissionTimer();
          }

          // Reset submission timer on each chunk while waiting for file to be processed
          // This ensures we don't submit until the terminal has been quiet for the threshold
          if (promptTextSent && !promptSubmitted) {
            this.log(
              `⏳ [FILE FLOW] Screen processed, restarting silence timer (will fire if no more chunks for ${FILE_PROCESSING_SILENCE_MS}ms)`
            );
            startSubmissionTimer();
          }

          // Phase 2: After prompt submitted, detect completion and emit deltas
          if (promptSubmitted) {
            // Extract and emit new content (delta from this screen)
            const delta = this.extractNewContent(
              screen,
              lastEmittedContent,
              this.lastSanitizedPrompt
            );
            if (delta.trim().length > 0) {
              this.streamingChunkEmitter.fire(delta);
              // Also append filtered delta to output channel (not raw TUI data)
              if (this.shouldShowOutput()) {
                this.outputChannel?.append(delta);
              }
            }

            // Check for escape indicator in this screen
            const hasIndicator = screenLower.includes(escapeIndicator);

            if (hasIndicator) {
              // CLI is actively generating - reset counter and mark that we've seen it
              if (!indicatorEverSeen) {
                this.log(
                  `🔍 [Screen] First indicator seen - CLI is now processing`
                );
              }
              indicatorEverSeen = true;
              consecutiveNoIndicatorScreens = 0;
            } else if (indicatorEverSeen) {
              // Only count absence after we've seen it at least once
              consecutiveNoIndicatorScreens++;
              this.log(
                `🔍 [Screen] No indicator, consecutiveNoIndicator=${consecutiveNoIndicatorScreens}`
              );

              // Require 2+ consecutive complete screens without indicator
              if (consecutiveNoIndicatorScreens >= 2) {
                this.log(
                  `✅ Response complete (no indicator for ${consecutiveNoIndicatorScreens} consecutive screens)`
                );
                completed = true;
                break;
              }
            }
            // If !indicatorEverSeen && !hasIndicator, we're still waiting for CLI to start processing
          }
        }

        if (completed) {
          break;
        }
      }

      // Clear the submission timer if still pending
      if (submissionTimeoutId) {
        this.log(
          `⏳ [CLEANUP] Clearing pending submission timer (stream ended)`
        );
        clearTimeout(submissionTimeoutId);
      }
      clearTimeout(timeoutId);

      // Process any remaining content in the buffer (e.g., error messages without status bar)
      if (promptSubmitted && screenBuffer.trim().length > 0) {
        this.log(
          `📺 [REMAINDER] Processing ${screenBuffer.length} chars remaining in buffer (may contain errors/incomplete output)`
        );
        const delta = this.extractNewContent(
          screenBuffer,
          lastEmittedContent,
          this.lastSanitizedPrompt
        );
        if (delta.trim().length > 0) {
          this.log(
            `📺 [REMAINDER] Emitting ${delta.length} chars from remainder buffer`
          );
          this.streamingChunkEmitter.fire(delta);
        }
      }

      this.log(
        `📺 Streaming complete: ${chunkCount} chunks, ${totalBytes} bytes | State: tuiReady=${tuiReady}, promptTextSent=${promptTextSent}, promptSubmitted=${promptSubmitted}, completed=${completed}`
      );
      this.log(
        `📺 [FILE FLOW SUMMARY] Final state: Did we submit \\r? ${promptSubmitted} | Did response complete? ${completed} | Error detected? ${errorDetected}`
      );

      // Handle CLI errors detected during execution
      if (errorDetected) {
        this.log(
          `❌ CLI error detected - disposing terminal to stop paste, switching to dashboard`
        );
        // Emit full error message to dashboard FIRST (before disposing terminal)
        this.streamingChunkEmitter.fire(
          `\n❌ CLI Error Detected:\n\n${errorMessage}\n\n` +
            "The CLI crashed during execution. Terminal disposed to prevent further paste operations.\n"
        );
        // Try to open/focus FlightPath panel so user sees the error
        try {
          await vscode.commands.executeCommand("flightpath.openPanel");
        } catch (err) {
          // Ignore if command fails - error is still logged to output channel
          this.log(`⚠️ Could not focus FlightPath panel: ${err}`);
        }
        // Small delay to ensure dashboard message is visible before terminal closes
        await this.delay(100);
        // Dispose terminal to stop paste into crashed CLI
        this.disposeTerminalIfExists();
        this.responseCompleteEmitter.fire("CLI error");
        return false;
      }

      if (completed) {
        this.responseCompleteEmitter.fire("Response complete");
        return true;
      } else if (promptSubmitted) {
        // Stream ended after prompt was submitted - treat as success
        this.log(
          "⚠️ Stream ended after prompt submitted - treating as success"
        );
        this.responseCompleteEmitter.fire("Stream ended");
        return true;
      } else if (promptTextSent) {
        // File reference was sent but not yet submitted (file still being processed?)
        this.log("⚠️ Stream ended during file processing - may be incomplete");
        this.responseCompleteEmitter.fire(
          "Stream ended during file processing"
        );
        return false;
      } else {
        // TUI never became ready
        this.log("❌ TUI never became ready");
        this.responseCompleteEmitter.fire("TUI not ready");
        return false;
      }
    } catch (error) {
      if (submissionTimeoutId) {
        clearTimeout(submissionTimeoutId);
      }
      clearTimeout(timeoutId);

      // AbortError is expected on timeout/cancel
      if (error instanceof Error && error.name === "AbortError") {
        if (promptSubmitted) {
          this.responseCompleteEmitter.fire("Timeout after prompt submitted");
          return true; // Treat as success if prompt was submitted
        }
        this.responseCompleteEmitter.fire("Timeout");
        return false;
      }

      this.log(`❌ Stream error: ${error}`);
      this.streamingChunkEmitter.fire(
        `\n❌ Error capturing output: ${error}\n` +
          "   Please view the terminal window for the output.\n"
      );
      return false;
    } finally {
      this.readAbortController = undefined;

      // Cleanup temp prompt file if it was created
      if (tempFilePath) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFile(tempFilePath);
          this.log(`🗑️ Cleaned up temp file: ${tempFilePath}`);
        }
      }
    }
  }

  /**
   * Strip ANSI escape codes and terminal control sequences from output for clean display.
   *
   * This is surgical - only removes actual terminal control sequences, not content.
   * Preserves all printable characters including markdown formatting (*, #, `, etc.)
   */
  protected stripAnsiCodes(text: string): string {
    return (
      text
        // OSC sequences: \x1B] ... terminated by BEL (\x07) or ST (\x1B\\)
        .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
        // CSI sequences: \x1B[ followed by parameters and command letter
        // This includes cursor movement, colors, etc. but NOT printable content
        .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
        // Other escape sequences: \x1B followed by single character (not [)
        .replace(/\x1B[@-Z\\-_]/g, "")
        // Standalone BEL character (used in some terminals)
        .replace(/\x07/g, "")
        // Clean up excessive newlines but preserve paragraph breaks
        .replace(/\n{4,}/g, "\n\n\n")
    );
  }

  /**
   * Extract complete TUI screens from a buffer.
   *
   * TUI apps redraw the entire screen each frame. Chunks from execution.read()
   * can contain multiple complete screens OR partial screens. We need to:
   * 1. Accumulate chunks into a buffer
   * 2. Detect screen boundaries (the status bar "Ctrl+c Exit" pattern marks end of screen)
   * 3. Return complete screens and the remaining partial buffer
   *
   * @param buffer The accumulated buffer of TUI output
   * @returns Object with array of complete screens and remaining buffer
   */
  private extractScreensFromBuffer(buffer: string): {
    screens: string[];
    remainder: string;
  } {
    const screens: string[] = [];

    // Screen boundary marker - CLI-specific pattern that marks end of each TUI frame
    const screenEndPattern = this.getScreenEndPattern();

    let lastIndex = 0;
    let match;

    // Find all complete screens (ending with the status bar)
    while ((match = screenEndPattern.exec(buffer)) !== null) {
      // Extract the complete screen (from last boundary to this one, inclusive)
      const screenEnd = match.index + match[0].length;
      const screen = buffer.substring(lastIndex, screenEnd);

      if (screen.trim().length > 0) {
        screens.push(screen);
      }

      lastIndex = screenEnd;
    }

    // Everything after the last complete screen is the remainder (partial screen)
    const remainder = buffer.substring(lastIndex);

    return { screens, remainder };
  }

  /**
   * Extract new content from a screen that hasn't been emitted yet.
   *
   * Uses a smarter approach to deduplication:
   * - Preserves empty lines (important for code blocks and formatting)
   * - Only filters TUI chrome, not content
   * - Tracks content by trimmed line for dedup, but preserves original formatting
   * - Filters out the prompt echo (already shown in Prompt section)
   * - Collapses consecutive blank lines to maximum of 2
   *
   * @param screen The current screen content
   * @param emittedContent Set of content lines already emitted (normalized)
   * @param promptToFilter Optional prompt text to filter from the response (for echo removal)
   * @returns New content to emit (modifies emittedContent set)
   */
  private extractNewContent(
    screen: string,
    emittedContent: Set<string>,
    promptToFilter?: string
  ): string {
    const lines = screen.split(/\r?\n/);
    const newLines: string[] = [];
    let consecutiveBlankLines = 0;

    // Build set of prompt lines for efficient filtering (normalize for comparison)
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

      // Skip prompt echo lines (already shown in Prompt section)
      if (trimmed.length > 0 && promptLines.has(trimmed)) {
        continue;
      }

      // For deduplication, use normalized (trimmed) version
      // But preserve original line formatting in output
      const dedupKey = trimmed;

      // Skip if we've already emitted this content line
      // Empty lines are NOT deduplicated (always pass through, but limited)
      if (dedupKey.length > 0 && emittedContent.has(dedupKey)) {
        continue;
      }

      // Handle blank line collapsing (max 2 consecutive blank lines)
      if (trimmed.length === 0) {
        consecutiveBlankLines++;
        if (consecutiveBlankLines <= 2) {
          newLines.push(line);
        }
        // Skip blank lines beyond 2
        continue;
      } else {
        // Reset counter on non-blank line
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

    // Join with newlines and add trailing newline
    return newLines.join("\n") + "\n";
  }

  /**
   * Check if a line is TUI chrome (borders, prompts, status) that should be filtered.
   *
   * Patterns are specific to match complete TUI elements, not content fragments.
   * Avoids matching markdown headers (#), code fences (```), or horizontal rules (---).
   */
  private isTuiChromeLine(line: string): boolean {
    const trimmed = line.trim();

    // Empty or whitespace-only lines - keep them (preserve formatting)
    if (trimmed.length === 0) {
      return false;
    }

    const chromPatterns = [
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing only (8+ chars to avoid false positives)
      /Ctrl\+[a-z]\s+\w+.*Ctrl\+/i, // Multiple keyboard shortcuts (status bar pattern)
      /^Enter @ to mention/i, // Copilot prompt hint at start of line
      /^\(Esc to cancel\)/i, // Exact thinking indicator
      /^\(Esc to interrupt\)/i, // Exact Claude thinking indicator
      /^>\s*$/, // Empty prompt only
      /^[∙◉◎●]\s*$/, // Spinner alone
      /^Thinking\s*\([^)]*\)\s*$/i, // Complete thinking status line
      /^⎇\s+\w+\*?\s*[│|]\s*gpt-/i, // Git branch + model (status bar combo)
      /^\d+x\)\s*$/, // Exact token multiplier pattern
      /^Welcome to (GitHub Copilot|Claude)/i, // Welcome messages
    ];

    return chromPatterns.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Get the CLI name for terminal/logging (e.g., "copilot" or "claude")
   */
  protected abstract getCliName(): string;

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Used to warn users when running headless without full permissions
   */
  protected abstract hasFullPermissions(): boolean;

  /**
   * Get the escape indicator pattern for TUI completion detection.
   * This text appears while the CLI is generating a response.
   * When it disappears, the response is complete.
   *
   * Copilot: "(esc to cancel)"
   * Claude: "(esc to interrupt)"
   */
  protected abstract getEscapeIndicator(): string;

  /**
   * Get the TUI chrome pattern for error context detection.
   * This pattern identifies the bottom border/status area of the TUI.
   * Used to distinguish real CLI errors from error text in pasted content.
   *
   * Real errors appear AFTER the chrome with NO chrome following.
   * False positives (errors in pasted content) have chrome BEFORE and AFTER.
   *
   * Copilot: "Ctrl+c Exit" in the status bar
   * Claude: "? for shortcuts" or "ctrl-g to edit prompt" during paste
   */
  protected abstract getTuiChromePattern(): RegExp;

  /**
   * Get the regex pattern that marks the end of a TUI screen.
   * Used to split the output buffer into complete screen frames.
   *
   * TUI apps redraw the entire screen each frame. This pattern identifies
   * where each complete screen ends so we can:
   * 1. Parse complete screens from the buffer
   * 2. Check each screen for completion indicators
   * 3. Extract meaningful content deltas
   *
   * Copilot: "Ctrl+c Exit · Ctrl+r Expand recent" (status bar)
   * Claude: Line of dashes followed by "> " prompt
   */
  protected abstract getScreenEndPattern(): RegExp;

  /**
   * Build headless CLI arguments with temp file reference.
   * The prompt has been written to a temp file, and this method
   * should add the appropriate flag to reference it.
   *
   * @param baseArgs The base CLI arguments
   * @param promptFileRef The @-prefixed relative file reference (e.g., "@.flightpath/temp/prompt-123.md")
   * @returns Args array for headless mode with prompt file reference
   */
  protected abstract buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[];

  /**
   * Determine if stdout should be streamed in real-time during headless execution.
   *
   * By default, returns true to stream output as it arrives.
   * Subclasses can override to return false if the raw output format is not
   * human-readable (e.g., JSON), and instead emit parsed content after completion.
   *
   * @returns true to stream stdout chunks in real-time, false to buffer until complete
   */
  protected shouldStreamHeadlessOutput(): boolean {
    return true;
  }

  /**
   * Process a stdout chunk before streaming to the dashboard.
   *
   * By default, passes the chunk through as-is.
   * Subclasses can override to parse/transform the chunk (e.g., extract content from JSON).
   *
   * @param chunk The raw stdout chunk
   * @returns The processed chunk to emit, or undefined to skip emission
   */
  protected processStreamingChunk(chunk: string): string | undefined {
    return chunk;
  }

  /**
   * Build interactive TUI command to start the CLI in interactive mode.
   * Should NOT include the prompt - it will be sent via sendText().
   *
   * @param baseArgs The base CLI arguments
   * @returns The command to start the interactive TUI
   */
  protected abstract buildInteractiveTuiCommand(baseArgs: string[]): string;

  // ============================================================
  // INTERACTIVE TUI EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in interactive TUI mode.
   *
   * Strategy:
   * 1. Dispose any existing terminal (CLI may be running in it)
   * 2. Create fresh terminal and start CLI in interactive mode
   * 3. Wait for TUI to be ready (delay-based, simple)
   * 4. Send prompt via terminal.sendText() (no length limits!)
   * 5. Stream output via execution.read() and detect completion
   *
   * Session continuity is handled via --resume flag in CLI args, not by
   * reusing the same terminal. Each execution starts a fresh CLI process.
   *
   * Completion detection uses the stable TerminalShellExecution.read() API
   * to watch for the escape indicator to disappear from recent output.
   *
   * @param args The CLI arguments (WITHOUT prompt, but WITH --resume if session should continue)
   * @param promptText The prompt text (will be sent via sendText)
   * @param workflowContext Optional workflow context for temp file naming
   * @returns Promise<boolean> indicating success
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

    this.log(`🎮 [TRACE] executeInTerminal called`);
    this.log(`🎮 [TRACE] tuiCommand: ${tuiCommand}`);
    this.log(
      `🎮 [TRACE] promptText (first 50 chars): ${promptText.substring(0, 50)}`
    );
    this.log(`📝 Prompt length: ${promptText.length} characters`);

    // Always create a fresh terminal to ensure clean CLI state
    // The old terminal may have a CLI process still running in interactive mode,
    // and sending a new command would paste into that session instead of starting fresh.
    // Session continuity is handled via --resume flag, not terminal reuse.
    this.log(`🎮 [TRACE] Creating fresh terminal...`);
    const terminal = await this.createFreshTerminal();
    this.log(`🎮 [TRACE] Got fresh terminal, showing it...`);
    terminal.show();

    // Fire prompt ready event
    this.log(`🎮 [TRACE] Firing promptReadyEmitter...`);
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    this.streamingChunkEmitter.fire(
      "📺 Interactive TUI mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    try {
      // Wait for shell integration (needed for executeCommand and read())
      this.log(`🎮 [TRACE] Waiting for shell integration...`);
      const shellIntegration = await this.waitForShellIntegration(terminal);
      this.shellIntegration = shellIntegration;
      this.log(`🎮 [TRACE] Got shell integration`);

      // Use executeCommand to get an execution object for read() streaming
      // Note: executeCommand queues internally, so we wait for TUI output before sending prompt
      this.log(
        `🎮 [TRACE] Calling shellIntegration.executeCommand("${tuiCommand}")`
      );
      const execution = shellIntegration.executeCommand(tuiCommand);
      this.currentExecution = execution;
      this.log(`🎮 [TRACE] executeCommand returned, got execution object`);

      // Wait for TUI to be ready by watching for output that indicates Copilot has started
      // Then send the prompt and continue streaming for completion detection
      this.log("⏳ Waiting for TUI to be ready (watching for output)...");
      const success = await this.waitForTuiAndExecute(
        terminal,
        execution,
        promptText,
        ConfigurationUtils.getCliExecutionTimeoutMs(),
        workflowContext
      );

      return success;
    } catch (error) {
      this.log(`❌ TUI execution error: ${error}`);
      throw error;
    }
  }

  /**
   * Simple delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================
  // HEADLESS PROCESS EXECUTION WITH STDIN
  // ============================================================

  /**
   * Execute a CLI command in headless mode using temp file for prompt passing.
   *
   * Strategy:
   * 1. Write fully-expanded prompt to temp file
   * 2. Spawn CLI process with @temp-file or --prompt @temp-file parameter
   * 3. Wait for process to complete
   * 4. Cleanup temp file
   *
   * Benefits over stdin approach:
   * - Copilot: Allows agent specification with --prompt flag
   * - Claude: Avoids auto-expansion of @path references (no duplicates)
   * - Codex: Supports all CLIs (codex doesn't support stdin)
   * - Unified: Same approach for interactive and headless modes
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to temp file)
   * @param workflowContext Optional workflow context for temp file naming
   * @param executeCallback Callback for CLI-specific result handling
   * @returns Promise<boolean> indicating success
   */
  protected async executeHeadlessWithPromptFile(
    args: string[],
    promptText: string,
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: PromptItem[];
          filePath?: string;
        }
      | undefined,
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for temp file");
    }
    const tempMgr = new TempFileManager(workspaceRoot);
    let tempFilePath: string | undefined;

    try {
      // Create temp file with workflow context for meaningful filename
      tempFilePath = await tempMgr.createPromptFile(
        promptText,
        workflowContext?.filePath,
        workflowContext ? workflowContext.promptIndex + 1 : undefined
      );
      const relativeFilePath = tempMgr.getRelativePath(tempFilePath);
      this.log(`📝 Created temp file: ${relativeFilePath}`);

      // Build args with temp file reference
      const headlessArgs = this.buildHeadlessArgs(args, `@${relativeFilePath}`);
      const displayCommand = `${this.getCliName()} ${headlessArgs.join(" ")}`;

      this.log(`🚀 Starting headless mode with file: ${displayCommand}`);
      this.log(`📝 Prompt length: ${promptText.length} characters`);

      // Store for debugging
      this.lastCliCommand = displayCommand;

      // Fire prompt ready event
      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: displayCommand,
      });

      // Check if we should stream output in real-time
      const shouldStream = this.shouldStreamHeadlessOutput();

      // Spawn and execute (no stdin needed)
      const result = await this.spawnProcess(this.getCliName(), headlessArgs, {
        timeout: ConfigurationUtils.getCliExecutionTimeoutMs(),
        onStdout: shouldStream
          ? (chunk) => {
              const processedChunk = this.processStreamingChunk(chunk);
              if (processedChunk !== undefined) {
                this.streamingChunkEmitter.fire(processedChunk);
              }
            }
          : undefined,
      });

      // Check for cancellation
      if (this.isCancelling) {
        this.log("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Delegate result handling to subclass
      return await executeCallback(result);
    } catch (error) {
      this.log(`❌ Headless execution error: ${error}`);
      return false;
    } finally {
      // Cleanup temp file
      if (tempFilePath) {
        await tempMgr.deleteFile(tempFilePath);
        this.log(`🗑️ Cleaned up temp file`);
      }
    }
  }

  /**
   * Spawn a child process for headless CLI execution.
   * Prompt is passed via command line argument (temp file reference).
   *
   * @param command The command to run
   * @param args Command arguments (including prompt file reference)
   * @param options Timeout and streaming options
   */
  protected spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      this.log(`📤 Spawning: ${command} ${args.join(" ")}`);

      // Spawn WITH shell for PATH resolution (needed on Windows especially)
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required for PATH resolution of copilot/claude commands
        stdio: ["ignore", "pipe", "pipe"], // No stdin needed, pipe stdout/stderr
        env: { ...process.env },
      });

      // Store reference for cancellation
      this.currentProcess = child;

      // Handle stdout
      child.stdout.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.onStdout) {
          options.onStdout(chunk);
        }
      });

      // Handle stderr
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle errors
      child.on("error", (error) => {
        this.log(`❌ Process error: ${error}`);
        this.currentProcess = undefined;
        reject(error);
      });

      // Handle completion
      child.on("close", (code) => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.log(`✅ Process exited with code: ${code}`);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          if (this.currentProcess === child) {
            child.kill();
            this.currentProcess = undefined;
            reject(new Error(`Process timeout after ${options.timeout}ms`));
          }
        }, options.timeout);
      }
    });
  }

  /**
   * Spawn a simple command (like --version checks) without stdin.
   * Uses shell: true for PATH resolution.
   */
  protected spawnSimpleCommand(
    command: string,
    args: string[],
    timeoutMs: number = 5000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true,
        env: { ...process.env },
      });

      child.stdout.on("data", (data) => (stdout += data.toString()));
      child.stderr.on("data", (data) => (stderr += data.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      );

      setTimeout(() => {
        child.kill();
        reject(new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  // ============================================================
  // LOGGING HELPERS
  // ============================================================

  /**
   * Log message to both console and output channel (if enabled)
   */
  protected log(message: string): void {
    console.log(message);
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine(message);
    }
  }

  /**
   * Check if output should be shown in Output panel
   */
  protected shouldShowOutput(): boolean {
    return ConfigurationUtils.shouldShowCliOutput();
  }

  /**
   * Log prompt to output channel with formatting
   */
  protected logPrompt(promptText: string): void {
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine("");
      this.outputChannel?.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel?.appendLine(
        `[PROMPT] ${new Date().toLocaleTimeString()}`
      );
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine(promptText);
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine("");
    }
  }

  /**
   * Log response to output channel with formatting
   */
  protected logResponse(response: string, statistics?: string): void {
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine(
        `[RESPONSE] ${new Date().toLocaleTimeString()}`
      );
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine(response);
      if (statistics) {
        this.outputChannel?.appendLine("");
        this.outputChannel?.appendLine("[STATISTICS]");
        this.outputChannel?.appendLine(statistics);
      }
      this.outputChannel?.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel?.appendLine("");
    }
  }

  // ============================================================
  // WORKSPACE HELPERS
  // ============================================================

  /**
   * Get workspace directories for --add-dir flag
   */
  protected getWorkspaceDirs(): string[] {
    const configured = ConfigurationUtils.getCliAllowedDirs();
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
    return [...workspaceDirs, ...configured];
  }

  // ============================================================
  // RESULT ACCESSORS
  // ============================================================

  /**
   * Get the last CLI result
   */
  getLastResult(): CopilotCliResult | undefined {
    return this.lastResult;
  }

  /**
   * Get the last CLI command executed
   */
  getLastCliCommand(): string | undefined {
    return this.lastCliCommand;
  }

  /**
   * Get the full prompt text sent to CLI
   */
  getLastFullPrompt(): string | undefined {
    return this.lastFullPrompt;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize CLI by checking availability via --version command.
   * Subclasses can override for custom initialization logic.
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      const result = await this.spawnSimpleCommand(
        this.getCliName(),
        ["--version"],
        5000
      );

      if (result.exitCode === 0) {
        const version = result.stdout.trim();
        console.log(`✅ ${this.getCliName()} CLI available:`, version);
        this.log(`✅ ${this.getCliName()} CLI available: ${version}`);
        this.isAvailable = true;
        this.initializationStatus = CopilotStatus.Ready;
        this.statusChangeEmitter.fire(CopilotStatus.Ready);
      } else {
        this.handleInitializationError("command_failed", result.stderr);
      }
    } catch (error) {
      this.handleInitializationError("exception", error);
    }
  }

  /**
   * Handle initialization errors with logging.
   * Subclasses can override for custom error messages.
   */
  protected handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = CopilotStatus.Unavailable;
    this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${this.getCliName()} CLI not available:`, errorMessage);
    this.log(`❌ ${this.getCliName()} CLI unavailable: ${errorMessage}`);
  }

  /**
   * Show warning when running in headless mode without full permissions
   */
  protected warnIfHeadlessWithoutPermissions(): void {
    const mode = this.getExecutionMode();
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        CLI_WARNING_MESSAGES.HEADLESS_WITHOUT_PERMISSIONS
      );
    }
  }

  // ============================================================
  // STATUS METHODS
  // ============================================================

  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  isReady(): boolean {
    return this.initializationStatus === CopilotStatus.Ready;
  }

  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  isCli(): boolean {
    return true;
  }

  // ============================================================
  // CANCELLATION
  // ============================================================

  /**
   * Cancel the current CLI process
   */
  protected async cancelImplementation(): Promise<void> {
    // Handle interactive terminal execution
    if (this.currentExecution && this.terminal) {
      this.log("⏹️ Sending Ctrl+C to terminal...");
      this.terminal.sendText("\x03");
      this.currentExecution = undefined;
      this.log("✅ Terminal execution cancelled");
    }

    // Abort any active read() streaming
    if (this.readAbortController) {
      this.readAbortController.abort();
      this.readAbortController = undefined;
    }

    // Handle headless process execution
    if (this.currentProcess) {
      this.log("⏹️ Cancelling CLI process...");
      this.currentProcess.kill();
      this.currentProcess = undefined;
      this.log("✅ CLI process cancelled");
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    if (this.readAbortController) {
      this.readAbortController.abort();
      this.readAbortController = undefined;
    }
    this.shellIntegration = undefined;
    this.currentExecution = undefined;
  }

  // ============================================================
  // STATUS METHODS (CONTINUED)
  // ============================================================

  /**
   * Get integration status.
   * Subclasses can override getCliDisplayName() and getInstallCommand() for custom messages.
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: `✅ ${this.getCliDisplayName()} available`,
        strategy: this.getIntegrationMode(),
      };
    } else {
      return {
        available: false,
        message: `❌ ${this.getCliDisplayName()} unavailable - ${this.getInstallHint()}`,
        strategy: this.getIntegrationMode(),
      };
    }
  }

  /**
   * Parse pattern: toolName or toolName(args)
   * Returns [toolName, args] or null if invalid
   */
  protected parseToolPattern(pattern: string): [string, string?] | null {
    const match = pattern.match(/^(\w+)(\(.+\))?$/);
    if (!match) {
      return null;
    }
    const [, toolName, args] = match;
    return args ? [toolName, args] : [toolName];
  }

  // ============================================================
  // ABSTRACT METHODS
  // ============================================================

  /**
   * Get the CLI-specific integration mode string (e.g., "copilot-cli")
   */
  protected abstract getIntegrationMode(): string;

  /**
   * Get display name for status messages (e.g., "Copilot CLI", "Claude Code CLI")
   */
  protected abstract getCliDisplayName(): string;

  /**
   * Get installation hint for unavailable CLI
   */
  protected abstract getInstallHint(): string;

  /**
   * Parse token counts from statistics string
   */
  abstract parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined;
}
