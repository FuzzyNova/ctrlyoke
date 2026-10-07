import React, { useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useIosVisualViewportRootStyle } from "@hooks/useIosVisualViewportRootStyle";
import { WorkspaceViewerHeader } from "./WorkspaceViewerHeader";
import { WorkspaceExplorerPane } from "./WorkspaceExplorerPane";
import { WorkspaceSourceControlPane } from "./WorkspaceSourceControlPane";
import { WorkspaceSearchPane } from "./WorkspaceSearchPane";
import { WorkspaceLanguageReferencesPanel } from "./WorkspaceLanguageReferencesPanel";

const EXIT_DURATION_MS = 220;

export const WorkspaceViewerModal: React.FC = () => {
  const isOpen = useWorkspaceViewerStore((s) => s.isOpen);
  const activeTab = useWorkspaceViewerStore((s) => s.activeTab);
  const close = useWorkspaceViewerStore((s) => s.close);
  const setActiveTab = useWorkspaceViewerStore((s) => s.setActiveTab);
  const workspacePath = useSettingsStore((s) => s.globalSettings.workspaceRoot);
  const isMobile = useIsMobile();
  // This modal is portaled to document.body as its own `fixed inset-0` tree,
  // outside App's root div — App's own use of this hook only pins App's root,
  // so the mobile-keyboard treatment must be reproduced locally here too (see
  // useIosVisualViewportRootStyle's doc comment).
  const iosVisualViewportRootStyle = useIosVisualViewportRootStyle(isMobile);

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
      style={iosVisualViewportRootStyle}
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
        <WorkspaceLanguageReferencesPanel />
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
