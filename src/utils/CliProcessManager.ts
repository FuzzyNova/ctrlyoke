import { spawn, ChildProcess } from "child_process";
import kill from "tree-kill";
import { canonicalizeDriveLetter } from "./PathCasing";
import { withWorkingDirectoryEnv } from "./SpawnEnvironment";
import { attachStreamTextDecoder } from "./StreamTextDecoder";

/**
 * Options for spawning a CLI process
 */
export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  shell?: boolean | string;
  env?: NodeJS.ProcessEnv;
  /**
   * stdin behavior for the spawned process. Defaults to "ignore" (bound to
   * NUL/dev-null), which is required for AI-CLI harness invocations that may
   * probe or read stdin in headless mode — an open-but-unwritten pipe would
   * leave them blocked waiting for input that never arrives. Headless script
   * and end-condition execution (which never expects or wires up user input;
   * interactive script steps use a separate PTY path) should pass "pipe"
   * instead, so a script that probes stdin sees a real (non-NUL) handle rather
   * than a closed one.
   */
  stdin?: "ignore" | "pipe";
  /**
   * Set when `args` is already a cmd.exe-escaped verbatim payload (see
   * `CliResolvedCommand.requiresShellVerbatimArgs` /
   * `WindowsCmdEscaping.buildCmdExeVerbatimArgs`) so Node does not apply a
   * second layer of Win32 argv quoting on top of it.
   */
  windowsVerbatimArguments?: boolean;
}

/**
 * Result from spawning a CLI process
 */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Signal that terminated the process, when it was killed rather than exiting
   * on its own. Node reports a `null` exit code in that case, which `exitCode`
   * coalesces to `1` — so without this field a SIGKILL is indistinguishable
   * from a genuine non-zero exit, and callers report a killed process as a
   * harness failure (with whatever informational chatter happened to be on
   * stderr as the reason).
   */
  terminationSignal?: NodeJS.Signals;
  /** Whether ctrlyoke requested termination, rather than the OS/process. */
  terminatedByManager: boolean;
}

/** How an interactive (stdio-inherited) process ended. */
export interface InteractiveExitResult {
  /** Exit code, or `null` when a signal ended the process. */
  exitCode: number | null;
  /** Spawn failure (e.g. ENOENT); the process never ran. */
  error?: string;
  /**
   * Whether this manager asked for the kill (a detected Stop hook, a
   * cancellation). Such an exit is expected and says nothing about the CLI.
   */
  terminatedByManager: boolean;
}

/**
 * Configuration constants for process management
 */
