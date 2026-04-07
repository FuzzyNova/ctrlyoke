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
        <span className="text-sm text-foreground">{label}</span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

export function HistorySection({ settings, onUpdate }: Props) {
  const history = settings.settings.history;
  const s = "user" as const;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        History
      </h3>
      <ToggleRow
        label="Save output history"
        description="Save the output of each workflow run for later review."
        checked={history.saveOutput}
        onChange={(v) => onUpdate("history.saveOutput", v, s)}
      />
      <div>
        <label className="block text-xs text-description-fg mb-1">
          Max history runs (-1 = unlimited)
        </label>
        <input
          type="number"
          min={-1}
          value={history.maxRuns}
          onChange={(e) =>
            onUpdate("history.maxRuns", parseInt(e.target.value, 10) || -1, s)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
    </div>
  );
}
