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
  disabledReason?: string;
}

export const PermissionsQuickPicker: React.FC<PermissionsQuickPickerProps> = ({
  isNarrow,
  showLabel: _showLabel,
  disabled = false,
  disabledReason,
}) => {
  const properties = useEditorStore((s) => s.properties);
  const setProperty = useEditorStore((s) => s.setProperty);
  const multiSelection = useEditorStore((s) => s.multiSelection);
  const bulkPatch = useEditorStore((s) => s.bulkPatch);
  const clearBulkPatchField = useEditorStore((s) => s.clearBulkPatchField);
  const steps = useWorkflowStore((s) => s.steps);
  const permissionsValue = multiSelection
    ? getBulkDisplayValue(
        { multiSelection, bulkPatch },
        steps,
        "toolPermissions"
      )
    : properties.toolPermissions;
  const workflowProperties = useSettingsStore((s) => s.workflowProperties);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const footerOpenPicker = useUiStore((s) => s.footerOpenPicker);
  const setFooterOpenPicker = useUiStore((s) => s.setFooterOpenPicker);

  const isOpen = footerOpenPicker === FOOTER_PICKERS.PERMISSIONS;
  const isOverride = permissionsValue !== undefined;

  const wfPerms = workflowProperties.toolPermissions;
  const inheritedMode =
    wfPerms === null
      ? PERMISSION_MODES.NONE
      : (wfPerms?.mode ??
        globalSettings.toolPermissions.mode ??
        PERMISSION_MODES.ALLOW_ALL);
  const overrideMode =
    permissionsValue === MIXED_VALUE
      ? undefined
      : permissionsValue === undefined
        ? undefined
        : permissionsValue === null
          ? PERMISSION_MODES.NONE
          : ((permissionsValue as ToolPermissionsOverride).mode ??
            PERMISSION_MODES.ALLOW_ALL);
  const visual = getPermissionModeVisual(overrideMode ?? inheritedMode);

  const resolvedModeLabel =
    PERMISSION_MODE_OPTIONS_META[inheritedMode as PermissionMode]?.label ??
    "None";

  const valueLabel =
    permissionsValue === MIXED_VALUE
      ? "(mixed)"
      : !isOverride
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
      disabledReason={disabledReason}
    >
      <CustomSelect
        schemaPath="toolPermissions.mode"
        value={
          permissionsValue === MIXED_VALUE
            ? BULK_MIXED_OPTION
            : permissionsValue === undefined
              ? INHERIT_DEFAULT_OPTION
              : permissionsValue === null
                ? PERMISSION_MODES.NONE
                : (permissionsValue.mode ?? PERMISSION_MODES.ALLOW_ALL)
        }
        onChange={(v) => {
          if (v === BULK_MIXED_OPTION) {
            clearBulkPatchField("toolPermissions");
          } else if (v === INHERIT_DEFAULT_OPTION) {
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
          ...(permissionsValue === MIXED_VALUE
            ? [{ value: BULK_MIXED_OPTION, label: "(mixed)" }]
            : []),
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
