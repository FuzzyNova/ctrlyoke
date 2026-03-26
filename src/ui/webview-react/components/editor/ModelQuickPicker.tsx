import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { modelNamespaceForHarness } from "../../types/dropdownNamespaces";
import { CustomSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";

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
  const { properties, setProperty } = useEditorStore();
  const { globalSettings, workflowProperties, getModelsForHarness } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker, hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } =
    useUiStore();

  const isOpen = footerOpenPicker === "model";

  const resolvedHarness = (
    properties.harness ?? workflowProperties.harness ?? globalSettings.harness
  ) as HarnessId;
  const models = getModelsForHarness(resolvedHarness);
  const modelNamespace = modelNamespaceForHarness(resolvedHarness);

  const resolvedModelValue =
    workflowProperties.model ??
    globalSettings.harnessDefaultModels[resolvedHarness] ??
    globalSettings.model;
  const resolvedModelLabel =
    models.find((m) => m.value === resolvedModelValue)?.label ?? resolvedModelValue;
  const defaultModelLabel = `Default (${resolvedModelLabel || "None"})`;

  const valueLabel = properties.model
    ? (models.find((m) => m.value === properties.model)?.label ?? properties.model)
    : "Default";

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon="codicon-hubot"
      valueLabel={valueLabel}
      isOverride={properties.model !== undefined}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "model")}
      onClose={() => setFooterOpenPicker(null)}
      title="Model override"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        value={properties.model ?? "default"}
        onChange={(v) => {
          setProperty("model", v === "default" ? undefined : v);
          setFooterOpenPicker(null);
        }}
        options={[
          { value: "default", label: defaultModelLabel },
          ...(models.length === 0
            ? [{ value: "", label: "Loading models...", disabled: true }]
            : models.map((m) => ({ value: m.value, label: m.label }))),
        ]}
        namespace={modelNamespace}
        hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
        onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
        onUnhideOption={(v) => unhideDropdownOption(modelNamespace, v)}
        nonHideableValues={["default", ""]}
        dropdownMaxHeight="300px"
      />
    </FooterQuickPicker>
  );
};
