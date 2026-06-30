import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import type { UserHookConfig } from "@root/types/CtrlYokeTypes";
import { HooksEditor } from "../../editor/HooksEditor";
import { SettingInputRow } from "../../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

export function DefaultsHooksPage({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const hooks = settings.settings.defaults.hooks as UserHookConfig[];
  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-4">
      <SettingInputRow
        label="Default hooks"
        description="Hooks defined here run for all workflows by default."
        path="defaults.hooks"
        {...rowProps}
      >
        <HooksEditor
          value={hooks.length > 0 ? (hooks as object[]) : null}
          onChange={(value) => onUpdate("defaults.hooks", value ?? [])}
          showDefault={false}
        />
      </SettingInputRow>
    </div>
  );
}
