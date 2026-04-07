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
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
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
        <label className="block text-xs text-description-fg mb-1">Execution mode</label>
        <CustomSelect
          value={exec.mode}
          onChange={(v) => onUpdate("execution.mode", v, s)}
          options={MODE_OPTIONS}
        />
      </div>
      <div>
        <label className="block text-xs text-description-fg mb-1">
          Max prompt timeout (seconds, -1 = unlimited)
        </label>
        <input
          type="number"
          min={-1}
          value={exec.maxPromptTimeout}
          onChange={(e) =>
            onUpdate("execution.maxPromptTimeout", parseInt(e.target.value, 10) || -1, s)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <div>
        <label className="block text-xs text-description-fg mb-1">
          Script timeout (seconds)
        </label>
        <input
          type="number"
          min={1}
          value={exec.scriptTimeout}
          onChange={(e) =>
            onUpdate("execution.scriptTimeout", parseInt(e.target.value, 10) || 30, s)
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
    </div>
  );
}
