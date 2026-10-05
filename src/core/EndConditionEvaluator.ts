import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { type ScriptProperties } from "../types/CtrlYokeTypes";
import {
  CTRLYOKE_ENV_VARS,
  END_CONDITION_SCRIPT_TYPES,
  SCRIPT_FILE_INTERPRETER_KINDS,
  SCRIPT_FILE_INTERPRETERS,
  SCRIPT_SHEBANG_INTERPRETER_NAMES,
  DIRECT_EXECUTABLE_EXTENSIONS,
  SHELL_KINDS,
  SHELL_TYPES,
  type ScriptFileExtension,
  type ScriptFileInterpreterKind,
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
import type { ScriptComparisonConfig } from "../utils/ScriptComparison";
import { compareScriptOutputAsync } from "../utils/ScriptComparisonAsync";
import { sanitizeTerminalOutput } from "../utils/TerminalOutputSanitizer";
import {
  containsShellSyntax,
  resolveShellInvocation,
} from "./harness/PtyProcessManager";
import {
  getShellInvocationError,
  hasMeaningfulNewline,
  resolveShellKind,
} from "../utils/ShellCatalog";
import {
  buildSecretProcessEnvironment,
  resolveSecretEnvironment,
} from "../utils/SecretResolver";

const pythonExecutables = new Map<string, string>();
const powerShellExecutables = new Map<string, string>();
const SHEBANG_SHELL_NAMES = new Set<string>([
  ...Object.values(SHELL_TYPES),
  SHELL_KINDS.PWSH,
  SHELL_KINDS.POWERSHELL,
]);

export interface EvaluationResult {
  /** Whether the script evaluation passed. Use onPass/onFail from the condition config to branch on this. */
  passed: boolean;
  /** The value read from `compareSource` and compared against `expected`. */
  actual: string;
  /** Whether the script could not run or evaluation itself failed. */
  errored: boolean;
  stdout: string; // Separate stdout from script
  stderr: string; // Separate stderr from script
  result: string; // Same as stdout. Not the compared value — that is `actual`, which $endCondition:actual reads.
  error?: string;
  /** A comparison-specific explanation, such as a guarded regex timeout. */
  comparisonReason?: string;
  timeout?: boolean;
  cancelled?: boolean;
  duration: number;
  exitCode?: number; // Capture exit code for better error handling
}

export interface EvaluationComparison {
  passed: boolean;
  actual: string;
  comparisonReason?: string;
  stdout: string;
  stderr: string;
  result: string;
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
   * Whether a script value is inline text rather than a file path with
   * arguments. Any meaningful line after the first makes it inline, full stop —
   * nobody writes a file path containing a newline, and `parseScriptCommand`
   * treats newlines as ordinary whitespace, so without this guard
   * `package.json\nnpm test` would resolve `package.json` as the script and
   * silently drop the second line's intent into argv.
   *
   * A first line followed only by blank lines keeps file-path routing.
   */
  static isMultilineInlineScript(script: string): boolean {
    return hasMeaningfulNewline(script);
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
   * When `expected` is absent, exit code 0 = pass.
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
    processRunner?: ScriptProcessRunner,
    workingFilePath?: string
  ): Promise<EvaluationResult> {
    const startTime = Date.now();
    const executionRoot =
      workingDirectory ?? this.executionWorkspace.executionRoot;

    try {
      Log.info(
        `[EndConditionEvaluator] Evaluating end condition script: ${condition.script}`
      );

      const hasMeaningfulNewline =
        EndConditionEvaluator.isMultilineInlineScript(condition.script);
      const { scriptPath: rawScriptPath, args: additionalArgs } =
        hasMeaningfulNewline
          ? { scriptPath: "", args: [] }
          : EndConditionEvaluator.parseScriptCommand(condition.script);

      // Resolve script path
      const resolvedScriptPath = hasMeaningfulNewline
        ? null
        : await this.resolveScriptPath(rawScriptPath, workingDirectory);

      let command: {
        executable: string;
        args: string[];
        viaShell?: boolean;
        windowsVerbatimArguments?: boolean;
      };

      if (
        resolvedScriptPath &&
        !containsShellSyntax(additionalArgs.join(" "))
      ) {
        // A plain file command can use direct argv dispatch. If its arguments
        // include shell syntax, the command below must retain shell semantics.
        const fileCommand = this.getScriptCommand(resolvedScriptPath);
        if (!fileCommand) {
          return {
            passed: false,
            actual: "",
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
        // (honoring the per-condition override and `terminal.shellExecutable`)
        // instead of Node's own
        // `shell:true`/ComSpec fallback is what keeps this consistent with
        // interactive script steps — the same script text no longer runs
        // under a different, silently-chosen shell depending on execution mode.
        Log.info(
          `[EndConditionEvaluator] Using shell for command: ${condition.script}`
        );
        const shellInvocation = resolveShellInvocation(
          condition.script,
          condition.shell
        );
        const shellError = getShellInvocationError(
          condition.script,
          shellInvocation.shellKind
        );
        if (shellError) {
          throw new Error(shellError);
        }
        Log.debug(
          `[EndConditionEvaluator] Resolved shell (${shellInvocation.shellKind}) for direct command: ${shellInvocation.executable} ${shellInvocation.args
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
        ConfigurationUtils.secondsToMs(condition.timeoutSec) ??
        ConfigurationUtils.getScriptTimeoutMs();
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
        command.windowsVerbatimArguments ?? false,
        workingFilePath
      );

      const normalizedResult = this.normalizeScriptOutput(result);

      if (result.errored) {
        return {
          passed: false,
          actual: "",
          errored: true,
          stdout: normalizedResult.stdout,
          stderr: normalizedResult.stderr,
          result: normalizedResult.result,
          error: result.error,
          timeout: result.timeout,
          duration: Date.now() - startTime,
          exitCode: result.exitCode,
        };
      }

      const comparison = await this.evaluateSuccess(
        normalizedResult,
        condition
      );

      return {
        ...comparison,
        errored: result.errored ?? false,
        stdout: comparison.stdout,
        stderr: comparison.stderr,
        result: comparison.result,
        error: result.error,
        timeout: result.timeout,
        cancelled: result.cancelled,
        duration: Date.now() - startTime,
        exitCode: result.exitCode,
      };
    } catch (error) {
      return {
        passed: false,
        actual: "",
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
  async evaluateResult(
    result: {
      result: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      success: boolean;
    },
    comparison: ScriptComparisonConfig
  ): Promise<EvaluationComparison> {
    return this.evaluateSuccess(this.normalizeScriptOutput(result), comparison);
  }

  private normalizeScriptOutput<
    T extends { result: string; stdout?: string; stderr?: string },
  >(result: T): T & { result: string; stdout: string; stderr: string } {
    const stdout = sanitizeTerminalOutput(result.stdout ?? result.result);
    const stderr = sanitizeTerminalOutput(result.stderr ?? "");
    return { ...result, stdout, stderr, result: stdout };
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
  protected async resolveScriptPath(
    scriptPath: string,
    workingDirectory?: string
  ): Promise<string | null> {
    const workspaceRoot = this.executionWorkspace.executionRoot;
    const homeScriptsDir = EndConditionEvaluator.getUserHomeScriptsDir();

    // Try absolute path first
    if (path.isAbsolute(scriptPath)) {
      try {
        if (!(await this.isRegularFile(scriptPath))) return null;
        const canonical =
          await EndConditionEvaluator.canonicalizePath(scriptPath);
        if (
          !(await this.isAllowedPath(canonical, workspaceRoot, homeScriptsDir))
        ) {
          Log.error(
            `[EndConditionEvaluator] Security: Script path "${scriptPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
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
        if (await this.isRegularFile(fullPath)) {
          const canonical =
            await EndConditionEvaluator.canonicalizePath(fullPath);
          if (
            !(await this.isAllowedPath(
              canonical,
              workspaceRoot,
              homeScriptsDir
            ))
          ) {
            Log.error(
              `[EndConditionEvaluator] Security: Resolved script path "${fullPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
            );
            throw new Error(
              `Security: Resolved script path "${fullPath}" is outside workspace root "${workspaceRoot}" and home scripts directory "${homeScriptsDir}"`
            );
          }
          return canonical;
        }
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
        if (await this.isRegularFile(workspacePath)) {
          const canonical =
            await EndConditionEvaluator.canonicalizePath(workspacePath);
          const canonicalRoot =
            await EndConditionEvaluator.canonicalizePath(workspaceRoot);
          if (
            !EndConditionEvaluator.isWithinDirectory(canonical, canonicalRoot)
          ) {
            Log.error(
              `[EndConditionEvaluator] Security: Script path traversal detected: "${workspacePath}" resolves outside workspace root "${workspaceRoot}"`
            );
            throw new Error(
              `Security: Script path traversal detected: "${workspacePath}" resolves outside workspace root "${workspaceRoot}"`
            );
          }
          return canonical;
        }
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
        if (await this.isRegularFile(ctrlyokePath)) {
          const canonical =
            await EndConditionEvaluator.canonicalizePath(ctrlyokePath);
          const canonicalRoot =
            await EndConditionEvaluator.canonicalizePath(workspaceRoot);
          if (
            !EndConditionEvaluator.isWithinDirectory(canonical, canonicalRoot)
          ) {
            Log.error(
              `[EndConditionEvaluator] Security: Script path traversal detected: "${ctrlyokePath}" resolves outside workspace root "${workspaceRoot}"`
            );
            throw new Error(
              `Security: Script path traversal detected: "${ctrlyokePath}" resolves outside workspace root "${workspaceRoot}"`
            );
          }
          return canonical;
        }
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
      if (!(await this.isRegularFile(homeScriptPath))) return null;
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
          `[EndConditionEvaluator] Security: Script path traversal detected in home scripts directory: "${homeScriptPath}"`
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

  private async isRegularFile(candidatePath: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(candidatePath)).isFile();
    } catch {
      return false;
    }
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
  protected getScriptCommand(
    scriptPath: string
  ): { executable: string; args: string[] } | null {
    const ext = path.extname(scriptPath).toLowerCase();

    const interpreter = this.isScriptFileExtension(ext)
      ? SCRIPT_FILE_INTERPRETERS[ext]
      : undefined;

    if (!interpreter) {
      if (this.isDirectlyExecutable(scriptPath, ext)) {
        return { executable: scriptPath, args: [] };
      }

      return this.getShebangCommand(scriptPath);
    }

    // cmd.exe is a Windows-only interpreter. PowerShell 7, unlike cmd.exe, is
    // portable and its resolver supplies the Windows 5.1 fallback when needed.
    if (
      interpreter === SCRIPT_FILE_INTERPRETER_KINDS.CMD &&
      process.platform !== "win32"
    ) {
      return null;
    }

    const commandByInterpreter: {
      [kind in ScriptFileInterpreterKind]: {
        (): { executable: string; args: string[] };
      };
    } = {
      [SCRIPT_FILE_INTERPRETER_KINDS.PYTHON]: () => ({
        executable: this.resolvePythonExecutable(),
        args: [scriptPath],
      }),
      [SCRIPT_FILE_INTERPRETER_KINDS.NODE]: () => ({
        executable: "node",
        args: [scriptPath],
      }),
      [SCRIPT_FILE_INTERPRETER_KINDS.TYPESCRIPT]: () =>
        this.resolveTypeScriptCommand(scriptPath),
      [SCRIPT_FILE_INTERPRETER_KINDS.SHELL]: () => ({
        executable: process.platform === "win32" ? "bash" : "sh",
        args: [scriptPath],
      }),
      [SCRIPT_FILE_INTERPRETER_KINDS.CMD]: () => ({
        executable: "cmd",
        args: ["/c", scriptPath],
      }),
      [SCRIPT_FILE_INTERPRETER_KINDS.POWERSHELL]: () => ({
        executable: this.resolvePowerShellExecutable(),
        args: ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
      }),
    };

    return commandByInterpreter[interpreter]();
  }

  /**
   * Resolve an extensionless, non-executable script from its shebang. The
   * interpreter is reduced to the same executable vocabulary used by the
   * extension dispatcher so POSIX paths are never passed to Windows spawn.
   */
  private getShebangCommand(
    scriptPath: string
  ): { executable: string; args: string[] } | null {
    const interpreter = this.readShebangInterpreter(scriptPath);
    if (!interpreter) {
      return null;
    }

    const interpreterName = this.getInterpreterName(interpreter);
    if (
      interpreterName === SCRIPT_SHEBANG_INTERPRETER_NAMES.PYTHON ||
      interpreterName === SCRIPT_SHEBANG_INTERPRETER_NAMES.PYTHON3
    ) {
      return {
        executable: this.resolvePythonExecutable(),
        args: [scriptPath],
      };
    }

    if (interpreterName === SCRIPT_SHEBANG_INTERPRETER_NAMES.NODE) {
      return {
        executable: SCRIPT_FILE_INTERPRETER_KINDS.NODE,
        args: [scriptPath],
      };
    }

    if (!SHEBANG_SHELL_NAMES.has(interpreterName)) {
      return null;
    }

    const shellKind = resolveShellKind(interpreter);
    if (
      shellKind === SHELL_KINDS.PWSH ||
      shellKind === SHELL_KINDS.POWERSHELL
    ) {
      return {
        executable: this.resolvePowerShellExecutable(),
        args: [scriptPath],
      };
    }

    // resolveShellKind() is a UI-icon discriminant (dash/ksh collapse into
    // "sh", nu collapses into "nushell", which is not nu's real binary name)
    // — it must not be spawned directly. POSIX hosts run the literal
    // interpreter the shebang named; Windows has no standalone sh/dash/zsh,
    // so fall back to "bash" the same way the .sh extension dispatch above
    // does.
    return {
      executable: process.platform === "win32" ? "bash" : interpreterName,
      args: [scriptPath],
    };
  }

  /** Read and parse only the interpreter portion of the file's first line. */
  private readShebangInterpreter(scriptPath: string): string | null {
    try {
      const firstLine = fs
        .readFileSync(scriptPath, { encoding: "utf8" })
        .split(/\r?\n/, 1)[0];
      if (!firstLine.startsWith("#!")) {
        return null;
      }

      const tokens = firstLine.slice(2).trim().split(/\s+/);
      const firstToken = tokens[0];
      if (!firstToken || firstToken.startsWith("-")) {
        return null;
      }

      if (
        this.getInterpreterName(firstToken) ===
        SCRIPT_SHEBANG_INTERPRETER_NAMES.ENV
      ) {
        const envInterpreter = tokens[1];
        return envInterpreter && !envInterpreter.startsWith("-")
          ? envInterpreter
          : null;
      }

      return firstToken;
    } catch {
      return null;
    }
  }

  private getInterpreterName(interpreter: string): string {
    const baseName = interpreter.split(/[\\/]/).pop() ?? "";
    return baseName.replace(/\.exe$/i, "").toLowerCase();
  }

  private isScriptFileExtension(value: string): value is ScriptFileExtension {
    return Object.prototype.hasOwnProperty.call(
      SCRIPT_FILE_INTERPRETERS,
      value
    );
  }

  /**
   * Preserve direct execution only for files the host can execute without an
   * interpreter. Windows recognizes executable extensions; POSIX uses mode
   * bits because access(X_OK) is not meaningful on Windows.
   */
  private isDirectlyExecutable(scriptPath: string, ext: string): boolean {
    if (process.platform === "win32") {
      return Object.values(DIRECT_EXECUTABLE_EXTENSIONS).some(
        (extension) => extension === ext
      );
    }

    try {
      return (fs.statSync(scriptPath).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  private resolveTypeScriptCommand(scriptPath: string): {
    executable: string;
    args: string[];
  } {
    for (const entryPoint of ["tsx/cli", "ts-node/dist/bin.js"] as const) {
      try {
        const runnerPath = require.resolve(entryPoint, {
          paths: [
            path.dirname(scriptPath),
            this.executionWorkspace.executionRoot,
            __dirname,
          ],
        });
        return { executable: "node", args: [runnerPath, scriptPath] };
      } catch {
        // Try the next local runner.
      }
    }

    return {
      executable: "node",
      args: ["--experimental-strip-types", scriptPath],
    };
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
    windowsVerbatimArguments: boolean = false,
    workingFilePath?: string
  ): Promise<ScriptProcessResult> {
    const resolvedSecrets = await resolveSecretEnvironment(secretNames, {
      workspaceRoot: this.platform.getWorkspaceRoot(),
      secretStore: this.platform.getSecretStore?.(),
    });
    const env = {
      ...(buildSecretProcessEnvironment(
        processEnv,
        resolvedSecrets,
        secretNames
      ) ?? {}),
    };
    if (workingFilePath) {
      env[CTRLYOKE_ENV_VARS.WORKING_FILE] = workingFilePath.replace(/\\/g, "/");
    }
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
    const platform = process.platform;
    const cachedExecutable = pythonExecutables.get(platform);
    if (cachedExecutable !== undefined) {
      return cachedExecutable;
    }

    let executable: string;
    if (platform === "win32") {
      executable = "python";
    } else {
      try {
        const { execSync } = require("child_process");
        execSync("python3 --version", { stdio: "ignore", timeout: 5000 });
        executable = "python3";
      } catch {
        executable = "python";
      }
    }

    pythonExecutables.set(platform, executable);
    Log.debug(
      `[EndConditionEvaluator] Python executable resolved for ${platform}: ${executable}`
    );
    return executable;
  }

  /**
   * Resolve PowerShell executable — prefer `pwsh` (PowerShell 7+), fall back to
   * `powershell.exe` on Windows PowerShell 5.1.
   */
  protected resolvePowerShellExecutable(): string {
    const platform = process.platform;
    const cachedExecutable = powerShellExecutables.get(platform);
    if (cachedExecutable !== undefined) {
      return cachedExecutable;
    }

    let executable: string;
    if (platform !== "win32") {
      executable = "pwsh";
    } else {
      try {
        const { execSync } = require("child_process");
        execSync("pwsh -Version", { stdio: "ignore", timeout: 5000 });
        executable = "pwsh";
      } catch {
        executable = "powershell.exe";
      }
    }

    powerShellExecutables.set(platform, executable);
    Log.debug(
      `[EndConditionEvaluator] PowerShell executable resolved for ${platform}: ${executable}`
    );
    return executable;
  }

  /**
   * Determines whether a script condition passed by delegating to the shared
   * comparator. Nothing here inspects the output to choose a comparison — the
   * author's `operator` decides, and `compareSource` decides which stream is read.
   *
   * With no `expected`, the condition is "exited 0". Note there is deliberately
   * no implicit clean-exit requirement layered onto a stdout or stderr
   * comparison: if the author asked about the text, the text is the condition.
   */
  private async evaluateSuccess(
    result: {
      result: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      success: boolean;
    },
    comparison: ScriptComparisonConfig
  ): Promise<EvaluationComparison> {
    const comparisonResult = await compareScriptOutputAsync(comparison, {
      stdout: result.stdout ?? result.result,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    return {
      ...comparisonResult,
      comparisonReason: comparisonResult.reason,
      stdout: result.stdout ?? result.result,
      stderr: result.stderr ?? "",
      result: result.result,
    };
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
        templateFileName = "check_condition.sh";
        defaultDestinationFileName = "check_condition.sh";
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

    if (scriptType === END_CONDITION_SCRIPT_TYPES.SHELL) {
      const destinationExtension = path
        .extname(destinationFileName)
        .toLowerCase();
      templateFileName =
        destinationExtension === ".bat" || destinationExtension === ".cmd"
          ? "check_condition.bat"
          : "check_condition.sh";
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
      await fs.promises.writeFile(destinationPath, templateContent, {
        flag: "wx",
      });

      // Make script executable on Unix systems
      if (
        process.platform !== "win32" &&
        templateFileName === "check_condition.sh"
      ) {
        try {
          spawn("chmod", ["+x", destinationPath]);
        } catch {
          // Ignore chmod errors
        }
      }

      Log.info(
        `[EndConditionEvaluator] Created sample script from template: ${destinationPath}`
      );
      return destinationPath;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error(
          `A script named "${destinationFileName}" already exists in .ctrlyoke/scripts. Choose a different name.`
        );
      }
      Log.error(
        "[EndConditionEvaluator] Failed to create sample script from template:",
        error
      );
      return null;
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
    Log.info(
      "[EndConditionEvaluator] Killed all running end condition processes"
    );
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.killAllProcesses();
    Log.trace("[EndConditionEvaluator] disposed");
  }
}
