(function () {
  "use strict";

  // Generate a stable per-tab ID so each browser tab tracks its own state.
  // sessionStorage survives page refreshes but is unique per tab (not shared
  // between tabs like localStorage), giving us the right scoping:
  //   - Refresh: same tabId → same localStorage key → state restored ✓
  //   - New tab: new tabId → new localStorage key → fresh start ✓
  //   - 5 concurrent tabs: 5 different keys → independent per-tab state ✓
  let tabId = sessionStorage.getItem("fpTabId");
  if (!tabId) {
    tabId = Math.random().toString(36).slice(2);
    sessionStorage.setItem("fpTabId", tabId);
  }
  const STATE_KEY = "fpState-" + tabId;

  let _state = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener("open", () => {
    pending.forEach((m) => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);

    // Theme var updates: apply directly to :root without going through React
    if (msg.type === "themeVarsUpdated") {
      const style = document.documentElement.style;
      for (const [k, v] of Object.entries(msg.vars)) style.setProperty(k, v);
      // Replicate VS Code's body class so dark-mode detection works in the browser
      // (e.g. CodeMirror reads document.body.classList.contains("vscode-dark")).
      const kind = msg.vars["--fp-color-theme-kind"];
      if (kind) {
        document.body.classList.remove(
          "vscode-dark",
          "vscode-light",
          "vscode-high-contrast"
        );
        document.body.classList.add(
          kind === "dark"
            ? "vscode-dark"
            : kind === "high-contrast"
              ? "vscode-high-contrast"
              : "vscode-light"
        );
      }
      return;
    }

    // All other messages: dispatch to useMessageHandler via window.addEventListener('message', ...)
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });

  // Reconnect on server restart (development convenience)
  ws.addEventListener("close", () => setTimeout(() => location.reload(), 1500));

  window.__flightpathStandalone = true;

  window.vscodeApi = {
    postMessage(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    getState() {
      return _state;
    },
    setState(s) {
      _state = s;
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
    },
  };
})();
