import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SettingSourceBadge } from "./SettingSourceBadge";
import { Icon } from "./Icon";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";

interface Props {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // Optional badge + reset
  path?: string;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: SettingWriteScope;
}

export function SettingToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  path,
  sources,
  onReset,
  activeScope,
}: Props) {
  const source = path && sources ? sources[path] : undefined;
  const canReset =
    source !== undefined &&
    source !== INHERIT_DEFAULT_OPTION &&
    source === activeScope;

  return (
    <label
      title={path ? schemaTitle(path) : description}
      className={`flex items-start gap-3 py-2 group ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        aria-label={path ? schemaAriaLabel(label, path) : undefined}
        title={path ? schemaTitle(path) : undefined}
        className={`mt-0.5 w-4 h-4 accent-focus-border shrink-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
      <span className="flex flex-col flex-1 min-w-0">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-foreground">{label}</span>
          {source && source !== INHERIT_DEFAULT_OPTION && (
            <SettingSourceBadge source={source} />
          )}
        </span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">
            {description}
          </span>
        )}
      </span>
      {onReset && path && (
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
              ? `Reset to default`
              : source
                ? `Defined in ${source} config`
                : undefined
          }
          className={`shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center rounded text-description-fg hover:text-foreground transition-opacity ${
            canReset
              ? "opacity-0 group-hover:opacity-100"
              : "opacity-0 pointer-events-none"
          }`}
        >
          <Icon name="discard" className="text-xxs" />
        </button>
      )}
    </label>
  );
}
