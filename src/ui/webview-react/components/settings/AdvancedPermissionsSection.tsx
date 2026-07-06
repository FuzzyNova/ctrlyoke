import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { LocalTextarea } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const CODEX_SANDBOX_OPTIONS = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Danger: Full Access" },
];

const CODEX_APPROVAL_OPTIONS = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-request", label: "On Request" },
  { value: "never", label: "Never" },
];

export function AdvancedPermissionsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const permissions = settings.settings.permissions;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Allowed Directories
        </h3>
        <SettingInputRow
          label="Additional directories (one per line)"
          id="allowed-dirs"
          path="permissions.allowedDirs"
          {...rowProps}
        >
          <LocalTextarea
            id="allowed-dirs"
            rows={3}
            value={permissions.allowedDirs.join("\n")}
            onCommit={(v) =>
              onUpdate(
                "permissions.allowedDirs",
                v
                  .split("\n")
                  .map((d) => d.trim())
                  .filter(Boolean)
              )
            }
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
          />
        </SettingInputRow>
        <p className="text-xs text-description-fg mt-1">
          Applies to copilot-cli, claude-cli, codex-cli, and qwen-cli. Not
          supported by gemini-cli, antigravity-cli, opencode-cli, or
          copilot-chat.
        </p>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Copilot CLI
        </h3>
        <SettingToggleRow
          label="Allow all paths"
          description="Allow the Copilot CLI to access all file paths."
          checked={permissions.copilotAllowAllPaths}
          onChange={(v) => onUpdate("permissions.copilotAllowAllPaths", v)}
          path="permissions.copilotAllowAllPaths"
          {...rowProps}
        />
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
              options={CODEX_SANDBOX_OPTIONS}
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
              options={CODEX_APPROVAL_OPTIONS}
            />
          </SettingInputRow>
        </div>
      </div>
    </div>
  );
}
