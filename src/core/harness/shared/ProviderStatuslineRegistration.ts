import * as path from "path";
import { PERSISTENT_VALUE_INSTALL_RESULT_KINDS } from "../../../types/DashboardConstants";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { CliNotificationMonitor } from "./CliNotificationMonitor";
import type { StatuslineInstallResult } from "./StatuslineManager";

export interface ProviderStatuslineManager {
  resolveScriptPath(packageRoot: string): Promise<string | undefined>;
  install(
    workspaceRoot: string,
    command: string
  ): Promise<StatuslineInstallResult>;
}

export interface ProviderStatuslineRegistrationOptions {
  readonly manager: ProviderStatuslineManager;
  readonly logPrefix: string;
  readonly harnessLabel: string;
  readonly snapshotPrefix: string;
  readonly tokenEnvironmentVariable: string;
  readonly directoryEnvironmentVariable: string;
  readonly quoteNodeCommand?: boolean;
}

/** Owns the prompt-scoped statusline registration state shared by CLI harnesses. */
export class ProviderStatuslineRegistration {
  private readonly mutableSnapshotPaths = new Set<string>();
  private currentToken: string | undefined;
  private currentDirectory: string | undefined;
  private currentWorkspaceRoot: string | undefined;
  private enabledForPrompt = false;
  private installResult: StatuslineInstallResult | undefined;

  constructor(
    private readonly options: ProviderStatuslineRegistrationOptions
  ) {}

  get token(): string | undefined {
    return this.currentToken;
  }

  get directory(): string | undefined {
    return this.currentDirectory;
  }

  get workspaceRoot(): string | undefined {
    return this.currentWorkspaceRoot;
  }

  get enabled(): boolean {
    return this.enabledForPrompt;
  }

  get snapshotPaths(): ReadonlySet<string> {
    return this.mutableSnapshotPaths;
  }

  reset(token: string): void {
    this.currentToken = token;
    this.currentDirectory = undefined;
    this.currentWorkspaceRoot = undefined;
    this.enabledForPrompt = false;
    this.installResult = undefined;
  }

  async register(
    extensionPath: string,
    workspaceRoot: string
  ): Promise<StatuslineInstallResult> {
    const { manager, harnessLabel, logPrefix } = this.options;
    const scriptPath = await manager.resolveScriptPath(extensionPath);
    if (!scriptPath) {
      Log.warn(
        `[${logPrefix}] Skipping ${harnessLabel} statusline: no statusline script under ${extensionPath}`
      );
      return this.setNoOpResult();
    }

    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      [""],
      this.options.quoteNodeCommand
    ).trim();
    const snapshotDirectory = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const snapshotPath = path.join(
      snapshotDirectory,
      `${this.options.snapshotPrefix}-statusline-${this.currentToken}.json`
    );
    this.mutableSnapshotPaths.add(snapshotPath);

    try {
      const result = await manager.install(workspaceRoot, command);
      this.installResult = result;
      if (result.kind !== PERSISTENT_VALUE_INSTALL_RESULT_KINDS.DECLINED) {
        this.currentDirectory = snapshotDirectory;
        this.currentWorkspaceRoot = workspaceRoot;
        this.enabledForPrompt = true;
      }
      return result;
    } catch (error) {
      Log.warn(
        `[${logPrefix}] Failed to register ${harnessLabel} statusline: ${error}`
      );
      return this.setNoOpResult();
    }
  }

  consumeInstallResult(): StatuslineInstallResult | undefined {
    const result = this.installResult;
    this.installResult = undefined;
    return result;
  }

  buildSpawnEnv(): NodeJS.ProcessEnv {
    if (
      !this.enabledForPrompt ||
      !this.currentToken ||
      !this.currentDirectory
    ) {
      return {};
    }
    return {
      [this.options.tokenEnvironmentVariable]: this.currentToken,
      [this.options.directoryEnvironmentVariable]: this.currentDirectory,
      ...(this.currentWorkspaceRoot
        ? { CTRLYOKE_STATUSLINE_WORKSPACE_ROOT: this.currentWorkspaceRoot }
        : {}),
    };
  }

  private setNoOpResult(): StatuslineInstallResult {
    this.installResult = {
      kind: PERSISTENT_VALUE_INSTALL_RESULT_KINDS.NO_OP,
      captured: false,
    };
    return this.installResult;
  }
}
