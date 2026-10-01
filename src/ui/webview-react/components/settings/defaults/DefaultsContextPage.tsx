import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import { PriorContextSelect } from "../../shared/PriorContextSelect";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { SettingToggleRow } from "../../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsContextPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const wf = settings.settings.defaults;
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-1">
      <SettingToggleRow
        settingKey="defaults.resumeSession"
        checked={wf.resumeSession}
        onChange={(v) => onUpdate("defaults.resumeSession", v)}
        {...rowProps}
      />
      <SettingInputRow
        settingKey="defaults.priorContext"
        id="defaults-prior-context"
        {...rowProps}
      >
        {/* The shared select, so Custom ranges and Previous N defaults
            display and edit as themselves instead of reading as "None". */}
        <PriorContextSelect
          id="defaults-prior-context"
          value={wf.priorContext}
          // A default always has a value: clearing a custom range means none.
          onChange={(v) =>
            onUpdate("defaults.priorContext", v ?? PRIOR_CONTEXT_KEYWORDS.NONE)
          }
          schemaPath="defaults.priorContext"
          allowRunAddress={false}
        />
      </SettingInputRow>
    </div>
  );
}
