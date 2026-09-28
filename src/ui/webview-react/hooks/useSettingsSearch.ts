import { useCallback, useMemo, useState } from "react";
import { GLOBAL_SETTINGS_TABS } from "@root/types/DashboardConstants";
import {
  ALL_TABS,
  type GlobalSettingsTab,
} from "@components/settings/settingsTabs";
import type { DrawerPage } from "@/types/drawerPages";
import { searchSettingsCatalog } from "@components/settings/settingsSearch";

interface UseSettingsSearchOptions {
  devEnabled: boolean;
  activeTab: GlobalSettingsTab;
  activePage: DrawerPage;
  onTabChange: (tab: GlobalSettingsTab) => void;
  onPageChange: (page: DrawerPage) => void;
}

export function useSettingsSearch({
  devEnabled,
  activeTab,
  activePage,
  onTabChange,
  onPageChange,
}: UseSettingsSearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryValue] = useState("");
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const result = useMemo(
    () => searchSettingsCatalog(query, { devEnabled }),
    [query, devEnabled]
  );

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryValue(nextQuery);
      const nextResult = searchSettingsCatalog(nextQuery, { devEnabled });
      if (nextResult.matches.some((entry) => entry.id === activeMatchId))
        return;

      const matchesCurrentLocation = nextResult.matches.filter(
        (entry) =>
          entry.tab === activeTab &&
          (activeTab !== GLOBAL_SETTINGS_TABS.WORKFLOW ||
            entry.page === activePage)
      );
      if (matchesCurrentLocation.length > 0) {
        setActiveMatchId(matchesCurrentLocation[0].id);
        return;
      }

      if (nextResult.matches.length === 0) {
        setActiveMatchId(null);
        return;
      }

      const visibleTabs = ALL_TABS.filter(
        (tab) => !("devOnly" in tab && tab.devOnly) || devEnabled
      );
      const currentIndex = visibleTabs.findIndex((tab) => tab.id === activeTab);
      const nextTabMatch = Array.from(
        { length: visibleTabs.length },
        (_, offset) =>
          visibleTabs[(currentIndex + offset + 1) % visibleTabs.length]
      )
        .map((tab) => nextResult.matches.find((entry) => entry.tab === tab.id))
        .find((entry) => entry !== undefined);

      if (nextTabMatch) {
        setActiveMatchId(nextTabMatch.id);
        onTabChange(nextTabMatch.tab);
        if (nextTabMatch.page) onPageChange(nextTabMatch.page);
      } else {
        setActiveMatchId(null);
      }
    },
    [
      activeMatchId,
      activePage,
      activeTab,
      devEnabled,
      onPageChange,
      onTabChange,
    ]
  );

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setQueryValue("");
    setActiveMatchId(null);
  }, []);
  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [close, isOpen, open]);
  const navigate = useCallback(
    (direction: 1 | -1) => {
      const matches = result.matches;
      if (matches.length === 0) return;
      const currentIndex = matches.findIndex(
        (entry) => entry.id === activeMatchId
      );
      const targetIndex =
        currentIndex < 0
          ? direction === 1
            ? 0
            : matches.length - 1
          : (currentIndex + direction + matches.length) % matches.length;
      const target = matches[targetIndex];
      setActiveMatchId(target.id);
      if (target.tab !== activeTab) onTabChange(target.tab);
      if (target.page && target.page !== activePage) onPageChange(target.page);
    },
    [
      activeMatchId,
      activePage,
      activeTab,
      onPageChange,
      onTabChange,
      result.matches,
    ]
  );

  return {
    isOpen,
    query,
    activeMatchId,
    result,
    open,
    close,
    toggle,
    setQuery,
    navigate,
  };
}
