import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({ label, description, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <label className={`flex items-start gap-3 py-2 group ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className={`mt-0.5 w-4 h-4 accent-focus-border shrink-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

const MODE_OPTIONS = [
  { value: "interactive", label: "Interactive" },
  { value: "headless", label: "Headless" },
];

export function ExecutionSection({ settings, onUpdate }: Props) {
  const exec = settings.settings.execution;
  const s = "user" as const;

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
          onChange={(v) => onUpdate("execution.mode", v, s)}
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
              parseInt(e.target.value, 10) || -1,
              s
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
              parseInt(e.target.value, 10) || 30,
              s
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <ToggleRow
        label="Close terminal on completion"
        description="Automatically close the terminal when a workflow completes."
        checked={exec.closeTerminalOnComplete}
        onChange={(v) => onUpdate("execution.closeTerminalOnComplete", v, s)}
      />
      <ToggleRow
        label="Inject mode (interactive)"
        description={
          exec.closeTerminalOnComplete
            ? "Unavailable — inject mode requires keeping the terminal open. Disable 'Close terminal on completion' to enable this."
            : "Keep the TUI alive between prompts — faster and avoids the Claude Code resume cache bug."
        }
        checked={exec.injectMode ?? false}
        onChange={(v) => onUpdate("execution.injectMode", v, s)}
        disabled={exec.closeTerminalOnComplete}
      />
    </div>
  );
}
