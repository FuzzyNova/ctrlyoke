import React, { useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { WorkspaceViewerHeader } from "./WorkspaceViewerHeader";
import { WorkspaceExplorerPane } from "./WorkspaceExplorerPane";
import { WorkspaceSourceControlPane } from "./WorkspaceSourceControlPane";

const EXIT_DURATION_MS = 220;

export const WorkspaceViewerModal: React.FC = () => {
  const isOpen = useWorkspaceViewerStore((s) => s.isOpen);
  const activeTab = useWorkspaceViewerStore((s) => s.activeTab);
  const fileDirty = useWorkspaceViewerStore((s) => s.fileDirty);
  const close = useWorkspaceViewerStore((s) => s.close);
  const promptDirtyExit = useWorkspaceViewerStore((s) => s.promptDirtyExit);
  const setActiveTab = useWorkspaceViewerStore((s) => s.setActiveTab);
  const workspacePath = useSettingsStore((s) => s.globalSettings.workspaceRoot);

  const [rendering, setRendering] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setClosing(false);
      setRendering(true);
    } else {
      setClosing(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setRendering(false);
        setClosing(false);
      }, EXIT_DURATION_MS);
    }
  }, [isOpen]);

  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setRendering(false);
      setClosing(false);
    }
  }, [closing]);

  const handleClose = useCallback(() => {
    if (fileDirty) {
      promptDirtyExit(close);
    } else {
      close();
    }
  }, [fileDirty, promptDirtyExit, close]);

  if (!rendering) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[300] flex flex-col bg-sidebar-bg ${closing ? "animate-modal-exit" : "animate-modal-enter"}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <WorkspaceViewerHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={handleClose}
        workspacePath={workspacePath ?? undefined}
      />
      <div className="flex-1 overflow-hidden relative">
        {activeTab === "explorer" ? (
          <WorkspaceExplorerPane />
        ) : (
          <WorkspaceSourceControlPane />
        )}
      </div>
    </div>,
    document.body
  );
};
