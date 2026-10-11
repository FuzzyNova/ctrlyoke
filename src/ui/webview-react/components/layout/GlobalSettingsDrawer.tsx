import {
  GLOBAL_SETTINGS_TABS,
  KEYBOARD_KEYS,
  DASHBOARD_HOST_CAPABILITIES,
} from "@root/types/DashboardConstants";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import { openSettingsFile } from "@utils/contextReferenceActions";
import { GlobalSettingsVerticalTabBar } from "./GlobalSettingsVerticalTabBar";
import { SettingsSearchBar } from "./SettingsSearchBar";
import { useSettingsSearch } from "@hooks/useSettingsSearch";
import { SettingsSearchContext } from "../settings/SettingsSearchContext";
import {
  ALL_TABS,
  type GlobalSettingsTab,
  type SettingsTab,
} from "../settings/settingsTabs";
import {
  GeneralSection,
  WorkflowDefaultsSection,
  AdvancedPermissionsSection,
  ExecutionSection,
  WorktreesSection,
  TerminalSection,
  QueueSection,
  CoordinationSection,
  ServerSection,
  LicenseSection,
  NotificationsSection,
  DeveloperSection,
  AgentSkillsManagerSection,
  McpManagerSection,
  LanguageServersSection,
  CommitSection,
  SecretsSection,
  StatusLineSection,
} from "../settings";
import { StatsUsageSection } from "../settings/stats/StatsUsageSection";
import { ExitButton, ScopeToggle, SETTING_SCOPE_OPTIONS } from "../shared";
import { IconToggleButton } from "../shared/IconToggleButton";
import { Icon } from "../shared/Icon";
import { DRAWER_PAGES, type DrawerPage } from "@/types/drawerPages";
import { isFindShortcut } from "@utils/findShortcut";
import { SETTINGS_CATALOG_ENTRIES } from "../settings/settingsCatalog";

