import type { StateStorage } from "zustand/middleware";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

/**
 * Raw StateStorage adapter backed by the host webview state API.
 *
 * Values are stored under namespaced keys inside the host's shared root state
 * object so multiple stores can coexist. The VS Code panel persists that state
 * across restarts; the browser shim persists it in workspace-scoped localStorage.
 */
export const webviewRawStorage: StateStorage = {
  getItem(name: string): string | null {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      const value = root[name];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      vscode.setState({ ...root, [name]: value });
    } catch {
      // Swallow - best-effort persistence.
    }
  },
  removeItem(name: string): void {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      const { [name]: _removed, ...rest } = root as Record<string, unknown>;
      vscode.setState(rest);
    } catch {
      // Swallow - best-effort persistence.
    }
  },
};
