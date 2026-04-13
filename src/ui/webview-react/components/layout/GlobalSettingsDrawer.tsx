import { useEffect } from "react";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { GlobalSettingsVerticalTabBar } from "./GlobalSettingsVerticalTabBar";
import {
  GeneralSection,
  WorkflowDefaultsSection,
  HarnessesSection,
  PermissionsSection,
  ExecutionSection,
  ChatSection,
  McpHooksSection,
  QueueSection,
  HistorySection,
  ServerSection,
} from "../settings";

const ALL_TABS = [
  { id: "general", label: "General", icon: "codicon-settings" },
  { id: "workflow", label: "Workflow Defaults", icon: "codicon-git-branch" },
  { id: "harnesses", label: "Harnesses & Models", icon: "codicon-server" },
  { id: "permissions", label: "Permissions", icon: "codicon-shield" },
  { id: "execution", label: "Execution", icon: "codicon-play" },
  { id: "chat", label: "Chat", icon: "codicon-comment-discussion" },
  { id: "mcp", label: "MCP & Hooks", icon: "codicon-plug" },
  { id: "queue", label: "Queue", icon: "codicon-list-unordered" },
  { id: "history", label: "History & Safety", icon: "codicon-history" },
  { id: "server", label: "Server", icon: "codicon-cloud" },
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

  function handleUpdate(path: string, value: unknown, scope: "workspace" | "user") {
    vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, path, value, scope });
  }

  return (
    <div
      className={`absolute inset-0 flex flex-col z-40 bg-panel-bg border-t border-panel-border
        transition-transform duration-200 ease-out
        ${globalSettingsOpen ? "translate-y-0" : "translate-y-full"}`}
      aria-hidden={!globalSettingsOpen}
    >
      <div className="flex flex-1 min-h-0">
        {/* Left: vertical tab bar */}
        <GlobalSettingsVerticalTabBar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {/* Right: section content */}
        <div className="flex-1 overflow-y-auto relative">
          {/* Close button */}
          <button
            className="absolute top-2 right-2 control-button flex items-center justify-center w-7 h-7 rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover z-10"
            onClick={closeGlobalSettings}
            title="Close Global Settings"
            aria-label="Close Global Settings"
          >
            <span className="codicon codicon-close" />
          </button>

          <div className="p-4 pr-12 max-w-2xl">
            {fullSettings && activeTab === "general" && (
              <GeneralSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "workflow" && (
              <WorkflowDefaultsSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "harnesses" && (
              <HarnessesSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "permissions" && (
              <PermissionsSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "execution" && (
              <ExecutionSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "chat" && (
              <ChatSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "mcp" && (
              <McpHooksSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "queue" && (
              <QueueSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "history" && (
              <HistorySection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {fullSettings && activeTab === "server" && (
              <ServerSection settings={fullSettings} onUpdate={handleUpdate} />
            )}
            {!fullSettings && (
              <div className="text-description-fg text-sm">Loading settings…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
