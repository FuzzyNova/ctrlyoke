// Captured before the React bundle loads so the retained-panel reconnect path
// can reuse the latest API object. No imports — compiled as a standalone IIFE.
try {
  window.vscodeApi = window.acquireVsCodeApi?.();
} catch {
  // Stale retained context; useVsCodeApi() will recover once the panel reconnects.
}
