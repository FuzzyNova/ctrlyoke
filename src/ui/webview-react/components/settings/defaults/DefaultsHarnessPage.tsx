import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";
import { MultiCheckboxDropdown } from "../../shared/MultiCheckboxDropdown";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { LocalTextInput } from "../../shared/LocalInputs";
import { HarnessesSection } from "../HarnessesSection";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsHarnessPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const wf = settings.settings.defaults;
  const availableSkills = useSettingsStore((s) => s.availableSkills);
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <HarnessesSection
        settings={settings}
        activeScope={activeScope}
        onUpdate={onUpdate}
        onReset={onReset}
      />
      <div className="border-t border-panel-border pt-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
          Agent & Skill Defaults
        </h3>
        <SettingInputRow
          label="Default agent"
          description="Agent to use when none is specified in the workflow."
          id="defaults-agent"
          path="defaults.agent"
          {...rowProps}
        >
          <LocalTextInput
            id="defaults-agent"
            value={wf.agent}
            onCommit={(v) => onUpdate("defaults.agent", v)}
            placeholder="None"
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>
        <SettingInputRow
          label="Default skills"
          description="Skills to include in new workflows by default."
          id="defaults-skills"
          path="defaults.skills"
          {...rowProps}
        >
          <MultiCheckboxDropdown
            id="defaults-skills"
            selectedValues={wf.skills}
            onChange={(values) => onUpdate("defaults.skills", values)}
            options={availableSkills.map((skill) => ({
              value: skill.name,
              label: skill.name,
              description: skill.description,
            }))}
            placeholder="No skills selected"
          />
        </SettingInputRow>
      </div>
    </div>
  );
}
