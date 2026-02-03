/**
 * VS Code API types for webview communication
 */

/**
 * VS Code API instance (acquired via acquireVsCodeApi())
 */
export interface VsCodeApi {
  postMessage(message: any): void;
  setState(state: any): void;
  getState(): any;
}

/**
 * Declare global vscode API
 */
declare global {
  function acquireVsCodeApi(): VsCodeApi;
}