export function GlobalSettingsDrawer() {
  const canReloadHost = useUiStore((state) =>
    state.hostCapabilities.includes(DASHBOARD_HOST_CAPABILITIES.reloadHost)
  );
  const vscode = useVsCodeApi();
  const globalSettingsOpen = useUiStore((s) => s.globalSettingsOpen);
  const activeTab = useUiStore((s) => s.globalSettingsActiveTab);
  const setActiveTab = useUiStore((s) => s.setGlobalSettingsTab);
  const closeGlobalSettings = useUiStore((s) => s.closeGlobalSettings);
  const fullSettings = useSettingsStore((s) => s.fullGlobalSettings);
  const globalSettingsReadOnly = useSettingsStore(
    (s) => s.globalSettingsReadOnly
  );
  const serverRunning = useSettingsStore((s) => s.serverRunning);
  const dev = useSettingsStore((s) => s.dev);
  const [activePage, setActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [drawerRef, isNarrow] = useElementNarrow(580);
  const drawerElementRef = useRef<HTMLDivElement | null>(null);
  const mergedDrawerRef = useCallback(
    (node: HTMLDivElement | null) => {
      drawerElementRef.current = node;
      drawerRef(node);
    },
    [drawerRef]
  );
  const [activeScope, setActiveScope] = useState<SettingWriteScope>(
    SETTING_SCOPES.USER
  );
  const [shouldRender, setShouldRender] = useState(globalSettingsOpen);
  // Drives the slide transform separately from `globalSettingsOpen` so a fresh
  // mount first paints off-screen (translate-y-full) and only then slides in.
  const [isSlidIn, setIsSlidIn] = useState(false);
  const visibleTabs = ALL_TABS.filter(
    (t: SettingsTab) => !t.devOnly || dev?.enabled
  );
  const effectiveActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? (activeTab as GlobalSettingsTab)
    : GLOBAL_SETTINGS_TABS.GENERAL;
  const settingsSearch = useSettingsSearch({
    devEnabled: dev?.enabled ?? false,
    activeTab: effectiveActiveTab,
    activePage,
    onTabChange: setActiveTab,
    onPageChange: setActivePage,
  });
  const { close: closeSearch } = settingsSearch;
  const { isOpen: searchIsOpen, open: openSearch } = settingsSearch;
  const hasSearchQuery = settingsSearch.query.trim().length > 0;
  const hasNoSearchMatches =
    hasSearchQuery && settingsSearch.result.matches.length === 0;
  const closeSettingsSearch = useCallback(() => {
    closeSearch();
    window.requestAnimationFrame(() => {
      document
        .getElementById("settings-search-toggle")
        ?.querySelector("button")
        ?.focus();
    });
  }, [closeSearch]);
  const noSearchMatchesNotice = hasNoSearchMatches && (
    <div role="status" className="px-4 pt-3 text-sm text-description-fg">
      No settings match “{settingsSearch.query}”
    </div>
  );
  const isFullWidthSettingsTab =
    effectiveActiveTab === GLOBAL_SETTINGS_TABS.MCP_MANAGER ||
    effectiveActiveTab === GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS;

  useEffect(() => {
    if (!globalSettingsOpen) closeSearch();
  }, [globalSettingsOpen, closeSearch]);

  useEffect(() => {
    if (!globalSettingsOpen) return;
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".cm-editor")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (searchIsOpen) {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else {
        openSearch();
      }
    };
    window.addEventListener("keydown", handleFindShortcut, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleFindShortcut, {
        capture: true,
      });
  }, [globalSettingsOpen, searchIsOpen, openSearch]);

  useEffect(() => {
    if (!globalSettingsOpen) {
      setIsSlidIn(false);
      return;
    }
    if (!shouldRender) {
      setShouldRender(true);
      return;
    }
    // The drawer is now mounted at translate-y-full. Wait two frames so that
    // off-screen position is actually painted before flipping to translate-y-0;
    // otherwise the browser coalesces both styles and the drawer pops in.
    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => setIsSlidIn(true));
    });
    return () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
    };
  }, [globalSettingsOpen, shouldRender]);

  useEffect(() => {
    if (globalSettingsOpen || !shouldRender) return;

    const timer = window.setTimeout(() => setShouldRender(false), 220);
    return () => window.clearTimeout(timer);
  }, [globalSettingsOpen, shouldRender]);

  // Load settings when opened
  useEffect(() => {
    if (globalSettingsOpen) {
      vscode.postMessage({ type: MESSAGE_TYPES.GLOBAL_SETTINGS_LOAD_REQUEST });
    }
  }, [globalSettingsOpen, vscode]);

  // Escape key to close
  useEffect(() => {
    if (!globalSettingsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== KEYBOARD_KEYS.ESCAPE) return;
      e.preventDefault();
      if (settingsSearch.isOpen) closeSettingsSearch();
      else closeGlobalSettings();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    globalSettingsOpen,
    closeGlobalSettings,
    closeSettingsSearch,
    settingsSearch.isOpen,
  ]);

  useEffect(() => {
    if (!globalSettingsOpen || !settingsSearch.isOpen || !fullSettings) return;
    if (!settingsSearch.activeMatchId) return;
    const frame = window.requestAnimationFrame(() => {
      const root = drawerElementRef.current;
      if (!root) return;
      const activeMatchId = settingsSearch.activeMatchId;
      if (!activeMatchId) return;
      const findById = (id: string): HTMLElement | undefined =>
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-settings-search-id]")
        ).find((element) => element.dataset.settingsSearchId === id);
      const entry = SETTINGS_CATALOG_ENTRIES.find(
        (candidate) => candidate.id === activeMatchId
      );
      const target =
        findById(activeMatchId) ??
        (entry?.revealedBy ? findById(entry.revealedBy) : undefined);
      if (target) {
        target.scrollIntoView({ block: "nearest" });
        return;
      }
      const contentScroller = root.querySelector<HTMLElement>(
        "[data-settings-content-scroll]"
      );
      if (contentScroller) contentScroller.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    settingsSearch.activeMatchId,
    effectiveActiveTab,
    activePage,
    fullSettings,
    globalSettingsOpen,
    settingsSearch.isOpen,
  ]);

  if (!shouldRender) {
    return null;
  }

  function handleUpdate(path: string, value: unknown) {
    if (globalSettingsReadOnly) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path,
      value,
      scope: activeScope,
    });
  }

  function handleReset(path: string) {
    if (globalSettingsReadOnly) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path,
      value: undefined,
      scope: activeScope,
    });
  }

  function handleReloadWindow() {
    if (!canReloadHost) {
      window.location.reload();
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.RELOAD_WINDOW });
  }

  const sectionProps = {
    activeScope,
    onUpdate: handleUpdate,
    onReset: handleReset,
  };

  return (
    <div
      ref={mergedDrawerRef}
      className={`absolute inset-0 flex flex-col z-drawer bg-panel-bg border-t border-panel-border
        transition-transform duration-200 ease-out
        ${isSlidIn ? "translate-y-0" : "translate-y-full pointer-events-none"}`}
      aria-hidden={!globalSettingsOpen}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "transform" &&
          !globalSettingsOpen
        ) {
          setShouldRender(false);
        }
      }}
    >
      {/* Title bar — always visible, never scrolls */}
      <div className="flex items-center justify-between px-2 h-[30px] border-b border-panel-border shrink-0">
        <div className="flex items-center gap-1 text-description-fg">
          <Icon name="settings-gear" className="text-sm" />
          <span className="text-sm font-semibold uppercase tracking-wide ml-0.5">
            Settings
          </span>

          {/* Scope toggle */}
          <ScopeToggle
            className="ml-2"
            ariaLabel="Settings scope"
            value={activeScope}
            onChange={setActiveScope}
            iconOnly={isNarrow}
            options={SETTING_SCOPE_OPTIONS}
          />
        </div>

        <div className="flex items-center gap-1">
          <span id="settings-search-toggle">
            <IconToggleButton
              active={settingsSearch.isOpen}
              onToggle={settingsSearch.toggle}
              activeIcon="search"
              inactiveIcon="search"
              activeTooltip="Close search"
              inactiveTooltip="Search settings (Ctrl+F)"
              ariaLabel="Search settings"
            />
          </span>
          <button
            type="button"
            className="icon-btn py-1 px-1"
            title="Open settings file"
            aria-label="Open settings file"
            onClick={() => openSettingsFile(activeScope, vscode)}
          >
            <Icon name="go-to-file" className="codicon-lg" />
          </button>

          <ExitButton
            onClick={closeGlobalSettings}
            title="Close Global Settings"
            aria-label="Close Global Settings"
          />
        </div>
      </div>

      {settingsSearch.isOpen && (
        <SettingsSearchBar
          query={settingsSearch.query}
          matchCount={settingsSearch.result.matches.length}
          activeMatch={
            settingsSearch.activeMatchId
              ? settingsSearch.result.matches.findIndex(
                  (entry) => entry.id === settingsSearch.activeMatchId
                ) + 1
              : 0
          }
          isNarrow={isNarrow}
          onQueryChange={settingsSearch.setQuery}
          onNavigate={settingsSearch.navigate}
          onClose={closeSettingsSearch}
          inputRef={searchInputRef}
        />
      )}

      {globalSettingsReadOnly && (
        <div
          role="status"
          className={`absolute z-10 ${settingsSearch.isOpen ? "top-[64px]" : "top-[30px]"} inset-x-0 bg-warning/15 border-b border-warning px-3 py-2 text-sm`}
        >
          These settings use a newer format. Update ctrlyoke to edit them.
        </div>
      )}
      <fieldset
        disabled={globalSettingsReadOnly}
        className="flex flex-1 min-h-0 min-w-0 border-0 p-0 m-0"
      >
        {/* `min-w-0` is load-bearing: without it this row's automatic minimum
            width is its content's min-content width, so a single wide child
            in any section (a long select label, an unbreakable value)
            widens the whole page past the drawer instead of wrapping or
            scrolling inside its own control. */}
        <div className="flex flex-1 min-h-0 min-w-0">
          {/* Left: vertical tab bar */}
          <GlobalSettingsVerticalTabBar
            tabs={visibleTabs.map((t) => ({
              ...t,
              ...(t.id === GLOBAL_SETTINGS_TABS.SERVER
                ? { indicator: serverRunning }
                : {}),
              ...(hasSearchQuery
                ? {
                    matchCount:
                      settingsSearch.result.countsByTab.get(t.id) ?? 0,
                  }
                : {}),
            }))}
            activeTab={effectiveActiveTab}
            onTabChange={setActiveTab}
            iconOnly={isNarrow}
          />

          <SettingsSearchContext.Provider
            value={{
              tokens: settingsSearch.result.tokens,
              matchIds: settingsSearch.result.matchIds,
              activeMatchId: settingsSearch.activeMatchId,
            }}
          >
            {/* Right: section content.
            The "workflow" tab renders WorkflowDefaultsSection which owns its
            own scrolling and uses h-full + DrawerTabBar pinned at the bottom.
            It must be a direct flex child so h-full resolves to a definite
            size. MCP also gets the full available width so its wide layout can
            use equal columns; all other tabs use the standard width cap. */}
            {fullSettings &&
            effectiveActiveTab === GLOBAL_SETTINGS_TABS.WORKFLOW ? (
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {noSearchMatchesNotice}
                <WorkflowDefaultsSection
                  settings={fullSettings}
                  activePage={activePage}
                  onPageChange={setActivePage}
                  countsByPage={settingsSearch.result.countsByPage}
                  searchActive={hasSearchQuery}
                  {...sectionProps}
                />
              </div>
            ) : (
              <div
                data-settings-content-scroll
                className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden"
              >
                {noSearchMatchesNotice}
                <div
                  className={`p-4 ${
                    isFullWidthSettingsTab ? "max-w-none" : "max-w-2xl"
                  }`}
                >
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.GENERAL && (
                      <GeneralSection
                        settings={fullSettings}
                        {...sectionProps}
                        onReload={handleReloadWindow}
                      />
                    )}
                  {effectiveActiveTab === GLOBAL_SETTINGS_TABS.LICENSE && (
                    <LicenseSection />
                  )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.STATS && (
                      <StatsUsageSection
                        showCostEstimates={
                          fullSettings.settings.ui.showCostEstimates
                        }
                        isNarrow={isNarrow}
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.STATUS_LINE && (
                      <StatusLineSection settings={fullSettings} />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.PERMISSIONS && (
                      <AdvancedPermissionsSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.SECRETS && (
                      <SecretsSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.EXECUTION && (
                      <ExecutionSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.WORKTREES && (
                      <WorktreesSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab ===
                      GLOBAL_SETTINGS_TABS.NOTIFICATIONS && (
                      <NotificationsSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.TERMINAL && (
                      <TerminalSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.QUEUE && (
                      <QueueSection settings={fullSettings} {...sectionProps} />
                    )}
                  {fullSettings &&
                    effectiveActiveTab ===
                      GLOBAL_SETTINGS_TABS.COORDINATION && (
                      <CoordinationSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.SERVER && (
                      <ServerSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {effectiveActiveTab ===
                    GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER && (
                    <AgentSkillsManagerSection activeScope={activeScope} />
                  )}
                  {effectiveActiveTab === GLOBAL_SETTINGS_TABS.MCP_MANAGER && (
                    <McpManagerSection activeScope={activeScope} />
                  )}
                  {effectiveActiveTab ===
                    GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS && (
                    <LanguageServersSection activeScope={activeScope} />
                  )}
                  {fullSettings &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.COMMIT && (
                      <CommitSection
                        settings={fullSettings}
                        {...sectionProps}
                      />
                    )}
                  {dev?.enabled &&
                    effectiveActiveTab === GLOBAL_SETTINGS_TABS.DEVELOPER && (
                      <DeveloperSection />
                    )}
                  {!fullSettings &&
                    effectiveActiveTab !== GLOBAL_SETTINGS_TABS.DEVELOPER &&
                    effectiveActiveTab !==
                      GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER &&
                    effectiveActiveTab !== GLOBAL_SETTINGS_TABS.MCP_MANAGER &&
                    effectiveActiveTab !==
                      GLOBAL_SETTINGS_TABS.LANGUAGE_SERVERS && (
                      <div className="text-description-fg text-sm">
                        Loading settings…
                      </div>
                    )}
                </div>
              </div>
            )}
          </SettingsSearchContext.Provider>
        </div>
      </fieldset>
    </div>
  );
}
