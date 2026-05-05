import React from "react";
import ReactDOM from "react-dom/client";
import BootstrapApp from "./BootstrapApp";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { WebviewLog } from "@utils/logger";
import { useUiStore } from "@store/uiStore";
import "./styles/globals.css";

const root = document.getElementById("root");
window.__flightpathReactMounted = true;
WebviewLog.debug(`[main] entry rootFound=${Boolean(root)}`);
if (!root) {
  WebviewLog.error("[main] root element not found");
} else {
  const start = async () => {
    try {
      WebviewLog.debug("[main] rehydrating uiStore");
      await useUiStore.persist.rehydrate();
      WebviewLog.debug("[main] uiStore rehydrated, calling ReactDOM.createRoot");
      ReactDOM.createRoot(root).render(
        <React.StrictMode>
          <ErrorBoundary>
            <BootstrapApp />
          </ErrorBoundary>
        </React.StrictMode>
      );
      WebviewLog.debug("[main] ReactDOM.createRoot().render() returned");
    } catch (error) {
      WebviewLog.error(
        `[main] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  };

  void start();
}
