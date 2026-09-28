import { createContext, useContext } from "react";
import type { SettingsCatalogKey } from "./settingsCatalog";

interface SettingsSearchContextValue {
  tokens: readonly string[];
  matchIds: ReadonlySet<string>;
  activeMatchId: string | null;
}

const INACTIVE_SETTINGS_SEARCH: SettingsSearchContextValue = {
  tokens: [],
  matchIds: new Set(),
  activeMatchId: null,
};

export const SettingsSearchContext = createContext<SettingsSearchContextValue>(
  INACTIVE_SETTINGS_SEARCH
);

export function useSettingMatch(settingKey?: SettingsCatalogKey) {
  const { tokens, matchIds, activeMatchId } = useContext(SettingsSearchContext);
  const id = settingKey;
  const isMatch = !!id && matchIds.has(id);
  return {
    isMatch,
    isActive: isMatch && activeMatchId === id,
    tokens: isMatch ? tokens : [],
  };
}
