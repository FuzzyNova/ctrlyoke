import React from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { DiffView } from "@components/output/DiffView";

export const WorkspaceDiffPane: React.FC = () => {
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const diffOldContent = useWorkspaceViewerStore((s) => s.diffOldContent);
  const diffNewContent = useWorkspaceViewerStore((s) => s.diffNewContent);
  const diffLanguage = useWorkspaceViewerStore((s) => s.diffLanguage);
  const diffLoading = useWorkspaceViewerStore((s) => s.diffLoading);

  if (!selectedDiffPath) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--editor-fg)] opacity-40 select-none">
        <p className="text-sm">Select a file to see its diff</p>
      </div>
    );
  }

  if (diffLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-[var(--editor-fg)] opacity-50">
        <i className="codicon codicon-loading animate-spin" />
        <span className="text-sm">Loading diff…</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-3 py-2">
      <DiffView
        oldContent={diffOldContent}
        newContent={diffNewContent}
        language={diffLanguage}
        globallyCollapsed={false}
      />
    </div>
  );
};
