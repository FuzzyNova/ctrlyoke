import { useEffect, useState } from "react";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
  STATUS_LINE_HARNESS_IDS,
} from "@root/types/DashboardConstants";
import type { StatusLineHarnessId } from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import {
  STATUS_LINE_FORMAT_PROVIDERS,
  type StatusLineFormatProvider,
  type StatusLineSegment,
} from "@root/utils/StatuslineFormat";
import { AnimatedSection } from "@components/shared/AnimatedSection";
import { sendMessage } from "@hooks/useMessageHandler";
import { Button } from "@components/shared/Button";
import { HarnessIcon } from "@components/shared/HarnessIcon";
import { LocalTextInput } from "@components/shared/LocalInputs";
import { Modal } from "@components/shared/Modal";
import { SettingInputRow } from "@components/shared/SettingInputRow";
import { SettingToggleRow } from "@components/shared/SettingToggleRow";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { StatusLineFormatEditor } from "./StatusLineFormatEditor";
import { StatusLinePreview } from "./StatusLinePreview";

interface Props {
  harnessId: StatusLineHarnessId;
  settings: FullGlobalSettings;
  sharedDraft?: StatusLineSegment[];
  useDifferentFormatPerHarness?: boolean;
}

interface StatusLineSettingPaths {
  enabled: string;
  customCommand: string;
  useCtrlyokeStyle: string;
  format: string;
}

const STATUS_LINE_SETTING_PATHS: Partial<
  Record<StatusLineHarnessId, StatusLineSettingPaths>
> = {
  [STATUS_LINE_HARNESS_IDS.CLAUDE]: {
    enabled: SETTING_PATHS.STATUS_LINE_CLAUDE_ENABLED,
    customCommand: SETTING_PATHS.STATUS_LINE_CLAUDE_CUSTOM_COMMAND,
    useCtrlyokeStyle: SETTING_PATHS.STATUS_LINE_CLAUDE_USE_CTRLYOKE_STYLE,
    format: SETTING_PATHS.STATUS_LINE_CLAUDE_FORMAT,
  },
  [STATUS_LINE_HARNESS_IDS.ANTIGRAVITY]: {
    enabled: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_ENABLED,
    customCommand: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_CUSTOM_COMMAND,
    useCtrlyokeStyle: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_USE_CTRLYOKE_STYLE,
    format: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_FORMAT,
  },
  [STATUS_LINE_HARNESS_IDS.COPILOT]: {
    enabled: SETTING_PATHS.STATUS_LINE_COPILOT_ENABLED,
    customCommand: SETTING_PATHS.STATUS_LINE_COPILOT_CUSTOM_COMMAND,
    useCtrlyokeStyle: SETTING_PATHS.STATUS_LINE_COPILOT_USE_CTRLYOKE_STYLE,
    format: SETTING_PATHS.STATUS_LINE_COPILOT_FORMAT,
  },
  [STATUS_LINE_HARNESS_IDS.QWEN]: {
    enabled: SETTING_PATHS.STATUS_LINE_QWEN_ENABLED,
    customCommand: SETTING_PATHS.STATUS_LINE_QWEN_CUSTOM_COMMAND,
    useCtrlyokeStyle: SETTING_PATHS.STATUS_LINE_QWEN_USE_CTRLYOKE_STYLE,
    format: SETTING_PATHS.STATUS_LINE_QWEN_FORMAT,
  },
};

const RESTORE_LABEL_MAX_LENGTH = 56;

function providerForHarness(
  harnessId: StatusLineHarnessId
): StatusLineHarnessId {
  switch (harnessId) {
    case HARNESS_IDS.CLAUDE_CLI:
      return STATUS_LINE_HARNESS_IDS.CLAUDE;
    case HARNESS_IDS.ANTIGRAVITY_CLI:
      return STATUS_LINE_HARNESS_IDS.ANTIGRAVITY;
    case HARNESS_IDS.COPILOT_CLI:
      return STATUS_LINE_HARNESS_IDS.COPILOT;
    case HARNESS_IDS.QWEN_CLI:
      return STATUS_LINE_HARNESS_IDS.QWEN;
    default:
      throw new Error(`Unsupported statusline harness: ${harnessId}`);
  }
}

