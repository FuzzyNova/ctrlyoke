import type { FullGlobalSettings, SettingSource } from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: "workspace" | "user";
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const PERMISSION_MODE_OPTIONS = [
  { value: "allowAll", label: "Allow All" },
  { value: "dangerouslyAllowAll", label: "Dangerously Allow All" },
  { value: "custom", label: "Custom" },
];

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

export function PermissionsSection({ settings, activeScope, onUpdate, onReset }: Props) {
  const tools = settings.settings.tools;
  const sources = settings.sources as Record<string, SettingSource>;

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Permission Mode
        </h3>
        <CustomSelect
          value={tools.permissionMode}
          onChange={(v) => onUpdate("tools.permissionMode", v)}
          options={PERMISSION_MODE_OPTIONS}
        />
      </div>
      <div className="space-y-3 mt-2">
        <div>
          <label
            htmlFor="tools-allowed"
            className="block text-xs text-description-fg mb-1"
          >
            Allowed tools (one per line)
          </label>
          <textarea
            id="tools-allowed"
            rows={3}
            value={tools.allowed.join("\n")}
            onChange={(e) =>
              onUpdate(
                "tools.allowed",
                e.target.value
                  .split("\n")
                  .map((t) => t.trim())
                  .filter(Boolean)
              )
            }
            placeholder={"read\nglob\ngrep"}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
          />
        </div>
        <div>
          <label
            htmlFor="tools-denied"
            className="block text-xs text-description-fg mb-1"
          >
            Denied tools (one per line)
          </label>
          <textarea
            id="tools-denied"
            rows={3}
            value={tools.denied.join("\n")}
            onChange={(e) =>
              onUpdate(
                "tools.denied",
                e.target.value
                  .split("\n")
                  .map((t) => t.trim())
                  .filter(Boolean)
              )
            }
            placeholder={"shell(rm:*)\nwrite"}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
          />
        </div>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Allowed Directories
        </h3>
        <div>
          <label
            htmlFor="allowed-dirs"
            className="block text-xs text-description-fg mb-1"
          >
            Additional directories (one per line)
          </label>
          <textarea
            id="allowed-dirs"
            rows={3}
            value={tools.allowedDirs.join("\n")}
            onChange={(e) =>
              onUpdate(
                "tools.allowedDirs",
                e.target.value
                  .split("\n")
                  .map((d) => d.trim())
                  .filter(Boolean)
              )
            }
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
          />
          <p className="text-xs text-description-fg mt-1">
            Applies to copilot-cli, claude-cli, codex-cli, and qwen-cli. Not
            supported by gemini-cli, opencode-cli, or copilot-chat.
          </p>
        </div>
      </div>
      <div className="border-t border-panel-border pt-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Copilot CLI
        </h3>
        <SettingToggleRow
          label="Allow all paths"
          description="Allow the Copilot CLI to access all file paths."
          checked={tools.copilotAllowAllPaths}
          onChange={(v) => onUpdate("tools.copilotAllowAllPaths", v)}
          path="tools.copilotAllowAllPaths"
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
          <div>
            <label
              htmlFor="codex-sandbox-mode"
              className="block text-xs text-description-fg mb-1"
            >
              Sandbox mode
            </label>
            <CustomSelect
              id="codex-sandbox-mode"
              value={tools.codexSandboxMode}
              onChange={(v) => onUpdate("tools.codexSandboxMode", v)}
              options={CODEX_SANDBOX_OPTIONS}
            />
          </div>
          <div>
            <label
              htmlFor="codex-approval-policy"
              className="block text-xs text-description-fg mb-1"
            >
              Approval policy
            </label>
            <CustomSelect
              id="codex-approval-policy"
              value={tools.codexApprovalPolicy}
              onChange={(v) => onUpdate("tools.codexApprovalPolicy", v)}
              options={CODEX_APPROVAL_OPTIONS}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
