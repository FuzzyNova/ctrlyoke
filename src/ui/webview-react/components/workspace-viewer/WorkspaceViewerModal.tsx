import React, { useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { WorkspaceViewerHeader } from "./WorkspaceViewerHeader";
import { WorkspaceExplorerPane } from "./WorkspaceExplorerPane";
import { WorkspaceSourceControlPane } from "./WorkspaceSourceControlPane";
import { WorkspaceSearchPane } from "./WorkspaceSearchPane";

const EXIT_DURATION_MS = 220;

export const WorkspaceViewerModal: React.FC = () => {
  const isOpen = useWorkspaceViewerStore((s) => s.isOpen);
  const activeTab = useWorkspaceViewerStore((s) => s.activeTab);
  const close = useWorkspaceViewerStore((s) => s.close);
  const setActiveTab = useWorkspaceViewerStore((s) => s.setActiveTab);
  const workspacePath = useSettingsStore((s) => s.globalSettings.workspaceRoot);

  // Once opened, the modal stays mounted (hidden via CSS) rather than
  // unmounting on close. This keeps WorkspaceExplorerPane / WorkspaceFileEditor
  // alive across close/reopen so scroll position, markdown-preview toggle, and
  // CodeMirror undo history survive for free instead of resetting each time.
  const [everOpened, setEverOpened] = useState(isOpen);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setClosing(false);
      setEverOpened(true);
    } else if (everOpened) {
      setClosing(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setClosing(false);
        timerRef.current = null;
      }, EXIT_DURATION_MS);
    }
  }, [isOpen, everOpened]);

  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setClosing(false);
    }
  }, [closing]);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  if (!everOpened) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-workspace-viewer flex flex-col bg-sidebar-bg ${
        closing
          ? "animate-modal-exit"
          : isOpen
            ? "animate-modal-enter"
            : "hidden"
      }`}
      aria-hidden={!isOpen}
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
        ) : activeTab === "sourceControl" ? (
          <WorkspaceSourceControlPane />
        ) : (
          <WorkspaceSearchPane />
        )}
      </div>

      {/* fixed inset-0 escapes the App root's flex layout (and its trailing
          .safe-area-spacer), so reproduce it here — otherwise bottom-anchored
          content in the active pane can sit under the home indicator. No-op
          (0px) on desktop/non-notch devices via env(safe-area-inset-bottom). */}
      <div className="safe-area-spacer" aria-hidden="true" />
    </div>,
    document.body
  );
};
