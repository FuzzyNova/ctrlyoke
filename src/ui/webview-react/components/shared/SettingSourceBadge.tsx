import type { SettingSource } from "@root/types/WebviewMessageTypes";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";

interface Props {
  source: SettingSource;
}

export function SettingSourceBadge({ source }: Props) {
  if (source === SETTING_SCOPES.DEFAULT) return null;

  const isWorkspace = source === SETTING_SCOPES.WORKSPACE;
  return (
    <span
      className={`inline-flex items-center px-1 py-0 text-xxs font-mono rounded-sm border leading-[14px] ${
        isWorkspace
          ? "text-scope-workspace border-scope-workspace/50 bg-scope-workspace/10"
          : "text-scope-user border-scope-user/50 bg-scope-user/10"
      }`}
      title={isWorkspace ? "Set in workspace config" : "Set in user config"}
    >
      {isWorkspace ? "workspace" : "user"}
    </span>
  );
}
