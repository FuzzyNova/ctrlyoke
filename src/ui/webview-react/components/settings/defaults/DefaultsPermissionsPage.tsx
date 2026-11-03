import { useEffect, useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../../shared/CustomSelect";
import { PermissionListEditor } from "../../shared/PermissionListEditor";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { SettingToggleRow } from "../../shared/SettingToggleRow";
import { PermissionCapabilitySummary } from "../../shared/PermissionCapabilitySummary";
import {
  PERMISSION_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import {
  CODEX_APPROVAL_POLICY_OPTIONS_META,
  CODEX_SANDBOX_MODE_OPTIONS_META,
} from "@root/types/SchemaUiMetadata";

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
      <SettingToggleRow
        settingKey="defaults.sandbox"
        checked={settings.settings.defaults.sandbox === true}
        onChange={(value) => onUpdate("defaults.sandbox", value)}
        {...rowProps}
      />
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-2 tracking-wide">
          Codex sandbox
        </h3>
        <p className="text-xs text-description-fg mb-3">
          These settings control how strict Codex is when contained.
        </p>
        <SettingInputRow
          settingKey="permissions.codexSandboxMode"
          id="codex-sandbox-mode"
          {...rowProps}
        >
          <CustomSelect
            id="codex-sandbox-mode"
            value={settings.settings.permissions.codexSandboxMode}
            onChange={(v) => onUpdate("permissions.codexSandboxMode", v)}
            schemaPath="permissions.codexSandboxMode"
            options={toSelectOptions(
              CODEX_SANDBOX_MODE_OPTIONS_META,
              "permissions.codexSandboxMode"
            )}
          />
        </SettingInputRow>
        <SettingInputRow
          settingKey="permissions.codexApprovalPolicy"
          id="codex-approval-policy"
          {...rowProps}
        >
          <CustomSelect
            id="codex-approval-policy"
            value={settings.settings.permissions.codexApprovalPolicy}
            onChange={(v) => onUpdate("permissions.codexApprovalPolicy", v)}
            schemaPath="permissions.codexApprovalPolicy"
            options={toSelectOptions(
              CODEX_APPROVAL_POLICY_OPTIONS_META,
              "permissions.codexApprovalPolicy"
            )}
          />
        </SettingInputRow>
      </div>
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
          className="w-full min-h-[72px] bg-input-bg border border-input-border rounded-sm text-sm text-foreground focus:outline-hidden focus:border-focus-border font-mono"
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
          className="w-full min-h-[72px] bg-input-bg border border-input-border rounded-sm text-sm text-foreground focus:outline-hidden focus:border-focus-border font-mono"
        />
        <PermissionCapabilitySummary
          id="defaults-denied-tools-diagnostic"
          field="deniedTools"
        />
      </SettingInputRow>
    </div>
  );
}
