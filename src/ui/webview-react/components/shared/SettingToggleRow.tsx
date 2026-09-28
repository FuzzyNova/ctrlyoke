import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SettingSourceBadge } from "./SettingSourceBadge";
import { Icon } from "./Icon";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import {
  SETTINGS_CATALOG,
  type SettingsCatalogEntry,
  type SettingsCatalogKey,
} from "@components/settings/settingsCatalog";

interface Props {
  label?: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // Optional badge + reset
  path?: string;
  settingKey?: SettingsCatalogKey;
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
  settingKey,
  sources,
  onReset,
  activeScope,
}: Props) {
  const entry: SettingsCatalogEntry | undefined = settingKey
    ? SETTINGS_CATALOG[settingKey]
    : undefined;
  const resolvedLabel = entry?.label ?? label ?? "";
  const resolvedDescription = description ?? entry?.description;
  const resolvedPath = entry?.path ?? (settingKey ? undefined : path);
  const source = resolvedPath && sources ? sources[resolvedPath] : undefined;
  const canReset =
    source !== undefined &&
    source !== INHERIT_DEFAULT_OPTION &&
    source === activeScope;

  return (
    <label
      data-settings-search-id={entry?.id}
      title={resolvedPath ? schemaTitle(resolvedPath) : resolvedDescription}
      className={`flex items-start gap-3 py-2 group ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        aria-label={
          resolvedPath
            ? schemaAriaLabel(resolvedLabel, resolvedPath)
            : undefined
        }
        title={resolvedPath ? schemaTitle(resolvedPath) : undefined}
        className={`mt-0.5 w-4 h-4 accent-focus-border shrink-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      />
      <span className="flex flex-col flex-1 min-w-0">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm text-foreground">{resolvedLabel}</span>
          {source && source !== INHERIT_DEFAULT_OPTION && (
            <SettingSourceBadge source={source} />
          )}
        </span>
        {resolvedDescription && (
          <span className="text-xs text-description-fg mt-0.5">
            {resolvedDescription}
          </span>
        )}
      </span>
      {onReset && resolvedPath && (
        <button
          type="button"
          aria-label={`Reset ${resolvedLabel}`}
          onClick={(e) => {
            e.preventDefault();
            if (canReset) onReset(resolvedPath);
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
