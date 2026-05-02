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
    : "Workspace";

  return (
    <div className="relative flex items-center px-3 py-1.5 border-b border-panel-border bg-sidebar-bg flex-shrink-0">
      {/* Tab buttons — left-aligned */}
      <div className="flex items-center" role="tablist">
        <button
          className={`fp-tab ${activeTab === "explorer" ? "fp-tab-active" : "fp-tab-inactive"}`}
          onClick={() => onTabChange("explorer")}
          aria-selected={activeTab === "explorer"}
          role="tab"
        >
          <i className="codicon codicon-files text-sm" />
          Explorer
        </button>
        <button
          className={`fp-tab ${activeTab === "sourceControl" ? "fp-tab-active" : "fp-tab-inactive"}`}
          onClick={() => onTabChange("sourceControl")}
          aria-selected={activeTab === "sourceControl"}
          role="tab"
        >
          <i className="codicon codicon-source-control text-sm" />
          Source Control
        </button>
      </div>

      {/* Title — centered absolutely; two-line stack with name + full path */}
      <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center select-none pointer-events-none">
        <span className="flex items-center gap-1 text-sm font-medium text-editor-fg opacity-70 whitespace-nowrap">
          <i className="codicon codicon-project text-sm" />
          Workspace: {workspaceName}
        </span>
        {workspacePath && (
          <span
            className="text-xs text-description-fg truncate max-w-[40vw]"
            title={workspacePath}
          >
            {workspacePath}
          </span>
        )}
      </div>

      {/* Close button — pushed to right */}
      <button
        className="ml-auto flex items-center justify-center w-7 h-7 rounded border border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover transition-colors flex-shrink-0"
        onClick={onClose}
        title="Close workspace viewer"
        aria-label="Close workspace viewer"
      >
        <i className="codicon codicon-close" />
      </button>
    </div>
  );
};
