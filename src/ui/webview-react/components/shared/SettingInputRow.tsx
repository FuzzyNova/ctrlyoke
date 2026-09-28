import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import type { ReactNode } from "react";
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
import { useSettingMatch } from "@components/settings/SettingsSearchContext";
import { HighlightedText } from "./HighlightedText";

interface Props {
  label?: string;
  description?: string;
  id?: string;
  path?: string;
  settingKey?: SettingsCatalogKey;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: SettingWriteScope;
  children: ReactNode;
}

export function SettingInputRow({
  label,
  description,
  id,
  path,
  settingKey,
  sources,
  onReset,
  activeScope,
  children,
}: Props) {
  const entry: SettingsCatalogEntry | undefined = settingKey
    ? SETTINGS_CATALOG[settingKey]
    : undefined;
  const resolvedLabel = entry?.label ?? label ?? "";
  const resolvedDescription = description ?? entry?.description;
  const resolvedPath = entry?.path ?? (settingKey ? undefined : path);
  const { isMatch, isActive, tokens } = useSettingMatch(settingKey);
  const source = resolvedPath && sources ? sources[resolvedPath] : undefined;
  const canReset =
    source !== undefined &&
    source !== INHERIT_DEFAULT_OPTION &&
    source === activeScope;

  return (
    <div
      className={`group${isMatch ? " rounded-sm bg-list-hover-bg/50" : ""}${isActive ? " outline outline-1 outline-focus-border" : ""}`}
      data-settings-search-id={entry?.id}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <label
          htmlFor={id}
          title={resolvedPath ? schemaTitle(resolvedPath) : resolvedDescription}
          className="text-xs text-description-fg"
        >
          <HighlightedText text={resolvedLabel} tokens={tokens} />
          {resolvedPath && (
            <span className="sr-only">
              {schemaAriaLabel(resolvedLabel, resolvedPath).slice(
                resolvedLabel.length
              )}
            </span>
          )}
        </label>
        {source && source !== INHERIT_DEFAULT_OPTION && (
          <SettingSourceBadge source={source} />
        )}
        {onReset && resolvedPath && (
          <button
            type="button"
            aria-label={`Reset ${resolvedLabel}`}
            onClick={() => {
              if (canReset) onReset(resolvedPath);
            }}
            disabled={!canReset}
            title={
              canReset
                ? "Reset to default"
                : source
                  ? `Defined in ${source} config`
                  : undefined
            }
            className={`w-4 h-4 flex items-center justify-center rounded text-description-fg hover:text-foreground transition-opacity ${
              canReset
                ? "opacity-0 group-hover:opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
          >
            <Icon name="discard" className="text-xxs" />
          </button>
        )}
      </div>
      {children}
      {resolvedDescription && (
        <p className="text-xs text-description-fg mt-1">
          <HighlightedText text={resolvedDescription} tokens={tokens} />
        </p>
      )}
    </div>
  );
}
