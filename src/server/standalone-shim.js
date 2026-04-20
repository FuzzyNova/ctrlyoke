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

  let _state = {};
  try {
    _state = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
  } catch {
    localStorage.removeItem(STATE_KEY);
  }

  let ws;
  let reconnectTimer;
  let connectWatchdogTimer;
  let reconnectAttempt = 0;
  let reactReady = false;
  let pageUnloading = false;
  let readySentForSocket = false;
  let lastSentReadyPreferredWorkingFilePath;
  let lastReadyMessage;
  const pendingOutbound = [];
  const pendingInbound = [];

  function getWebSocketUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const token = new URLSearchParams(location.search).get("token") ?? "";
    return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  }

  function sendNow(socket, msg) {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    if (msg && msg.type === "ready") {
      readySentForSocket = true;
      lastSentReadyPreferredWorkingFilePath = msg.preferredWorkingFilePath;
    }
    return true;
  }

  function flushOutbound() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingOutbound.length > 0) {
      const msg = pendingOutbound.shift();
      if (!sendNow(ws, msg)) {
        pendingOutbound.unshift(msg);
        break;
      }
    }
  }

  function getPersistedWorkingFilePath() {
    const rawUiState = _state && _state["flightpath-ui-state"];
    if (typeof rawUiState !== "string") return undefined;
    try {
      const parsed = JSON.parse(rawUiState);
      const path = parsed?.state?.activeWorkflowWorkingFilePath;
      return typeof path === "string" && path.trim().length > 0
        ? path
        : undefined;
    } catch {
      return undefined;
    }
  }

  function buildReadyMessage() {
    const preferredWorkingFilePath =
      getPersistedWorkingFilePath() ||
      lastReadyMessage?.preferredWorkingFilePath;
    return {
      ...(lastReadyMessage || { type: "ready" }),
      ...(preferredWorkingFilePath ? { preferredWorkingFilePath } : {}),
    };
  }

  function dispatchToReact(msg) {
    if (!reactReady) {
      pendingInbound.push(msg);
      return;
    }
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  }

  function flushInbound() {
    if (!reactReady) return;
    while (pendingInbound.length > 0) {
      window.dispatchEvent(
        new MessageEvent("message", { data: pendingInbound.shift() })
      );
    }
  }

  function applyThemeVars(vars) {
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) style.setProperty(k, v);
    // Replicate VS Code's body class so dark-mode detection works in the browser
    // (e.g. CodeMirror reads document.body.classList.contains("vscode-dark")).
    const kind = vars["--fp-color-theme-kind"];
    if (!kind) return;

    const applyBodyClass = () => {
      if (!document.body) return;
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
    };

    if (document.body) {
      applyBodyClass();
    } else {
      document.addEventListener("DOMContentLoaded", applyBodyClass, {
        once: true,
      });
    }
  }

  function handleInboundMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Theme var updates: apply directly to :root without going through React
    if (msg.type === "themeVarsUpdated") {
      applyThemeVars(msg.vars || {});
      return;
    }

    // All other messages: dispatch to useMessageHandler via window.addEventListener('message', ...).
    // Messages that arrive before React sends READY are buffered so initial state
    // cannot be lost during refresh or slow bundle startup.
    dispatchToReact(msg);
  }

  function clearConnectWatchdog() {
    if (!connectWatchdogTimer) return;
    window.clearTimeout(connectWatchdogTimer);
    connectWatchdogTimer = undefined;
  }

  function scheduleReconnect() {
    if (pageUnloading || document.visibilityState === "hidden") return;
    if (reconnectTimer) return;
    const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function isSocketActive() {
    return (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    );
  }

  function connect() {
    if (pageUnloading || isSocketActive()) return;
    readySentForSocket = false;
    lastSentReadyPreferredWorkingFilePath = undefined;
    const socket = new WebSocket(getWebSocketUrl());
    ws = socket;

    // iOS Safari can leave a WebSocket stuck in CONNECTING indefinitely — the
    // server sees a brief connect/close but the browser fires neither open nor
    // close. After 1800ms still CONNECTING, abandon the socket and force a fresh
    // connect so queued READY can actually reach the server.
    clearConnectWatchdog();
    connectWatchdogTimer = window.setTimeout(() => {
      connectWatchdogTimer = undefined;
      if (ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      ws = undefined;
      try {
        socket.close();
      } catch {
        /* best-effort */
      }
      connect();
    }, 1800);

    socket.addEventListener("open", () => {
      clearConnectWatchdog();
      reconnectAttempt = 0;
      const hasQueuedReady = pendingOutbound.some(
        (msg) => msg && msg.type === "ready"
      );
      // Register this WebSocket with the extension immediately. Any replay this
      // triggers is buffered below until React posts its own READY, so no state
      // is delivered before useMessageHandler has installed its listener.
      if (!hasQueuedReady) {
        sendNow(socket, buildReadyMessage());
      }
      flushOutbound();
    });

    socket.addEventListener("message", handleInboundMessage);

    // Reconnect without reloading the page while the document is alive. Safari
    // can fire WebSocket close during refresh/page cache teardown; reconnecting
    // from that stale document creates short-lived sockets that never send READY.
    socket.addEventListener("close", () => {
      clearConnectWatchdog();
      if (ws === socket) ws = undefined;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    });
  }

  function pauseForPageExit() {
    pageUnloading = true;
    clearReconnectTimer();
    if (ws) {
      try {
        ws.close(1001, "page unloading");
      } catch {
        /* already closing */
      }
    }
  }

  function resumeAfterPageShow() {
    pageUnloading = false;
    connect();
  }

  window.addEventListener("pagehide", pauseForPageExit);
  window.addEventListener("pageshow", resumeAfterPageShow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearReconnectTimer();
      return;
    }
    pageUnloading = false;
    connect();
  });

  connect();

  window.__flightpathStandalone = true;

  window.vscodeApi = {
    postMessage(msg) {
      if (msg && msg.type === "ready") {
        reactReady = true;
        lastReadyMessage = msg;
        queueMicrotask(flushInbound);
        const duplicateReady =
          readySentForSocket &&
          msg.preferredWorkingFilePath ===
            lastSentReadyPreferredWorkingFilePath;
        if (duplicateReady) return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) sendNow(ws, msg);
      else pendingOutbound.push(msg);
    },
    getState() {
      return _state;
    },
    setState(s) {
      _state = s;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(s));
      } catch {
        /* best-effort persistence */
      }
    },
  };
})();
