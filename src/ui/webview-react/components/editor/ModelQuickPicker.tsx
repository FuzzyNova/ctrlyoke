import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { FOOTER_PICKERS } from "../../types/messages";
import { modelNamespaceForHarness } from "../../types/dropdownNamespaces";
import { CustomSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { Icon } from "../shared/Icon";

interface ModelQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const ModelQuickPicker: React.FC<ModelQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.MODEL;

  const resolvedHarness = (properties.harness ??
    workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const models = getModelsForHarness(resolvedHarness);
  const modelNamespace = modelNamespaceForHarness(resolvedHarness);

  const resolvedModelValue =
    workflowProperties.model ??
    globalSettings.harnessDefaultModels[resolvedHarness] ??
    globalSettings.model;
  const resolvedModelLabel =
    models.find((m) => m.value === resolvedModelValue)?.label ??
    resolvedModelValue;
  const defaultModelLabel = `Inherit (${resolvedModelLabel || "None"})`;

  const valueLabel = properties.model
    ? (models.find((m) => m.value === properties.model)?.label ??
      properties.model)
    : resolvedModelLabel || "None";

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon={
        <Icon
          name="robot"
          className={`codicon-sm transition-opacity ${properties.model !== undefined ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={properties.model !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "model")}
      onClose={() => setFooterOpenPicker(null)}
      title="Model override"
      heading="Model"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        value={properties.model ?? INHERIT_DEFAULT_OPTION}
        onChange={(v) => {
          setProperty("model", v === INHERIT_DEFAULT_OPTION ? undefined : v);
          setFooterOpenPicker(null);
        }}
        options={[
          { value: INHERIT_DEFAULT_OPTION, label: defaultModelLabel },
          ...(models.length === 0
            ? [{ value: "", label: "Loading models...", disabled: true }]
            : models.map((m) => ({ value: m.value, label: m.label }))),
        ]}
        namespace={modelNamespace}
        hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
        onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
        onUnhideOption={(v) => unhideDropdownOption(modelNamespace, v)}
        nonHideableValues={[INHERIT_DEFAULT_OPTION, ""]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
