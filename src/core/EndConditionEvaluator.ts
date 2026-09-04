import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  type ScriptProperties,
  type EndConditionCompareSource,
  type ScriptMatchRule,
} from "../types/CtrlYokeTypes";
import {
  BOOLEAN_STRING_VALUES,
  SCRIPT_BOOLEAN_OUTPUT_VALUES,
  COMPARE_SOURCES,
  END_CONDITION_SCRIPT_TYPES,
  type EndConditionScriptType,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { isPathWithinDirectory } from "../utils/PathSecurity";
import {
  createNoWorktreeExecutionWorkspace,
  type PlatformAdapter,
} from "../platform/PlatformAdapter";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import {
  ScriptProcessRunner,
  type ScriptProcessResult,
} from "./orchestration/ScriptProcessRunner";
import { resolveShellInvocation } from "./harness/PtyProcessManager";
import {
  buildSecretProcessEnvironment,
  resolveSecretEnvironment,
} from "../utils/SecretResolver";

export interface EvaluationResult {
  /** Whether the script evaluation passed. Use onPass/onFail from the condition config to branch on this. */
  passed: boolean;
  /** The comparison rule that produced the verdict, or none when nothing matched. */
  matchRule: ScriptMatchRule;
  /** The value from the source that was compared against returns. */
  actual: string;
  /** The output axis used for the comparison, including the resolved auto axis. */
  actualSource: "stdout" | "stderr" | "exitCode";
  /** Whether the script could not run or evaluation itself failed. */
  errored: boolean;
  stdout: string; // Separate stdout from script
  stderr: string; // Separate stderr from script
  result: string; // Same as stdout; used in retry prompt interpolation ($endCondition:actual)
  error?: string;
  timeout?: boolean;
  duration: number;
  exitCode?: number; // Capture exit code for better error handling
}

export interface EvaluationComparison {
  passed: boolean;
  matchRule: ScriptMatchRule;
  actual: string;
  actualSource: "stdout" | "stderr" | "exitCode";
}

export class EndConditionEvaluator {
  private readonly platform: PlatformAdapter;
  private readonly executionWorkspace: ExecutionWorkspace;
  private readonly processRunners = new Set<ScriptProcessRunner>();

  constructor(
    platform: PlatformAdapter,
    executionWorkspace: ExecutionWorkspace = createNoWorktreeExecutionWorkspace(
      platform
    )
  ) {
    this.platform = platform;
    this.executionWorkspace = executionWorkspace;
  }

  /**
   * Parse script command to separate script path from arguments.
   * Handles both space-separated and quoted arguments.
   * @returns { scriptPath: string, args: string[] }
   */
  static parseScriptCommand(script: string): {
    scriptPath: string;
    args: string[];
  } {
    // Quote-aware tokenizer: splits on unquoted whitespace, keeps quoted spans
    // (single or double) intact, and strips the surrounding quotes.
    //
    // This matters because scripts run with `shell: false` — any leftover quote
    // characters are passed literally to the spawned process. For example,
    // `node "C:\dir\check.js" arg` must yield args ["C:\dir\check.js", "arg"],
    // not ['"C:\dir\check.js"', "arg"], otherwise node tries to resolve a
    // filename that literally contains quotes.
    //
    // Backslashes are NOT treated as escape characters so Windows paths
    // (C:\foo\bar) survive intact.
    const tokens: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let hasToken = false; // distinguishes an empty quoted arg ("") from no token

    for (const ch of script.trim()) {
      if (inSingle) {
        if (ch === "'") inSingle = false;
        else current += ch;
        continue;
      }
      if (inDouble) {
        if (ch === '"') inDouble = false;
        else current += ch;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        hasToken = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        hasToken = true;
        continue;
      }
      if (/\s/.test(ch)) {
        if (hasToken) {
          tokens.push(current);
          current = "";
          hasToken = false;
        }
        continue;
      }
      current += ch;
      hasToken = true;
    }
    if (hasToken) {
      tokens.push(current);
    }

    return {
      scriptPath: tokens[0] ?? "",
      args: tokens.slice(1),
    };
  }

  /**
   * Evaluate a script condition (endCondition, preCondition, or scriptStep).
   * When `returns` is absent, exit code 0 = pass.
   * @param vars Optional variable map — injected as CTRLYOKE_VAR_<KEY> environment
   *   variables so end condition scripts can branch on workflow variables.
   * @param onOutput Optional streaming callback — called for each stdout chunk as it
   *   arrives so callers can forward live output to the dashboard without waiting for
   *   the process to finish.
   */
  async evaluateCondition(
    condition: ScriptProperties,
    workingDirectory?: string,
    vars?: Record<string, string>,
    onOutput?: (chunk: string) => void,
    secretNames: readonly string[] = [],
    processRunner?: ScriptProcessRunner
  ): Promise<EvaluationResult> {
    const startTime = Date.now();
    const executionRoot =
      workingDirectory ?? this.executionWorkspace.executionRoot;

    try {
      Log.info(`Evaluating end condition script: ${condition.script}`);

      // Parse script command to separate path from arguments
      const { scriptPath: rawScriptPath, args: additionalArgs } =
        EndConditionEvaluator.parseScriptCommand(condition.script);

      // Resolve script path
      const resolvedScriptPath = await this.resolveScriptPath(
        rawScriptPath,
        workingDirectory
      );

      const actualSource = this.resolveActualSource(
        condition.returns,
        condition.compareSource
      );

      let command: {
        executable: string;
        args: string[];
        viaShell?: boolean;
        windowsVerbatimArguments?: boolean;
      };

      if (resolvedScriptPath) {
        // File found - determine script type and command
        const fileCommand = this.getScriptCommand(resolvedScriptPath);
        if (!fileCommand) {
          return {
            passed: false,
            matchRule: "none",
            actual: "",
            actualSource,
            errored: true,
            stdout: "",
            stderr: "",
            result: "",
            error: `Unsupported script type: ${path.extname(resolvedScriptPath)}`,
            duration: Date.now() - startTime,
          };
        }
        // Append additional arguments from the script command
        fileCommand.args = [...fileCommand.args, ...additionalArgs];
        command = fileCommand;
      } else {
        // File not found - treat as direct shell command. Run the untouched
        // command string through an explicitly resolved shell (same
        // resolution interactive script-step PTYs use): spawning the bare
        // name with shell:false fails ENOENT on Windows for anything that is
        // not a .exe (npm/npx/yarn are .cmd shims; echo is a builtin), and a
        // shell is also what gives PATH lookup, quoting, and pipes the
        // semantics a user's terminal would. Resolving the shell explicitly
        // (honoring `terminal.shellExecutable`) instead of Node's own
        // `shell:true`/ComSpec fallback is what keeps this consistent with
        // interactive script steps — the same script text no longer runs
        // under a different, silently-chosen shell depending on execution mode.
        Log.info(
          `Script file not found, treating as direct command: ${condition.script}`
        );
        const shellInvocation = resolveShellInvocation(condition.script);
        Log.debug(
          `Resolved shell (${shellInvocation.shellKind}) for direct command: ${shellInvocation.executable} ${shellInvocation.args
            .map((a) => JSON.stringify(a))
            .join(" ")}`
        );
        command = {
          executable: shellInvocation.executable,
          args: shellInvocation.args,
          viaShell: false,
          windowsVerbatimArguments: shellInvocation.windowsVerbatimArguments,
        };
      }

      // Execute script with timeout from config or per-condition override
      const timeout =
        condition.timeout || ConfigurationUtils.getScriptTimeoutMs();
      const result = await this.executeScript(
        command.executable,
        command.args,
        executionRoot,
        timeout,
        vars,
        onOutput,
        command.viaShell ?? false,
        secretNames,
        condition.env,
        processRunner,
        command.windowsVerbatimArguments ?? false
      );

      if (result.errored) {
        return {
          passed: false,
          matchRule: "none",
          actual: "",
          actualSource,
          errored: true,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          result: result.result,
          error: result.error,
          timeout: result.timeout,
          duration: Date.now() - startTime,
          exitCode: result.exitCode,
        };
      }

      const comparison = this.evaluateSuccess(
        result,
        condition.returns,
        condition.compareSource
      );

      return {
        ...comparison,
        errored: result.errored ?? false,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        result: result.result,
        error: result.error,
        timeout: result.timeout,
        duration: Date.now() - startTime,
        exitCode: result.exitCode,
      };
    } catch (error) {
      return {
        passed: false,
        matchRule: "none",
        actual: "",
        actualSource: this.resolveActualSource(
          condition.returns,
          condition.compareSource
        ),
        errored: true,
        stdout: "",
        stderr: "",
        result: "",
        error: getErrorMessage(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Apply the same comparison rules used by evaluateCondition to output that
   * has already been collected by another transport, such as a PTY.
   */
  evaluateResult(
    result: {
      result: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      success: boolean;
    },
    returns: string | undefined,
    compareSource: EndConditionCompareSource = COMPARE_SOURCES.AUTO
  ): EvaluationComparison {
    return this.evaluateSuccess(result, returns, compareSource);
  }

  /**
   * Resolve script path relative to workspace or absolute.
   *
   * Resolution order:
   *   1. Absolute path — validated against workspace root OR home scripts dir
   *   2. Relative to workingDirectory — same validation
   *   3. Relative to workspace root — validated within workspace
   *   4. Relative to .ctrlyoke/ dir — validated within workspace
   *   5. Relative to ~/.ctrlyoke/scripts — user-level shared scripts, validated within home scripts dir
   *
   * All resolved paths are canonicalized with realpath() to prevent sibling-prefix
   * and symlink-escape bypasses before the boundary check.
   */
  private async resolveScriptPath(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.executionWorkspace.executionRoot;
    const homeScriptsDir = EndConditionEvaluator.getUserHomeScriptsDir();

    // Try absolute path first
    if (path.isAbsolute(scriptPath)) {
      try {
        await fs.promises.access(scriptPath);
        const canonical =
          await EndConditionEvaluator.canonicalizePath(scriptPath);
        if (
          !(await this.isAllowedPath(canonical, workspaceRoot, homeScriptsDir))
        ) {
          Log.error(
            `Security: Script path "${scriptPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
          );
          throw new Error(
            `Security: Script path "${scriptPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
          );
        }
        return canonical;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Security:")) {
          throw error;
        }
        return null;
      }
    }

    // Try relative to working directory
    if (workingDirectory) {
      const fullPath = path.resolve(workingDirectory, scriptPath);
      try {
        await fs.promises.access(fullPath);
        const canonical =
          await EndConditionEvaluator.canonicalizePath(fullPath);
        if (
          !(await this.isAllowedPath(canonical, workspaceRoot, homeScriptsDir))
        ) {
          Log.error(
            `Security: Resolved script path "${fullPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
          );
          throw new Error(
            `Security: Resolved script path "${fullPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
          );
        }
        return canonical;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Security:")) {
          throw error;
        }
        // Continue to workspace resolution
      }
    }

    // Try relative to workspace root
    if (workspaceRoot) {
      const workspacePath = path.resolve(workspaceRoot, scriptPath);
      try {
        await fs.promises.access(workspacePath);
        const canonical =
          await EndConditionEvaluator.canonicalizePath(workspacePath);
        const canonicalRoot =
          await EndConditionEvaluator.canonicalizePath(workspaceRoot);
        if (
          !EndConditionEvaluator.isWithinDirectory(canonical, canonicalRoot)
        ) {
          Log.error(
            `Security: Script path traversal detected: "${workspacePath}" resolves outside workspace root "${workspaceRoot}"`
          );
          throw new Error(
            `Security: Script path traversal detected: "${workspacePath}" resolves outside workspace root "${workspaceRoot}"`
          );
        }
        return canonical;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Security:")) {
          throw error;
        }
        // Continue to .ctrlyoke directory
      }

      // Try in .ctrlyoke directory
      const ctrlyokePath = path.resolve(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        scriptPath
      );
      try {
        await fs.promises.access(ctrlyokePath);
        const canonical =
          await EndConditionEvaluator.canonicalizePath(ctrlyokePath);
        const canonicalRoot =
          await EndConditionEvaluator.canonicalizePath(workspaceRoot);
        if (
          !EndConditionEvaluator.isWithinDirectory(canonical, canonicalRoot)
        ) {
          Log.error(
            `Security: Script path traversal detected: "${ctrlyokePath}" resolves outside workspace root "${workspaceRoot}"`
          );
          throw new Error(
            `Security: Script path traversal detected: "${ctrlyokePath}" resolves outside workspace root "${workspaceRoot}"`
          );
        }
        return canonical;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Security:")) {
          throw error;
        }
        // Continue to home scripts directory
      }
    }

    // Try in ~/.ctrlyoke/scripts (user shared scripts directory)
    const homeScriptPath = path.resolve(homeScriptsDir, scriptPath);
    try {
      await fs.promises.access(homeScriptPath);
      const canonical =
        await EndConditionEvaluator.canonicalizePath(homeScriptPath);
      const canonicalHomeScripts =
        await EndConditionEvaluator.canonicalizePath(homeScriptsDir);
      if (
        !EndConditionEvaluator.isWithinDirectory(
          canonical,
          canonicalHomeScripts
        )
      ) {
        Log.error(
          `Security: Script path traversal detected in home scripts directory: "${homeScriptPath}"`
        );
        throw new Error(
          `Security: Script path traversal detected in home scripts directory: "${homeScriptPath}"`
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Security:")) {
        throw error;
      }
      // Script not found
    }

    return null;
  }

  /**
   * Check if a canonicalized candidate path is within the workspace root OR the
   * user home scripts directory. Both allowed roots are also canonicalized.
   */
  private async isAllowedPath(
    canonicalCandidate: string,
    workspaceRoot: string,
    homeScriptsDir: string
  ): Promise<boolean> {
    if (workspaceRoot) {
      const canonicalRoot =
        await EndConditionEvaluator.canonicalizePath(workspaceRoot);
      if (
        EndConditionEvaluator.isWithinDirectory(
          canonicalCandidate,
          canonicalRoot
        )
      ) {
        return true;
      }
    }
    const canonicalHomeScripts =
      await EndConditionEvaluator.canonicalizePath(homeScriptsDir);
    return EndConditionEvaluator.isWithinDirectory(
      canonicalCandidate,
      canonicalHomeScripts
    );
  }

  /**
   * Canonicalize a path using realpath to resolve symlinks and normalize
   * separators. Falls back to the original path if realpath fails (e.g., the
   * path does not exist on disk).
   */
  static async canonicalizePath(p: string): Promise<string> {
    try {
      return await fs.promises.realpath(p);
    } catch {
      return p;
    }
  }

  /**
   * Returns true if `candidate` is equal to or a direct descendant of `directory`.
   * Both paths must be canonicalized (via canonicalizePath) before calling.
   *
   * Using `path.sep` prevents sibling-prefix bypass attacks where a path like
   * `C:\dev\ctrlyoke-evil` would incorrectly match workspace root `C:\dev\ctrlyoke`.
   */
  static isWithinDirectory(candidate: string, directory: string): boolean {
    return isPathWithinDirectory(candidate, directory);
  }

  /**
   * Returns the user's shared ctrlyoke scripts directory (~/.ctrlyoke/scripts).
   * Scripts placed here can be referenced from any workspace, giving users a
   * single location for shared scripts without copying them per-project.
   */
  static getUserHomeScriptsDir(): string {
    return path.join(
      os.homedir(),
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.SCRIPTS_DIR
    );
  }

  /**
   * Get command and arguments for script execution
   */
  private getScriptCommand(
    scriptPath: string
  ): { executable: string; args: string[] } | null {
    const ext = path.extname(scriptPath).toLowerCase();

    switch (ext) {
      case ".py":
        return {
          executable: this.resolvePythonExecutable(),
          args: [scriptPath],
        };
      case ".js":
        return { executable: "node", args: [scriptPath] };
      case ".ts":
        // Try to use ts-node if available, otherwise compile first
        return { executable: "npx", args: ["ts-node", scriptPath] };
      case ".sh":
        return process.platform === "win32"
          ? { executable: "bash", args: [scriptPath] }
          : { executable: "sh", args: [scriptPath] };
      case ".bat":
      case ".cmd":
        return process.platform === "win32"
          ? { executable: "cmd", args: ["/c", scriptPath] }
          : null;
      case ".ps1":
        return process.platform === "win32"
          ? {
              executable: this.resolvePowerShellExecutable(),
              args: ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
            }
          : null;
      default:
        // Try to execute directly (for executable files)
        return { executable: scriptPath, args: [] };
    }
  }

  /**
   * Execute script with timeout.
   * `viaShell` runs the command through the platform shell — used for the
   * direct-command fallback where `executable` is the full command string.
   */
  private async executeScript(
    executable: string,
    args: string[],
    workingDirectory?: string,
    timeout: number = ConfigurationUtils.getScriptTimeoutMs(),
    vars?: Record<string, string>,
    onOutput?: (chunk: string) => void,
    viaShell: boolean = false,
    secretNames: readonly string[] = [],
    processEnv?: Record<string, string>,
    processRunner?: ScriptProcessRunner,
    windowsVerbatimArguments: boolean = false
  ): Promise<ScriptProcessResult> {
    const resolvedSecrets = await resolveSecretEnvironment(secretNames, {
      workspaceRoot: this.platform.getWorkspaceRoot(),
      secretStore: this.platform.getSecretStore?.(),
    });
    const env = buildSecretProcessEnvironment(
      processEnv,
      resolvedSecrets,
      secretNames
    );
    const ownsRunner = !processRunner;
    const runner =
      processRunner ??
      new ScriptProcessRunner(
        workingDirectory ?? this.executionWorkspace.executionRoot
      );
    if (ownsRunner) {
      this.processRunners.add(runner);
    }
    try {
      return await runner.run({
        cwd: workingDirectory ?? this.executionWorkspace.executionRoot,
        timeout,
        argv: [executable, ...args],
        vars,
        env,
        onOutput,
        viaShell,
        windowsVerbatimArguments,
      });
    } finally {
      if (ownsRunner) {
        this.processRunners.delete(runner);
        runner.dispose();
      }
    }
  }

  /**
   * Resolve Python executable — prefer `python3` (Linux/macOS standard), fall back to `python`.
   */
  private resolvePythonExecutable(): string {
    if (process.platform === "win32") {
      return "python";
    }
    try {
      const { execSync } = require("child_process");
      execSync("python3 --version", { stdio: "ignore", timeout: 5000 });
      return "python3";
    } catch {
      return "python";
    }
  }

  /**
   * Resolve PowerShell executable — prefer `pwsh` (PowerShell 7+), fall back to `powershell`.
   */
  private resolvePowerShellExecutable(): string {
    try {
      const { execSync } = require("child_process");
      execSync("pwsh -Version", { stdio: "ignore", timeout: 5000 });
      return "pwsh";
    } catch {
      return "powershell";
    }
  }

  /**
   * Determines whether an end condition passes, routing to the correct comparison
   * axis based on `compareSource`.
   *
   * - `"auto"` (default): `"true"`/`"false"` use exit code; other values compare stdout.
   *   Stdout comparisons also require a clean exit (exitCode === 0).
   * - `"stdout"`: Compares stdout. Also requires a clean exit.
   * - `"stderr"`: Compares stderr content. Exit code is not checked.
   * - `"exitCode"`: Compares the numeric exit code directly. `"true"` = exit 0, `"false"` = non-zero.
   */
  private evaluateSuccess(
    result: {
      result: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      success: boolean;
    },
    returns: string | undefined,
    compareSource: EndConditionCompareSource = COMPARE_SOURCES.AUTO
  ): EvaluationComparison {
    const actualSource = this.resolveActualSource(returns, compareSource);

    // When returns is absent, exit code 0 = pass
    if (returns === undefined) {
      return {
        passed: result.exitCode === 0,
        matchRule: "exitCode",
        actual: String(result.exitCode ?? ""),
        actualSource,
      };
    }
    const expectedLower = returns.trim().toLowerCase();

    switch (compareSource) {
      case COMPARE_SOURCES.EXIT_CODE: {
        // Directly compare exit code — boolean keywords or exact integer string
        if (expectedLower === BOOLEAN_STRING_VALUES.TRUE) {
          return {
            passed: result.exitCode === 0,
            matchRule: result.exitCode === 0 ? "exitCode" : "none",
            actual: String(result.exitCode ?? ""),
            actualSource,
          };
        }
        if (expectedLower === BOOLEAN_STRING_VALUES.FALSE) {
          const passed = result.exitCode !== undefined && result.exitCode !== 0;
          return {
            passed,
            matchRule: passed ? "exitCode" : "none",
            actual: String(result.exitCode ?? ""),
            actualSource,
          };
        }
        const expectedCode = parseInt(returns.trim(), 10);
        const passed = !isNaN(expectedCode) && result.exitCode === expectedCode;
        return {
          passed,
          matchRule: passed ? "exitCode" : "none",
          actual: String(result.exitCode ?? ""),
          actualSource,
        };
      }

      case COMPARE_SOURCES.STDERR:
        // Compare stderr, no exit code requirement
        return this.checkResult(
          result.stderr ?? "",
          returns,
          undefined,
          actualSource
        );

      case COMPARE_SOURCES.STDOUT: {
        // Compare stdout, require clean exit
        const comparison = this.checkResult(
          result.result,
          returns,
          undefined,
          actualSource
        );
        return { ...comparison, passed: comparison.passed && result.success };
      }

      case COMPARE_SOURCES.AUTO:
      default: {
        // "true"/"false" use exit code; everything else compares stdout + requires clean exit
        const comparison = this.checkResult(
          result.result,
          returns,
          result.exitCode,
          actualSource
        );
        const isBooleanReturn =
          expectedLower === BOOLEAN_STRING_VALUES.TRUE ||
          expectedLower === BOOLEAN_STRING_VALUES.FALSE;
        return {
          ...comparison,
          passed: isBooleanReturn
            ? comparison.passed
            : comparison.passed && result.success,
          actual: isBooleanReturn
            ? String(result.exitCode ?? "")
            : comparison.actual,
        };
      }
    }
  }

  private resolveActualSource(
    returns: string | undefined,
    compareSource: EndConditionCompareSource = COMPARE_SOURCES.AUTO
  ): "stdout" | "stderr" | "exitCode" {
    if (compareSource === COMPARE_SOURCES.STDERR) return "stderr";
    if (compareSource === COMPARE_SOURCES.STDOUT) return "stdout";
    if (compareSource === COMPARE_SOURCES.EXIT_CODE) return "exitCode";
    if (returns === undefined) return "exitCode";

    const expectedLower = returns.trim().toLowerCase();
    return expectedLower === BOOLEAN_STRING_VALUES.TRUE ||
      expectedLower === BOOLEAN_STRING_VALUES.FALSE
      ? "exitCode"
      : "stdout";
  }

  /**
   * Compares an actual output string against an expected value using four strategies
   * (in order): exact match, boolean synonyms (with optional exit code precedence),
   * numeric >=, substring.
   *
   * Pass `exitCode` only for `"auto"` mode — it makes `"true"`/`"false"` use exit
   * code instead of stdout content. For explicit `compareSource` values, call
   * `evaluateSuccess` directly; don't pass `exitCode` here.
   */
  private checkResult(
    actualResult: string,
    expectedResult: string,
    exitCode?: number,
    actualSource: "stdout" | "stderr" | "exitCode" = "stdout"
  ): EvaluationComparison {
    const actual = actualResult.trim().toLowerCase();
    const expected = expectedResult.trim().toLowerCase();
    const comparisonActual = actualResult.trim();

    const matched = (passed: boolean, matchRule: ScriptMatchRule) => ({
      passed,
      matchRule: passed ? matchRule : ("none" as const),
      actual: comparisonActual,
      actualSource,
    });

    // Exact match (handles explicit "true"/"false" stdout output)
    if (actual === expected) {
      return matched(true, "exact");
    }

    // Boolean interpretation — explicit stdout output takes priority; exit code is the fallback.
    // This prevents a script that explicitly prints "false" from being treated as passing
    // just because it exited cleanly (exit code 0).
    const isExplicitTrue =
      actual === BOOLEAN_STRING_VALUES.TRUE ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.TRUE_NUMERIC ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.TRUE_YES ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.TRUE_PASS ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.TRUE_PASSED;
    const isExplicitFalse =
      actual === BOOLEAN_STRING_VALUES.FALSE ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.FALSE_NUMERIC ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.FALSE_NO ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.FALSE_FAIL ||
      actual === SCRIPT_BOOLEAN_OUTPUT_VALUES.FALSE_FAILED;

    if (expected === BOOLEAN_STRING_VALUES.TRUE) {
      if (isExplicitFalse) return matched(false, "boolean"); // Explicit "false" stdout overrides exit code
      if (isExplicitTrue) return matched(true, "boolean"); // Explicit "true" stdout (already caught by exact match above, kept for clarity)
      // No explicit boolean output — fall back to exit code
      if (exitCode !== undefined) {
        return matched(exitCode === 0, "boolean");
      }
      return matched(false, "boolean");
    }

    if (expected === BOOLEAN_STRING_VALUES.FALSE) {
      if (isExplicitTrue) return matched(false, "boolean"); // Explicit "true" stdout overrides exit code
      if (isExplicitFalse) return matched(true, "boolean"); // Explicit "false" stdout
      // No explicit boolean output — fall back to exit code
      if (exitCode !== undefined) {
        return matched(exitCode !== 0, "boolean");
      }
      return matched(false, "boolean");
    }

    // Numeric comparison
    const actualNum = parseFloat(actual);
    const expectedNum = parseFloat(expected);
    if (!isNaN(actualNum) && !isNaN(expectedNum)) {
      return matched(actualNum >= expectedNum, "numericGte"); // For coverage percentages, etc.
    }

    // String contains (for complex outputs)
    return matched(actual.includes(expected), "substring");
  }

  /**
   * Create a sample end condition script by copying from templates
   */
  async createSampleScript(
    scriptType: EndConditionScriptType,
    scriptName?: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.platform.getWorkspaceRoot();
    if (!workspaceRoot && !workingDirectory) {
      return null;
    }

    const baseDir = workingDirectory || workspaceRoot!;
    const ctrlyokeDir = path.join(baseDir, PATH_CONSTANTS.CTRLYOKE_DIR);
    const scriptsDir = path.join(ctrlyokeDir, PATH_CONSTANTS.SCRIPTS_DIR);

    // Ensure .ctrlyoke/scripts directory exists
    try {
      await fs.promises.mkdir(scriptsDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    // Determine template file name and destination file name
    let templateFileName: string;
    let defaultDestinationFileName: string;

    switch (scriptType) {
      case END_CONDITION_SCRIPT_TYPES.PYTHON:
        templateFileName = "check_condition.py";
        defaultDestinationFileName = "check_condition.py";
        break;

      case END_CONDITION_SCRIPT_TYPES.JAVASCRIPT:
        templateFileName = "check_condition.js";
        defaultDestinationFileName = "check_condition.js";
        break;

      case END_CONDITION_SCRIPT_TYPES.SHELL:
        templateFileName =
          process.platform === "win32"
            ? "check_condition.bat"
            : "check_condition.sh";
        defaultDestinationFileName = templateFileName;
        break;

      case END_CONDITION_SCRIPT_TYPES.POWERSHELL:
        templateFileName = "check_condition.ps1";
        defaultDestinationFileName = "check_condition.ps1";
        break;

      default:
        return null;
    }

    const destinationFileName =
      scriptName?.trim() || defaultDestinationFileName;
    if (
      destinationFileName === "." ||
      destinationFileName === ".." ||
      /[\\/\0]/.test(destinationFileName) ||
      destinationFileName.includes("..")
    ) {
      throw new Error(
        "Script name must be a file name inside .ctrlyoke/scripts."
      );
    }

    // Get template file path from extension directory
    const templatePath = path.join(
      this.platform.getExtensionPath(),
      "out",
      "templates",
      templateFileName
    );
    const destinationPath = path.join(scriptsDir, destinationFileName);

    try {
      // Read template file
      const templateContent = await fs.promises.readFile(templatePath);

      // Write to destination
      await fs.promises.writeFile(destinationPath, templateContent);

      // Make script executable on Unix systems
      if (process.platform !== "win32" && scriptType === "shell") {
        try {
          spawn("chmod", ["+x", destinationPath]);
        } catch {
          // Ignore chmod errors
        }
      }

      Log.info(`Created sample script from template: ${destinationPath}`);
      return destinationPath;
    } catch (error) {
      Log.error("Failed to create sample script from template:", error);
      return null;
    }
  }

  /**
   * Validate script before execution
   */
  async validateScript(
    scriptPath: string
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const stats = await fs.promises.stat(scriptPath);

      if (!stats.isFile()) {
        return { valid: false, error: "Path is not a file" };
      }

      const command = this.getScriptCommand(scriptPath);
      if (!command) {
        return { valid: false, error: "Unsupported script type" };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "File not found",
      };
    }
  }

  /**
   * Kill all running processes
   */
  killAllProcesses(): void {
    for (const runner of this.processRunners) {
      runner.dispose();
    }
    this.processRunners.clear();
    Log.info("Killed all running end condition processes");
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.killAllProcesses();
    Log.trace("EndConditionEvaluator disposed");
  }
}
