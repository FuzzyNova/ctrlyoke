import { getErrorMessage } from "../../utils/ErrorUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import { Log } from "../../utils/Log";
import { resolveShellInvocation } from "../harness/PtyProcessManager";

export interface ResolvedScriptInvocation {
  argv: readonly [string, ...string[]];
  windowsVerbatimArguments: boolean;
}

/** Resolve script text to the explicit shell argv used by headless execution. */
export function resolveScriptInvocation(
  script: string,
  shellOverride?: string
): ResolvedScriptInvocation {
  const invocation = resolveShellInvocation(script, shellOverride);
  const argv: [string, ...string[]] = [
    invocation.executable,
    ...invocation.args,
  ];
  return {
    argv,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
}

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
  /** Pass argv to Windows verbatim (cmd.exe payloads — see resolveShellInvocation). */
  windowsVerbatimArguments?: boolean;
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
  /** The process tree was terminated by ctrlyoke, rather than exiting itself. */
  cancelled?: boolean;
}

type ScriptProcessManager = Pick<
  CliProcessManager,
  "spawn" | "cancel" | "dispose"
> &
  Partial<Pick<CliProcessManager, "disposeAsync">>;

/** Shared headless process transport for conditions and worktree setup. */
export class ScriptProcessRunner {
  private readonly processManager: ScriptProcessManager;

  constructor(
    processManagerRoot: string,
    processManager?: ScriptProcessManager
  ) {
    this.processManager =
      processManager ??
      new CliProcessManager(processManagerRoot, (msg) =>
        Log.trace(`[ScriptProcessRunner] ${msg}`)
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
      `[ScriptProcessRunner] Spawning command - executable: "${executable}", args: [${args
        .map((arg) => `"${arg}"`)
        .join(", ")}]${options.viaShell ? " (via shell)" : ""}`
    );
    Log.debug(`[ScriptProcessRunner] Working directory: ${options.cwd}`);

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
      `[ScriptProcessRunner] Cleaned ${vsCodeEnvVars.length} VS Code env vars for isolated execution`
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
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        // Headless scripts never receive user input. A pipe preserves the
        // historical stdin behavior for scripts that probe the handle.
        stdin: "pipe",
      });

      return {
        success: result.exitCode === 0 && !result.terminationSignal,
        result: result.stdout.trim(),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error:
          (result.terminationSignal && !result.terminatedByManager
            ? `Process terminated by ${result.terminationSignal}`
            : undefined) ||
          result.stderr.trim() ||
          undefined,
        ...(result.terminationSignal && result.terminatedByManager
          ? { cancelled: true }
          : { exitCode: result.exitCode }),
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

  async waitForProcessShutdown(): Promise<void> {
    await this.processManager.disposeAsync?.();
  }

  async cancel(): Promise<void> {
    await this.processManager.cancel();
  }
}