const KILL_ESCALATION_DELAY_MS = 3000;
type KillProcessTree = (
  pid: number,
  signal?: string | number,
  callback?: (error?: Error) => void
) => void;

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
  private readonly killTimeouts = new Map<ChildProcess, NodeJS.Timeout>();
  private lastSpawnedCommand?: string;
  /**
   * Signals this manager has requested for a child, so `SpawnResult` can report
   * a kill that Node cannot see. `tree-kill` shells out to `taskkill /F` on
   * Windows, so the child dies at the hands of another process and Node reports
   * exit code 1 with no signal — indistinguishable from a genuine failure.
   * Recording our own request is the portable way to tell the two apart.
   */
  private readonly requestedKills = new WeakMap<ChildProcess, NodeJS.Signals>();

  constructor(
    private workspaceRoot: string,
    private logger?: (msg: string) => void,
    private readonly killProcessTree: KillProcessTree = kill
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

      // Canonical drive letter: the workspace root usually originates from
      // VS Code, which reports `c:\...`, while a shell reports `C:\...`. Some
      // tools key internal caches off the cwd string and treat the two as
      // different roots — `npm test` as a pre/end-condition failed all 114
      // Vitest suites with "failed to find the runner" purely because of this.
      const cwd = canonicalizeDriveLetter(options.cwd || this.workspaceRoot);
      const child = spawn(command, args, {
        cwd,
        shell: options.shell ?? false,
        stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
        env: withWorkingDirectoryEnv(options.env, cwd),
        // The extension host is a GUI process, so Windows creates a visible
        // console for cmd.exe/PowerShell launchers unless it is explicitly
        // hidden. This method is the headless transport; interactive launches
        // use spawnInteractive() below and retain their terminal behavior.
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      });

      this.currentProcess = child;

      // Handle stdout with streaming support
      const flushStdout = child.stdout
        ? attachStreamTextDecoder(child.stdout, (chunk) => {
            stdout += chunk;
            if (options.onStdout) {
              options.onStdout(chunk);
            }
          })
        : () => "";

      // Handle stderr
      const flushStderr = child.stderr
        ? attachStreamTextDecoder(child.stderr, (chunk) => {
            stderr += chunk;
          })
        : () => "";

      /*
       * StringDecoder buffers an incomplete UTF-8 sequence until the next
       * chunk, so the close handler must explicitly flush both streams.
       */
      const appendStdoutTail = () => {
        const tail = flushStdout();
        if (tail.length > 0) {
          stdout += tail;
          options.onStdout?.(tail);
        }
      };
      const appendStderrTail = () => {
        stderr += flushStderr();
      };

      // Cleanup (currentProcess/timers) must run whenever the child actually
      // exits, even if a timeout already flipped `settled` and sent a kill
      // signal — otherwise a stale `currentProcess` survives the exit and the
      // SIGKILL escalation timer fires against an already-gone PID.
      const cleanupProcessState = () => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.clearKillTimeout(child);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      // Handle errors
      child.on("error", (error: Error) => {
        cleanupProcessState();
        if (settled) {
          return;
        }
        settled = true;
        this.logger?.(`❌ Process error: ${error}`);
        reject(error);
      });

      // Handle completion
      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          cleanupProcessState();
          if (settled) {
            return;
          }
          settled = true;
          this.logger?.(
            `✅ Process exited with code: ${code}` +
              (signal ? ` (terminated by ${signal})` : "")
          );

          appendStdoutTail();
          appendStderrTail();

          resolve({
            stdout,
            stderr,
            exitCode: code ?? 1,
            terminationSignal: signal ?? this.requestedKills.get(child),
            terminatedByManager: this.requestedKills.has(child),
          });
        }
      );

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

    this.clearKillTimeout(child);

    this.requestedKills.set(child, "SIGKILL");
    this.logger?.("📤 Sending SIGKILL to process tree (immediate termination)");
    this.killProcessTree(child.pid, "SIGKILL", (err) => {
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
   * @param env Environment overrides for the child process
   * @param windowsVerbatimArguments Set when `args` is already a cmd.exe-escaped
   *   verbatim payload (see `SpawnOptions.windowsVerbatimArguments`)
   */
  async spawnInteractive(
    command: string,
    args: string[],
    workingDirectory: string,
    env?: NodeJS.ProcessEnv,
    windowsVerbatimArguments?: boolean
  ): Promise<InteractiveExitResult> {
    return new Promise<InteractiveExitResult>((resolve) => {
      this.logger?.(`📤 Spawning interactive: ${command} ${args.join(" ")}`);

      const cwd = canonicalizeDriveLetter(workingDirectory);
      const child = spawn(command, args, {
        cwd,
        stdio: "inherit",
        shell: false,
        windowsVerbatimArguments,
        env: withWorkingDirectoryEnv(env, cwd),
      });

      this.currentProcess = child;

      let settled = false;
      const settle = (result: InteractiveExitResult): void => {
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        this.clearKillTimeout(child);
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      child.on("close", (code) => {
        this.logger?.(`✅ Interactive process exited (code ${code})`);
        settle({
          exitCode: code,
          terminatedByManager: this.requestedKills.has(child),
        });
      });

      child.on("error", (err: Error) => {
        this.logger?.(`❌ Interactive process error: ${err.message}`);
        settle({
          exitCode: null,
          error: err.message,
          terminatedByManager: this.requestedKills.has(child),
        });
      });
    });
  }

  /**
   * Dispose only the process resources, leaving the terminal open.
   * Used when closeTerminalWhenPromptCompletes is false.
   */
  disposeProcess(): void {
    if (this.currentProcess) {
      // Routine teardown lets interactive CLIs restore terminal state and
      // flush their session data. Keep the child current until close so the
      // graceful kill's escalation timer can still force-kill the tree.
      this.killGracefully(this.currentProcess);
    }
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

    this.clearKillTimeout(child);

    this.requestedKills.set(child, "SIGTERM");
    this.logger?.(
      "📤 Sending SIGTERM to process tree (graceful shutdown requested)"
    );
    this.killProcessTree(child.pid, "SIGTERM", (err) => {
      if (err) {
        this.logger?.(`⚠️ SIGTERM failed: ${err.message}`);
      }
    });

    // Escalate to forceful kill after delay if process hasn't exited
    const killTimeout = setTimeout(() => {
      this.killTimeouts.delete(child);
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        this.requestedKills.set(child, "SIGKILL");
        this.logger?.(
          "⚠️ Process did not respond to SIGTERM after 3s - escalating to SIGKILL"
        );
        this.killProcessTree(child.pid, "SIGKILL", (err) => {
          if (err) {
            this.logger?.(`❌ SIGKILL failed: ${err.message}`);
          }
        });
      }
    }, KILL_ESCALATION_DELAY_MS);
    this.killTimeouts.set(child, killTimeout);
  }

  /**
   * Clear the SIGKILL escalation timeout
   */
  private clearKillTimeout(child: ChildProcess): void {
    const killTimeout = this.killTimeouts.get(child);
    if (killTimeout) {
      clearTimeout(killTimeout);
      this.killTimeouts.delete(child);
    }
  }
}
