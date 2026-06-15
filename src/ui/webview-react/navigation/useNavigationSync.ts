/**
 * Mounts the navigation sync layer once near the App root.
 *
 * In the hosted browser it wires up URL ⇄ store History sync
 * ({@link setupBrowserNavigation}); in the VS Code webview it records
 * navigations into the in-memory stack so the in-app back/forward controls work
 * without an address bar. Applying routes is owned by {@link applyRoute};
 * mutations it causes are skipped via {@link isApplyingRoute}.
 */
import { useEffect } from "react";
import { isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useNavHistoryStore } from "./navHistoryStore";
import { deriveCurrentRoute } from "./navState";
import { isApplyingRoute } from "./applyRoute";
import { setupBrowserNavigation } from "./browserNavigation";

function recordCurrentRoute(): void {
  if (isApplyingRoute()) return;
  useNavHistoryStore.getState().record(deriveCurrentRoute());
}

function setupInMemoryRecorder(): () => void {
  recordCurrentRoute();
  const unsubscribers = [
    useUiStore.subscribe(recordCurrentRoute),
    useWorkspaceViewerStore.subscribe(recordCurrentRoute),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function useNavigationSync(): void {
  useEffect(() => {
    return isStandalone ? setupBrowserNavigation() : setupInMemoryRecorder();
  }, []);
}
