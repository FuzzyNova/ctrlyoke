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

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const PERMISSION_MODE_OPTIONS = [
  { value: "allowAll", label: "Allow All" },
  { value: "dangerouslyAllowAll", label: "Dangerously Allow All" },
  { value: "custom", label: "Custom" },
];

export function DefaultsPermissionsPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const toolPermissions = settings.settings.defaults.toolPermissions;
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
        label="Permission mode"
        id="defaults-permission-mode"
        path="defaults.toolPermissions.mode"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-permission-mode"
          value={toolPermissions.mode}
          onChange={(v) => onUpdate("defaults.toolPermissions.mode", v)}
          options={PERMISSION_MODE_OPTIONS}
        />
      </SettingInputRow>
      <SettingInputRow
        label="Allowed tools (one per line)"
        id="defaults-allowed-tools"
        path="defaults.toolPermissions.allowedTools"
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
        label="Denied tools (one per line)"
        id="defaults-denied-tools"
        path="defaults.toolPermissions.deniedTools"
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
