import * as path from "path";
import type { PlatformAdapter } from "./PlatformAdapter";
import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
import type {
  ExecutionMode,
  PermissionMode,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";

export interface ResolvedCliConfig {
  harness: string;
  model?: string;
  cwd?: string;
  timeout: number;
  scriptTimeout: number;
  /** Explicit tool permission mode. Use PERMISSION_MODES constants. */
  permissionMode: PermissionMode;
  allowedTools: string[];
  deniedTools: string[];
  /** Extra directories to pass as --add-dir to Copilot CLI (from --add-dir flags). */
  additionalDirs: string[];
  /**
   * Session ID to resume (from --resume <id> flag).
   * When set, the first prompt step will resume this session.
   */
  sessionId?: string;
  /**
   * Whether to resume an existing session. Mirrors PromptFile.resumeSession semantics:
   * - false: always start a new session (equivalent to the old --new-session flag)
   * - true: resume the existing session
   * - undefined: inherit from workflow file / global setting
   */
  resumeSession?: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  color: boolean;
  /**
   * Variables from --var key=value flags. Merged over workflow-level vars: defaults.
   * Applied as {{key}} substitution in prompt text, model, additionalArgs, hook commands,
   * and endCondition script paths before execution.
   */
  vars: Record<string, string>;
  /**
   * Execution mode for CLI operation.
   * Detected from TTY presence (default) or overridden by --interactive / --headless flags.
   * Exposed so that CliAdapter.getConfig("cliExecutionMode") returns the
   * correct value when CliIntegration reads the execution mode via the
   * platform adapter rather than vscode.workspace.getConfiguration().
   */
  cliExecutionMode: ExecutionMode;
}

/**
 * Node.js CLI implementation of PlatformAdapter.
 * Used by the standalone ctrlyoke CLI binary.
 */
export class CliAdapter implements PlatformAdapter {
  constructor(private readonly config: ResolvedCliConfig) {}

  getConfig<T>(key: string, defaultValue: T): T {
    switch (key) {
      // ── Tool permissions ────────────────────────────────────────────────
      case "cliAllowedTools":
        return this.config.allowedTools as unknown as T;
      case "cliDeniedTools":
        return this.config.deniedTools as unknown as T;
      case "cliToolPermissions":
        return this.config.permissionMode as unknown as T;

      // ── Additional directories (--add-dir) ─────────────────────────────
      // CliProviderUtils.getWorkspaceDirs() reads this key to build --add-dir args.
      case "copilotCliAllowedDirs":
        return this.config.additionalDirs as unknown as T;

      // ── Execution mode ──────────────────────────────────────────────────
      case "cliExecutionMode":
        return this.config.cliExecutionMode as unknown as T;

      // ── Model selection ─────────────────────────────────────────────────
      // All three harness model keys map to the single --model flag value.
      case "copilotCliModel":
      case "claudeCliModel":
      case "codexCliModel":
        return (this.config.model ?? defaultValue) as unknown as T;

      // ── Timeouts ────────────────────────────────────────────────────────
      // ConfigurationUtils stores timeouts in *seconds* in the config key;
      // the *Ms() helpers multiply by 1000.  We need to reverse that here.
      case "scriptTimeout":
        return Math.round(this.config.scriptTimeout / 1000) as unknown as T;
      case "maxPromptExecutionTime":
        return Math.round(this.config.timeout / 1000) as unknown as T;

      // ── Session resumption ──────────────────────────────────────────────
      // Maps to PropertyResolver tier-3 (global setting fallback).
      case "resumeExistingSession":
        return (this.config.resumeSession ?? false) as unknown as T;

      // ── Fallback: config service only (file-based settings) ────────────
      // Do NOT fall back to this.config[key] — config field names don't match
      // VS Code setting key names, so property-name collisions cause silent bugs.
      default: {
        const serviceValue = configService.getNested(key);
        if (serviceValue !== undefined) {
          return serviceValue as unknown as T;
        }
        return defaultValue;
      }
    }
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  getWorkspaceRoots(): string[] {
    return [this.getWorkspaceRoot()];
  }

  getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    const fsPath = this.getWorkspaceRoot();
    return [{ name: path.basename(fsPath), fsPath }];
  }

  log(message: string): void {
    if (!this.config.quiet) {
      console.log(message);
    }
  }

  warn(message: string): void {
    if (!this.config.quiet) {
      console.warn(`⚠ ${message}`);
    }
  }

  error(message: string): void {
    console.error(`✗ ${message}`);
  }

  showProgress(message: string): void {
    if (!this.config.quiet && !this.config.json) {
      process.stdout.write(`\r${message}`);
    }
  }

  async showChoice(
    _message: string,
    ..._options: string[]
  ): Promise<string | undefined> {
    // In headless mode (CI/CD), choices cannot be presented — return undefined
    return undefined;
  }

  getExtensionPath(): string {
    // Match VS Code's `context.extensionPath` contract: return package root.
    // In the bundled CLI this file lives under `<root>/out/cli.js`, so climb one level.
    const entryDir = path.dirname(
      typeof __filename !== "undefined" ? __filename : process.cwd()
    );
    return path.basename(entryDir).toLowerCase() === "out"
      ? path.dirname(entryDir)
      : entryDir;
  }

  // focusDashboard is intentionally not implemented (no dashboard in CLI)
}
