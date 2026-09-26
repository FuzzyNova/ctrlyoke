import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";
import { PermissionCapabilitySummary } from "../shared/PermissionCapabilitySummary";
import { TrustedRootsListEditor } from "../shared/TrustedRootsListEditor";
import {
  CODEX_APPROVAL_POLICY_OPTIONS_META,
  CODEX_SANDBOX_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function AdvancedPermissionsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const vscode = useVsCodeApi();
  const permissions = settings.settings.permissions;
  const ui = settings.settings.ui;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };
  const scopedEntries =
    activeScope === SETTING_SCOPES.USER
      ? (
          settings.externalFileRootsByScope?.user ??
          permissions.trustedExternalRoots
        ).map((path) => ({ path }))
      : (
          settings.externalFileRootsByScope?.workspace ??
          permissions.trustedExternalRoots.map((path) => ({ path }))
        ).map((entry) => (typeof entry === "string" ? { path: entry } : entry));

  const handleBrowseExternalRoot = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.BROWSE_AND_ADD_EXTERNAL_ROOT,
      scope: activeScope,
    });
  };

  const handleAddExternalRoot = (path: string) => {
    onUpdate(SETTING_PATHS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS, [
      ...scopedEntries.map((entry) => entry.path),
      path,
    ]);
  };

  const handleRemoveExternalRoot = (path: string) => {
    onUpdate(
      SETTING_PATHS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS,
      scopedEntries
        .map((entry) => entry.path)
        .filter((entryPath) => entryPath !== path)
    );
  };

  const handleDecisionChange = (path: string, decision: "allow" | "deny") => {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_EXTERNAL_ROOT_DECISION,
      scope: activeScope,
      path,
      decision,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-2 tracking-wide">
          Tool Permission Compatibility
        </h3>
        <p className="text-xs text-description-fg mb-2">
          Allowed Tools and Denied Tools are currently supported by Copilot CLI,
          Claude CLI, Qwen Code, and OpenCode. Qwen uses inline granular
          support; OpenCode uses{" "}
          <code className="font-mono">OPENCODE_CONFIG_CONTENT</code>
          and does not write a workspace{" "}
          <code className="font-mono">opencode.json</code>.
        </p>
        <p className="text-xs text-description-fg mb-2">
          Manage secret values, declarations, and redaction settings in the
          separate Secrets tab.
        </p>
        <PermissionCapabilitySummary
          id="advanced-allowed-tools-diagnostic"
          field="allowedTools"
        />
        <PermissionCapabilitySummary
          id="advanced-denied-tools-diagnostic"
          field="deniedTools"
        />
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Trusted External Roots
        </h3>
        <SettingInputRow
          label="Trusted external roots"
          id="trusted-external-roots"
          path={SETTING_PATHS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS}
          {...rowProps}
        >
          <TrustedRootsListEditor
            entries={scopedEntries}
            showDecisionStatus={activeScope === SETTING_SCOPES.WORKSPACE}
            onAdd={handleAddExternalRoot}
            onBrowse={handleBrowseExternalRoot}
            onRemove={handleRemoveExternalRoot}
            onDecisionChange={
              activeScope === SETTING_SCOPES.WORKSPACE
                ? handleDecisionChange
                : undefined
            }
          />
        </SettingInputRow>
        <p className="text-xs text-description-fg mt-1">
          Absolute directories outside the workspace that ctrlyoke may read for
          prompt attachments and open from file links, and that the harness
          (copilot-cli, claude-cli, codex-cli, and antigravity-cli via
          --add-dir; qwen-cli and opencode-cli via their own trust mechanisms)
          gets tool access to. Workspace files are always allowed. Entries added
          at workspace scope require a one-time approval (VS Code prompt, or{" "}
          <code className="font-mono">ctrlyoke trust-external-roots</code> for
          the standalone CLI) before they take effect.
        </p>
        <div className="mt-3">
          <SettingToggleRow
            label="Offer trust for untrusted file links"
            description="Allow an AI-generated file link outside trusted roots to offer a Trust Parent Folder action. When off, untrusted links are still blocked outright — this only controls whether the offer appears."
            checked={ui.offerTrustForUntrustedFileLinks}
            onChange={(v) => onUpdate("ui.offerTrustForUntrustedFileLinks", v)}
            path="ui.offerTrustForUntrustedFileLinks"
            {...rowProps}
          />
        </div>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Codex CLI
        </h3>
        <p className="text-xs text-description-fg mb-3">
          Sandbox mode and approval policy only apply when Permission Mode is
          set to <span className="font-medium text-foreground">Custom</span>.
        </p>
        <div className="space-y-3">
          <SettingInputRow
            label="Sandbox mode"
            id="codex-sandbox-mode"
            path="permissions.codexSandboxMode"
            {...rowProps}
          >
            <CustomSelect
              id="codex-sandbox-mode"
              value={permissions.codexSandboxMode}
              onChange={(v) => onUpdate("permissions.codexSandboxMode", v)}
              schemaPath="permissions.codexSandboxMode"
              options={toSelectOptions(
                CODEX_SANDBOX_MODE_OPTIONS_META,
                "permissions.codexSandboxMode"
              )}
            />
          </SettingInputRow>
          <SettingInputRow
            label="Approval policy"
            id="codex-approval-policy"
            path="permissions.codexApprovalPolicy"
            {...rowProps}
          >
            <CustomSelect
              id="codex-approval-policy"
              value={permissions.codexApprovalPolicy}
              onChange={(v) => onUpdate("permissions.codexApprovalPolicy", v)}
              schemaPath="permissions.codexApprovalPolicy"
              options={toSelectOptions(
                CODEX_APPROVAL_POLICY_OPTIONS_META,
                "permissions.codexApprovalPolicy"
              )}
            />
          </SettingInputRow>
        </div>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Antigravity CLI
        </h3>
        <p className="text-xs text-description-fg">
          Antigravity CLI uses permission modes only: Allow All passes
          --dangerously-skip-permissions, Custom passes --sandbox, and
          individual allow/deny tool patterns are ignored.
        </p>
      </div>
    </div>
  );
}
