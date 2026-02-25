import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import kill from "tree-kill";

/**
 * Options for spawning a CLI process
 */
export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Result from spawning a CLI process
 */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Configuration constants for process management
 */
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
const KILL_ESCALATION_DELAY_MS = 3000;
const TERMINAL_CTRL_C_DELAY_MS = 100;
const TERMINAL_DISPOSE_DELAY_MS = 800;

/**
 * Manages CLI process spawning and VS Code terminal lifecycle.
 *
 * Responsibilities:
 * - Spawn CLI processes (headless and interactive)
 * - Create and manage VS Code terminals
 * - Graceful process shutdown (SIGTERM → SIGKILL escalation)
 * - Terminal shell integration handling
 * - Coordinated cancellation (both process and terminal)
 */
export class CliProcessManager {
  private currentProcess?: ChildProcess;
  private killTimeoutId?: NodeJS.Timeout;
  private terminal?: vscode.Terminal;
  private shellIntegration?: vscode.TerminalShellIntegration;

  constructor(
    private workspaceRoot: string,
    private logger?: (msg: string) => void
  ) {}

  /**
   * Spawn a CLI process with full control over stdin/stdout/stderr.
   * Supports streaming output via onStdout callback.
   */
  async spawn(
    command: string,
    args: string[],
    options: SpawnOptions = {}
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      this.logger?.(`📤 Spawning: ${command} ${args.join(" ")}`);

      const child = spawn(command, args, {
        cwd: options.cwd || this.workspaceRoot,
        shell: options.shell ?? true, // Default to true for PATH resolution
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env || { ...process.env },
      });

      this.currentProcess = child;

      // Handle stdout with streaming support
      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (options.onStdout) {
          options.onStdout(chunk);
        }
      });

      // Handle stderr
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle errors
      child.on("error", (error: Error) => {
        this.logger?.(`❌ Process error: ${error}`);
        this.currentProcess = undefined;
        this.clearKillTimeout();
        reject(error);
      });

      // Handle completion
      child.on("close", (code: number | null) => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.clearKillTimeout();
        this.logger?.(`✅ Process exited with code: ${code}`);

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
            this.logger?.(
              "⏱️ Process timeout - sending SIGTERM, will escalate to SIGKILL if needed"
            );
            this.killGracefully(child);
            reject(new Error(`Process timeout after ${options.timeout}ms`));
          }
        }, options.timeout);
      }
    });
  }

  /**
   * Spawn a simple command (e.g., --version checks) with timeout.
   */
  async spawnSimple(
    command: string,
    args: string[],
    timeoutMs: number = 5000
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const child = spawn(command, args, {
        cwd: this.workspaceRoot,
        shell: true,
        env: { ...process.env },
      });

      child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
      child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
      child.on("error", reject);
      child.on("close", (code: number | null) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      );

      setTimeout(() => {
        child.kill();
        reject(new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /**
   * Create a fresh VS Code terminal with specified name.
   * Disposes existing terminal if present.
   */
  async createTerminal(name: string, cwd?: string): Promise<vscode.Terminal> {
    this.disposeTerminal();

    this.terminal = vscode.window.createTerminal({
      name,
      cwd: cwd || this.workspaceRoot,
    });

    return this.terminal;
  }

  /**
   * Wait for shell integration to become available on terminal.
   * Required for using executeCommand() and read() APIs.
   */
  async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number = SHELL_INTEGRATION_TIMEOUT_MS
  ): Promise<vscode.TerminalShellIntegration> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (terminal.shellIntegration) {
          clearInterval(checkInterval);
          this.shellIntegration = terminal.shellIntegration;
          resolve(terminal.shellIntegration);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(
            new Error(
              `Shell integration not available after ${timeoutMs}ms - check your shell configuration`
            )
          );
        }
      }, 100);
    });
  }

  /**
   * Dispose the current terminal if it exists.
   */
  disposeTerminal(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
      this.shellIntegration = undefined;
    }
  }

  /**
   * Get the current terminal reference (if any).
   */
  getTerminal(): vscode.Terminal | undefined {
    return this.terminal;
  }

  /**
   * Get the current shell integration (if any).
   */
  getShellIntegration(): vscode.TerminalShellIntegration | undefined {
    return this.shellIntegration;
  }

  /**
   * Cancel current execution (process or terminal).
   * For terminal: Sends Ctrl+C twice, then disposes
   * For process: SIGKILL immediately (user-initiated stop, no grace period needed)
   */
  async cancel(
    currentExecution?: vscode.TerminalShellExecution
  ): Promise<void> {
    // Handle interactive terminal execution
    if (currentExecution && this.terminal) {
      this.logger?.(
        "⏹️ Sending Ctrl+C to terminal (twice for TUI cancellation)..."
      );

      // Most TUIs require Ctrl+C twice to actually stop
      this.terminal.sendText("\x03");

      // Send second Ctrl+C after brief delay
      setTimeout(() => {
        if (this.terminal) {
          this.terminal.sendText("\x03");
          this.logger?.("⏹️ Second Ctrl+C sent");
        }
      }, TERMINAL_CTRL_C_DELAY_MS);

      // Dispose the terminal after allowing time for both Ctrl+C to process
      setTimeout(() => {
        if (this.terminal) {
          this.logger?.("🗑️ Disposing terminal after cancellation");
          this.disposeTerminal();
        }
      }, TERMINAL_DISPOSE_DELAY_MS);
    }

    // Handle headless process execution - kill immediately, no grace period
    if (this.currentProcess) {
      this.logger?.(
        "⏹️ Force-killing headless CLI process (user-initiated stop)..."
      );
      this.killImmediately(this.currentProcess);
    }
  }

  /**
   * Kill a process immediately with SIGKILL (no grace period).
   * Used for user-initiated stops where we want instant termination.
   */
  killImmediately(child: ChildProcess): void {
    if (!child.pid) {
      this.logger?.("⚠️ No PID available to kill");
      return;
    }

    this.clearKillTimeout();

    this.logger?.("📤 Sending SIGKILL to process tree (immediate termination)");
    kill(child.pid, "SIGKILL", (err) => {
      if (err) {
        this.logger?.(`⚠️ SIGKILL failed: ${err.message}`);
      }
    });
  }

  /**
   * Check if there's an active process or terminal.
   */
  isActive(): boolean {
    return !!this.currentProcess || !!this.terminal;
  }

  /**
   * Clean up all resources (terminal and process).
   */
  dispose(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = undefined;
    }
    this.clearKillTimeout();
    this.disposeTerminal();
  }

  /**
   * Gracefully kill a process: SIGTERM first, escalate to SIGKILL after 3 seconds.
   * Uses tree-kill for cross-platform process tree handling.
   */
  private killGracefully(child: ChildProcess): void {
    if (!child.pid) {
      this.logger?.("⚠️ No PID available to kill");
      return;
    }

    this.clearKillTimeout();

    this.logger?.(
      "📤 Sending SIGTERM to process tree (graceful shutdown requested)"
    );
    kill(child.pid, "SIGTERM", (err) => {
      if (err) {
        this.logger?.(`⚠️ SIGTERM failed: ${err.message}`);
      }
    });

    // Escalate to forceful kill after delay if process hasn't exited
    this.killTimeoutId = setTimeout(() => {
      if (this.currentProcess === child && child.pid) {
        this.logger?.(
          "⚠️ Process did not respond to SIGTERM after 3s - escalating to SIGKILL"
        );
        kill(child.pid, "SIGKILL", (err) => {
          if (err) {
            this.logger?.(`❌ SIGKILL failed: ${err.message}`);
          }
        });
      }
    }, KILL_ESCALATION_DELAY_MS);
  }

  /**
   * Clear the SIGKILL escalation timeout
   */
  private clearKillTimeout(): void {
    if (this.killTimeoutId) {
      clearTimeout(this.killTimeoutId);
      this.killTimeoutId = undefined;
    }
  }
}
