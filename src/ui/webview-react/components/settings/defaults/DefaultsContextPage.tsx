import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import { CustomSelect } from "../../shared/CustomSelect";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { SettingToggleRow } from "../../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const PRIOR_CONTEXT_OPTIONS = [
  { value: PRIOR_CONTEXT_KEYWORDS.NONE, label: "None" },
  { value: PRIOR_CONTEXT_KEYWORDS.ALL, label: "All" },
  { value: PRIOR_CONTEXT_KEYWORDS.PREVIOUS, label: "Previous" },
  { value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL, label: "Final Step (All)" },
  {
    value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS,
    label: "Final Step (Previous)",
  },
];

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
        label="Resume existing session"
        description="Attempt to resume the most recent AI session."
        checked={wf.resumeSession}
        onChange={(v) => onUpdate("defaults.resumeSession", v)}
        path="defaults.resumeSession"
        {...rowProps}
      />
      <SettingInputRow
        label="Default prior context"
        description="How to handle prior context between prompts."
        id="defaults-prior-context"
        path="defaults.priorContext"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-prior-context"
          value={wf.priorContext || PRIOR_CONTEXT_KEYWORDS.NONE}
          onChange={(v) => onUpdate("defaults.priorContext", v)}
          options={PRIOR_CONTEXT_OPTIONS}
        />
      </SettingInputRow>
    </div>
  );
}
