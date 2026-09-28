import { useCallback, useMemo, useState } from "react";
import { searchSettingsCatalog } from "@components/settings/settingsSearch";

export function useSettingsSearch(devEnabled: boolean) {
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
      setActiveMatchId(nextResult.matches[0]?.id ?? null);
    },
    [devEnabled]
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

  return {
    isOpen,
    query,
    activeMatchId,
    result,
    open,
    close,
    toggle,
    setQuery,
  };
}
