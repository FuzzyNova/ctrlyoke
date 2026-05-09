import type { StateStorage } from "zustand/middleware";
import { getVsCodeApi } from "@hooks/useVsCodeApi";

/**
 * Raw StateStorage adapter backed by the VS Code webview state API.
 *
 * Unlike localStorage, vscode.getState()/setState() persists across VS Code
 * restarts for sidebar webview views. Values are stored under namespaced keys
 * inside the shared root state object so multiple stores can coexist.
 */
export const vsCodeRawStorage: StateStorage = {
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
