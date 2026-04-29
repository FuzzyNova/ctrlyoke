import React from "react";

interface WorkspaceViewerHeaderProps {
  activeTab: "explorer" | "sourceControl";
  onTabChange: (tab: "explorer" | "sourceControl") => void;
  onClose: () => void;
}

export const WorkspaceViewerHeader: React.FC<WorkspaceViewerHeaderProps> = ({
  activeTab,
  onTabChange,
  onClose,
}) => {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--panel-border)] bg-[var(--sidebar-bg)] flex-shrink-0">
      {/* Title */}
      <span className="text-sm font-medium text-[var(--editor-fg)] opacity-60 whitespace-nowrap mr-2 select-none">
        FlightPath Workspace
      </span>

      {/* Tab buttons — centered via flex-1 */}
      <div className="flex-1 flex items-center justify-center gap-1">
        <button
          className={`px-3 py-1 text-sm rounded transition-colors border-b-2 ${
            activeTab === "explorer"
              ? "border-[var(--btn-bg)] text-[var(--btn-fg)] bg-[var(--btn-bg)] bg-opacity-10"
              : "border-transparent text-[var(--editor-fg)] opacity-70 hover:opacity-100 hover:bg-[var(--btn-secondary-hover)]"
          }`}
          onClick={() => onTabChange("explorer")}
          aria-selected={activeTab === "explorer"}
          role="tab"
        >
          <i className="codicon codicon-files mr-1.5" />
          Explorer
        </button>
        <button
          className={`px-3 py-1 text-sm rounded transition-colors border-b-2 ${
            activeTab === "sourceControl"
              ? "border-[var(--btn-bg)] text-[var(--btn-fg)] bg-[var(--btn-bg)] bg-opacity-10"
              : "border-transparent text-[var(--editor-fg)] opacity-70 hover:opacity-100 hover:bg-[var(--btn-secondary-hover)]"
          }`}
          onClick={() => onTabChange("sourceControl")}
          aria-selected={activeTab === "sourceControl"}
          role="tab"
        >
          <i className="codicon codicon-source-control mr-1.5" />
          Source Control
        </button>
      </div>

      {/* Close button */}
      <button
        className="flex items-center justify-center w-7 h-7 rounded border border-[var(--btn-border)] bg-[var(--btn-secondary-bg)] text-[var(--btn-secondary-fg)] hover:bg-[var(--btn-secondary-hover)] transition-colors flex-shrink-0"
        onClick={onClose}
        title="Close workspace viewer"
        aria-label="Close workspace viewer"
      >
        <i className="codicon codicon-close" />
      </button>
    </div>
  );
};
