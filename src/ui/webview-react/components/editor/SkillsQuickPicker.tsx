import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { SkillsSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";

interface SkillsQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const SkillsQuickPicker: React.FC<SkillsQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties, availableSkills } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker } = useUiStore();

  const isOpen = footerOpenPicker === "skills";

  const resolvedSkills =
    workflowProperties.skills === undefined
      ? (globalSettings.skills ?? [])
      : (workflowProperties.skills ?? []);
  const defaultSkillsLabel =
    resolvedSkills.length === 0
      ? "Default (None)"
      : resolvedSkills.length <= 2
        ? `Default (${resolvedSkills.join(", ")})`
        : `Default (${resolvedSkills.slice(0, 2).join(", ")} +${resolvedSkills.length - 2})`;

  const skillsValue = properties.skills as string[] | null | undefined;

  let valueLabel: string;
  if (skillsValue === undefined) {
    valueLabel = "Default";
  } else if (skillsValue === null) {
    valueLabel = "None";
  } else if (skillsValue.length === 0) {
    valueLabel = "None selected";
  } else if (skillsValue.length <= 2) {
    valueLabel = skillsValue.join(", ");
  } else {
    valueLabel = `${skillsValue.slice(0, 1).join(", ")} +${skillsValue.length - 1}`;
  }

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon="codicon-tools"
      valueLabel={valueLabel}
      isOverride={skillsValue !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "skills")}
      onClose={() => setFooterOpenPicker(null)}
      title="Skills override"
      popupMinWidth="240px"
      disabled={disabled}
    >
      <SkillsSelect
        value={skillsValue}
        onChange={(v) => setProperty("skills", v)}
        availableSkills={availableSkills.map((s) => ({
          name: s.name,
          description: s.description || undefined,
        }))}
        defaultLabel={defaultSkillsLabel}
        dropdownMaxHeight="300px"
      />
    </FooterQuickPicker>
  );
};
