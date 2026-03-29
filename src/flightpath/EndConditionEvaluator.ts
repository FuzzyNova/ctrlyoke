import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { EndCondition } from "../types/FlightPathTypes";
import { ConfigurationUtils, PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { CliProcessManager } from "../utils/CliProcessManager";
import type { PlatformAdapter } from "../platform/PlatformAdapter";

export interface EvaluationResult {
  success: boolean;
  stdout: string; // Separate stdout from script
  stderr: string; // Separate stderr from script
  result: string; // Keep for backward compatibility (same as stdout)
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
   * Evaluate an end condition
   */
  async evaluateCondition(
    condition: EndCondition,
    workingDirectory?: string
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
            success: false,
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
        timeout
      );

      // Check if result matches expected value
      const checkSuccess = this.checkResult(result.result, condition.returns, result.exitCode);

      // For boolean "true"/"false" returns, exit code IS the success criterion
      // (checkResult already evaluated it). For other returns, also require a
      // clean exit (exitCode === 0) so unexpected crashes still fail the check.
      const expectedLower = condition.returns.trim().toLowerCase();
      const isBooleanReturn = expectedLower === "true" || expectedLower === "false";
      const success = isBooleanReturn ? checkSuccess : checkSuccess && result.success;

      return {
        success,
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
        success: false,
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
   * After resolution, validates the path is within the workspace root for security.
   */
  private async resolveScriptPath(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.platform.getWorkspaceRoot();

    // Try absolute path first
    if (path.isAbsolute(scriptPath)) {
      try {
        await fs.promises.access(scriptPath);
        // Security: validate absolute path is within workspace
        if (workspaceRoot && !scriptPath.startsWith(workspaceRoot)) {
          Log.error(
            `Security: Script path "${scriptPath}" is outside workspace root "${workspaceRoot}"`
          );
          return null;
        }
        return scriptPath;
      } catch {
        return null;
      }
    }

    // Try relative to working directory
    if (workingDirectory) {
      const fullPath = path.resolve(workingDirectory, scriptPath);
      try {
        await fs.promises.access(fullPath);
        // Security: validate resolved path is within workspace
        if (workspaceRoot && !fullPath.startsWith(workspaceRoot)) {
          Log.error(
            `Security: Resolved script path "${fullPath}" is outside workspace root "${workspaceRoot}"`
          );
          return null;
        }
        return fullPath;
      } catch {
        // Continue to workspace resolution
      }
    }

    // Try relative to workspace root
    if (workspaceRoot) {
      const workspacePath = path.resolve(workspaceRoot, scriptPath);
      try {
        await fs.promises.access(workspacePath);
        return workspacePath;
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
        return flightpathPath;
      } catch {
        // Script not found
      }
    }

    return null;
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
        return { executable: this.resolvePythonExecutable(), args: [scriptPath] };
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
    timeout: number = ConfigurationUtils.getScriptTimeoutMs()
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

    try {
      const result = await this.processManager.spawn(executable, args, {
        cwd: workingDirectory || this.platform.getWorkspaceRoot(),
        timeout,
        env: cleanEnv,
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
   * Check if script result matches expected value.
   *
   * For boolean "true"/"false" expected values, exit code takes precedence when
   * available — exit 0 = "true", non-zero exit = "false". This means commands like
   * `npm run compile` with `returns: "true"` pass on a clean exit without needing
   * to emit a literal "true" to stdout.
   *
   * For all other expected values, stdout is compared (exact, numeric >=, substring).
   */
  private checkResult(actualResult: string, expectedResult: string, exitCode?: number): boolean {
    const actual = actualResult.trim().toLowerCase();
    const expected = expectedResult.trim().toLowerCase();

    // Exact match (handles explicit "true"/"false" stdout output)
    if (actual === expected) {
      return true;
    }

    // Boolean interpretation — exit code takes precedence over stdout
    if (expected === "true") {
      if (exitCode !== undefined) {
        return exitCode === 0;
      }
      return (
        actual === "true" ||
        actual === "1" ||
        actual === "yes" ||
        actual === "pass" ||
        actual === "passed"
      );
    }

    if (expected === "false") {
      if (exitCode !== undefined) {
        return exitCode !== 0;
      }
      return (
        actual === "false" ||
        actual === "0" ||
        actual === "no" ||
        actual === "fail" ||
        actual === "failed"
      );
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
    expectedValue: string,
    retryCount: number,
    maxRetries: number
  ): string {
    return template
      .replace(/{scriptOutput}/g, evaluationResult.stdout.trim())
      .replace(/{errorOutput}/g, evaluationResult.stderr.trim())
      .replace(/{expectedValue}/g, expectedValue)
      .replace(/{actualValue}/g, evaluationResult.result.trim())
      .replace(/{retryCount}/g, String(retryCount))
      .replace(/{maxRetries}/g, String(maxRetries));
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