function getDisableWarning(harnessId: StatusLineHarnessId): string {
  switch (harnessId) {
    case HARNESS_IDS.CLAUDE_CLI:
      return "Disabling Claude statusline tracking loses token/quota data.";
    case HARNESS_IDS.ANTIGRAVITY_CLI:
      return "Disabling Antigravity statusline tracking loses token/quota and context-window data.";
    case HARNESS_IDS.COPILOT_CLI:
      return "Disabling Copilot statusline tracking loses token and context-window data.";
    case HARNESS_IDS.QWEN_CLI:
      return "Disabling Qwen statusline tracking loses token and context-window data.";
    default:
      throw new Error(`Unsupported statusline harness: ${harnessId}`);
  }
}

const STATUS_LINE_FORMAT_PROVIDER_BY_HARNESS: Record<
  StatusLineHarnessId,
  StatusLineFormatProvider
> = {
  [STATUS_LINE_HARNESS_IDS.CLAUDE]: STATUS_LINE_FORMAT_PROVIDERS.CLAUDE,
  [STATUS_LINE_HARNESS_IDS.ANTIGRAVITY]:
    STATUS_LINE_FORMAT_PROVIDERS.ANTIGRAVITY,
  [STATUS_LINE_HARNESS_IDS.COPILOT]: STATUS_LINE_FORMAT_PROVIDERS.COPILOT,
  [STATUS_LINE_HARNESS_IDS.QWEN]: STATUS_LINE_FORMAT_PROVIDERS.QWEN,
};

function getPlainScriptBasename(command: string): string | undefined {
  if (
    command.length === 0 ||
    /\s|["'`$;&|<>()[\]{}]/.test(command) ||
    (!/[\\/]/.test(command) && !/\.[a-z0-9]+$/i.test(command))
  ) {
    return undefined;
  }

  const basename = command.split(/[\\/]/).pop();
  return basename && basename !== "." && basename !== ".."
    ? basename
    : undefined;
}

function getRestoreLabel(command: string): {
  label: string;
  tooltip?: string;
} {
  const basename = getPlainScriptBasename(command);
  if (basename) {
    return {
      label: `Restore ${basename} as the statusline command`,
    };
  }

  const displayCommand =
    command.length > RESTORE_LABEL_MAX_LENGTH
      ? `${command.slice(0, RESTORE_LABEL_MAX_LENGTH - 1)}…`
      : command;
  return {
    label: `Restore "${displayCommand}" as the statusline command`,
    tooltip: command,
  };
}

function sendGlobalSetting(path: string, value: unknown): void {
  sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
    path,
    value,
    scope: SETTING_SCOPES.USER,
  });
}

