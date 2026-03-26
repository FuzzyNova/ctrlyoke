import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import {
  HarnessDropdown,
  HARNESS_DISPLAY_NAMES,
} from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";

interface HarnessQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const HarnessQuickPicker: React.FC<HarnessQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties, harnessStatus } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker, hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } =
    useUiStore();

  const isOpen = footerOpenPicker === "harness";

  const resolvedHarness = (workflowProperties.harness ?? globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Default (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const valueLabel = properties.harness
    ? (HARNESS_DISPLAY_NAMES[properties.harness as HarnessId] ?? properties.harness)
    : "Default";

  const handleHarnessChange = (newHarness: string) => {
    setProperty("harness", newHarness === "default" ? undefined : newHarness);
    setProperty("model", undefined);
    setFooterOpenPicker(null);
  };

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon="codicon-circuit-board"
      valueLabel={valueLabel}
      isOverride={properties.harness !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "harness")}
      onClose={() => setFooterOpenPicker(null)}
      title="Harness override"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <HarnessDropdown
        value={properties.harness ?? "default"}
        onChange={handleHarnessChange}
        showDefault={true}
        defaultLabel={defaultHarnessLabel}
        showStatus={true}
        harnessStatus={harnessStatus}
        hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []}
        onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
        onUnhideOption={(v) => unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
        dropdownMaxHeight="300px"
      />
    </FooterQuickPicker>
  );
};
