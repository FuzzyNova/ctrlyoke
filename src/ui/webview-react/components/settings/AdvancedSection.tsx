import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { SettingInputRow } from "../shared/SettingInputRow";
import { LocalNumberInput } from "../shared/LocalInputs";
import { LimitSelect } from "../shared/LimitSelect";
import { CustomSelect } from "../shared/CustomSelect";
import {
  CTRLYOKE_MCP_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { RunHistorySection } from "./RunHistorySection";
import { CoordinationSection } from "./CoordinationSection";
import { settingLabel } from "./settingsCatalog";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
  onReload: () => void;
}

/** Internals most users never change: run storage, temp files, coordination limits, logs. */
export function AdvancedSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
  onReload,
}: Props) {
  const exec = settings.settings.execution;
  const runs = settings.settings.runs;
  const diagnostics = settings.settings.diagnostics;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };
  const sectionProps = { settings, activeScope, onUpdate, onReset };

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Runs
      </h3>
      <SettingInputRow
        settingKey="runs.maxRuns"
        id="runs-max-runs"
        {...rowProps}
      >
        <LimitSelect
          id="runs-max-runs"
          label={settingLabel("runs.maxRuns")}
          path="runs.maxRuns"
          value={runs.maxRuns}
          onChange={(v) => onUpdate("runs.maxRuns", v)}
          customFallback={100}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="runs.historySearchCacheMb"
        id="runs-history-search-cache-mb"
        {...rowProps}
      >
        <LocalNumberInput
          id="runs-history-search-cache-mb"
          min={0}
          value={runs.historySearchCacheMb}
          onCommit={(v) => onUpdate("runs.historySearchCacheMb", v)}
          parse={(v) => Math.max(0, parseInt(v, 10) || 0)}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <RunHistorySection {...sectionProps} onReload={onReload} />
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Prompt Files
        </h3>
        <SettingToggleRow
          settingKey="execution.autoDeleteTempFiles"
          checked={exec.autoDeleteTempFiles}
          onChange={(v) => onUpdate("execution.autoDeleteTempFiles", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="execution.inlineGeneratedPromptOnStdin"
          checked={exec.inlineGeneratedPromptOnStdin}
          onChange={(v) =>
            onUpdate("execution.inlineGeneratedPromptOnStdin", v)
          }
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          ctrlyoke MCP server
        </h3>
        <SettingInputRow
          settingKey="execution.ctrlyokeMcpMode"
          id="settings-ctrlyoke-mcp-mode"
          {...rowProps}
        >
          <CustomSelect
            id="settings-ctrlyoke-mcp-mode"
            value={exec.ctrlyokeMcpMode}
            onChange={(v) => onUpdate("execution.ctrlyokeMcpMode", v)}
            schemaPath="execution.ctrlyokeMcpMode"
            options={toSelectOptions(
              CTRLYOKE_MCP_MODE_OPTIONS_META,
              "execution.ctrlyokeMcpMode"
            )}
          />
        </SettingInputRow>
      </div>
      <CoordinationSection {...sectionProps} />
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Diagnostics
        </h3>
        <SettingToggleRow
          settingKey="diagnostics.verboseLogging"
          checked={diagnostics.verboseLogging}
          onChange={(v) => onUpdate("diagnostics.verboseLogging", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="diagnostics.logRawCliOutput"
          {...{
            description: !diagnostics.verboseLogging
              ? "Unavailable — requires diagnostic logs to be enabled."
              : "Write raw CLI output to a log file for debugging.",
          }}
          checked={diagnostics.logRawCliOutput}
          onChange={(v) => onUpdate("diagnostics.logRawCliOutput", v)}
          disabled={!diagnostics.verboseLogging}
          {...rowProps}
        />
      </div>
    </div>
  );
}
