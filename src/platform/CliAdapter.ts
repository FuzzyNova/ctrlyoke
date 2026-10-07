import * as path from "path";
import type { PlatformAdapter } from "./PlatformAdapter";
import type { ResolverWorkspaceFolder } from "./WorkspaceRootResolver";
import type { ExecutionMode } from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { SecretStore } from "./SecretStore";
import { OsCredentialStore } from "./OsCredentialStore";
import { resolvePackageRootFromEntry } from "../utils/CtrlyokeCliPath";
import { INTERACTIVE_TERMINAL_MODES } from "../types/DashboardConstants";
import type { InteractiveTerminalMode } from "../types/DashboardConstants";

export interface ResolvedCliConfig {
  model?: string;
  cwd?: string;
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
  interactiveTerminal?: InteractiveTerminalMode;
}

/**
 * Node.js CLI implementation of PlatformAdapter.
 * Used by the standalone ctrlyoke CLI binary.
 */
export class CliAdapter implements PlatformAdapter {
  readonly interactiveTerminal: InteractiveTerminalMode;
  private readonly secretStore: SecretStore;

  constructor(
    private readonly config: ResolvedCliConfig,
    secretStore: SecretStore = new OsCredentialStore()
  ) {
    this.secretStore = secretStore;
    this.interactiveTerminal =
      config.interactiveTerminal ?? INTERACTIVE_TERMINAL_MODES.INHERIT_STDIO;
  }

  getSecretStore(): SecretStore {
    return this.secretStore;
  }

  getConfig<T extends string>(key: string, defaultValue: T): T {
    if (key === "cliExecutionMode") {
      return this.config.cliExecutionMode as T;
    }
    return defaultValue;
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  getWorkspaceRoots(): string[] {
    return [this.getWorkspaceRoot()];
  }

  getApprovedExternalFileRoots(stateRoot?: string): string[] {
    return ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      ExternalRootsTrustStore.canonicalizeRoot(
        stateRoot ?? this.getWorkspaceRoot()
      )
    );
  }

  getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    const fsPath = this.getWorkspaceRoot();
    return [{ name: path.basename(fsPath), fsPath }];
  }

  getExtensionPath(): string {
    // Match VS Code's `context.extensionPath` contract: return package root.
    // In the bundled CLI this file lives under `<root>/out/cli.js`, so climb one level.
    return resolvePackageRootFromEntry(
      typeof __filename !== "undefined" ? __filename : process.cwd()
    );
  }
}
