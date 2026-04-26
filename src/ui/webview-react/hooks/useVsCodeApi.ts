import { useEffect, useState } from "react";

interface VsCodeApi {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
}

// Declare global window extension for vscodeApi
declare global {
  interface Window {
    vscodeApi?: VsCodeApi;
    __flightpathStandalone?: boolean;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/** True when the UI is served by FlightPathHostedServer (browser tab), not the VS Code panel. */
export const isStandalone =
  typeof window !== "undefined" && !!window.__flightpathStandalone;

let vscodeApi: VsCodeApi | undefined;

function resolveVsCodeApi(): VsCodeApi | undefined {
  if (typeof window === "undefined") {
    return vscodeApi;
  }

  // Prefer the current global reference. On retained webviews, VS Code may
  // replace window.vscodeApi during a reconnect, so never pin the first object
  // forever if a newer one is present.
  if (window.vscodeApi && window.vscodeApi !== vscodeApi) {
    vscodeApi = window.vscodeApi;
  }

  if (!vscodeApi && typeof window.acquireVsCodeApi === "function") {
    vscodeApi = window.acquireVsCodeApi();
    window.vscodeApi = vscodeApi;
  }

  return vscodeApi;
}

export function useVsCodeApi(): VsCodeApi {
  const [api, setApi] = useState<VsCodeApi | undefined>(() => resolveVsCodeApi());

  useEffect(() => {
    const resolvedApi = resolveVsCodeApi();
    if (!resolvedApi) {
      console.error("FlightPath: window.vscodeApi is undefined!");
      throw new Error(
        "VS Code API not available - window.vscodeApi is undefined"
      );
    }
    if (resolvedApi !== api) {
      setApi(resolvedApi);
    }
  }, [api]);

  if (!api) {
    console.error("FlightPath: api is undefined in useVsCodeApi hook");
    throw new Error("VS Code API not available");
  }

  return api;
}

export function getVsCodeApi(): VsCodeApi {
  const resolvedApi = resolveVsCodeApi();
  if (!resolvedApi) {
    throw new Error(
      "VS Code API not available - window.vscodeApi is undefined"
    );
  }
  return resolvedApi;
}
