import React from "react";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { NavHistoryControls } from "../shared/NavHistoryControls";
import { ExitButton } from "../shared/ExitButton";
import {
  WORKSPACE_VIEWER_TABS,
  type WorkspaceViewerTab,
} from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

interface WorkspaceViewerHeaderProps {
  activeTab: WorkspaceViewerTab;
  onTabChange: (tab: WorkspaceViewerTab) => void;
  onClose: () => void;
  workspacePath?: string;
}

const getFileName = (filePath: string): string =>
  filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath;

const getWorkspaceFilePath = (
  workspaceName: string | null,
  filePath: string,
  workspacePath?: string
): string => {
  const norm = filePath.replace(/\\/g, "/");
  let relative = norm;
  // Strip workspace root prefix with case-insensitive comparison (Windows
  // drive letters may differ in casing between uri.fsPath and AI output).
  if (workspacePath) {
    const root = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
    if (norm.toLowerCase().startsWith(root.toLowerCase() + "/")) {
      relative = norm.slice(root.length + 1);
    }
  }
  // Strip any remaining leading slashes (e.g. Unix absolute paths)
  relative = relative.replace(/^[/\\]+/, "");
  return workspaceName ? `${workspaceName}/${relative}` : relative;
};

export const WorkspaceViewerHeader: React.FC<WorkspaceViewerHeaderProps> = ({
  activeTab,
  onTabChange,
  onClose,
  workspacePath,
}) => {
  const selectedFilePath = useWorkspaceViewerStore((s) => s.selectedFilePath);
  const fileDirty = useWorkspaceViewerStore((s) => s.fileDirty);
  const mobileEditorVisible = useWorkspaceViewerStore(
    (s) => s.mobileEditorVisible
  );
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const mobileDiffVisible = useWorkspaceViewerStore((s) => s.mobileDiffVisible);
  const isMobile = useIsMobile();

  const workspaceRootName = workspacePath
    ? (workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? workspacePath)
    : null;
  const workspaceName = workspaceRootName ?? "ctrlyoke Workspace";
  const explorerFileVisible =
    activeTab === WORKSPACE_VIEWER_TABS.EXPLORER &&
    selectedFilePath !== null &&
    (!isMobile || mobileEditorVisible);
  const diffFileVisible =
    activeTab === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL &&
    selectedDiffPath !== null &&
    (!isMobile || mobileDiffVisible);
  const titleFilePath = explorerFileVisible
    ? selectedFilePath
    : diffFileVisible
      ? selectedDiffPath
      : null;
  const showDirtyDot = explorerFileVisible && fileDirty;
  const subtitle = titleFilePath
    ? getWorkspaceFilePath(workspaceRootName, titleFilePath, workspacePath)
    : workspacePath;

  return (
    <div className="flex items-center px-3 py-1.5 border-b border-panel-border bg-sidebar-bg flex-shrink-0">
      {/* Tab buttons — fixed left, never shrink */}
      <div className="flex items-center flex-shrink-0" role="tablist">
        <button
          className={`fp-tab fp-tab-hc ${activeTab === WORKSPACE_VIEWER_TABS.EXPLORER ? "fp-tab-active fp-tab-hc-selected" : "fp-tab-inactive"}`}
          onClick={() => onTabChange(WORKSPACE_VIEWER_TABS.EXPLORER)}
          aria-selected={activeTab === WORKSPACE_VIEWER_TABS.EXPLORER}
          role="tab"
          title="Explorer"
        >
          <Icon name="files" className="codicon-sm px-1 sm:px-0" />
          <span className="hidden sm:inline">Explorer</span>
        </button>
        <button
          className={`fp-tab fp-tab-hc ${activeTab === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL ? "fp-tab-active fp-tab-hc-selected" : "fp-tab-inactive"}`}
          onClick={() => onTabChange(WORKSPACE_VIEWER_TABS.SOURCE_CONTROL)}
          aria-selected={activeTab === WORKSPACE_VIEWER_TABS.SOURCE_CONTROL}
          role="tab"
          title="Source Control"
        >
          <Icon name="source-control" className="codicon-sm px-1 sm:px-0" />
          <span className="hidden sm:inline">Source Control</span>
        </button>
        <button
          className={`fp-tab fp-tab-hc ${activeTab === WORKSPACE_VIEWER_TABS.SEARCH ? "fp-tab-active fp-tab-hc-selected" : "fp-tab-inactive"}`}
          onClick={() => onTabChange(WORKSPACE_VIEWER_TABS.SEARCH)}
          aria-selected={activeTab === WORKSPACE_VIEWER_TABS.SEARCH}
          role="tab"
          title="Search"
        >
          <Icon name="search" className="codicon-sm px-1 sm:px-0" />
          <span className="hidden sm:inline">Search</span>
        </button>
        <NavHistoryControls className="ml-2" />
      </div>

      {/* Title — takes remaining space, truncates before touching side elements */}
      <div className="flex-1 min-w-0 flex flex-col items-center px-2 select-none pointer-events-none">
        <div className="flex items-center gap-1 text-sm font-medium text-editor-fg opacity-70 max-w-full min-w-0">
          <Icon
            name={titleFilePath ? "codicon-file" : "codicon-project"}
            className="codicon-sm flex-shrink-0"
          />
          <span className="truncate" data-testid="workspace-name">
            {titleFilePath
              ? getFileName(titleFilePath)
              : `Workspace: ${workspaceName}`}
          </span>
          {showDirtyDot && (
            <span
              className="text-[var(--status-warning)] flex-shrink-0"
              title="Unsaved changes"
            >
              ●
            </span>
          )}
        </div>
        {subtitle && (
          <span
            className="text-xs text-description-fg truncate w-full text-center"
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
      </div>

      {/* Close button — fixed right, never shrink */}
      <ExitButton
        className="shrink-0"
        onClick={onClose}
        title="Close workspace viewer"
        aria-label="Close workspace viewer"
      />
    </div>
  );
};
