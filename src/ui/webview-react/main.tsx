import "./wdyr"; // must be first — patches React before any component is imported
import React from "react";
import ReactDOM from "react-dom/client";
import BootstrapApp from "./BootstrapApp";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { WebviewLog } from "@utils/logger";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { installPerformanceProfiler } from "@utils/performanceProfiler";
import "./styles/globals.css";

const root = document.getElementById("root");
window.__flightpathReactMounted = true;
installPerformanceProfiler();
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
