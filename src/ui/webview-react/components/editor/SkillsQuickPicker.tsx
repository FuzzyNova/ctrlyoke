import React from "react";
import {
  useEditorStore,
  getBulkDisplayValue,
  MIXED_VALUE,
} from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { FOOTER_PICKERS } from "../../types/messages";
import { SkillsSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { Icon } from "../shared/Icon";

interface SkillsQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export const SkillsQuickPicker: React.FC<SkillsQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
  disabledReason,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const clearBulkPatchField = useEditorStore((s) => s.clearBulkPatchField);
  const steps = useWorkflowStore((s) => s.steps);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const availableSkills = useSettingsStore((s) => s.availableSkills);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.SKILLS;

  const resolvedSkills =
    workflowProperties.skills === undefined
      ? (globalSettings.skills ?? [])
      : (workflowProperties.skills ?? []);
  const defaultSkillsLabel =
    resolvedSkills.length === 0
      ? "Inherit (None)"
      : resolvedSkills.length <= 2
        ? `Inherit (${resolvedSkills.join(", ")})`
        : `Inherit (${resolvedSkills.slice(0, 2).join(", ")} +${resolvedSkills.length - 2})`;

  const rawSkillsValue = multiSelection
    ? getBulkDisplayValue({ multiSelection, bulkPatch }, steps, "skills")
    : properties.skills;
  const isMixed = rawSkillsValue === MIXED_VALUE;
  const skillsValue = isMixed
    ? undefined
    : (rawSkillsValue as string[] | null | undefined);

  const resolvedSkillsLabel =
    resolvedSkills.length === 0
      ? "None"
      : resolvedSkills.length <= 2
        ? resolvedSkills.join(", ")
        : `${resolvedSkills.slice(0, 2).join(", ")} +${resolvedSkills.length - 2}`;

  let valueLabel: string;
  if (isMixed) {
    valueLabel = "(mixed)";
  } else if (skillsValue === undefined) {
    valueLabel = resolvedSkillsLabel;
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
      showLabel={showLabel && (isMixed || skillsValue !== undefined)}
      icon={
        <Icon
          name="tools"
          className={`codicon-sm transition-opacity ${isMixed || skillsValue !== undefined ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={isMixed || skillsValue !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "skills")}
      onClose={() => setFooterOpenPicker(null)}
      title="Skills override"
      heading="Skills"
      popupMinWidth="240px"
      popupMaxWidth="320px"
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <SkillsSelect
        value={skillsValue}
        onChange={(v) => setProperty("skills", v)}
        availableSkills={availableSkills.map((s) => ({
          name: s.name,
          description: s.description || undefined,
        }))}
        defaultLabel={defaultSkillsLabel}
        namespace={DROPDOWN_NAMESPACES.SKILLS}
        hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.SKILLS] ?? []}
        onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)}
        onUnhideOption={(v) =>
          unhideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)
        }
        dropdownMaxHeight="300px"
        inline={true}
        mixed={isMixed}
        onSelectMixed={() => clearBulkPatchField("skills")}
      />
    </FooterQuickPicker>
  );
};
