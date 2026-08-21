import * as os from "os";
import * as path from "path";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import {
  STATUS_LINE_TRACKING_PROVIDERS,
  HARNESS_IDS,
  type StatusLineTrackingHarnessId,
  type StatusLineTrackingProvider,
} from "../../../types/DashboardConstants";
import type { StatusLineTrackingSettings } from "../../../types/CtrlYokeSettings";
import { SettingsJsonMcpTracker } from "./SettingsJsonMcpTracker";
import {
  STATUS_LINE_SETTING_KEY,
  type SettingsJsonPersistentValueInstallResult,
} from "./SettingsJsonMcpTracker";

export interface StatuslineInstallResult {
  readonly kind: SettingsJsonPersistentValueInstallResult["kind"];
  readonly captured: boolean;
}

export interface StatuslineManagerLike {
  getSettings(): StatusLineTrackingSettings;
  uninstall(
    workspaceRoot: string,
    restoreCustomCommand: boolean
  ): Promise<void>;
}

interface StatuslineProviderDefinition {
  readonly tracker: SettingsJsonMcpTracker;
}

/**
 * Owns the persistent lifecycle of one harness's global statusline command.
 *
 * The harness settings file is machine-global, while the ctrlyoke settings
 * object stores the user's forward command. Keeping both mutations here makes
 * first-install capture and explicit restore/delete use the same locking and
 * statusLine parsing rules for every host and provider.
 */
export class StatuslineManager implements StatuslineManagerLike {
  private static readonly definitions = new Map<
    StatusLineTrackingProvider,
    StatuslineProviderDefinition
  >();

  static forProvider(provider: StatusLineTrackingProvider): StatuslineManager {
    return new StatuslineManager(provider, this.getDefinition(provider));
  }

  static providerForHarness(
    harnessId: StatusLineTrackingHarnessId
  ): StatusLineTrackingProvider {
    switch (harnessId) {
      case HARNESS_IDS.CLAUDE_CLI:
        return STATUS_LINE_TRACKING_PROVIDERS.CLAUDE;
      case HARNESS_IDS.ANTIGRAVITY_CLI:
        return STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY;
    }
  }

  static forHarness(harnessId: StatusLineTrackingHarnessId): StatuslineManager {
    return this.forProvider(this.providerForHarness(harnessId));
  }

  private static getDefinition(
    provider: StatusLineTrackingProvider
  ): StatuslineProviderDefinition {
    const existing = this.definitions.get(provider);
    if (existing) {
      return existing;
    }

    const tracker =
      provider === STATUS_LINE_TRACKING_PROVIDERS.CLAUDE
        ? SettingsJsonMcpTracker.getInstance("claude-cli-settings", {
            projectConfigPath: () =>
              path.join(os.homedir(), ".claude", "settings.json"),
            userConfigPath: () =>
              path.join(os.homedir(), ".claude", "settings.json"),
          })
        : SettingsJsonMcpTracker.getInstance("antigravity-cli-settings", {
            projectConfigPath: () =>
              path.join(
                os.homedir(),
                ".gemini",
                "antigravity-cli",
                "settings.json"
              ),
          });
    const definition = { tracker };
    this.definitions.set(provider, definition);
    return definition;
  }

  private constructor(
    private readonly provider: StatusLineTrackingProvider,
    private readonly definition: StatuslineProviderDefinition
  ) {}

  getSettings(): StatusLineTrackingSettings {
    return ConfigurationUtils.getStatusLineTrackingSettings(this.provider);
  }

  /** Install the wrapper and capture the user's command exactly once. */
  async install(
    workspaceRoot: string,
    command: string
  ): Promise<StatuslineInstallResult> {
    let captured = false;
    const result = await this.definition.tracker.installPersistentValue(
      workspaceRoot,
      STATUS_LINE_SETTING_KEY,
      { type: "command", command },
      async (preexistingValue, hadKey) => {
        const settings = this.getSettings();
        const customCommand = this.extractCommand(preexistingValue, hadKey);
        if (
          settings.customCommand.length === 0 &&
          customCommand !== undefined &&
          customCommand !== command
        ) {
          captured = true;
          await ConfigurationUtils.setStatusLineTrackingSettings(
            this.provider,
            {
              ...settings,
              customCommand,
              useCtrlyokeStyle: false,
            }
          );
        }
      },
      (currentValue, hadKey) =>
        this.extractCommand(currentValue, hadKey) === command
    );

    return { kind: result.kind, captured };
  }

  /** Restore the live custom command, or remove ctrlyoke's statusline key. */
  async uninstall(workspaceRoot: string, restoreCustomCommand: boolean) {
    const { customCommand } = this.getSettings();
    if (restoreCustomCommand && customCommand.length > 0) {
      await this.definition.tracker.uninstallPersistentValue(
        workspaceRoot,
        STATUS_LINE_SETTING_KEY,
        {
          action: "restore",
          value: { type: "command", command: customCommand },
        }
      );
      return;
    }

    await this.definition.tracker.uninstallPersistentValue(
      workspaceRoot,
      STATUS_LINE_SETTING_KEY,
      { action: "delete" }
    );
  }

  private extractCommand(value: unknown, hadKey: boolean): string | undefined {
    if (
      !hadKey ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const command = (value as { command?: unknown }).command;
    return typeof command === "string" && command.length > 0
      ? command
      : undefined;
  }
}
