import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import {
  INHERIT_DEFAULT_OPTION,
  PERMISSION_MODES,
} from "@root/types/DashboardConstants";
import type { PermissionMode } from "@root/types/DashboardConstants";
import { FOOTER_PICKERS } from "@root/types/DashboardConstants";
import type {
  ToolPermissionsOverride,
  ToolPermissionMode,
} from "../../types/messages";
import { CustomSelect } from "../shared";
import { buildPermissionsDefaultLabel } from "../shared/permissionUtils";
import {
  PERMISSION_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { getPermissionModeVisual } from "../shared/tabBadgeUtils";
import { FooterQuickPicker } from "./FooterQuickPicker";
import { Icon } from "../shared/Icon";

interface PermissionsQuickPickerProps {
  isNarrow: boolean;
  showLabel: boolean;
  disabled?: boolean;
}

export const PermissionsQuickPicker: React.FC<PermissionsQuickPickerProps> = ({
  isNarrow,
  showLabel: _showLabel,
  disabled = false,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.PERMISSIONS;
  const isOverride = properties.toolPermissions !== undefined;

  const wfPerms = workflowProperties.toolPermissions;
  const inheritedMode =
    wfPerms === null
      ? PERMISSION_MODES.NONE
      : (wfPerms?.mode ??
        globalSettings.toolPermissions.mode ??
        PERMISSION_MODES.ALLOW_ALL);
  const overrideMode =
    properties.toolPermissions === undefined
      ? undefined
      : properties.toolPermissions === null
        ? PERMISSION_MODES.NONE
        : ((properties.toolPermissions as ToolPermissionsOverride).mode ??
          PERMISSION_MODES.ALLOW_ALL);
  const visual = getPermissionModeVisual(overrideMode ?? inheritedMode);

  const resolvedModeLabel =
    PERMISSION_MODE_OPTIONS_META[inheritedMode as PermissionMode]?.label ??
    "None";

  const valueLabel = !isOverride
    ? resolvedModeLabel
    : ((overrideMode
        ? PERMISSION_MODE_OPTIONS_META[overrideMode]?.label
        : undefined) ?? "None");

  const defaultLabel = buildPermissionsDefaultLabel(
    workflowProperties.toolPermissions,
    globalSettings.toolPermissions as ToolPermissionsOverride
  );

  return (
    <FooterQuickPicker
      isNarrow={isNarrow}
      showLabel={false}
      icon={
        <Icon
          name={visual.codicon}
          className={`codicon-sm transition-opacity ${visual.color} ${
            isOverride ? "" : "opacity-40"
          }`}
        />
      }
      valueLabel={valueLabel}
      isOverride={isOverride}
      isOpen={isOpen}
      onToggle={() => setFooterOpenPicker(isOpen ? null : "permissions")}
      onClose={() => setFooterOpenPicker(null)}
      title={`Permissions: ${valueLabel}`}
      heading="Permissions"
      popupMinWidth="220px"
      disabled={disabled}
    >
      <CustomSelect
        schemaPath="toolPermissions.mode"
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
                ToolPermissionsOverride | undefined) || {};
            setProperty("toolPermissions", {
              ...current,
              mode: v as ToolPermissionMode,
            });
          }
          setFooterOpenPicker(null);
        }}
        options={[
          {
            value: INHERIT_DEFAULT_OPTION,
            label: defaultLabel,
            pseudo: { omit: true },
          },
          ...toSelectOptions(
            PERMISSION_MODE_OPTIONS_META,
            "toolPermissions.mode"
          ),
        ]}
        dropdownMaxHeight="300px"
        inline={true}
      />
    </FooterQuickPicker>
  );
};
