import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { PRIOR_CONTEXT_KEYWORDS } from "@root/types/DashboardConstants";
import {
  PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { CustomSelect } from "../../shared/CustomSelect";
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
        label="Resume existing session"
        description="Attempt to resume the most recent AI session."
        checked={wf.resumeSession}
        onChange={(v) => onUpdate("defaults.resumeSession", v)}
        path="defaults.resumeSession"
        {...rowProps}
      />
      <SettingInputRow
        label="Prior Context"
        description="How to handle prior context between prompts."
        id="defaults-prior-context"
        path="defaults.priorContext"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-prior-context"
          value={
            typeof wf.priorContext === "string"
              ? wf.priorContext
              : PRIOR_CONTEXT_KEYWORDS.NONE
          }
          onChange={(v) => onUpdate("defaults.priorContext", v)}
          schemaPath="defaults.priorContext"
          options={toSelectOptions(
            PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
            "defaults.priorContext"
          )}
        />
      </SettingInputRow>
    </div>
  );
}
