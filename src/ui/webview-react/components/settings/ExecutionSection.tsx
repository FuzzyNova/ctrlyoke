import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const MODE_OPTIONS = [
  { value: "interactive", label: "Interactive" },
  { value: "headless", label: "Headless" },
];

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
      <div>
        <label
          htmlFor="exec-mode"
          className="block text-xs text-description-fg mb-1"
        >
          Execution mode
        </label>
        <CustomSelect
          id="exec-mode"
          value={exec.mode}
          onChange={(v) => onUpdate("execution.mode", v)}
          options={MODE_OPTIONS}
        />
      </div>
      <div>
        <label
          htmlFor="exec-max-prompt-timeout"
          className="block text-xs text-description-fg mb-1"
        >
          Max prompt timeout (seconds, -1 = unlimited)
        </label>
        <input
          id="exec-max-prompt-timeout"
          type="number"
          min={-1}
          value={exec.maxPromptTimeout}
          onChange={(e) =>
            onUpdate(
              "execution.maxPromptTimeout",
              parseInt(e.target.value, 10) || -1
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <div>
        <label
          htmlFor="exec-script-timeout"
          className="block text-xs text-description-fg mb-1"
        >
          Script timeout (seconds)
        </label>
        <input
          id="exec-script-timeout"
          type="number"
          min={1}
          value={exec.scriptTimeout}
          onChange={(e) =>
            onUpdate(
              "execution.scriptTimeout",
              parseInt(e.target.value, 10) || 30
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
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
