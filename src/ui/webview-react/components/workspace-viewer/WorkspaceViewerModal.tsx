import React, { useCallback } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { WorkspaceViewerHeader } from "./WorkspaceViewerHeader";
import { WorkspaceExplorerPane } from "./WorkspaceExplorerPane";
import { WorkspaceSourceControlPane } from "./WorkspaceSourceControlPane";

export const WorkspaceViewerModal: React.FC = () => {
  const isOpen = useWorkspaceViewerStore((s) => s.isOpen);
  const activeTab = useWorkspaceViewerStore((s) => s.activeTab);
  const fileDirty = useWorkspaceViewerStore((s) => s.fileDirty);
  const close = useWorkspaceViewerStore((s) => s.close);
  const promptDirtyExit = useWorkspaceViewerStore((s) => s.promptDirtyExit);
  const setActiveTab = useWorkspaceViewerStore((s) => s.setActiveTab);

  const handleClose = useCallback(() => {
    if (fileDirty) {
      promptDirtyExit(close);
    } else {
      close();
    }
  }, [fileDirty, promptDirtyExit, close]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--sidebar-bg)]">
      <WorkspaceViewerHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={handleClose}
      />
      <div className="flex-1 overflow-hidden relative">
        {activeTab === "explorer" ? (
          <WorkspaceExplorerPane />
        ) : (
          <WorkspaceSourceControlPane />
        )}
      </div>
    </div>
  );
};
