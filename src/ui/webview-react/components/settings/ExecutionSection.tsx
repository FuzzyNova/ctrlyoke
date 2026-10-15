import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SETTING_PATHS } from "@root/types/DashboardConstants";
import { LocalNumberInput } from "../shared/LocalInputs";
import { LimitSelect } from "../shared/LimitSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { CustomSelect } from "../shared/CustomSelect";
import {
  CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { settingLabel } from "./settingsCatalog";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function ExecutionSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const exec = settings.settings.execution;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Execution
      </h3>
      <SettingInputRow
        settingKey="execution.contextResolutionFailure"
        id="exec-strict-context-resolution"
        {...rowProps}
      >
        <CustomSelect
          id="exec-strict-context-resolution"
          value={exec.contextResolutionFailure}
          onChange={(value) =>
            onUpdate(SETTING_PATHS.EXECUTION_CONTEXT_RESOLUTION_FAILURE, value)
          }
          schemaPath="execution.contextResolutionFailure"
          options={toSelectOptions(
            CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
            "execution.contextResolutionFailure"
          )}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="execution.maxPromptTimeoutSec"
        id="exec-max-prompt-timeout"
        {...rowProps}
      >
        <LimitSelect
          id="exec-max-prompt-timeout"
          label={settingLabel("execution.maxPromptTimeoutSec")}
          path="execution.maxPromptTimeoutSec"
          value={exec.maxPromptTimeoutSec}
          onChange={(v) => onUpdate("execution.maxPromptTimeoutSec", v)}
          customFallback={30}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="execution.scriptTimeoutSec"
        id="exec-script-timeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-script-timeout"
          min={1}
          value={exec.scriptTimeoutSec}
          onCommit={(v) => onUpdate("execution.scriptTimeoutSec", v)}
          parse={(v) => parseInt(v, 10) || 30}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="execution.regexTimeoutSec"
        id="exec-regex-timeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-regex-timeout"
          min={1}
          value={exec.regexTimeoutSec}
          onCommit={(v) => onUpdate("execution.regexTimeoutSec", v)}
          parse={(v) => parseInt(v, 10) || 10}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        settingKey="execution.closeTerminalOnComplete"
        checked={exec.closeTerminalOnComplete}
        onChange={(v) => onUpdate("execution.closeTerminalOnComplete", v)}
        {...rowProps}
      />
      <SettingToggleRow
        settingKey="execution.reuseRunningTerminal"
        {...{
          description: exec.closeTerminalOnComplete
            ? "Unavailable — terminal reuse requires keeping the terminal open. Disable 'Close terminal on completion' to enable this."
            : "Keep the TUI alive between prompts — faster and avoids the Claude Code resume cache bug.",
        }}
        checked={exec.reuseRunningTerminal ?? false}
        onChange={(v) => onUpdate("execution.reuseRunningTerminal", v)}
        disabled={exec.closeTerminalOnComplete}
        {...rowProps}
      />
    </div>
  );
}
