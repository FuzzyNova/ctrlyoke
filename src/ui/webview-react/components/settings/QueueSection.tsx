import type { FullGlobalSettings, SettingSource } from "@root/types/WebviewMessageTypes";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function QueueSection({ settings, activeScope, onUpdate, onReset }: Props) {
  const queue = settings.settings.queue;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Queue
      </h3>
      <div>
        <label
          htmlFor="queue-max-size"
          className="block text-xs text-description-fg mb-1"
        >
          Max queue size
        </label>
        <input
          id="queue-max-size"
          type="number"
          min={1}
          value={queue.maxSize}
          onChange={(e) =>
            onUpdate("queue.maxSize", parseInt(e.target.value, 10) || 10)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <div>
        <label
          htmlFor="queue-max-execution-time"
          className="block text-xs text-description-fg mb-1"
        >
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
              parseInt(e.target.value, 10) || -1
            )
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </div>
      <SettingToggleRow
        label="Unlimited mode"
        description="Disable all queue size and time limits."
        checked={queue.unlimitedMode}
        onChange={(v) => onUpdate("queue.unlimitedMode", v)}
        path="queue.unlimitedMode"
        {...rowProps}
      />
      <SettingToggleRow
        label="Notify on queue extension"
        description="Show a notification when the queue is extended beyond the limit."
        checked={queue.notifyOnExtension}
        onChange={(v) => onUpdate("queue.notifyOnExtension", v)}
        path="queue.notifyOnExtension"
        {...rowProps}
      />
    </div>
  );
}
