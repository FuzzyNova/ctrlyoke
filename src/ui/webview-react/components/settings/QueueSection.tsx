import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { LocalNumberInput } from "../shared/LocalInputs";
import { LimitSelect } from "../shared/LimitSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { settingLabel } from "./settingsCatalog";

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
        settingKey="queue.maxSteps"
        id="queue-max-steps"
        {...rowProps}
      >
        <LimitSelect
          id="queue-max-steps"
          label={settingLabel("queue.maxSteps")}
          path="queue.maxSteps"
          value={queue.maxSteps}
          onChange={(v) => onUpdate("queue.maxSteps", v)}
          customFallback={100}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="queue.maxParallelSteps"
        id="queue-max-parallel-steps"
        {...rowProps}
      >
        <LocalNumberInput
          id="queue-max-parallel-steps"
          min={1}
          value={queue.maxParallelSteps}
          onCommit={(v) => onUpdate("queue.maxParallelSteps", v)}
          parse={(v) => parseInt(v, 10) || 1}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="queue.maxWorkflowExecutionTimeSec"
        id="queue-max-execution-time"
        {...rowProps}
      >
        <LimitSelect
          id="queue-max-execution-time"
          label={settingLabel("queue.maxWorkflowExecutionTimeSec")}
          path="queue.maxWorkflowExecutionTimeSec"
          value={queue.maxWorkflowExecutionTimeSec}
          onChange={(v) => onUpdate("queue.maxWorkflowExecutionTimeSec", v)}
          customFallback={3600}
        />
      </SettingInputRow>
      <SettingToggleRow
        settingKey="queue.notifyOnExtension"
        checked={queue.notifyOnExtension}
        onChange={(v) => onUpdate("queue.notifyOnExtension", v)}
        {...rowProps}
      />
    </div>
  );
}
