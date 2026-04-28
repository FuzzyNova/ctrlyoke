import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function GeneralSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const ui = settings.settings.ui;
  const exec = settings.settings.execution;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        UI Preferences
      </h3>
      <SettingToggleRow
        label="Show CLI output"
        description="Display the AI CLI output in the output panel."
        checked={ui.showCliOutput}
        onChange={(v) => onUpdate("ui.showCliOutput", v)}
        path="ui.showCliOutput"
        {...rowProps}
      />
      <SettingToggleRow
        label="Show CLI command"
        description="Show the CLI command used to start the AI harness."
        checked={ui.showCliCommand}
        onChange={(v) => onUpdate("ui.showCliCommand", v)}
        path="ui.showCliCommand"
        {...rowProps}
      />
      <SettingToggleRow
        label="Log raw CLI output"
        description="Write raw CLI output to a log file for debugging."
        checked={ui.logRawCliOutput}
        onChange={(v) => onUpdate("ui.logRawCliOutput", v)}
        path="ui.logRawCliOutput"
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
        label="Confirm delete operations"
        description="Show a confirmation dialog before deleting prompts."
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
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          File Management
        </h3>
        <SettingToggleRow
          label="Auto-delete temp files"
          description="Automatically delete prompt temp files after execution. Disable to retain files in .flightpath/temp/ for debugging."
          checked={exec.autoDeleteTempFiles}
          onChange={(v) => onUpdate("execution.autoDeleteTempFiles", v)}
          path="execution.autoDeleteTempFiles"
          {...rowProps}
        />
      </div>
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Diagnostics
        </h3>
        <SettingToggleRow
          label="Enable diagnostic logs"
          description="Write detailed diagnostic logs to help troubleshoot issues."
          checked={settings.settings.enableDiagnosticLogs}
          onChange={(v) => onUpdate("enableDiagnosticLogs", v)}
          path="enableDiagnosticLogs"
          {...rowProps}
        />
      </div>
    </div>
  );
}
