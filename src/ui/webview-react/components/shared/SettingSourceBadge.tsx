import type { SettingSource } from "@root/types/WebviewMessageTypes";

interface Props {
  source: SettingSource;
}

export function SettingSourceBadge({ source }: Props) {
  if (source === "default") return null;

  const isWorkspace = source === "workspace";
  return (
    <span
      className={`inline-flex items-center px-1 py-0 text-xxs font-mono rounded border leading-[14px] ${
        isWorkspace
          ? "text-scope-workspace border-scope-workspace/50 bg-scope-workspace/10"
          : "text-scope-user border-scope-user/50 bg-scope-user/10"
      }`}
      title={isWorkspace ? "Set in workspace config" : "Set in user config"}
    >
      {isWorkspace ? "ws" : "user"}
    </span>
  );
}
