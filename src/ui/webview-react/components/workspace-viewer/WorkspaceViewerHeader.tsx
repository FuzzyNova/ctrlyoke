import React from "react";

interface WorkspaceViewerHeaderProps {
  activeTab: "explorer" | "sourceControl";
  onTabChange: (tab: "explorer" | "sourceControl") => void;
  onClose: () => void;
  workspacePath?: string;
}

export const WorkspaceViewerHeader: React.FC<WorkspaceViewerHeaderProps> = ({
  activeTab,
  onTabChange,
  onClose,
  workspacePath,
}) => {
  const workspaceName = workspacePath
    ? (workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? workspacePath)
    : "FlightPath Workspace";

  return (
    <div className="flex items-center px-3 py-1.5 border-b border-panel-border bg-sidebar-bg flex-shrink-0">
      {/* Tab buttons — fixed left, never shrink */}
      <div className="flex items-center flex-shrink-0" role="tablist">
        <button
          className={`fp-tab ${activeTab === "explorer" ? "fp-tab-active" : "fp-tab-inactive"}`}
          onClick={() => onTabChange("explorer")}
          aria-selected={activeTab === "explorer"}
          role="tab"
          title="Explorer"
        >
          <i className="codicon codicon-files codicon-sm px-1 sm:px-0" />
          <span className="hidden sm:inline">Explorer</span>
        </button>
        <button
          className={`fp-tab ${activeTab === "sourceControl" ? "fp-tab-active" : "fp-tab-inactive"}`}
          onClick={() => onTabChange("sourceControl")}
          aria-selected={activeTab === "sourceControl"}
          role="tab"
          title="Source Control"
        >
          <i className="codicon codicon-source-control codicon-sm px-1 sm:px-0" />
          <span className="hidden sm:inline">Source Control</span>
        </button>
      </div>

      {/* Title — takes remaining space, truncates before touching side elements */}
      <div className="flex-1 min-w-0 flex flex-col items-center px-2 select-none pointer-events-none">
        <div className="flex items-center gap-1 text-sm font-medium text-editor-fg opacity-70 max-w-full min-w-0">
          <i className="codicon codicon-project codicon-sm flex-shrink-0" />
          <span className="truncate" data-testid="workspace-name">
            Workspace: {workspaceName}
          </span>
        </div>
        {workspacePath && (
          <span
            className="text-xs text-description-fg truncate w-full text-center"
            title={workspacePath}
          >
            {workspacePath}
          </span>
        )}
      </div>

      {/* Close button — fixed right, never shrink */}
      <button
        className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover transition-colors"
        onClick={onClose}
        title="Close workspace viewer"
        aria-label="Close workspace viewer"
      >
        <i className="codicon codicon-close" />
      </button>
    </div>
  );
};
