import type {
  FullGlobalSettings,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function HistorySection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const history = settings.settings.history;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
        History
      </h3>
      <SettingToggleRow
        label="Save output history"
        description="Save the output of each workflow run for later review."
        checked={history.saveOutput}
        onChange={(v) => onUpdate("history.saveOutput", v)}
        path="history.saveOutput"
        {...rowProps}
      />
      <SettingInputRow
        label="Max history runs (-1 = unlimited)"
        id="history-max-runs"
        path="history.maxRuns"
        {...rowProps}
      >
        <input
          id="history-max-runs"
          type="number"
          min={-1}
          value={history.maxRuns}
          onChange={(e) =>
            onUpdate("history.maxRuns", parseInt(e.target.value, 10) || -1)
          }
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
        />
      </SettingInputRow>
    </div>
  );
}
