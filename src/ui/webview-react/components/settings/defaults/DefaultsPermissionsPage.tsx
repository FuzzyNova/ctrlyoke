import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../../shared/CustomSelect";
import { LocalTextarea } from "../../shared/LocalInputs";
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
  const rowProps = { sources, onReset, activeScope };

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
        <LocalTextarea
          id="defaults-allowed-tools"
          rows={3}
          value={toolPermissions.allowedTools.join("\n")}
          onCommit={(v) =>
            onUpdate(
              "defaults.toolPermissions.allowedTools",
              v
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean)
            )
          }
          placeholder={"read\nglob\ngrep"}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
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
        <LocalTextarea
          id="defaults-denied-tools"
          rows={3}
          value={toolPermissions.deniedTools.join("\n")}
          onCommit={(v) =>
            onUpdate(
              "defaults.toolPermissions.deniedTools",
              v
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean)
            )
          }
          placeholder={"shell(rm:*)\nwrite"}
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-focus-border resize-none font-mono"
        />
        <PermissionCapabilitySummary
          id="defaults-denied-tools-diagnostic"
          field="deniedTools"
        />
      </SettingInputRow>
    </div>
  );
}
