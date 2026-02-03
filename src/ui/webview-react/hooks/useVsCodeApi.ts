import { useEffect, useState } from "react";

interface VsCodeApi {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
}

let vscodeApi: VsCodeApi | undefined;

export function useVsCodeApi(): VsCodeApi {
  const [api, setApi] = useState<VsCodeApi | undefined>(vscodeApi);

  useEffect(() => {
    if (!vscodeApi) {
      // @ts-ignore - Injected by VS Code
      vscodeApi = acquireVsCodeApi();
      setApi(vscodeApi);
    }
  }, []);

  if (!api) {
    throw new Error("VS Code API not available");
  }

  return api;
}

export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApi) {
    // @ts-ignore
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}
