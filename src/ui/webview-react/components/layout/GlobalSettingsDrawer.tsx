import { useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { MESSAGE_TYPES } from "@/types/messages";
import { GlobalSettingsVerticalTabBar } from "./GlobalSettingsVerticalTabBar";
import {
  GeneralSection,
  WorkflowDefaultsSection,
  HarnessesSection,
  PermissionsSection,
  ExecutionSection,
  TerminalSection,
  ChatSection,
  McpHooksSection,
  QueueSection,
  HistorySection,
  ServerSection,
  NotificationsSection,
  DeveloperSection,
} from "../settings";

const ALL_TABS = [
  { id: "general", label: "General", icon: "codicon-settings" },
  { id: "workflow", label: "Workflow Defaults", icon: "codicon-globe" },
  { id: "harnesses", label: "Harnesses & Models", icon: "codicon-robot" },
  { id: "permissions", label: "Permissions", icon: "codicon-shield" },
  { id: "execution", label: "Execution", icon: "codicon-play" },
  { id: "notifications", label: "Notifications", icon: "codicon-bell" },
  { id: "terminal", label: "Terminal", icon: "codicon-terminal" },
  { id: "chat", label: "Chat", icon: "codicon-comment-discussion" },
  { id: "mcp", label: "MCP & Hooks", icon: "codicon-plug" },
  { id: "queue", label: "Queue", icon: "codicon-list-ordered" },
  { id: "history", label: "History", icon: "codicon-history" },
  { id: "server", label: "Server", icon: "codicon-server" },
  { id: "developer", label: "Developer", icon: "codicon-tools" },
];

const TABS = isStandalone
  ? ALL_TABS.filter((t) => t.id !== "server")
  : ALL_TABS;

export function GlobalSettingsDrawer() {
  const vscode = useVsCodeApi();
  const globalSettingsOpen = useUiStore((s) => s.globalSettingsOpen);
  const activeTab = useUiStore((s) => s.globalSettingsActiveTab);
  const setActiveTab = useUiStore((s) => s.setGlobalSettingsTab);
  const closeGlobalSettings = useUiStore((s) => s.closeGlobalSettings);
  const fullSettings = useSettingsStore((s) => s.fullGlobalSettings);
  const serverRunning = useSettingsStore((s) => s.serverRunning);
  const dev = useSettingsStore((s) => s.dev);
  const [drawerRef, isNarrow] = useElementNarrow(580);
  const visibleTabs = TABS.filter((t) => t.id !== "developer" || dev?.enabled);
  const effectiveActiveTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : "general";

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
      if (e.key === "Escape") closeGlobalSettings();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [globalSettingsOpen, closeGlobalSettings]);

  function handleUpdate(
    path: string,
    value: unknown,
    scope: "workspace" | "user"
  ) {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path,
      value,
      scope,
    });
  }

  return (
    <div
      ref={drawerRef}
      className={`absolute inset-0 flex flex-col z-40 bg-panel-bg border-t border-panel-border
        transition-transform duration-200 ease-out
        ${globalSettingsOpen ? "translate-y-0" : "translate-y-full"}`}
      aria-hidden={!globalSettingsOpen}
    >
      {/* Title bar — always visible, never scrolls */}
      <div className="flex items-center justify-between px-2 h-[30px] border-b border-panel-border shrink-0">
        <div className="flex items-center gap-1 text-description-fg">
          <i className="codicon codicon-settings-gear text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide ml-0.5">
            Settings
          </span>
        </div>
        <button
          className="control-button flex items-center justify-center w-5 h-5 rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
          onClick={closeGlobalSettings}
          title="Close Global Settings"
          aria-label="Close Global Settings"
        >
          <span className="codicon codicon-close" />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left: vertical tab bar */}
        <GlobalSettingsVerticalTabBar
          tabs={visibleTabs.map((t) =>
            t.id === "server" ? { ...t, indicator: serverRunning } : t
          )}
          activeTab={effectiveActiveTab}
          onTabChange={setActiveTab}
          iconOnly={isNarrow}
        />

        {/* Right: section content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 max-w-2xl">
            {fullSettings && effectiveActiveTab === "general" && (
              <GeneralSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && effectiveActiveTab === "workflow" && (
              <WorkflowDefaultsSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "harnesses" && (
              <HarnessesSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "permissions" && (
              <PermissionsSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "execution" && (
              <ExecutionSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "notifications" && (
              <NotificationsSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "terminal" && (
              <TerminalSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "chat" && (
              <ChatSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && effectiveActiveTab === "mcp" && (
              <McpHooksSection
                settings={fullSettings}
                onUpdate={handleUpdate}
              />
            )}
            {fullSettings && effectiveActiveTab === "queue" && (
              <QueueSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && effectiveActiveTab === "history" && (
              <HistorySection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && effectiveActiveTab === "server" && (
              <ServerSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {dev?.enabled && effectiveActiveTab === "developer" && (
              <DeveloperSection />
            )}
            {!fullSettings && effectiveActiveTab !== "developer" && (
              <div className="text-description-fg text-sm">
                Loading settings…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
