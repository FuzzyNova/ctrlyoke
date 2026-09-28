import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { useEffect, useState } from "react";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { SettingInputRow } from "../shared/SettingInputRow";
import { LocalNumberInput, LocalTextInput } from "../shared/LocalInputs";
import { LimitSelect } from "../shared/LimitSelect";
import { CustomSelect } from "../shared/CustomSelect";
import { DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT } from "@root/types/CtrlYokeSettings";
import {
  DEFAULT_FORMAT_OPTIONS_META,
  STEP_COLOR_MODE_OPTIONS_META,
  CTRLYOKE_MCP_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { STEP_COLOR_MODES } from "@root/types/DashboardConstants";
import { RunHistorySection } from "./RunHistorySection";
import { settingLabel } from "./settingsCatalog";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
  onReload: () => void;
}

export function GeneralSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
  onReload,
}: Props) {
  const general = settings.settings.general;
  const ui = settings.settings.ui;
  const harnessColors = ui.harnessColors;
  const exec = settings.settings.execution;
  const runs = settings.settings.runs;
  const sources = settings.sources as Record<string, SettingSource>;
  const isMultiRoot = settings.isMultiRoot;

  const rowProps = { sources, onReset, activeScope };
  const [localScriptColor, setLocalScriptColor] = useState(
    harnessColors.script
  );

  useEffect(() => {
    setLocalScriptColor(harnessColors.script);
  }, [harnessColors.script]);

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Workflow File Defaults
      </h3>
      <SettingInputRow
        settingKey="general.defaultFormat"
        id="general-default-format"
        {...rowProps}
      >
        <CustomSelect
          id="general-default-format"
          value={general.defaultFormat}
          onChange={(v) => onUpdate("general.defaultFormat", v)}
          schemaPath="general.defaultFormat"
          options={toSelectOptions(
            DEFAULT_FORMAT_OPTIONS_META,
            "general.defaultFormat"
          )}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="general.defaultTemplate"
        id="general-default-template"
        {...rowProps}
      >
        <LocalTextInput
          id="general-default-template"
          value={general.defaultTemplate}
          onCommit={(v) => onUpdate("general.defaultTemplate", v || "blank")}
          placeholder="blank"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Session Behavior
        </h3>
        <SettingToggleRow
          settingKey="general.autoLoadRecentSession"
          checked={general.autoLoadRecentSession}
          onChange={(v) => onUpdate("general.autoLoadRecentSession", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="general.omitPreviouslyAttachedAgentsSkillsOnResume"
          checked={general.omitPreviouslyAttachedAgentsSkillsOnResume}
          onChange={(v) =>
            onUpdate("general.omitPreviouslyAttachedAgentsSkillsOnResume", v)
          }
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          UI Preferences
        </h3>
        <SettingToggleRow
          settingKey="ui.showCliCommand"
          checked={ui.showCliCommand}
          onChange={(v) => onUpdate("ui.showCliCommand", v)}
          {...rowProps}
        />
        <SettingInputRow
          settingKey="ui.stepColorMode"
          id="ui-step-color-mode"
          {...rowProps}
        >
          <CustomSelect
            id="ui-step-color-mode"
            value={ui.stepColorMode}
            onChange={(v) => onUpdate("ui.stepColorMode", v)}
            schemaPath="ui.stepColorMode"
            options={toSelectOptions(
              STEP_COLOR_MODE_OPTIONS_META,
              "ui.stepColorMode"
            )}
          />
        </SettingInputRow>
        {ui.stepColorMode === STEP_COLOR_MODES.HARNESS && (
          <SettingInputRow
            settingKey="ui.harnessColors.script"
            id="ui-step-colors-script"
            {...rowProps}
          >
            <input
              id="ui-step-colors-script"
              type="color"
              value={localScriptColor}
              onChange={(e) => setLocalScriptColor(e.target.value)}
              onBlur={(e) =>
                onUpdate("ui.harnessColors.script", e.target.value)
              }
              className="w-full h-8 cursor-pointer rounded border border-input-border p-0.5 bg-input-bg"
              title="Script step color"
            />
          </SettingInputRow>
        )}
        <SettingToggleRow
          settingKey="ui.showCostEstimates"
          checked={ui.showCostEstimates}
          onChange={(v) => onUpdate("ui.showCostEstimates", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.showHeadlessPermissionWarning"
          checked={ui.showHeadlessPermissionWarning}
          onChange={(v) => onUpdate("ui.showHeadlessPermissionWarning", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.autoFocusOutputOnExecution"
          checked={ui.autoFocusOutputOnExecution}
          onChange={(v) => onUpdate("ui.autoFocusOutputOnExecution", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.openPromptsInSecondGroup"
          checked={ui.openPromptsInSecondGroup}
          onChange={(v) => onUpdate("ui.openPromptsInSecondGroup", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.respectGitignoreForCompletions"
          checked={ui.respectGitignoreForCompletions}
          onChange={(v) => onUpdate("ui.respectGitignoreForCompletions", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.autoExpandEditorWhenTyping"
          checked={ui.autoExpandEditorWhenTyping}
          onChange={(v) => onUpdate("ui.autoExpandEditorWhenTyping", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.atomicContextReferences"
          checked={ui.atomicContextReferences}
          onChange={(v) => onUpdate("ui.atomicContextReferences", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.useAbsolutePathReferences"
          {...{
            description: isMultiRoot
              ? "Forced on — multiple workspace folders are open."
              : "Send absolute file paths to the harness/model instead of relative paths. Stored workflow text always stays relative.",
          }}
          checked={isMultiRoot ? true : ui.useAbsolutePathReferences}
          onChange={(v) => onUpdate("ui.useAbsolutePathReferences", v)}
          disabled={isMultiRoot}
          {...rowProps}
        />
        <SettingInputRow
          settingKey="ui.collapsedToolOutputLineCount"
          id="ui-collapsed-tool-output-line-count"
          {...rowProps}
        >
          <LocalNumberInput
            id="ui-collapsed-tool-output-line-count"
            min={1}
            value={ui.collapsedToolOutputLineCount}
            onCommit={(v) => onUpdate("ui.collapsedToolOutputLineCount", v)}
            parse={(v) => {
              const parsed = parseInt(v, 10);
              return Number.isFinite(parsed)
                ? Math.max(1, parsed)
                : DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT;
            }}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>
        <SettingInputRow
          settingKey="ui.outputVirtualizationRowThreshold"
          id="ui-output-virtualization-row-threshold"
          {...rowProps}
        >
          <LimitSelect
            id="ui-output-virtualization-row-threshold"
            label={settingLabel("ui.outputVirtualizationRowThreshold")}
            path="ui.outputVirtualizationRowThreshold"
            value={ui.outputVirtualizationRowThreshold}
            onChange={(v) => onUpdate("ui.outputVirtualizationRowThreshold", v)}
            mode="never"
            min={0}
            customFallback={200}
          />
        </SettingInputRow>
        <SettingToggleRow
          settingKey="ui.confirmDeleteOperations"
          checked={ui.confirmDeleteOperations}
          onChange={(v) => onUpdate("ui.confirmDeleteOperations", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.confirmResetOperations"
          checked={ui.confirmResetOperations}
          onChange={(v) => onUpdate("ui.confirmResetOperations", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.confirmContinuationDiscardOperations"
          checked={ui.confirmContinuationDiscardOperations}
          onChange={(v) =>
            onUpdate("ui.confirmContinuationDiscardOperations", v)
          }
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="ui.hideGitIgnoredFiles"
          checked={ui.hideGitIgnoredFiles}
          onChange={(v) => onUpdate("ui.hideGitIgnoredFiles", v)}
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Prior Context
        </h3>
        <SettingToggleRow
          settingKey="general.includeFullDiffsInPriorContext"
          checked={general.includeFullDiffsInPriorContext}
          onChange={(v) =>
            onUpdate("general.includeFullDiffsInPriorContext", v)
          }
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          File Management
        </h3>
        <SettingToggleRow
          settingKey="execution.autoDeleteTempFiles"
          checked={exec.autoDeleteTempFiles}
          onChange={(v) => onUpdate("execution.autoDeleteTempFiles", v)}
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
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
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>
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
            value={settings.settings.execution.ctrlyokeMcpMode}
            onChange={(v) => onUpdate("execution.ctrlyokeMcpMode", v)}
            schemaPath="execution.ctrlyokeMcpMode"
            options={toSelectOptions(
              CTRLYOKE_MCP_MODE_OPTIONS_META,
              "execution.ctrlyokeMcpMode"
            )}
          />
        </SettingInputRow>
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Diagnostics
        </h3>
        <SettingToggleRow
          settingKey="diagnostics.verboseLogging"
          checked={settings.settings.diagnostics.verboseLogging}
          onChange={(v) => onUpdate("diagnostics.verboseLogging", v)}
          {...rowProps}
        />
        <SettingToggleRow
          settingKey="diagnostics.logRawCliOutput"
          {...{
            description: !settings.settings.diagnostics.verboseLogging
              ? "Unavailable — requires diagnostic logs to be enabled."
              : "Write raw CLI output to a log file for debugging.",
          }}
          checked={settings.settings.diagnostics.logRawCliOutput}
          onChange={(v) => onUpdate("diagnostics.logRawCliOutput", v)}
          disabled={!settings.settings.diagnostics.verboseLogging}
          {...rowProps}
        />
      </div>
      <RunHistorySection
        settings={settings}
        activeScope={activeScope}
        onUpdate={onUpdate}
        onReset={onReset}
        onReload={onReload}
      />
    </div>
  );
}
