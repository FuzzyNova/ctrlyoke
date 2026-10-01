import { useEffect, useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../../shared/CustomSelect";
import { PermissionListEditor } from "../../shared/PermissionListEditor";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { PermissionCapabilitySummary } from "../../shared/PermissionCapabilitySummary";
import {
  PERMISSION_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

const EMPTY_TOOL_PERMISSIONS = {
  mode: PERMISSION_MODES.NONE,
  allowedTools: [] as string[],
  deniedTools: [] as string[],
};

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsPermissionsPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const toolPermissions =
    settings.settings.defaults.toolPermissions ?? EMPTY_TOOL_PERMISSIONS;
  const [allowedTools, setAllowedTools] = useState(
    toolPermissions.allowedTools
  );
  const [deniedTools, setDeniedTools] = useState(toolPermissions.deniedTools);
  const rowProps = { sources, onReset, activeScope };

  useEffect(() => {
    setAllowedTools(toolPermissions.allowedTools);
  }, [toolPermissions.allowedTools]);

  useEffect(() => {
    setDeniedTools(toolPermissions.deniedTools);
  }, [toolPermissions.deniedTools]);

  return (
    <div className="space-y-4">
      <SettingInputRow
        settingKey="defaults.toolPermissions.mode"
        id="defaults-permission-mode"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-permission-mode"
          value={toolPermissions.mode}
          onChange={(v) => onUpdate("defaults.toolPermissions.mode", v)}
          schemaPath="defaults.toolPermissions.mode"
          options={toSelectOptions(
            PERMISSION_MODE_OPTIONS_META,
            "defaults.toolPermissions.mode"
          )}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="defaults.toolPermissions.allowedTools"
        id="defaults-allowed-tools"
        {...rowProps}
      >
        <PermissionListEditor
          id="defaults-allowed-tools"
          aria-label="Allowed tools (one per line)"
          value={allowedTools}
          onChange={setAllowedTools}
          onBlur={(finalValue) =>
            onUpdate("defaults.toolPermissions.allowedTools", finalValue)
          }
          placeholder={"read\nglob\ngrep"}
          fontSize="0.875rem"
          className="w-full min-h-[72px] bg-input-bg border border-input-border rounded text-sm text-foreground focus:outline-none focus:border-focus-border font-mono"
        />
        <PermissionCapabilitySummary
          id="defaults-allowed-tools-diagnostic"
          field="allowedTools"
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="defaults.toolPermissions.deniedTools"
        id="defaults-denied-tools"
        {...rowProps}
      >
        <PermissionListEditor
          id="defaults-denied-tools"
          aria-label="Denied tools (one per line)"
          value={deniedTools}
          onChange={setDeniedTools}
          onBlur={(finalValue) =>
            onUpdate("defaults.toolPermissions.deniedTools", finalValue)
          }
          placeholder={"shell(rm:*)\nwrite"}
          fontSize="0.875rem"
          className="w-full min-h-[72px] bg-input-bg border border-input-border rounded text-sm text-foreground focus:outline-none focus:border-focus-border font-mono"
        />
        <PermissionCapabilitySummary
          id="defaults-denied-tools-diagnostic"
          field="deniedTools"
        />
      </SettingInputRow>
    </div>
  );
}
