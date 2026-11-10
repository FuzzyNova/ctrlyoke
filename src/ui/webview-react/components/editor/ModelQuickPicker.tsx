import {
  INHERIT_DEFAULT_OPTION,
  PICKER_SHORTCUT_TARGETS,
} from "@root/types/DashboardConstants";
import React from "react";
import {
  useEditorStore,
  getBulkDisplayValue,
  MIXED_VALUE,
  BULK_MIXED_OPTION,
} from "../../store/editorStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import { FOOTER_PICKERS } from "../../types/messages";
import { useModelDropdownHiding } from "../../hooks/useModelDropdownHiding";
import { CustomSelect } from "../shared";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { harnessScopedFallbackLabel } from "../../utils/harnessScopedFallback";
import { modelSummaryLabel } from "../../utils/modelLabels";
import { Icon } from "../shared/Icon";

interface ModelQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export const ModelQuickPicker: React.FC<ModelQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
  disabledReason,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const clearBulkPatchField = useEditorStore((s) => s.clearBulkPatchField);
  const steps = useWorkflowStore((s) => s.steps);
  const modelValue = multiSelection
    ? getBulkDisplayValue({ multiSelection, bulkPatch }, steps, "model")
    : properties.model;
  const setProperty = useEditorStore((s) => s.setProperty);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const getModelsForHarness = useSettingsStore((s) => s.getModelsForHarness);
  const getEffectiveModel = useSettingsStore((s) => s.getEffectiveModel);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);
  const isOpen = footerOpenPicker === FOOTER_PICKERS.MODEL;

  const workflowHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const resolvedHarness = (properties.harness ?? workflowHarness) as HarnessId;
  const models = getModelsForHarness(resolvedHarness);
  const modelHiding = useModelDropdownHiding(resolvedHarness, models);

  const resolvedModelValue = getEffectiveModel(resolvedHarness);
  const resolvedModelLabel = modelSummaryLabel(resolvedModelValue, models);
  const defaultModelLabel = harnessScopedFallbackLabel(
    resolvedHarness,
    workflowHarness,
    resolvedModelLabel || "None"
  );

  const valueLabel =
    modelValue === MIXED_VALUE
      ? "(mixed)"
      : modelValue
        ? modelSummaryLabel(modelValue, models)
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
      disabledReason={disabledReason}
      shortcutTarget={PICKER_SHORTCUT_TARGETS.STEP_MODEL}
    >
      <CustomSelect
        shortcutTarget={PICKER_SHORTCUT_TARGETS.STEP_MODEL}
        onRequestClose={() => setFooterOpenPicker(null)}
        value={
          modelValue === MIXED_VALUE
            ? BULK_MIXED_OPTION
            : (modelValue ?? INHERIT_DEFAULT_OPTION)
        }
        onChange={(v) => {
          if (v === BULK_MIXED_OPTION) clearBulkPatchField("model");
          else
            setProperty("model", v === INHERIT_DEFAULT_OPTION ? undefined : v);
          setFooterOpenPicker(null);
        }}
        schemaPath="model"
        options={[
          ...(modelValue === MIXED_VALUE
            ? [{ value: BULK_MIXED_OPTION, label: "(mixed)" }]
            : []),
          { value: INHERIT_DEFAULT_OPTION, label: defaultModelLabel },
          ...(models.length === 0
            ? [{ value: "", label: "Loading models...", disabled: true }]
            : models.map((m) => ({
                value: m.value,
                label: m.label,
                description: m.description,
              }))),
        ]}
        {...modelHiding}
        nonHideableValues={[INHERIT_DEFAULT_OPTION, ""]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