export function StatusLineTrackingControls({
  harnessId,
  settings,
  sharedDraft = settings.settings.statusLine.sharedFormat,
  useDifferentFormatPerHarness = settings.settings.statusLine
    .useDifferentFormatPerHarness,
}: Props) {
  const provider = providerForHarness(harnessId);
  const paths = STATUS_LINE_SETTING_PATHS[provider];
  if (!paths) {
    throw new Error(
      `Missing statusline setting paths for provider: ${provider}`
    );
  }
  const tracking = settings.settings.statusLine.byHarness[provider];
  const formatProvider = STATUS_LINE_FORMAT_PROVIDER_BY_HARNESS[provider];
  const snapshot = useHarnessUsageStore(
    (state) => state.snapshotsByHarness[harnessId]
  );
  const harnessName = HARNESS_INFO[harnessId].name;
  const [isDisableModalOpen, setIsDisableModalOpen] = useState(false);
  const [restoreCustomCommand, setRestoreCustomCommand] = useState(true);

  useEffect(() => {
    if (isDisableModalOpen) {
      setRestoreCustomCommand(true);
    }
  }, [isDisableModalOpen]);

  const restoreLabel =
    tracking.customCommand.length > 0
      ? getRestoreLabel(tracking.customCommand)
      : undefined;

  const handleDisable = () => {
    sendMessage(MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING, {
      harnessId,
      restoreCustomCommand:
        tracking.customCommand.length > 0 ? restoreCustomCommand : false,
    });
    setIsDisableModalOpen(false);
  };

  const handleEnabledChange = (enabled: boolean) => {
    if (enabled) {
      sendGlobalSetting(paths.enabled, true);
      return;
    }
    setRestoreCustomCommand(true);
    setIsDisableModalOpen(true);
  };

  return (
    <div className="rounded border border-panel-border bg-panel-bg p-2 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <HarnessIcon harnessId={harnessId} size={16} />
        <span>{harnessName}</span>
      </div>
      <SettingToggleRow
        settingKey={`statusLine.byHarness.${harnessId}.enabled`}
        {...{ description: getDisableWarning(harnessId) }}
        checked={tracking.enabled}
        onChange={handleEnabledChange}
        sources={settings.sources}
        onReset={(path) => sendGlobalSetting(path, undefined)}
        activeScope={SETTING_SCOPES.USER}
      />
      <SettingInputRow
        settingKey={`statusLine.byHarness.${harnessId}.customCommand`}
        id={`${provider}-custom-command`}
        sources={settings.sources}
        onReset={(path) => sendGlobalSetting(path, undefined)}
        activeScope={SETTING_SCOPES.USER}
      >
        <LocalTextInput
          id={`${provider}-custom-command`}
          value={tracking.customCommand}
          onCommit={(value) => sendGlobalSetting(paths.customCommand, value)}
          placeholder="None"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border font-mono"
        />
      </SettingInputRow>
      <SettingToggleRow
        settingKey={`statusLine.byHarness.${harnessId}.useCtrlyokeStyle`}
        checked={tracking.useCtrlyokeStyle}
        onChange={(enabled) =>
          sendGlobalSetting(paths.useCtrlyokeStyle, enabled)
        }
        sources={settings.sources}
        onReset={(path) => sendGlobalSetting(path, undefined)}
        activeScope={SETTING_SCOPES.USER}
      />
      <AnimatedSection
        visible={tracking.useCtrlyokeStyle && useDifferentFormatPerHarness}
      >
        <StatusLineFormatEditor
          searchId={`statusLine.byHarness.${harnessId}.format`}
          format={tracking.format}
          onCommit={(format) => sendGlobalSetting(paths.format, format)}
          provider={formatProvider}
          snapshot={snapshot}
          percentDirection={settings.settings.usageTracking.percentDirection}
        />
      </AnimatedSection>
      <AnimatedSection
        visible={tracking.useCtrlyokeStyle && !useDifferentFormatPerHarness}
      >
        <StatusLinePreview
          format={sharedDraft}
          provider={formatProvider}
          snapshot={snapshot}
          percentDirection={settings.settings.usageTracking.percentDirection}
        />
      </AnimatedSection>
      <Modal
        isOpen={isDisableModalOpen}
        onClose={() => setIsDisableModalOpen(false)}
        title={`Disable ${harnessName} statusline tracking?`}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setIsDisableModalOpen(false)}
            >
              Cancel
            </Button>
            {restoreLabel && (
              <label
                className="flex min-w-0 shrink items-center gap-2 text-xs text-description-fg cursor-pointer"
                title={restoreLabel.tooltip}
              >
                <input
                  type="checkbox"
                  checked={restoreCustomCommand}
                  onChange={(event) =>
                    setRestoreCustomCommand(event.target.checked)
                  }
                  className="w-3.5 h-3.5 accent-focus-border cursor-pointer shrink-0"
                />
                <span className="truncate">{restoreLabel.label}</span>
              </label>
            )}
            <Button variant="danger" size="md" onClick={handleDisable}>
              Disable tracking
            </Button>
          </>
        }
      >
        <p className="text-foreground">{getDisableWarning(harnessId)}</p>
        {tracking.useCtrlyokeStyle && (
          <p className="mt-2 text-sm text-description-fg">
            The visible statusline text will change back too because ctrlyoke
            style is on.
          </p>
        )}
      </Modal>
    </div>
  );
}
