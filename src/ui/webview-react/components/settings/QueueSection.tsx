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

export function QueueSection({ settings, onUpdate }: Props) {
  const queue = settings.settings.queue;
  const s = "user" as const;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Queue
      </h3>
      <div>
        <label htmlFor="queue-max-size" className="block text-xs text-description-fg mb-1">
          Max queue size
        </label>
        <input
          id="queue-max-size"
          type="number"
          min={1}
          value={queue.maxSize}
          onChange={(e) =>
            onUpdate("queue.maxSize", parseInt(e.target.value, 10) || 10, s)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <div>
        <label htmlFor="queue-max-execution-time" className="block text-xs text-description-fg mb-1">
          Max workflow execution time (seconds, -1 = unlimited)
        </label>
        <input
          id="queue-max-execution-time"
          type="number"
          min={-1}
          value={queue.maxWorkflowExecutionTime}
          onChange={(e) =>
            onUpdate(
              "queue.maxWorkflowExecutionTime",
              parseInt(e.target.value, 10) || -1,
              s
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <ToggleRow
        label="Unlimited mode"
        description="Disable all queue size and time limits."
        checked={queue.unlimitedMode}
        onChange={(v) => onUpdate("queue.unlimitedMode", v, s)}
      />
      <ToggleRow
        label="Notify on queue extension"
        description="Show a notification when the queue is extended beyond the limit."
        checked={queue.notifyOnExtension}
        onChange={(v) => onUpdate("queue.notifyOnExtension", v, s)}
      />
    </div>
  );
}
