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
import { TrustedExternalRootsRows } from "./TrustedExternalRootsRows";
import {
  PERMISSION_MODE_OPTIONS_META,
  HEADLESS_APPROVAL_POLICY_OPTIONS_META,
  SANDBOX_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import {
  PERMISSION_MODES,
  HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC,
  HEADLESS_APPROVAL_POLICIES,
  SETTING_PATHS,
  defaultSandboxSelectOptions,
  sandboxSelectionFromValue,
  sandboxValueFromSelection,
} from "@root/types/DashboardConstants";

const EMPTY_TOOL_PERMISSIONS = {
  mode: PERMISSION_MODES.NONE,
  allowedTools: [] as string[],
  deniedTools: [] as string[],
  headlessApprovals: HEADLESS_APPROVAL_POLICIES.DENY,
  headlessApprovalTimeoutSec: HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC,
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
  const [approvalTimeoutSec, setApprovalTimeoutSec] = useState(
    String(
      toolPermissions.headlessApprovalTimeoutSec ??
        HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC
    )
  );
  const rowProps = { sources, onReset, activeScope };

  useEffect(() => {
    setAllowedTools(toolPermissions.allowedTools);
  }, [toolPermissions.allowedTools]);

  useEffect(() => {
    setDeniedTools(toolPermissions.deniedTools);
  }, [toolPermissions.deniedTools]);

  useEffect(() => {
    setApprovalTimeoutSec(
      String(
        toolPermissions.headlessApprovalTimeoutSec ??
          HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC
      )
    );
  }, [toolPermissions.headlessApprovalTimeoutSec]);

  return (
    <div className="space-y-4">
      {/* On / Off / None: removing the key restores the shipped Off. */}
      <SettingInputRow
        settingKey="defaults.sandbox"
        id="defaults-sandbox"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-sandbox"
          value={sandboxSelectionFromValue(settings.settings.defaults.sandbox)}
          onChange={(selection) => {
            const value = sandboxValueFromSelection(selection);
            if (value === undefined) onReset("defaults.sandbox");
            else onUpdate("defaults.sandbox", value);
          }}
          schemaPath="defaults.sandbox"
          options={defaultSandboxSelectOptions()}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey="defaults.sandboxMode"
        id="defaults-sandbox-mode"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-sandbox-mode"
          value={settings.settings.defaults.sandboxMode}
          onChange={(v) => onUpdate("defaults.sandboxMode", v)}
          schemaPath="defaults.sandboxMode"
          options={toSelectOptions(
            SANDBOX_MODE_OPTIONS_META,
            "defaults.sandboxMode"
          )}
        />
      </SettingInputRow>
      {/* Same order as the workflow Permissions tab: roots follow the sandbox. */}
      <TrustedExternalRootsRows
        settings={settings}
        activeScope={activeScope}
        onUpdate={onUpdate}
        onReset={onReset}
      />
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
      <SettingInputRow
        settingKey={SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS_HEADLESS_APPROVALS}
        id="defaults-headless-approvals"
        {...rowProps}
      >
        <CustomSelect
          id="defaults-headless-approvals"
          value={
            toolPermissions.headlessApprovals ?? HEADLESS_APPROVAL_POLICIES.DENY
          }
          onChange={(value) =>
            onUpdate(
              SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS_HEADLESS_APPROVALS,
              value
            )
          }
          schemaPath="defaults.toolPermissions.headlessApprovals"
          options={toSelectOptions(
            HEADLESS_APPROVAL_POLICY_OPTIONS_META,
            "defaults.toolPermissions.headlessApprovals"
          )}
        />
      </SettingInputRow>
      <SettingInputRow
        settingKey={
          SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS_HEADLESS_APPROVAL_TIMEOUT_SEC
        }
        id="defaults-headless-approval-timeout"
        {...rowProps}
      >
        <input
          id="defaults-headless-approval-timeout"
          type="number"
          min={1}
          max={600}
          step={1}
          value={approvalTimeoutSec}
          aria-label="Headless approval timeout in seconds"
          onChange={(event) => setApprovalTimeoutSec(event.target.value)}
          onBlur={() => {
            const parsed = Number(approvalTimeoutSec);
            const value = Number.isFinite(parsed)
              ? Math.max(1, Math.min(600, Math.round(parsed)))
              : HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC;
            setApprovalTimeoutSec(String(value));
            onUpdate(
              SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS_HEADLESS_APPROVAL_TIMEOUT_SEC,
              value
            );
          }}
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-input-fg focus:outline-hidden focus:border-focus-border"
        />
      </SettingInputRow>
    </div>
  );
}
