/**
 * Shared helpers for reading the current navigable route out of the live
 * stores. Used by both the in-memory recorder (webview) and the browser
 * History controller so they derive routes identically.
 */
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { deriveRoute, type Route, type RouteSourceState } from "./route";

export function currentSourceState(): RouteSourceState {
  const ui = useUiStore.getState();
  const wv = useWorkspaceViewerStore.getState();
  return {
    activeWorkflowWorkingFilePath: ui.activeWorkflowWorkingFilePath,
    isOpen: wv.isOpen,
    activeTab: wv.activeTab,
    selectedFilePath: wv.selectedFilePath,
    explorerPath: wv.explorerPath,
    selectedDiffPath: wv.selectedDiffPath,
    diffRef: wv.diffRef,
  };
}

export function deriveCurrentRoute(): Route {
  return deriveRoute(currentSourceState());
}
