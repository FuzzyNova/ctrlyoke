import {
  GLOBAL_SETTINGS_TABS,
  KEYBOARD_KEYS,
} from "@root/types/DashboardConstants";
import { useEffect, useState } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import { openSettingsFile } from "@utils/contextReferenceActions";
import { GlobalSettingsVerticalTabBar } from "./GlobalSettingsVerticalTabBar";
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
  CommitSection,
  SecretsSection,
  StatusLineSection,
} from "../settings";
import { StatsUsageSection } from "../settings/stats/StatsUsageSection";
import { ExitButton, ScopeToggle } from "../shared";
import { Icon } from "../shared/Icon";

const ALL_TABS = [
  // Core
  {
    id: GLOBAL_SETTINGS_TABS.GENERAL,
    label: "General",
    icon: "codicon-settings",
  },
  {
    id: GLOBAL_SETTINGS_TABS.WORKFLOW,
    label: "Workflow Defaults",
    icon: "codicon-globe",
  },
  // Execution
  {
    id: GLOBAL_SETTINGS_TABS.EXECUTION,
    label: "Execution",
    icon: "codicon-play",
  },
  {
    id: GLOBAL_SETTINGS_TABS.QUEUE,
    label: "Queue",
    icon: "codicon-list-ordered",
  },
  {
    id: GLOBAL_SETTINGS_TABS.WORKTREES,
    label: "Worktrees",
    icon: "codicon-source-control",
  },
  {
    id: GLOBAL_SETTINGS_TABS.COORDINATION,
    label: "Coordination",
    icon: "codicon-person-voice",
  },
  // Output
  {
    id: GLOBAL_SETTINGS_TABS.TERMINAL,
    label: "Terminal",
    icon: "codicon-terminal",
  },
  {
    id: GLOBAL_SETTINGS_TABS.STATUS_LINE,
    label: "Status Line",
    icon: "codicon-list-flat",
  },
  {
    id: GLOBAL_SETTINGS_TABS.COMMIT,
    label: "Commit Message",
    icon: "codicon-git-commit",
  },
  // Security
  {
    id: GLOBAL_SETTINGS_TABS.PERMISSIONS,
    label: "Advanced Permissions",
    icon: "codicon-shield",
  },
  { id: GLOBAL_SETTINGS_TABS.SECRETS, label: "Secrets", icon: "codicon-lock" },
  // Integrations
  { id: GLOBAL_SETTINGS_TABS.SERVER, label: "Server", icon: "codicon-server" },
  {
    id: GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER,
    label: "Agent & Skills Manager",
    icon: "codicon-agent",
  },
  {
    id: GLOBAL_SETTINGS_TABS.MCP_MANAGER,
    label: "MCP Manager",
    icon: "codicon-mcp",
  },
  // Insights
  {
    id: GLOBAL_SETTINGS_TABS.NOTIFICATIONS,
    label: "Notifications",
    icon: "codicon-bell",
  },
  {
    id: GLOBAL_SETTINGS_TABS.STATS,
    label: "Stats & Usage",
    icon: "codicon-graph",
  },
  // Account
  { id: GLOBAL_SETTINGS_TABS.LICENSE, label: "License", icon: "codicon-key" },
  // Developer (dev builds only)
  {
    id: GLOBAL_SETTINGS_TABS.DEVELOPER,
    label: "Developer",
    icon: "codicon-tools",
  },
];

const TABS = ALL_TABS;

