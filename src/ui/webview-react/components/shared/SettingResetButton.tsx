import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { Icon } from "./Icon";

interface Props {
  label: string;
  path: string;
  source?: SettingSource;
  activeScope?: SettingWriteScope;
  onReset: (path: string) => void;
  className?: string;
}

export function hasSettingSourceBadge(
  source: SettingSource | undefined
): source is SettingSource {
  return Boolean(source && source !== INHERIT_DEFAULT_OPTION);
}

export function canResetSetting(
  source: SettingSource | undefined,
  activeScope: SettingWriteScope | undefined
): boolean {
  return (
    source !== undefined &&
    source !== INHERIT_DEFAULT_OPTION &&
    source === activeScope
  );
}

export function SettingResetButton({
  label,
  path,
  source,
  activeScope,
  onReset,
  className,
}: Props) {
  const canReset = canResetSetting(source, activeScope);

  return (
    <button
      type="button"
      aria-label={`Reset ${label}`}
      onClick={(e) => {
        e.preventDefault();
        if (canReset) onReset(path);
      }}
      disabled={!canReset}
      title={
        canReset
          ? "Reset to default"
          : source
            ? `Defined in ${source} config`
            : undefined
      }
      className={`${className ? `${className} ` : ""}w-4 h-4 flex items-center justify-center rounded-sm text-description-fg hover:text-foreground transition-opacity ${
        canReset
          ? "opacity-0 group-hover:opacity-100"
          : "opacity-0 pointer-events-none"
      }`}
    >
      <Icon name="discard" className="text-xxs" />
    </button>
  );
}
