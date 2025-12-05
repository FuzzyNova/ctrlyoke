import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

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
 * **Interactive Mode (TUI injection):**
 * - Starts CLI in interactive TUI mode (no prompt flags)
 * - Sends prompt via terminal.sendText() as "keyboard input"
 * - Detects completion by watching for escape indicator to disappear
 * - Copilot: "(esc to cancel)" disappears when response complete
 * - Claude: "(esc to interrupt)" disappears when response complete
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
   * Get or create a VS Code terminal for interactive execution
   */
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

  /**
   * Check if the terminal has been closed
   */
  private isTerminalClosed(): boolean {
    return !this.terminal || this.terminal.exitStatus !== undefined;
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
   */
  private async waitForTuiAndExecute(
    terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
    promptText: string,
    timeoutMs: number = ConfigurationUtils.getCliExecutionTimeoutMs()
  ): Promise<boolean> {
    const escapeIndicator = this.getEscapeIndicator().toLowerCase();

    // Paste silence threshold - wait this long with no terminal activity before checking
    // if paste is complete. We use a short timeout (1s) for responsiveness, but verify
    // the paste actually happened before submitting.
    const PASTE_SILENCE_THRESHOLD_MS = 1000;

    // Extract the last N characters of the prompt for verification
    // This helps detect if the paste actually completed (vs initial silence before paste)
    const PROMPT_TAIL_LENGTH = 50;
    const promptTail = promptText.slice(-PROMPT_TAIL_LENGTH).toLowerCase();

    // Both CLIs collapse large pastes into indicator patterns:
    // - Copilot: "[Paste #1 - 2987 lines]"
    // - Claude:  "[Pasted text #2 +2124 lines]"
    // This regex matches both formats
    const PASTE_INDICATOR_PATTERN =
      /\[Paste[d]?\s*(?:text\s*)?#?\d*\s*[-+]?\s*\d*\s*lines?\]/i;

    let tuiReady = false;
    let promptTextSent = false; // True after sendText(promptText) is called
    let promptSubmitted = false; // True after carriage return is sent to submit
    let completed = false;
    let chunkCount = 0;
    let totalBytes = 0;

    // TUI screen buffer - chunks can contain multiple screens or partial screens
    // We accumulate into a buffer and extract complete screens by detecting boundaries
    let screenBuffer = "";
    // Accumulator to track all terminal output since prompt was sent (for paste verification)
    let pasteVerificationBuffer = "";
    let lastEmittedContent = new Set<string>(); // Track what we've already sent to dashboard
    let indicatorEverSeen = false; // Must see indicator before counting its absence
    let consecutiveNoIndicatorScreens = 0; // Require 2+ screens without indicator

    // Check if paste has completed by looking for evidence in terminal output
    const isPasteComplete = (): boolean => {
      const bufferLower = pasteVerificationBuffer.toLowerCase();

      // Check for CLI paste indicator: [Paste #1 - 2987 lines] or [Pasted text #2 +2124 lines]
      if (PASTE_INDICATOR_PATTERN.test(pasteVerificationBuffer)) {
        this.log(`🔍 Paste verified: found paste indicator in output`);
        return true;
      }

      // Check for the tail of the prompt (works when CLI shows full text)
      if (bufferLower.includes(promptTail)) {
        this.log(
          `🔍 Paste verified: found last ${PROMPT_TAIL_LENGTH} chars of prompt`
        );
        return true;
      }

      return false;
    };

    // Dynamic paste completion detection - submit prompt after terminal output settles
    // AND we can verify the paste actually happened
    let submissionTimeoutId: NodeJS.Timeout | undefined;
    const startSubmissionTimer = () => {
      if (submissionTimeoutId) {
        clearTimeout(submissionTimeoutId);
      }
      submissionTimeoutId = setTimeout(() => {
        if (promptTextSent && !promptSubmitted) {
          // Verify paste actually completed before submitting
          if (isPasteComplete()) {
            this.log(
              `📤 Paste complete (${PASTE_SILENCE_THRESHOLD_MS / 1000}s silence + verified), sending carriage return to submit...`
            );
            // Copilot CLI uses Ink TUI framework which expects raw terminal mode input.
            // In raw mode, Enter key sends \r (carriage return), not \n (newline).
            terminal.sendText("\r", true);
            promptSubmitted = true;
          } else {
            // Silence detected but paste not verified - keep waiting
            this.log(
              `⏳ Silence detected but paste not verified yet, continuing to wait...`
            );
            // Don't restart timer here - we'll restart when next chunk arrives
          }
        }
      }, PASTE_SILENCE_THRESHOLD_MS);
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

        // Accumulate output for paste verification (only while waiting to submit)
        if (promptTextSent && !promptSubmitted) {
          pasteVerificationBuffer += cleanData;
        }

        // Always log raw data to output channel for debugging
        this.outputChannel?.append(data);

        // Extract complete screens from buffer using CLI-specific screen end pattern
        // If we get any complete screens, the TUI is ready (screen end pattern matched)
        const { screens, remainder } =
          this.extractScreensFromBuffer(screenBuffer);
        screenBuffer = remainder;

        // Process each complete screen
        for (const screen of screens) {
          const screenLower = screen.toLowerCase();

          // Phase 1: First complete screen means TUI is ready - send prompt
          if (!tuiReady) {
            this.log("✅ TUI is ready (first complete screen detected)");
            tuiReady = true;

            // Small delay to ensure TUI is fully interactive
            await this.delay(500);

            // Send prompt text (without adding newline - we'll submit separately)
            this.log(`📤 Sending prompt to TUI via terminal.sendText...`);
            terminal.sendText(promptText, false);
            promptTextSent = true;

            // Start the dynamic paste detection timer
            // The timer will be reset on each chunk received while pasting
            // When no chunks arrive for PASTE_SILENCE_THRESHOLD_MS, we submit
            this.log(
              `⏳ Waiting for paste to complete (will submit after ${PASTE_SILENCE_THRESHOLD_MS / 1000}s silence)...`
            );
            startSubmissionTimer();
          }

          // Reset submission timer on each chunk while waiting for paste to complete
          // This ensures we don't submit until the terminal has been quiet for the threshold
          if (promptTextSent && !promptSubmitted) {
            startSubmissionTimer();
          }

          // Phase 2: After prompt submitted, detect completion and emit deltas
          if (promptSubmitted) {
            // Extract and emit new content (delta from this screen)
            const delta = this.extractNewContent(screen, lastEmittedContent);
            if (delta.trim().length > 0) {
              this.streamingChunkEmitter.fire(delta);
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
        clearTimeout(submissionTimeoutId);
      }
      clearTimeout(timeoutId);

      this.log(
        `📺 Streaming complete: ${chunkCount} chunks, ${totalBytes} bytes, tuiReady=${tuiReady}, promptTextSent=${promptTextSent}, promptSubmitted=${promptSubmitted}, completed=${completed}`
      );

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
        // Prompt text was sent but not yet submitted (paste still in progress?)
        this.log("⚠️ Stream ended during paste - may be incomplete");
        this.responseCompleteEmitter.fire("Stream ended during paste");
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
    }
  }

  /**
   * Strip ANSI escape codes and terminal control sequences from output for clean display.
   */
  protected stripAnsiCodes(text: string): string {
    return (
      text
        // OSC sequences: \x1B] ... terminated by BEL (\x07) or ST (\x1B\\)
        .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
        // Cursor position (H) and similar commands that move to new lines - replace with newline
        .replace(/\x1B\[[0-9;]*[Hf]/g, "\n")
        // Other CSI sequences: \x1B[ followed by parameters and command (remove)
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
        // Other escape sequences: \x1B followed by various characters
        .replace(/\x1B[@-Z\\-_]/g, "")
        // Standalone BEL character
        .replace(/\x07/g, "")
        // Hide cursor and other private sequences
        .replace(/\x1B\[\?[0-9;]*[A-Za-z]/g, "")
        // Clean up multiple consecutive newlines (but keep at least one)
        .replace(/\n{3,}/g, "\n\n")
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
   * Tracks what content has already been sent to the dashboard and only
   * returns truly new lines. This prevents duplicate output.
   *
   * @param screen The current screen content
   * @param emittedContent Set of content lines already emitted
   * @returns New content to emit (modifies emittedContent set)
   */
  private extractNewContent(
    screen: string,
    emittedContent: Set<string>
  ): string {
    const lines = screen
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const newLines: string[] = [];

    for (const line of lines) {
      // Skip TUI chrome
      if (this.isTuiChromeLine(line)) {
        continue;
      }

      // Skip if already emitted
      if (emittedContent.has(line)) {
        continue;
      }

      // New content - add to emitted set and output
      emittedContent.add(line);
      newLines.push(line);
    }

    if (newLines.length === 0) {
      return "";
    }

    return newLines.join("\n") + "\n";
  }

  /**
   * Check if a line is TUI chrome (borders, prompts, status) that should be filtered.
   */
  private isTuiChromeLine(line: string): boolean {
    const chromPatterns = [
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]+$/, // Box drawing characters only
      /^[─═]+$/, // Horizontal lines
      /Ctrl\+[a-z]\s+\w+/i, // Keyboard shortcuts like "Ctrl+c Exit"
      /Enter @ to mention/i, // Copilot prompt hint
      /Esc to cancel/i, // Thinking indicator (we want to filter this from output)
      /Esc to interrupt/i, // Claude thinking indicator
      /^\s*>\s*$/, // Empty prompt
      /^\s*[∙◉◎●]\s*$/, // Spinner characters alone
      /^Thinking\s*\(/i, // Thinking status
      /^\s*[⎇]\s*\w+\*?\s*$/, // Git branch indicator alone
      /gpt-\d|claude-|gemini-/i, // Model names in status bar
      /^\d+x\)?\s*$/, // Token multiplier like "0x)"
    ];

    return chromPatterns.some((pattern) => pattern.test(line));
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
   * Build headless CLI arguments WITHOUT the prompt.
   * The prompt will be passed via stdin.
   *
   * @param baseArgs The base CLI arguments
   * @returns Args array for headless mode (prompt passed via stdin)
   */
  protected abstract buildHeadlessArgs(baseArgs: string[]): string[];

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
   * 1. Start CLI in interactive mode (gets proper TTY)
   * 2. Wait for TUI to be ready (delay-based, simple)
   * 3. Send prompt via terminal.sendText() (no length limits!)
   * 4. Stream output via execution.read() and detect completion
   *
   * Completion detection uses the stable TerminalShellExecution.read() API
   * to watch for the escape indicator to disappear from recent output.
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be sent via sendText)
   * @returns Promise<boolean> indicating success
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    const tuiCommand = this.buildInteractiveTuiCommand(args);
    const displayCommand = `${this.getCliName()} [TUI mode] "<prompt>"`;

    this.log(`🎮 [TRACE] executeInTerminal called`);
    this.log(`🎮 [TRACE] tuiCommand: ${tuiCommand}`);
    this.log(
      `🎮 [TRACE] promptText (first 50 chars): ${promptText.substring(0, 50)}`
    );
    this.log(`📝 Prompt length: ${promptText.length} characters`);

    // Get or create terminal
    this.log(`🎮 [TRACE] Getting or creating terminal...`);
    const terminal = await this.getOrCreateTerminal();
    this.log(`🎮 [TRACE] Got terminal, showing it...`);
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
        promptText
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
   * Execute a CLI command in headless mode using stdin for prompt passing.
   *
   * Strategy:
   * 1. Spawn CLI process with stdin pipe
   * 2. Write prompt to stdin
   * 3. Close stdin to signal end of input
   * 4. Wait for process to complete
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to stdin)
   * @param executeCallback Callback for CLI-specific result handling
   * @returns Promise<boolean> indicating success
   */
  protected async executeHeadlessWithStdin(
    args: string[],
    promptText: string,
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    const headlessArgs = this.buildHeadlessArgs(args);
    const displayCommand = `${this.getCliName()} ${headlessArgs.join(" ")} [stdin]`;

    this.log(`🚀 Starting headless mode with stdin: ${displayCommand}`);
    this.log(`📝 Prompt length: ${promptText.length} characters`);

    // Store for debugging
    this.lastCliCommand = displayCommand;

    // Fire prompt ready event
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    try {
      // Spawn with stdin pipe and execute
      const result = await this.spawnWithStdin(
        this.getCliName(),
        headlessArgs,
        promptText,
        {
          timeout: ConfigurationUtils.getCliExecutionTimeoutMs(),
          onStdout: (chunk) => {
            this.streamingChunkEmitter.fire(chunk);
          },
        }
      );

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
    }
  }

  /**
   * Spawn a child process and pass prompt via stdin.
   * This avoids all shell escaping issues and works for any prompt size.
   *
   * @param command The command to run
   * @param args Command arguments (NOT including prompt)
   * @param stdinContent Content to write to stdin
   * @param options Timeout and streaming options
   */
  protected spawnWithStdin(
    command: string,
    args: string[],
    stdinContent: string,
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
      // Since we pass prompt via stdin, no escaping issues with command args
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required for PATH resolution of copilot/claude commands
        stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr all piped
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

      // Write prompt to stdin and close it
      child.stdin.write(stdinContent);
      child.stdin.end();
      this.log(`📤 Wrote ${stdinContent.length} chars to stdin`);

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
  // SESSION MANAGEMENT
  // ============================================================

  /**
   * Start a new session (clear session ID)
   */
  startNewSession(): void {
    this.sessionId = undefined;
  }

  /**
   * Continue with existing session
   */
  continueSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get current session ID
   */
  getCurrentSession(): string | undefined {
    return this.sessionId;
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
  // ABSTRACT METHODS
  // ============================================================

  /**
   * Get the CLI-specific integration mode string
   */
  protected abstract getIntegrationMode(): string;

  /**
   * Parse token counts from statistics string
   */
  abstract parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined;
}
