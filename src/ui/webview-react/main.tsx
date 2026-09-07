import "./wdyr"; // must be first — patches React before any component is imported
import React from "react";
import ReactDOM from "react-dom/client";
import BootstrapApp from "./BootstrapApp";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { WebviewLog } from "@utils/logger";
import { watchStoreWrites } from "@utils/storeWriteWatch";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { installPerformanceProfiler } from "@utils/performanceProfiler";
import "./styles/globals.css";

const root = document.getElementById("root");
window.__ctrlyokeReactMounted = true;
installPerformanceProfiler();
// Diagnostic: logs writes to these frequently-over-subscribed stores and
// escalates to WARN on a burst (see storeWriteWatch.ts). Caught a real
// production incident — an unthrottled external-run broadcast spamming
// uiStore.loadedWorkflows/recentWorkflows caused a footer re-render storm
// bad enough to intermittently break click hit-testing (fixed in
// ExternalRunWatchSession; see orchestration.instructions.md). Kept as
// permanent early-warning tooling for the next chatty-store regression.
watchStoreWrites(useEditorStore, "editorStore");
watchStoreWrites(useSettingsStore, "settingsStore");
watchStoreWrites(useUiStore, "uiStore");
if (!root) {
  WebviewLog.error("[main] root element not found");
} else {
  const start = async () => {
    try {
      await useUiStore.persist.rehydrate();
      await useWorkspaceViewerStore.persist.rehydrate();
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <ErrorBoundary>
            <BootstrapApp />
          </ErrorBoundary>
        </React.StrictMode>
      );
    } catch (error) {
      WebviewLog.error(
        `[main] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  };

  void start();
}
