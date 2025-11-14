import * as vscode from "vscode";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { EndCondition } from "../types/FlightPathTypes";

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
  private runningProcesses: Set<ChildProcess> = new Set();
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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
      console.log(
        `FlightPath: Evaluating end condition script: ${condition.script}`
      );

      // Resolve script path
      const scriptPath = await this.resolveScriptPath(
        condition.script,
        workingDirectory
      );
      if (!scriptPath) {
        return {
          success: false,
          stdout: "",
          stderr: "",
          result: "",
          error: `Script not found: ${condition.script}`,
          duration: Date.now() - startTime,
        };
      }

      // Determine script type and command
      const command = this.getScriptCommand(scriptPath);
      if (!command) {
        return {
          success: false,
          stdout: "",
          stderr: "",
          result: "",
          error: `Unsupported script type: ${path.extname(scriptPath)}`,
          duration: Date.now() - startTime,
        };
      }

      // Execute script with timeout
      const timeout = condition.timeout || 30000; // 30 seconds default
      const result = await this.executeScript(
        command.executable,
        command.args,
        workingDirectory,
        timeout
      );

      // Check if result matches expected value
      const success = this.checkResult(result.result, condition.returns);

      return {
        success: success && result.success,
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
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Resolve script path relative to workspace or absolute
   */
  private async resolveScriptPath(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    // Try absolute path first
    if (path.isAbsolute(scriptPath)) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(scriptPath));
        return scriptPath;
      } catch {
        return null;
      }
    }

    // Try relative to working directory
    if (workingDirectory) {
      const fullPath = path.resolve(workingDirectory, scriptPath);
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
        return fullPath;
      } catch {
        // Continue to workspace resolution
      }
    }

    // Try relative to workspace root
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const workspacePath = path.resolve(
        workspaceFolder.uri.fsPath,
        scriptPath
      );
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(workspacePath));
        return workspacePath;
      } catch {
        // Continue to .flightpath directory
      }

      // Try in .flightpath directory
      const flightpathDir = vscode.workspace
        .getConfiguration("flightpath")
        .get<string>("promptsDirectory", ".flightpath");
      const flightpathPath = path.resolve(
        workspaceFolder.uri.fsPath,
        flightpathDir,
        scriptPath
      );
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(flightpathPath));
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
        return { executable: "python", args: [scriptPath] };
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
              executable: "powershell",
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
    timeout: number = 30000
  ): Promise<{
    success: boolean;
    result: string;
    error?: string;
    timeout?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let isResolved = false;

      const child = spawn(executable, args, {
        cwd:
          workingDirectory ||
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.runningProcesses.add(child);

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          child.kill("SIGKILL");
          this.runningProcesses.delete(child);
          resolve({
            success: false,
            result: stdout,
            stdout: stdout,
            stderr: stderr,
            error: "Script execution timed out",
            timeout: true,
          });
        }
      }, timeout);

      // Collect output
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      // Handle completion
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        this.runningProcesses.delete(child);

        if (!isResolved) {
          isResolved = true;
          resolve({
            success: code === 0,
            result: stdout.trim(),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            error: stderr.trim() || undefined,
            exitCode: code ?? undefined,
          });
        }
      });

      // Handle errors
      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        this.runningProcesses.delete(child);

        if (!isResolved) {
          isResolved = true;
          resolve({
            success: false,
            result: "",
            stdout: "",
            stderr: "",
            error: `Failed to execute script: ${error.message}`,
          });
        }
      });
    });
  }

  /**
   * Check if script result matches expected value
   */
  private checkResult(actualResult: string, expectedResult: string): boolean {
    const actual = actualResult.trim().toLowerCase();
    const expected = expectedResult.trim().toLowerCase();

    // Exact match
    if (actual === expected) {
      return true;
    }

    // Boolean interpretation
    if (expected === "true") {
      return (
        actual === "true" ||
        actual === "1" ||
        actual === "yes" ||
        actual === "pass" ||
        actual === "passed"
      );
    }

    if (expected === "false") {
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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder && !workingDirectory) {
      return null;
    }

    const baseDir = workingDirectory || workspaceFolder!.uri.fsPath;
    const flightpathDir = path.join(baseDir, ".flightpath");

    // Ensure .flightpath directory exists
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(flightpathDir));
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
      this.context.extensionPath,
      "out",
      "templates",
      templateFileName
    );
    const destinationPath = path.join(flightpathDir, destinationFileName);

    try {
      // Read template file
      const templateContent = await vscode.workspace.fs.readFile(
        vscode.Uri.file(templatePath)
      );

      // Write to destination
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(destinationPath),
        templateContent
      );

      // Make script executable on Unix systems
      if (process.platform !== "win32" && scriptType === "shell") {
        try {
          spawn("chmod", ["+x", destinationPath]);
        } catch {
          // Ignore chmod errors
        }
      }

      console.log(
        `FlightPath: Created sample script from template: ${destinationPath}`
      );
      return destinationPath;
    } catch (error) {
      console.error(
        "FlightPath: Failed to create sample script from template:",
        error
      );
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
      const stats = await vscode.workspace.fs.stat(vscode.Uri.file(scriptPath));

      if (stats.type !== vscode.FileType.File) {
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
    for (const process of this.runningProcesses) {
      try {
        process.kill("SIGKILL");
      } catch {
        // Ignore errors when killing processes
      }
    }
    this.runningProcesses.clear();
    console.log("FlightPath: Killed all running end condition processes");
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.killAllProcesses();
    console.log("FlightPath: EndConditionEvaluator disposed");
  }
}
