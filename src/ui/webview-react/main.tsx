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
// TEMP DEBUG: tracks down the EditorFooter stuck-click/flashing bug — several
// footer quick pickers subscribe to these stores with no selector, so any
// runaway writer here re-renders every one of them. See storeWriteWatch.ts.
// Remove once diagnosed.
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
