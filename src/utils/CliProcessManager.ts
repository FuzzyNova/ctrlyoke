import { spawn, ChildProcess } from "child_process";
import kill from "tree-kill";

/**
 * Options for spawning a CLI process
 */
export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  shell?: boolean | string;
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
const KILL_ESCALATION_DELAY_MS = 3000;

/**
 * Manages CLI process spawning.
 *
 * Responsibilities:
 * - Spawn CLI processes (headless and interactive)
 * - Graceful process shutdown (SIGTERM → SIGKILL escalation)
 * - Coordinated cancellation
 */
export class CliProcessManager {
  private currentProcess?: ChildProcess;
  private killTimeoutId?: NodeJS.Timeout;
  private lastSpawnedCommand?: string;

  constructor(
    private workspaceRoot: string,
    private logger?: (msg: string) => void
  ) {}

  getLastSpawnedCommand(): string | undefined {
    return this.lastSpawnedCommand;
  }

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
      let settled = false;

      this.lastSpawnedCommand = `${command} ${args.join(" ")}`;
      this.logger?.(`📤 Spawning: ${this.lastSpawnedCommand}`);

      const child = spawn(command, args, {
        cwd: options.cwd || this.workspaceRoot,
        shell: options.shell ?? false,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env || { ...process.env },
        // The extension host is a GUI process, so Windows creates a visible
        // console for cmd.exe/PowerShell launchers unless it is explicitly
        // hidden. This method is the headless transport; interactive launches
        // use spawnInteractive() below and retain their terminal behavior.
        windowsHide: true,
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
        if (settled) {
          return;
        }
        settled = true;
        this.logger?.(`❌ Process error: ${error}`);
        this.currentProcess = undefined;
        this.clearKillTimeout();
        reject(error);
      });

      // Handle completion
      child.on("close", (code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.clearKillTimeout();
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.logger?.(`✅ Process exited with code: ${code}`);

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (options.timeout) {
        timeoutId = setTimeout(() => {
          if (!settled && this.currentProcess === child) {
            settled = true;
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
   * Cancel current process execution.
   * SIGKILL immediately (user-initiated stop, no grace period needed).
   */
  async cancel(): Promise<void> {
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
   * Check if there's an active process.
   */
  isActive(): boolean {
    return !!this.currentProcess;
  }

  /**
   * Spawn a CLI process in interactive mode with stdio inherited from the
   * parent process. All three file descriptors (stdin, stdout, stderr) are
   * wired to the user's terminal so the AI CLI runs as if launched directly.
   *
   * Used exclusively in the standalone CLI binary (CliAdapter context).
   * The VS Code extension always uses createTerminal() instead.
   *
   * @param command Executable path or command name
   * @param args Raw argv entries passed to the executable
   * @param workingDirectory Working directory for the child process
   */
  async spawnInteractive(
    command: string,
    args: string[],
    workingDirectory: string,
    env?: NodeJS.ProcessEnv
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      this.logger?.(`📤 Spawning interactive: ${command} ${args.join(" ")}`);

      const child = spawn(command, args, {
        cwd: workingDirectory,
        stdio: "inherit",
        shell: false,
        ...(env ? { env } : {}),
      });

      this.currentProcess = child;

      child.on("close", () => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.logger?.("✅ Interactive process exited");
        resolve();
      });

      child.on("error", (err: Error) => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.logger?.(`❌ Interactive process error: ${err.message}`);
        resolve(); // treat errors as exit — caller checks success via return value
      });
    });
  }

  /**
   * Dispose only the process resources, leaving the terminal open.
   * Used when closeTerminalWhenPromptCompletes is false.
   */
  disposeProcess(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = undefined;
    }
    this.clearKillTimeout();
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    this.disposeProcess();
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
