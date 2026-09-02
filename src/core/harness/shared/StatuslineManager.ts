import * as os from "os";
import * as path from "path";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import {
  STATUS_LINE_TRACKING_PROVIDERS,
  HARNESS_IDS,
  SETTING_SCOPES,
  SETTING_PATHS,
  type StatusLineTrackingHarnessId,
  type StatusLineTrackingProvider,
} from "../../../types/DashboardConstants";
import { configService } from "../../../config/CtrlYokeConfigService";
import type { StatusLineTrackingSettings } from "../../../types/CtrlYokeSettings";
import { SettingsJsonMcpTracker } from "./SettingsJsonMcpTracker";
import {
  SETTINGS_JSON_INSTALL_KIND_WRITTEN,
  STATUS_LINE_SETTING_KEY,
  type SettingsJsonPersistentValueInstallResult,
} from "./SettingsJsonMcpTracker";

const QWEN_STATUS_LINE_SETTING_KEY = "ui.statusLine";

export interface StatuslineInstallResult {
  readonly kind: SettingsJsonPersistentValueInstallResult["kind"];
  readonly captured: boolean;
  /** True when a configured non-command statusline caused the install veto. */
  readonly collision?: boolean;
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
      case HARNESS_IDS.COPILOT_CLI:
        return STATUS_LINE_TRACKING_PROVIDERS.COPILOT;
      case HARNESS_IDS.QWEN_CLI:
        return STATUS_LINE_TRACKING_PROVIDERS.QWEN;
      default:
        throw new Error(`Unsupported statusline harness: ${harnessId}`);
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
        : provider === STATUS_LINE_TRACKING_PROVIDERS.COPILOT
          ? SettingsJsonMcpTracker.getInstance("copilot-cli-settings", {
              projectConfigPath: () =>
                path.join(os.homedir(), ".copilot", "settings.json"),
              userConfigPath: () =>
                path.join(os.homedir(), ".copilot", "settings.json"),
            })
          : provider === STATUS_LINE_TRACKING_PROVIDERS.QWEN
            ? SettingsJsonMcpTracker.getInstance("qwen-cli-settings", {
                projectConfigPath: () =>
                  path.join(os.homedir(), ".qwen", "settings.json"),
                userConfigPath: () =>
                  path.join(os.homedir(), ".qwen", "settings.json"),
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
    let collision = false;
    const result = await this.definition.tracker.installPersistentValue(
      workspaceRoot,
      this.getPersistentValueKey(),
      { type: "command", command },
      async (preexistingValue, hadKey) => {
        const settings = this.getSettings();
        const customCommand = this.extractCommand(preexistingValue, hadKey);
        const isCtrlyokeCommand =
          customCommand !== undefined &&
          this.isCtrlyokeStatuslineCommand(customCommand);
        const enabledSettingPath = `${SETTING_PATHS.PERMISSIONS_STATUS_LINE_TRACKING}.${this.provider}.enabled`;
        // The automatic veto materializes a user-scoped disabled setting. A later
        // user-scoped re-enable is the explicit opt-in that permits replacement,
        // so no separate persisted "already asked" flag is needed.
        const explicitlyEnabledByUser =
          configService.getLeafSources()[enabledSettingPath] ===
          SETTING_SCOPES.USER;
        if (
          hadKey &&
          customCommand === undefined &&
          !isCtrlyokeCommand &&
          !explicitlyEnabledByUser
        ) {
          if (settings.enabled) {
            collision = true;
            await ConfigurationUtils.setStatusLineTrackingSettings(
              this.provider,
              {
                ...settings,
                enabled: false,
              }
            );
          }
          return { proceed: false };
        }
        if (
          settings.customCommand.length === 0 &&
          customCommand !== undefined &&
          !this.isCtrlyokeStatuslineCommand(customCommand)
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

    // A wrapper path changes when an extension update moves the installed
    // files. Updating that owned command is still a real write, but the
    // notification must reflect an already-preserved custom output rather
    // than claim ctrlyoke styling will become visible.
    if (result.kind === SETTINGS_JSON_INSTALL_KIND_WRITTEN && !captured) {
      const settings = this.getSettings();
      captured =
        settings.customCommand.length > 0 && !settings.useCtrlyokeStyle;
    }

    return {
      kind: result.kind,
      captured,
      ...(collision ? { collision: true } : {}),
    };
  }

  /** Restore the live custom command, or remove ctrlyoke's statusline key. */
  async uninstall(workspaceRoot: string, restoreCustomCommand: boolean) {
    const { customCommand } = this.getSettings();
    if (restoreCustomCommand && customCommand.length > 0) {
      await this.definition.tracker.uninstallPersistentValue(
        workspaceRoot,
        this.getPersistentValueKey(),
        {
          action: "restore",
          value: { type: "command", command: customCommand },
        }
      );
      return;
    }

    await this.definition.tracker.uninstallPersistentValue(
      workspaceRoot,
      this.getPersistentValueKey(),
      { action: "delete" }
    );
  }

  private getPersistentValueKey(): string {
    return this.provider === STATUS_LINE_TRACKING_PROVIDERS.QWEN
      ? QWEN_STATUS_LINE_SETTING_KEY
      : STATUS_LINE_SETTING_KEY;
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

  /** Recognize an older ctrlyoke wrapper without depending on its absolute path. */
  private isCtrlyokeStatuslineCommand(command: string): boolean {
    const [runtime, script] = parseArgString(command);
    if (
      !runtime ||
      !script ||
      !/^node(?:\.exe)?$/iu.test(path.basename(runtime))
    ) {
      return false;
    }

    const scriptName = script.replace(/\\/gu, "/").split("/").pop();
    return scriptName === `ctrlyoke-${this.provider}-statusline.js`;
  }
}
