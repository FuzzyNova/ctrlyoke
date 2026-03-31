import * as path from "path";
import type { PlatformAdapter } from "./PlatformAdapter";
import { PERMISSION_MODES } from "../types/DashboardConstants";

export interface ResolvedCliConfig {
  harness: string;
  model?: string;
  cwd?: string;
  timeout: number;
  scriptTimeout: number;
  allowedTools: string[];
  deniedTools: string[];
  /** When true, maps to "dangerouslyAllowAll" tool permissions mode. */
  allowAllTools: boolean;
  /** Extra directories to pass as --add-dir to Copilot CLI (from --add-dir flags). */
  additionalDirs: string[];
  /** Session ID to resume (--resume flag). */
  resume?: string;
  /** Force-start a brand-new session even if the workflow says resumeSession. */
  newSession?: boolean;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
  color: boolean;
  headless?: boolean;
  /**
   * Execution mode for CLI operation.
   * Detected from TTY presence (default) or overridden by --interactive / --headless flags.
   * Exposed so that CliAdapter.getConfig("cliExecutionMode") returns the
   * correct value when CliIntegration reads the execution mode via the
   * platform adapter rather than vscode.workspace.getConfiguration().
   */
  cliExecutionMode: "interactive" | "headless";
}

/**
 * Node.js CLI implementation of PlatformAdapter.
 * Used by the standalone flightpath CLI binary.
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
        if (this.config.allowAllTools)
          return PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL as unknown as T;
        if (
          this.config.allowedTools.length > 0 ||
          this.config.deniedTools.length > 0
        )
          return PERMISSION_MODES.CUSTOM as unknown as T;
        return PERMISSION_MODES.ALLOW_ALL as unknown as T;

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

      // ── Fallback: direct property access ─────────────────────────────────
      default:
        return (
          ((this.config as unknown as Record<string, unknown>)[key] as T) ??
          defaultValue
        );
    }
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
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
