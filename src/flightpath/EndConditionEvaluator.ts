import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  type ScriptProperties,
  type EndConditionCompareSource,
} from "../types/FlightPathTypes";
import {
  COMPARE_SOURCES,
  RETRY_PROMPT_PLACEHOLDERS,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { CliProcessManager } from "../utils/CliProcessManager";
import type { PlatformAdapter } from "../platform/PlatformAdapter";

export interface EvaluationResult {
  /** Whether the script evaluation passed. Use onPass/onFail from the condition config to branch on this. */
  passed: boolean;
  stdout: string; // Separate stdout from script
  stderr: string; // Separate stderr from script
  result: string; // Same as stdout; used in retry prompt interpolation ({actual})
  error?: string;
  timeout?: boolean;
  duration: number;
  exitCode?: number; // Capture exit code for better error handling
}

export class EndConditionEvaluator {
  private platform: PlatformAdapter;
  private processManager: CliProcessManager;

  constructor(platform: PlatformAdapter) {
    this.platform = platform;
    const workspaceRoot = platform.getWorkspaceRoot();
    this.processManager = new CliProcessManager(workspaceRoot, (msg) =>
      Log.debug(msg)
    );
  }

  /**
   * Evaluate whether an exit code satisfies a condition's returns/compareSource criteria.
   * Used when output is unavailable (e.g. interactive PTY execution).
   * Falls back to exit code 0 = pass for stdout/stderr comparisons where we have no output.
   */
  static evaluateExitCodeResult(
    exitCode: number,
    returns: string | undefined,
    compareSource: EndConditionCompareSource = "auto"
  ): boolean {
    if (returns === undefined) return exitCode === 0;
    const expectedLower = returns.trim().toLowerCase();

    if (compareSource === COMPARE_SOURCES.EXIT_CODE) {
      if (expectedLower === "true") return exitCode === 0;
      if (expectedLower === "false") return exitCode !== 0;
      const expected = parseInt(returns.trim(), 10);
      return !isNaN(expected) && exitCode === expected;
    }

    // AUTO mode: boolean keywords use exit code
    if (compareSource === COMPARE_SOURCES.AUTO) {
      if (expectedLower === "true") return exitCode === 0;
      if (expectedLower === "false") return exitCode !== 0;
    }

    // STDOUT / STDERR / AUTO with non-boolean: no output available — default to exit code 0
    return exitCode === 0;
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
    // Simple parsing: split by spaces, first part is script, rest are args
    // This handles common cases like ".flightpath/scripts/check.py 5"
    const parts = script.trim().split(/\s+/);
    return {
      scriptPath: parts[0],
      args: parts.slice(1),
    };
  }

  /**
   * Evaluate a script condition (endCondition, preCondition, or scriptStep).
   * When `returns` is absent, exit code 0 = pass.
   * @param vars Optional variable map — injected as FLIGHTPATH_VAR_<KEY> environment
   *   variables so end condition scripts can branch on workflow variables.
   * @param onOutput Optional streaming callback — called for each stdout chunk as it
   *   arrives so callers can forward live output to the dashboard without waiting for
   *   the process to finish.
   */
  async evaluateCondition(
    condition: ScriptProperties,
    workingDirectory?: string,
    vars?: Record<string, string>,
    onOutput?: (chunk: string) => void
  ): Promise<EvaluationResult> {
    const startTime = Date.now();

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

      let command: { executable: string; args: string[] } | null;

      if (resolvedScriptPath) {
        // File found - determine script type and command
        command = this.getScriptCommand(resolvedScriptPath);
        if (!command) {
          return {
            passed: false,
            stdout: "",
            stderr: "",
            result: "",
            error: `Unsupported script type: ${path.extname(resolvedScriptPath)}`,
            duration: Date.now() - startTime,
          };
        }
        // Append additional arguments from the script command
        command.args = [...command.args, ...additionalArgs];
      } else {
        // File not found - treat as direct shell command
        Log.info(
          `Script file not found, treating as direct command: ${condition.script}`
        );
        // Execute as shell command directly
        command = { executable: rawScriptPath, args: additionalArgs };
      }

      // Execute script with timeout from config or per-condition override
      const timeout =
        condition.timeout || ConfigurationUtils.getScriptTimeoutMs();
      const result = await this.executeScript(
        command.executable,
        command.args,
        workingDirectory,
        timeout,
        vars,
        onOutput
      );

      const passed = this.evaluateSuccess(
        result,
        condition.returns,
        condition.compareSource
      );

      return {
        passed,
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
        stdout: "",
        stderr: "",
        result: "",
        error: getErrorMessage(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Resolve script path relative to workspace or absolute.
   *
   * Resolution order:
   *   1. Absolute path — validated against workspace root OR home scripts dir
   *   2. Relative to workingDirectory — same validation
   *   3. Relative to workspace root — validated within workspace
   *   4. Relative to .flightpath/ dir — validated within workspace
   *   5. Relative to ~/.flightpath/scripts — user-level shared scripts, validated within home scripts dir
   *
   * All resolved paths are canonicalized with realpath() to prevent sibling-prefix
   * and symlink-escape bypasses before the boundary check.
   */
  private async resolveScriptPath(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.platform.getWorkspaceRoot();
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
          return null;
        }
        return canonical;
      } catch {
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
          return null;
        }
        return canonical;
      } catch {
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
          return null;
        }
        return canonical;
      } catch {
        // Continue to .flightpath directory
      }

      // Try in .flightpath directory
      const flightpathPath = path.resolve(
        workspaceRoot,
        PATH_CONSTANTS.FLIGHTPATH_DIR,
        scriptPath
      );
      try {
        await fs.promises.access(flightpathPath);
        const canonical =
          await EndConditionEvaluator.canonicalizePath(flightpathPath);
        const canonicalRoot =
          await EndConditionEvaluator.canonicalizePath(workspaceRoot);
        if (
          !EndConditionEvaluator.isWithinDirectory(canonical, canonicalRoot)
        ) {
          Log.error(
            `Security: Script path traversal detected: "${flightpathPath}" resolves outside workspace root "${workspaceRoot}"`
          );
          return null;
        }
        return canonical;
      } catch {
        // Continue to home scripts directory
      }
    }

    // Try in ~/.flightpath/scripts (user shared scripts directory)
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
        return null;
      }
      return canonical;
    } catch {
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
   * `C:\dev\FlightPath-evil` would incorrectly match workspace root `C:\dev\FlightPath`.
   */
  static isWithinDirectory(candidate: string, directory: string): boolean {
    return (
      candidate === directory || candidate.startsWith(directory + path.sep)
    );
  }

  /**
   * Returns the user's shared FlightPath scripts directory (~/.flightpath/scripts).
   * Scripts placed here can be referenced from any workspace, giving users a
   * single location for shared scripts without copying them per-project.
   */
  static getUserHomeScriptsDir(): string {
    return path.join(
      os.homedir(),
      PATH_CONSTANTS.FLIGHTPATH_DIR,
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
   * Execute script with timeout
   */
  private async executeScript(
    executable: string,
    args: string[],
    workingDirectory?: string,
    timeout: number = ConfigurationUtils.getScriptTimeoutMs(),
    vars?: Record<string, string>,
    onOutput?: (chunk: string) => void
  ): Promise<{
    success: boolean;
    result: string;
    error?: string;
    timeout?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }> {
    // Log what we're about to execute
    Log.debug(
      `Spawning command - executable: "${executable}", args: [${args.map((a) => `"${a}"`).join(", ")}]`
    );
    Log.debug(
      `Working directory: ${workingDirectory || this.platform.getWorkspaceRoot()}`
    );

    // Clean VS Code-specific environment variables that interfere with nested VS Code instances
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
    Log.debug(
      `Cleaned ${vsCodeEnvVars.length} VS Code env vars for isolated execution`
    );

    // Inject workflow variables as FLIGHTPATH_VAR_<KEY>=value so scripts can branch on them.
    if (vars && Object.keys(vars).length > 0) {
      for (const [k, v] of Object.entries(vars)) {
        cleanEnv[`FLIGHTPATH_VAR_${k.toUpperCase()}`] = v;
      }
    }

    try {
      const result = await this.processManager.spawn(executable, args, {
        cwd: workingDirectory || this.platform.getWorkspaceRoot(),
        timeout,
        env: cleanEnv,
        onStdout: onOutput,
        shell: false,
      });

      return {
        success: result.exitCode === 0,
        result: result.stdout.trim(),
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.stderr.trim() || undefined,
        exitCode: result.exitCode,
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
      };
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
    compareSource: EndConditionCompareSource = "auto"
  ): boolean {
    // When returns is absent, exit code 0 = pass
    if (returns === undefined) {
      return result.exitCode === 0;
    }
    const expectedLower = returns.trim().toLowerCase();

    switch (compareSource) {
      case COMPARE_SOURCES.EXIT_CODE: {
        // Directly compare exit code — boolean keywords or exact integer string
        if (expectedLower === "true") return result.exitCode === 0;
        if (expectedLower === "false")
          return result.exitCode !== undefined && result.exitCode !== 0;
        const expectedCode = parseInt(returns.trim(), 10);
        return !isNaN(expectedCode) && result.exitCode === expectedCode;
      }

      case COMPARE_SOURCES.STDERR:
        // Compare stderr, no exit code requirement
        return this.checkResult(result.stderr ?? "", returns);

      case COMPARE_SOURCES.STDOUT:
        // Compare stdout, require clean exit
        return this.checkResult(result.result, returns) && result.success;

      case COMPARE_SOURCES.AUTO:
      default: {
        // "true"/"false" use exit code; everything else compares stdout + requires clean exit
        const checkSuccess = this.checkResult(
          result.result,
          returns,
          result.exitCode
        );
        const isBooleanReturn =
          expectedLower === "true" || expectedLower === "false";
        return isBooleanReturn ? checkSuccess : checkSuccess && result.success;
      }
    }
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
    exitCode?: number
  ): boolean {
    const actual = actualResult.trim().toLowerCase();
    const expected = expectedResult.trim().toLowerCase();

    // Exact match (handles explicit "true"/"false" stdout output)
    if (actual === expected) {
      return true;
    }

    // Boolean interpretation — explicit stdout output takes priority; exit code is the fallback.
    // This prevents a script that explicitly prints "false" from being treated as passing
    // just because it exited cleanly (exit code 0).
    const isExplicitTrue =
      actual === "true" ||
      actual === "1" ||
      actual === "yes" ||
      actual === "pass" ||
      actual === "passed";
    const isExplicitFalse =
      actual === "false" ||
      actual === "0" ||
      actual === "no" ||
      actual === "fail" ||
      actual === "failed";

    if (expected === "true") {
      if (isExplicitFalse) return false; // Explicit "false" stdout overrides exit code
      if (isExplicitTrue) return true; // Explicit "true" stdout (already caught by exact match above, kept for clarity)
      // No explicit boolean output — fall back to exit code
      if (exitCode !== undefined) {
        return exitCode === 0;
      }
      return false;
    }

    if (expected === "false") {
      if (isExplicitTrue) return false; // Explicit "true" stdout overrides exit code
      if (isExplicitFalse) return true; // Explicit "false" stdout
      // No explicit boolean output — fall back to exit code
      if (exitCode !== undefined) {
        return exitCode !== 0;
      }
      return false;
    }

    // Numeric comparison
    const actualNum = parseFloat(actual);
    const expectedNum = parseFloat(expected);
    if (!isNaN(actualNum) && !isNaN(expectedNum)) {
      return actualNum >= expectedNum; // For coverage percentages, etc.
    }

    // String contains (for complex outputs)
    return actual.includes(expected);
  }

  /**
   * Build retry prompt from template by replacing placeholders
   */
  buildRetryPrompt(
    template: string,
    evaluationResult: EvaluationResult,
    expected: string,
    compareSource?: EndConditionCompareSource
  ): string {
    const replacements: Record<string, string> = {
      [RETRY_PROMPT_PLACEHOLDERS.STDOUT]: evaluationResult.stdout.trim(),
      [RETRY_PROMPT_PLACEHOLDERS.STDERR]: evaluationResult.stderr.trim(),
      [RETRY_PROMPT_PLACEHOLDERS.EXPECTED_VALUE]: expected,
      [RETRY_PROMPT_PLACEHOLDERS.ACTUAL_VALUE]: evaluationResult.result.trim(),
      [RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE]: String(
        evaluationResult.exitCode ?? ""
      ),
      [RETRY_PROMPT_PLACEHOLDERS.COMPARE_SOURCE]: compareSource ?? "auto",
    };

    return Object.entries(replacements).reduce(
      (result, [key, value]) =>
        result.replace(new RegExp(`\\{${key}\\}`, "g"), value),
      template
    );
  }

  /**
   * Create a sample end condition script by copying from templates
   */
  async createSampleScript(
    scriptType: "python" | "javascript" | "shell" | "powershell",
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.platform.getWorkspaceRoot();
    if (!workspaceRoot && !workingDirectory) {
      return null;
    }

    const baseDir = workingDirectory || workspaceRoot!;
    const flightpathDir = path.join(baseDir, PATH_CONSTANTS.FLIGHTPATH_DIR);
    const scriptsDir = path.join(flightpathDir, PATH_CONSTANTS.SCRIPTS_DIR);

    // Ensure .flightpath/scripts directory exists
    try {
      await fs.promises.mkdir(scriptsDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    // Determine template file name and destination file name
    let templateFileName: string;
    let destinationFileName: string;

    switch (scriptType) {
      case "python":
        templateFileName = "check_condition.py";
        destinationFileName = "check_condition.py";
        break;

      case "javascript":
        templateFileName = "check_condition.js";
        destinationFileName = "check_condition.js";
        break;

      case "shell":
        templateFileName =
          process.platform === "win32"
            ? "check_condition.bat"
            : "check_condition.sh";
        destinationFileName = templateFileName;
        break;

      case "powershell":
        templateFileName = "check_condition.ps1";
        destinationFileName = "check_condition.ps1";
        break;

      default:
        return null;
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
    this.processManager.dispose();
    Log.info("Killed all running end condition processes");
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.killAllProcesses();
    Log.debug("EndConditionEvaluator disposed");
  }
}
