/**
 * Shared helpers for reading the current navigable route out of the live
 * stores. Used by both the in-memory recorder (webview) and the browser
 * History controller so they derive routes identically.
 */
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { deriveRoute, type Route, type RouteSourceState } from "./route";

function currentSourceState(): RouteSourceState {
  const ui = useUiStore.getState();
  const wv = useWorkspaceViewerStore.getState();
  return {
    displayedViewAddress: ui.displayedViewAddress,
    isOpen: wv.isOpen,
    activeTab: wv.activeTab,
    selectedFilePath: wv.selectedFilePath,
    explorerPath: wv.explorerPath,
    selectedDiffPath: wv.selectedDiffPath,
    diffRef: wv.diffRef,
    searchQuery: wv.searchQuery,
    searchScope: wv.searchScope,
    searchIncludeGitIgnored: wv.searchIncludeGitIgnored,
    searchRepo: wv.repos.length > 1 ? wv.selectedRepoId : null,
  };
}

export function deriveCurrentRoute(): Route {
  return deriveRoute(currentSourceState());
}
