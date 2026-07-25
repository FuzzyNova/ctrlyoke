import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { LocalNumberInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

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
        label="Max prompt timeout (seconds, -1 = unlimited)"
        id="exec-max-prompt-timeout"
        path="execution.maxPromptTimeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-max-prompt-timeout"
          min={-1}
          value={exec.maxPromptTimeout}
          onCommit={(v) => onUpdate("execution.maxPromptTimeout", v)}
          parse={(v) => parseInt(v, 10) || -1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Script timeout (seconds)"
        id="exec-script-timeout"
        path="execution.scriptTimeout"
        {...rowProps}
      >
        <LocalNumberInput
          id="exec-script-timeout"
          min={1}
          value={exec.scriptTimeout}
          onCommit={(v) => onUpdate("execution.scriptTimeout", v)}
          parse={(v) => parseInt(v, 10) || 30}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingToggleRow
        label="Close terminal on completion"
        description="Automatically close the terminal when a workflow completes."
        checked={exec.closeTerminalOnComplete}
        onChange={(v) => onUpdate("execution.closeTerminalOnComplete", v)}
        path="execution.closeTerminalOnComplete"
        {...rowProps}
      />
      <SettingToggleRow
        label="Inject mode (interactive)"
        description={
          exec.closeTerminalOnComplete
            ? "Unavailable — inject mode requires keeping the terminal open. Disable 'Close terminal on completion' to enable this."
            : "Keep the TUI alive between prompts — faster and avoids the Claude Code resume cache bug."
        }
        checked={exec.injectMode ?? false}
        onChange={(v) => onUpdate("execution.injectMode", v)}
        disabled={exec.closeTerminalOnComplete}
        path="execution.injectMode"
        {...rowProps}
      />
    </div>
  );
}
