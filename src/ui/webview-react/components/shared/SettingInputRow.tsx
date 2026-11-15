import type { ReactNode } from "react";
import type {
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SettingSourceBadge } from "./SettingSourceBadge";
import {
  hasSettingSourceBadge,
  SettingResetButton,
} from "./SettingResetButton";
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

  return (
    <div
      className={`group${isMatch ? " rounded-xs bg-list-hover-bg/50" : ""}${isActive ? " outline-solid outline-1 outline-focus-border" : ""}`}
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
        {hasSettingSourceBadge(source) && (
          <SettingSourceBadge source={source} />
        )}
        {onReset && resolvedPath && (
          <SettingResetButton
            label={resolvedLabel}
            path={resolvedPath}
            source={source}
            activeScope={activeScope}
            onReset={onReset}
          />
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
