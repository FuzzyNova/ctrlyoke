import { useEffect, useState } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import { GlobalSettingsVerticalTabBar } from "./GlobalSettingsVerticalTabBar";
import {
  GeneralSection,
  WorkflowDefaultsSection,
  AdvancedPermissionsSection,
  ExecutionSection,
  TerminalSection,
  ChatSection,
  QueueSection,
  ServerSection,
  NotificationsSection,
  DeveloperSection,
  AgentSkillsManagerSection,
  McpManagerSection,
  CommitSection,
} from "../settings";

const ALL_TABS = [
  { id: "general", label: "General", icon: "codicon-settings" },
  { id: "workflow", label: "Workflow Defaults", icon: "codicon-globe" },
  { id: "permissions", label: "Advanced Permissions", icon: "codicon-shield" },
  { id: "execution", label: "Execution", icon: "codicon-play" },
  { id: "notifications", label: "Notifications", icon: "codicon-bell" },
  { id: "terminal", label: "Terminal", icon: "codicon-terminal" },
  { id: "chat", label: "Chat", icon: "codicon-comment-discussion" },
  { id: "queue", label: "Queue", icon: "codicon-list-ordered" },
  { id: "server", label: "Server", icon: "codicon-server" },
  {
    id: "agentskillsmanager",
    label: "Agent & Skills Manager",
    icon: "codicon-agent",
  },
  { id: "mcpmanager", label: "MCP Manager", icon: "codicon-mcp" },
  { id: "commit", label: "Commit Message", icon: "codicon-git-commit" },
  { id: "developer", label: "Developer", icon: "codicon-tools" },
];

const TABS = ALL_TABS;

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
  const [activeScope, setActiveScope] = useState<SettingWriteScope>(
    SETTING_SCOPES.USER
  );
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

  function handleUpdate(path: string, value: unknown) {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path,
      value,
      scope: activeScope,
    });
  }

  function handleReset(path: string) {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path,
      value: undefined,
      scope: activeScope,
    });
  }

  const sectionProps = {
    activeScope,
    onUpdate: handleUpdate,
    onReset: handleReset,
  };

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
          <i className="codicon codicon-settings-gear text-sm" />
          <span className="text-sm font-semibold uppercase tracking-wide ml-0.5">
            Settings
          </span>

          {/* Scope toggle */}
          <div
            className="fp-mode-switch ml-2"
            role="group"
            aria-label="Settings scope"
          >
            <button
              type="button"
              onClick={() => setActiveScope(SETTING_SCOPES.USER)}
              className={`fp-mode-switch-btn ${activeScope === SETTING_SCOPES.USER ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
              title="Edit user-scoped settings"
            >
              <i className="codicon codicon-person" />
              User
            </button>
            <div className="fp-mode-switch-divider">
              <div className="w-px h-full bg-current opacity-40" />
            </div>
            <button
              type="button"
              onClick={() => setActiveScope(SETTING_SCOPES.WORKSPACE)}
              className={`fp-mode-switch-btn ${activeScope === SETTING_SCOPES.WORKSPACE ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
              title="Edit workspace-scoped settings"
            >
              <i className="codicon codicon-project" />
              Workspace
            </button>
          </div>
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

        {/* Right: section content.
            The "workflow" tab renders WorkflowDefaultsSection which owns its
            own scrolling and uses h-full + DrawerTabBar pinned at the bottom.
            It must be a direct flex child so h-full resolves to a definite
            size. All other tabs use the standard scrollable wrapper. */}
        {fullSettings && effectiveActiveTab === "workflow" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <WorkflowDefaultsSection
              settings={fullSettings}
              {...sectionProps}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="p-4 max-w-2xl">
              {fullSettings && effectiveActiveTab === "general" && (
                <GeneralSection settings={fullSettings} {...sectionProps} />
              )}
              {fullSettings && effectiveActiveTab === "permissions" && (
                <AdvancedPermissionsSection
                  settings={fullSettings}
                  {...sectionProps}
                />
              )}
              {fullSettings && effectiveActiveTab === "execution" && (
                <ExecutionSection settings={fullSettings} {...sectionProps} />
              )}
              {fullSettings && effectiveActiveTab === "notifications" && (
                <NotificationsSection
                  settings={fullSettings}
                  {...sectionProps}
                />
              )}
              {fullSettings && effectiveActiveTab === "terminal" && (
                <TerminalSection settings={fullSettings} {...sectionProps} />
              )}
              {fullSettings && effectiveActiveTab === "chat" && (
                <ChatSection settings={fullSettings} {...sectionProps} />
              )}
              {fullSettings && effectiveActiveTab === "queue" && (
                <QueueSection settings={fullSettings} {...sectionProps} />
              )}
              {fullSettings && effectiveActiveTab === "server" && (
                <ServerSection settings={fullSettings} {...sectionProps} />
              )}
              {effectiveActiveTab === "agentskillsmanager" && (
                <AgentSkillsManagerSection activeScope={activeScope} />
              )}
              {effectiveActiveTab === "mcpmanager" && (
                <McpManagerSection activeScope={activeScope} />
              )}
              {fullSettings && effectiveActiveTab === "commit" && (
                <CommitSection settings={fullSettings} {...sectionProps} />
              )}
              {dev?.enabled && effectiveActiveTab === "developer" && (
                <DeveloperSection />
              )}
              {!fullSettings &&
                effectiveActiveTab !== "developer" &&
                effectiveActiveTab !== "agentskillsmanager" &&
                effectiveActiveTab !== "mcpmanager" && (
                  <div className="text-description-fg text-sm">
                    Loading settings…
                  </div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
