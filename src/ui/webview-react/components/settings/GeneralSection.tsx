import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-focus-border cursor-pointer shrink-0"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground group-hover:text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

export function GeneralSection({ settings, onUpdate }: Props) {
  const ui = settings.settings.ui;
  const s = "user" as const;

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        UI Preferences
      </h3>
      <ToggleRow
        label="Show CLI output"
        description="Display the AI CLI output in the output panel."
        checked={ui.showCliOutput}
        onChange={(v) => onUpdate("ui.showCliOutput", v, s)}
      />
      <ToggleRow
        label="Show CLI command"
        description="Show the CLI command used to start the AI harness."
        checked={ui.showCliCommand}
        onChange={(v) => onUpdate("ui.showCliCommand", v, s)}
      />
      <ToggleRow
        label="Log raw CLI output"
        description="Write raw CLI output to a log file for debugging."
        checked={ui.logRawCliOutput}
        onChange={(v) => onUpdate("ui.logRawCliOutput", v, s)}
      />
      <ToggleRow
        label="Open prompts in second group"
        description="Open prompt files in the second editor group."
        checked={ui.openPromptsInSecondGroup}
        onChange={(v) => onUpdate("ui.openPromptsInSecondGroup", v, s)}
      />
      <ToggleRow
        label="Respect .gitignore for completions"
        description="Filter file completions using .gitignore rules."
        checked={ui.respectGitignoreForCompletions}
        onChange={(v) => onUpdate("ui.respectGitignoreForCompletions", v, s)}
      />
      <ToggleRow
        label="Confirm delete operations"
        description="Show a confirmation dialog before deleting prompts."
        checked={ui.confirmDeleteOperations}
        onChange={(v) => onUpdate("ui.confirmDeleteOperations", v, s)}
      />
      <ToggleRow
        label="Confirm reset operations"
        description="Show a confirmation dialog before resetting the workflow."
        checked={ui.confirmResetOperations}
        onChange={(v) => onUpdate("ui.confirmResetOperations", v, s)}
      />
      <div className="pt-3 border-t border-panel-border mt-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Diagnostics
        </h3>
        <ToggleRow
          label="Enable diagnostic logs"
          description="Write detailed diagnostic logs to help troubleshoot issues."
          checked={settings.settings.enableDiagnosticLogs}
          onChange={(v) => onUpdate("enableDiagnosticLogs", v, s)}
        />
      </div>
    </div>
  );
}
