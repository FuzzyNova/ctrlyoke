import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import {
  INHERIT_DEFAULT_OPTION,
  PERMISSION_MODES,
} from "@root/types/DashboardConstants";
import { FOOTER_PICKERS } from "@root/types/DashboardConstants";
import type {
  ToolPermissionsOverride,
  ToolPermissionMode,
} from "../../types/messages";
import { CustomSelect } from "../shared";
import {
  PERMISSION_MODE_OPTIONS,
  buildPermissionsDefaultLabel,
} from "../shared/permissionUtils";
import { FooterQuickPicker } from "./FooterQuickPicker";

interface PermissionsQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const PermissionsQuickPicker: React.FC<PermissionsQuickPickerProps> = ({
  isNarrow,
  showLabel,
  disabled = false,
}) => {
  const { properties, setProperty } = useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const { footerOpenPicker, setFooterOpenPicker } = useUiStore();

  const isOpen = footerOpenPicker === FOOTER_PICKERS.PERMISSIONS;
  const isOverride = properties.toolPermissions !== undefined;

  const resolvedModeLabel = (() => {
    const wf = workflowProperties.toolPermissions;
    // Fall back to global settings when no workflow-level override is set
    const effective = wf !== undefined ? wf : globalSettings.toolPermissions;
    if (effective === undefined || effective === null) return "None";
    return (
      PERMISSION_MODE_OPTIONS.find((o) => o.value === effective.mode)?.label ??
      effective.mode ??
      "None"
    );
  })();

  const valueLabel = !isOverride
    ? resolvedModeLabel
    : properties.toolPermissions === null
      ? "None"
      : (PERMISSION_MODE_OPTIONS.find(
          (o) =>
            o.value ===
            (properties.toolPermissions as ToolPermissionsOverride).mode
        )?.label ?? "Allow All");

  const defaultLabel = buildPermissionsDefaultLabel(
    workflowProperties.toolPermissions,
    globalSettings.toolPermissions as ToolPermissionsOverride
  );

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={showLabel}
      icon={
        <i
          className={`codicon codicon-shield codicon-sm transition-opacity ${isOverride ? "text-focus-border" : "opacity-40"}`}
        />
      }
      valueLabel={valueLabel}
      isOverride={isOverride}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "permissions")}
      onClose={() => setFooterOpenPicker(null)}
      title="Permissions override"
      heading="Permissions"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        value={
          properties.toolPermissions === undefined
            ? INHERIT_DEFAULT_OPTION
            : properties.toolPermissions === null
              ? PERMISSION_MODES.NONE
              : (properties.toolPermissions.mode ?? PERMISSION_MODES.ALLOW_ALL)
        }
        onChange={(v) => {
          if (v === INHERIT_DEFAULT_OPTION) {
            setProperty("toolPermissions", undefined);
          } else {
            const current =
              (properties.toolPermissions as
                | ToolPermissionsOverride
                | undefined) || {};
            setProperty("toolPermissions", {
              ...current,
              mode: v as ToolPermissionMode,
            });
          }
          setFooterOpenPicker(null);
        }}
        options={[
          { value: INHERIT_DEFAULT_OPTION, label: defaultLabel },
          ...PERMISSION_MODE_OPTIONS,
        ]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
