import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { DROPDOWN_NAMESPACES } from "../../types/dropdownNamespaces";
import { HarnessDropdown, HarnessIcon, HARNESS_DISPLAY_NAMES } from "../shared";
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
  const { globalSettings, workflowProperties, harnessStatus } =
    useSettingsStore();
  const {
    footerOpenPicker,
    setFooterOpenPicker,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
  } = useUiStore();

  const isOpen = footerOpenPicker === "harness";

  const resolvedHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Default (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const valueLabel = properties.harness
    ? (HARNESS_DISPLAY_NAMES[properties.harness as HarnessId] ??
      properties.harness)
    : (HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness);

  const handleHarnessChange = (newHarness: string) => {
    if (newHarness === "default") {
      setProperty("harness", undefined);
      setProperty("model", undefined);
      setProperty("additionalArgs", undefined);
    } else {
      setProperty("harness", newHarness);
      const defaultModel = globalSettings.harnessDefaultModels[newHarness];
      setProperty("model", defaultModel || undefined);
      const defaultArgs = globalSettings.harnessDefaultAdditionalArgs[newHarness];
      setProperty("additionalArgs", defaultArgs || null);
    }
    setFooterOpenPicker(null);
  };

  const activeHarnessId = (properties.harness ?? resolvedHarness) as HarnessId;
  const isOverride = properties.harness !== undefined;

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon={
        <HarnessIcon
          harnessId={activeHarnessId}
          size={14}
          dimmed={!isOverride}
        />
      }
      valueLabel={valueLabel}
      isOverride={isOverride}
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
        onUnhideOption={(v) =>
          unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
        }
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
