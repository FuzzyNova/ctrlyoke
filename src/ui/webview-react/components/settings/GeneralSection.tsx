import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { useEffect, useState } from "react";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { SettingInputRow } from "../shared/SettingInputRow";
import { LocalNumberInput, LocalTextInput } from "../shared/LocalInputs";
import { CustomSelect } from "../shared/CustomSelect";
import { DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT } from "@root/types/CtrlYokeSettings";
import {
  DEFAULT_FORMAT_OPTIONS_META,
  STEP_COLOR_MODE_OPTIONS_META,
  CTRLYOKE_MCP_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import {
  SETTING_PATHS,
  STEP_COLOR_MODES,
} from "@root/types/DashboardConstants";
import { RunHistorySection } from "./RunHistorySection";

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
        label="Default format"
        description="Default file format used when creating new workflows."
        id="general-default-format"
        path="general.defaultFormat"
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
        label="Default template"
        description="Template ID used when creating new workflows. Use 'blank' for a minimal starter."
        id="general-default-template"
        path="general.defaultTemplate"
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
          label="Auto-load recent session"
          description="Automatically load the most recently used workflow when the extension starts."
          checked={general.autoLoadRecentSession}
          onChange={(v) => onUpdate("general.autoLoadRecentSession", v)}
          path="general.autoLoadRecentSession"
          {...rowProps}
        />
        <SettingToggleRow
          label="Omit already attached agents & skills on resume"
          description="When resuming a session, only attach agents and skills that are not already present in that session's context."
          checked={general.omitPreviouslyAttachedAgentsSkillsOnResume}
          onChange={(v) =>
            onUpdate("general.omitPreviouslyAttachedAgentsSkillsOnResume", v)
          }
          path="general.omitPreviouslyAttachedAgentsSkillsOnResume"
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          UI Preferences
        </h3>
        <SettingToggleRow
          label="Show CLI command"
          description="Show the CLI command used to start the AI harness."
          checked={ui.showCliCommand}
          onChange={(v) => onUpdate("ui.showCliCommand", v)}
          path="ui.showCliCommand"
          {...rowProps}
        />
        <SettingInputRow
          label="Step identity colors"
          description="Choose how workflow step identity colors are rendered across the dashboard."
          id="ui-step-color-mode"
          path="ui.stepColorMode"
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
            label="Script step color"
            description="Identity color used for script steps in harness mode."
            id="ui-step-colors-script"
            path="ui.harnessColors.script"
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
          label="Show token cost estimates"
          description="Show source-labelled token cost estimates. These are not incremental subscription spend."
          checked={ui.showCostEstimates}
          onChange={(v) => onUpdate("ui.showCostEstimates", v)}
          path={SETTING_PATHS.UI_SHOW_COST_ESTIMATES}
          {...rowProps}
        />
        <SettingToggleRow
          label="Headless permission warning"
          description="Warn when headless execution uses limited tool permissions."
          checked={ui.showHeadlessPermissionWarning}
          onChange={(v) => onUpdate("ui.showHeadlessPermissionWarning", v)}
          path="ui.showHeadlessPermissionWarning"
          {...rowProps}
        />
        <SettingToggleRow
          label="Auto-focus output on execution"
          description="Automatically expand the output section when a prompt starts. Headless runs show Output; interactive and inject-mode runs show Terminal."
          checked={ui.autoFocusOutputOnExecution}
          onChange={(v) => onUpdate("ui.autoFocusOutputOnExecution", v)}
          path="ui.autoFocusOutputOnExecution"
          {...rowProps}
        />
        <SettingToggleRow
          label="Open prompts in second group"
          description="Open prompt files in the second editor group."
          checked={ui.openPromptsInSecondGroup}
          onChange={(v) => onUpdate("ui.openPromptsInSecondGroup", v)}
          path="ui.openPromptsInSecondGroup"
          {...rowProps}
        />
        <SettingToggleRow
          label="Respect .gitignore for completions"
          description="Filter file completions using .gitignore rules."
          checked={ui.respectGitignoreForCompletions}
          onChange={(v) => onUpdate("ui.respectGitignoreForCompletions", v)}
          path="ui.respectGitignoreForCompletions"
          {...rowProps}
        />
        <SettingToggleRow
          label="Auto-expand editor when typing"
          description="Automatically grow the editor panel as you type past its current height, up to 60% of the available area. Shrinks back when text is deleted or the prompt is submitted."
          checked={ui.autoExpandEditorWhenTyping}
          onChange={(v) => onUpdate("ui.autoExpandEditorWhenTyping", v)}
          path="ui.autoExpandEditorWhenTyping"
          {...rowProps}
        />
        <SettingToggleRow
          label="Atomic context references"
          description="In the prompt editor, treat @file, #symbol, ~git, and $context references as single units: arrow keys skip over them and Backspace/Delete removes the whole reference at once. In output, format clickable local references as compact chips. Clicking or long-pressing a reference still opens it; when off, editor references edit character by character and output uses ordinary text links."
          checked={ui.atomicContextReferences}
          onChange={(v) => onUpdate("ui.atomicContextReferences", v)}
          path="ui.atomicContextReferences"
          {...rowProps}
        />
        <SettingToggleRow
          label="Use absolute file paths"
          description={
            isMultiRoot
              ? "Forced on — multiple workspace folders are open."
              : "Send absolute file paths to the harness/model instead of relative paths. Stored workflow text always stays relative."
          }
          checked={isMultiRoot ? true : ui.useAbsolutePathReferences}
          onChange={(v) => onUpdate("ui.useAbsolutePathReferences", v)}
          disabled={isMultiRoot}
          path="ui.useAbsolutePathReferences"
          {...rowProps}
        />
        <SettingInputRow
          label="Collapsed tool output lines"
          description="Approximate number of wrapped lines shown for Bash and generic tool results before they collapse."
          id="ui-collapsed-tool-output-line-count"
          path="ui.collapsedToolOutputLineCount"
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
          label="Output virtualization row threshold"
          description="Minimum output rows before virtualization is enabled. Use 0 to always virtualize, -1 to never virtualize."
          id="ui-output-virtualization-row-threshold"
          path="ui.outputVirtualizationRowThreshold"
          {...rowProps}
        >
          <LocalNumberInput
            id="ui-output-virtualization-row-threshold"
            min={-1}
            value={ui.outputVirtualizationRowThreshold}
            onCommit={(v) => onUpdate("ui.outputVirtualizationRowThreshold", v)}
            parse={(v) => {
              const parsed = parseInt(v, 10);
              return Number.isFinite(parsed) ? Math.max(-1, parsed) : 200;
            }}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>
        <SettingToggleRow
          label="Confirm delete operations"
          description="Show a confirmation dialog before delete operations like removing prompts, deleting workflow history, or discarding untracked files."
          checked={ui.confirmDeleteOperations}
          onChange={(v) => onUpdate("ui.confirmDeleteOperations", v)}
          path="ui.confirmDeleteOperations"
          {...rowProps}
        />
        <SettingToggleRow
          label="Confirm reset operations"
          description="Show a confirmation dialog before resetting the workflow."
          checked={ui.confirmResetOperations}
          onChange={(v) => onUpdate("ui.confirmResetOperations", v)}
          path="ui.confirmResetOperations"
          {...rowProps}
        />
        <SettingToggleRow
          label="Confirm continuation discard operations"
          description="Show a confirmation dialog before discarding a continuation's edited suffix (Discard Continuation, Start New Run Instead)."
          checked={ui.confirmContinuationDiscardOperations}
          onChange={(v) =>
            onUpdate("ui.confirmContinuationDiscardOperations", v)
          }
          path="ui.confirmContinuationDiscardOperations"
          {...rowProps}
        />
        <SettingToggleRow
          label="Hide git-ignored files"
          description="Hide files and directories ignored by .gitignore in the workspace file explorer and workflow file picker."
          checked={ui.hideGitIgnoredFiles}
          onChange={(v) => onUpdate("ui.hideGitIgnoredFiles", v)}
          path="ui.hideGitIgnoredFiles"
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Prior Context
        </h3>
        <SettingToggleRow
          label="Include full file diffs"
          description="Include actual file changes in captured responses used by later prior-context attachments. Disable for smaller response-only context."
          checked={general.includeFullDiffsInPriorContext}
          onChange={(v) =>
            onUpdate("general.includeFullDiffsInPriorContext", v)
          }
          path="general.includeFullDiffsInPriorContext"
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          File Management
        </h3>
        <SettingToggleRow
          label="Auto-delete temp files"
          description="Automatically delete prompt temp files after execution. Disable to retain files in .ctrlyoke/temp/ for debugging."
          checked={exec.autoDeleteTempFiles}
          onChange={(v) => onUpdate("execution.autoDeleteTempFiles", v)}
          path="execution.autoDeleteTempFiles"
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Runs
        </h3>
        <SettingInputRow
          label="Max runs to keep (-1 = unlimited)"
          description="Deletes entire runs—definition and output—oldest first."
          id="runs-max-runs"
          path="runs.maxRuns"
          {...rowProps}
        >
          <LocalNumberInput
            id="runs-max-runs"
            min={-1}
            value={runs.maxRuns}
            onCommit={(v) => onUpdate("runs.maxRuns", v)}
            parse={(v) => parseInt(v, 10) || -1}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>
        <SettingInputRow
          label="History search cache (MB, 0 = disabled)"
          description="Approximate working-set budget for caching parsed history-search documents from the most recently run workflows, evicted oldest-first once exceeded. Bounds real process memory, not a literal byte count — raising it does not scale memory use 1:1."
          id="runs-history-search-cache-mb"
          path="runs.historySearchCacheMb"
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
          label="MCP mode"
          description="Controls only ctrlyoke's own MCP server (queue/coordination/commit tools) — never any other MCP servers a workflow configures. Native attaches ctrlyoke's real MCP server. Skill replaces it with the built-in MCP-tools skill instead, for environments where MCP configuration itself is unavailable (e.g. blocked by policy)."
          id="settings-ctrlyoke-mcp-mode"
          path="execution.ctrlyokeMcpMode"
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
          label="Enable diagnostic logs"
          description="Write detailed diagnostic logs to help troubleshoot issues."
          checked={settings.settings.diagnostics.verboseLogging}
          onChange={(v) => onUpdate("diagnostics.verboseLogging", v)}
          path="diagnostics.verboseLogging"
          {...rowProps}
        />
        <SettingToggleRow
          label="Log raw CLI output"
          description={
            !settings.settings.diagnostics.verboseLogging
              ? "Unavailable — requires diagnostic logs to be enabled."
              : "Write raw CLI output to a log file for debugging."
          }
          checked={settings.settings.diagnostics.logRawCliOutput}
          onChange={(v) => onUpdate("diagnostics.logRawCliOutput", v)}
          disabled={!settings.settings.diagnostics.verboseLogging}
          path="diagnostics.logRawCliOutput"
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
