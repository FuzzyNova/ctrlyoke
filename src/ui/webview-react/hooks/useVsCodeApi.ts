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
  }
}

let vscodeApi: VsCodeApi | undefined;

// Initialize immediately from window (set by inline script).
// No logging here — WebviewLog imports this module (circular dep) and the
// VS Code API is not yet available at module-load time anyway.
if (typeof window !== "undefined" && window.vscodeApi && !vscodeApi) {
  vscodeApi = window.vscodeApi;
}

export function useVsCodeApi(): VsCodeApi {
  const [api, setApi] = useState<VsCodeApi | undefined>(vscodeApi);

  useEffect(() => {
    if (!vscodeApi) {
      // Use the globally captured API from the inline script
      vscodeApi = window.vscodeApi;
      if (!vscodeApi) {
        console.error("FlightPath: window.vscodeApi is undefined!");
        throw new Error(
          "VS Code API not available - window.vscodeApi is undefined"
        );
      }
      setApi(vscodeApi);
    }
  }, []);

  if (!api) {
    console.error("FlightPath: api is undefined in useVsCodeApi hook");
    throw new Error("VS Code API not available");
  }

  return api;
}

export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApi) {
    vscodeApi = window.vscodeApi;
    if (!vscodeApi) {
      throw new Error(
        "VS Code API not available - window.vscodeApi is undefined"
      );
    }
  }
  return vscodeApi;
}
