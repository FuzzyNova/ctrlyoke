import { getErrorMessage } from "../../utils/ErrorUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import { Log } from "../../utils/Log";

export interface ScriptProcessRunnerOptions {
  /** Directory in which the process must run. */
  cwd: string;
  /** Maximum runtime in milliseconds. */
  timeout: number;
  /** Process argv, with the executable at index zero. */
  argv: readonly string[];
  /** Optional workflow variables exposed as CTRLYOKE_VAR_<KEY>. */
  vars?: Record<string, string>;
  /** Environment overrides for the script process. */
  env?: Record<string, string>;
  /** Receives stdout chunks as they arrive. */
  onOutput?: (chunk: string) => void;
  /** Run the command through the platform shell. */
  viaShell?: boolean;
}

export interface ScriptProcessResult {
  success: boolean;
  result: string;
  error?: string;
  timeout?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errored?: boolean;
}

/** Shared headless process transport for conditions and worktree setup. */
export class ScriptProcessRunner {
  private readonly processManager: CliProcessManager;

  constructor(processManagerRoot: string) {
    this.processManager = new CliProcessManager(processManagerRoot, (msg) =>
      Log.trace(msg)
    );
  }

  async run(options: ScriptProcessRunnerOptions): Promise<ScriptProcessResult> {
    const [executable, ...args] = options.argv;
    if (!executable) {
      return {
        success: false,
        result: "",
        error: "Cannot execute an empty script command",
        errored: true,
      };
    }

    Log.debug(
      `Spawning command - executable: "${executable}", args: [${args
        .map((arg) => `"${arg}"`)
        .join(", ")}]${options.viaShell ? " (via shell)" : ""}`
    );
    Log.debug(`Working directory: ${options.cwd}`);

    const cleanEnv = { ...process.env };
    const vsCodeEnvVars = [
      "VSCODE_INJECTION",
      "VSCODE_HANDLES_UNCAUGHT_ERRORS",
      "VSCODE_NLS_CONFIG",
      "VSCODE_PID",
      "ELECTRON_RUN_AS_NODE",
    ];
    for (const key of vsCodeEnvVars) {
      delete cleanEnv[key];
    }
    Log.trace(
      `Cleaned ${vsCodeEnvVars.length} VS Code env vars for isolated execution`
    );

    if (options.vars && Object.keys(options.vars).length > 0) {
      for (const [key, value] of Object.entries(options.vars)) {
        cleanEnv[`CTRLYOKE_VAR_${key.toUpperCase()}`] = value;
      }
    }

    if (options.env) {
      Object.assign(cleanEnv, options.env);
    }

    try {
      const result = await this.processManager.spawn(executable, args, {
        cwd: options.cwd,
        timeout: options.timeout,
        env: cleanEnv,
        onStdout: options.onOutput,
        shell: options.viaShell ?? false,
        // Headless scripts never receive user input. A pipe preserves the
        // historical stdin behavior for scripts that probe the handle.
        stdin: "pipe",
      });

      return {
        success: result.exitCode === 0,
        result: result.stdout.trim(),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.stderr.trim() || undefined,
        exitCode: result.exitCode,
        errored: false,
      };
    } catch (error) {
      const isTimeout =
        error instanceof Error && error.message.includes("timeout");
      return {
        success: false,
        result: "",
        stdout: "",
        stderr: "",
        error: getErrorMessage(error),
        timeout: isTimeout,
        errored: true,
      };
    }
  }

  dispose(): void {
    this.processManager.dispose();
  }
}