export function GlobalSettingsDrawer() {
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
  const [drawerRef, isNarrow] = useElementNarrow(580);
  const [activeScope, setActiveScope] = useState<SettingWriteScope>(
    SETTING_SCOPES.USER
  );
  const [shouldRender, setShouldRender] = useState(globalSettingsOpen);
  // Drives the slide transform separately from `globalSettingsOpen` so a fresh
  // mount first paints off-screen (translate-y-full) and only then slides in.
  const [isSlidIn, setIsSlidIn] = useState(false);
  const visibleTabs = TABS.filter(
    (t) => t.id !== GLOBAL_SETTINGS_TABS.DEVELOPER || dev?.enabled
  );
  const effectiveActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : GLOBAL_SETTINGS_TABS.GENERAL;
  const isFullWidthSettingsTab =
    effectiveActiveTab === GLOBAL_SETTINGS_TABS.MCP_MANAGER;

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
      if (e.key === KEYBOARD_KEYS.ESCAPE) closeGlobalSettings();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [globalSettingsOpen, closeGlobalSettings]);

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
    if (isStandalone) {
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
      ref={drawerRef}
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
            options={[
              {
                value: SETTING_SCOPES.USER,
                label: "User",
                icon: "codicon-person",
                title: "Edit user-scoped settings",
              },
              {
                value: SETTING_SCOPES.WORKSPACE,
                label: "Workspace",
                icon: "codicon-project",
                title: "Edit workspace-scoped settings",
              },
            ]}
          />
        </div>

        <div className="flex items-center gap-1">
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

      {globalSettingsReadOnly && (
        <div
          role="status"
          className="absolute z-10 top-[30px] inset-x-0 bg-warning/15 border-b border-warning px-3 py-2 text-sm"
        >
          These settings use a newer format. Update ctrlyoke to edit them.
        </div>
      )}
      <fieldset
        disabled={globalSettingsReadOnly}
        className="flex flex-1 min-h-0 min-w-0 border-0 p-0 m-0"
      >
        <div className="flex flex-1 min-h-0">
          {/* Left: vertical tab bar */}
          <GlobalSettingsVerticalTabBar
            tabs={visibleTabs.map((t) =>
              t.id === GLOBAL_SETTINGS_TABS.SERVER
                ? { ...t, indicator: serverRunning }
                : t
            )}
            activeTab={effectiveActiveTab}
            onTabChange={setActiveTab}
            iconOnly={isNarrow}
          />

          {/* Right: section content.
            The "workflow" tab renders WorkflowDefaultsSection which owns its
            own scrolling and uses h-full + DrawerTabBar pinned at the bottom.
            It must be a direct flex child so h-full resolves to a definite
            size. MCP also gets the full available width so its wide layout can
            use equal columns; all other tabs use the standard width cap. */}
          {fullSettings &&
          effectiveActiveTab === GLOBAL_SETTINGS_TABS.WORKFLOW ? (
            <div className="flex-1 flex flex-col min-h-0">
              <WorkflowDefaultsSection
                settings={fullSettings}
                {...sectionProps}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
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
                    <SecretsSection settings={fullSettings} {...sectionProps} />
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
                  effectiveActiveTab === GLOBAL_SETTINGS_TABS.NOTIFICATIONS && (
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
                  effectiveActiveTab === GLOBAL_SETTINGS_TABS.COORDINATION && (
                    <CoordinationSection
                      settings={fullSettings}
                      {...sectionProps}
                    />
                  )}
                {fullSettings &&
                  effectiveActiveTab === GLOBAL_SETTINGS_TABS.SERVER && (
                    <ServerSection settings={fullSettings} {...sectionProps} />
                  )}
                {effectiveActiveTab ===
                  GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER && (
                  <AgentSkillsManagerSection activeScope={activeScope} />
                )}
                {effectiveActiveTab === GLOBAL_SETTINGS_TABS.MCP_MANAGER && (
                  <McpManagerSection activeScope={activeScope} />
                )}
                {fullSettings &&
                  effectiveActiveTab === GLOBAL_SETTINGS_TABS.COMMIT && (
                    <CommitSection settings={fullSettings} {...sectionProps} />
                  )}
                {dev?.enabled &&
                  effectiveActiveTab === GLOBAL_SETTINGS_TABS.DEVELOPER && (
                    <DeveloperSection />
                  )}
                {!fullSettings &&
                  effectiveActiveTab !== GLOBAL_SETTINGS_TABS.DEVELOPER &&
                  effectiveActiveTab !==
                    GLOBAL_SETTINGS_TABS.AGENT_SKILLS_MANAGER &&
                  effectiveActiveTab !== GLOBAL_SETTINGS_TABS.MCP_MANAGER && (
                    <div className="text-description-fg text-sm">
                      Loading settings…
                    </div>
                  )}
              </div>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}
