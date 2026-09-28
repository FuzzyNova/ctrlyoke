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

export function QueueSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const queue = settings.settings.queue;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        Queue
      </h3>
      <SettingInputRow
        label="Max steps"
        id="queue-max-steps"
        path="queue.maxSteps"
        {...rowProps}
      >
        <LocalNumberInput
          id="queue-max-steps"
          min={1}
          value={queue.maxSteps}
          onCommit={(v) => onUpdate("queue.maxSteps", v)}
          parse={(v) => parseInt(v, 10) || 10}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Max parallel steps"
        id="queue-max-parallel-steps"
        path="queue.maxParallelSteps"
        {...rowProps}
      >
        <LocalNumberInput
          id="queue-max-parallel-steps"
          min={1}
          value={queue.maxParallelSteps}
          onCommit={(v) => onUpdate("queue.maxParallelSteps", v)}
          parse={(v) => parseInt(v, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        label="Max workflow execution time (seconds, -1 = unlimited)"
        id="queue-max-execution-time"
        path="queue.maxWorkflowExecutionTimeSec"
        {...rowProps}
      >
        <LocalNumberInput
          id="queue-max-execution-time"
          min={-1}
          value={queue.maxWorkflowExecutionTimeSec}
          onCommit={(v) => onUpdate("queue.maxWorkflowExecutionTimeSec", v)}
          parse={(v) => parseInt(v, 10) || -1}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
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
