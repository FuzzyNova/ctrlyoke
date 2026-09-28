import { DRAWER_TABS } from "@/types/drawerPages";
import type { GlobalSettingsTab } from "@root/types/DashboardConstants";
import type { DrawerPage } from "@/types/drawerPages";
import { ALL_TABS } from "./settingsTabs";
import {
  SETTINGS_CATALOG_ENTRIES,
  type SettingsCatalogEntry,
} from "./settingsCatalog";

export interface SettingsSearchResult {
  tokens: readonly string[];
  matches: readonly SettingsCatalogEntry[];
  matchIds: ReadonlySet<string>;
  countsByTab: ReadonlyMap<GlobalSettingsTab, number>;
  countsByPage: ReadonlyMap<DrawerPage, number>;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.\-_\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettingsCatalog(
  query: string,
  opts: { devEnabled: boolean }
): SettingsSearchResult {
  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery ? normalizedQuery.split(" ") : [];
  const tabOrder = new Map(ALL_TABS.map((tab, index) => [tab.id, index]));
  const pageOrder = new Map(DRAWER_TABS.map((tab, index) => [tab.id, index]));
  const entries = SETTINGS_CATALOG_ENTRIES.map((entry, index) => ({
    entry,
    index,
  }));
  const matches =
    tokens.length === 0
      ? []
      : entries
          .filter(({ entry }) => !entry.devOnly || opts.devEnabled)
          .filter(({ entry }) => {
            const tabLabel =
              ALL_TABS.find((tab) => tab.id === entry.tab)?.label ?? "";
            const pageLabel = entry.page
              ? (DRAWER_TABS.find((tab) => tab.id === entry.page)?.label ?? "")
              : "";
            const haystack = normalize(
              [
                entry.label,
                entry.description,
                entry.context,
                entry.path,
                ...(entry.keywords ?? []),
                tabLabel,
                pageLabel,
              ]
                .filter(Boolean)
                .join(" ")
            );
            return tokens.every((token) => haystack.includes(token));
          })
          .sort(
            (a, b) =>
              (tabOrder.get(a.entry.tab) ?? Number.MAX_SAFE_INTEGER) -
                (tabOrder.get(b.entry.tab) ?? Number.MAX_SAFE_INTEGER) ||
              (pageOrder.get(a.entry.page as DrawerPage) ?? -1) -
                (pageOrder.get(b.entry.page as DrawerPage) ?? -1) ||
              a.index - b.index
          )
          .map(({ entry }) => entry);
  const countsByTab = new Map<GlobalSettingsTab, number>();
  const countsByPage = new Map<DrawerPage, number>();
  for (const entry of matches) {
    countsByTab.set(entry.tab, (countsByTab.get(entry.tab) ?? 0) + 1);
    if (entry.page)
      countsByPage.set(entry.page, (countsByPage.get(entry.page) ?? 0) + 1);
  }
  return {
    tokens,
    matches,
    matchIds: new Set(matches.map((entry) => entry.id)),
    countsByTab,
    countsByPage,
  };
}
