import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { EXECUTION_MODE_OPTIONS } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
import { agentWarning, skillsWarning } from "@utils/dropdownValidation";
import { CustomSelect } from "../../shared/CustomSelect";
import { toAgentSelectOption } from "../../shared/agentSelectOptions";
import { MultiCheckboxDropdown } from "../../shared/MultiCheckboxDropdown";
import { SettingInputRow } from "../../shared/SettingInputRow";
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
  const availableAgents = useSettingsStore((s) => s.availableAgents);
  const availableSkills = useSettingsStore((s) => s.availableSkills);
  const rowProps = { sources, onReset, activeScope };
  const agentWarn = agentWarning(wf.agent, availableAgents);
  const skillsWarn = skillsWarning(wf.skills, availableSkills);

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
          Execution Defaults
        </h3>
        <SettingInputRow
          label="Execution mode"
          description="Where steps run by default. Interactive spawns a live terminal you can steer; headless runs in the background. Workflows and steps can override this. Pre/end-condition scripts always run headless."
          id="defaults-execution-mode"
          path="defaults.executionMode"
          {...rowProps}
        >
          <CustomSelect
            id="defaults-execution-mode"
            value={wf.executionMode}
            onChange={(v) => onUpdate("defaults.executionMode", v)}
            options={EXECUTION_MODE_OPTIONS}
          />
        </SettingInputRow>
      </div>
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
          <CustomSelect
            id="defaults-agent"
            value={wf.agent || ""}
            onChange={(v) => onUpdate("defaults.agent", v)}
            options={[
              { value: "", label: "None" },
              ...availableAgents.map((agent) =>
                toAgentSelectOption(agent, agent.name)
              ),
            ]}
            warning={agentWarn ?? undefined}
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
            warning={skillsWarn ?? undefined}
          />
        </SettingInputRow>
      </div>
    </div>
  );
}
