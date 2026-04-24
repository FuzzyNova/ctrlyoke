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
          ? "text-amber-400 border-amber-400/50 bg-amber-400/10"
          : "text-blue-400 border-blue-400/50 bg-blue-400/10"
      }`}
      title={isWorkspace ? "Set in workspace config" : "Set in user config"}
    >
      {isWorkspace ? "ws" : "user"}
    </span>
  );
}
