(function () {
  "use strict";

  // Generate a stable per-tab ID so each browser tab tracks its own state.
  // sessionStorage survives page refreshes, but a real browser/PWA close clears
  // it. Mirror the most recent state in localStorage so reopening the only tab
  // can recover unsent prompt text even when the tab gets a new session id.
  const TAB_ID_KEY = "fpTabId";
  const LAST_TAB_ID_KEY = "fpLastTabId";
  const OPEN_TABS_KEY = "fpOpenTabs";
  const LAST_STATE_KEY = "fpState-last";
  const OPEN_TAB_STALE_MS = 15000;
  const HEARTBEAT_MS = 5000;

  function randomId() {
    return Math.random().toString(36).slice(2);
  }

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
    } catch {
      localStorage.removeItem(key);
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* best-effort persistence */
    }
  }

  function getOpenTabs(now) {
    const rawTabs = readJson(OPEN_TABS_KEY, {});
    const tabs =
      rawTabs && typeof rawTabs === "object" && !Array.isArray(rawTabs)
        ? rawTabs
        : {};
    for (const [id, lastSeen] of Object.entries(tabs)) {
      if (typeof lastSeen !== "number" || now - lastSeen > OPEN_TAB_STALE_MS) {
        delete tabs[id];
      }
    }
    return tabs;
  }

  let tabId = sessionStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    const now = Date.now();
    const openTabs = getOpenTabs(now);
    const lastTabId = localStorage.getItem(LAST_TAB_ID_KEY);
    tabId =
      lastTabId && !Object.prototype.hasOwnProperty.call(openTabs, lastTabId)
        ? lastTabId
        : randomId();
    sessionStorage.setItem(TAB_ID_KEY, tabId);
  }
  localStorage.setItem(LAST_TAB_ID_KEY, tabId);
  const STATE_KEY = "fpState-" + tabId;

  function markTabOpen() {
    const tabs = getOpenTabs(Date.now());
    tabs[tabId] = Date.now();
    writeJson(OPEN_TABS_KEY, tabs);
  }

  function markTabClosed() {
    const tabs = getOpenTabs(Date.now());
    delete tabs[tabId];
    writeJson(OPEN_TABS_KEY, tabs);
  }

  markTabOpen();
  setInterval(markTabOpen, HEARTBEAT_MS);
  window.addEventListener("pagehide", markTabClosed);
  window.addEventListener("beforeunload", markTabClosed);

  let _state = {};
  try {
    const persistedState = localStorage.getItem(STATE_KEY);
    const lastState = localStorage.getItem(LAST_STATE_KEY);
    _state = JSON.parse(persistedState || lastState || "{}");
  } catch {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(LAST_STATE_KEY);
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
  let hiddenAtMs;
  let lastForegroundRefreshAt = 0;
  const reconnectDelaysMs = [250, 500, 1000, 1500, 2000];
  const backgroundSocketRevalidateMs = 30000;
  const foregroundRefreshDebounceMs = 1000;
  const pendingOutbound = [];
  // iOS Safari rejects WSS to self-signed certs even after the HTTPS warning is
  // accepted. The cert rejection manifests identically to the "stuck CONNECTING"
  // bug (watchdog fires, close event, immediate reconnect — repeat forever).
  // Track consecutive sockets that never reach OPEN; once we hit the threshold
  // stop reconnecting and show an actionable error banner.
  let consecutiveConnectFailures = 0;
  const MAX_CONNECT_FAILURES = 5;
  let connectionBannerShown = false;
  const pendingInbound = [];
  // Millisecond timestamp until which an expected server restart is in progress.
  // While active, connection failures don't count toward the banner threshold.
  // Set by window.__fpExpectServerRestart() called from DEV_RESTARTING handler.
  let serverRestartExpectedUntil = 0;

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

  function getUrlWorkingFilePath() {
    const workflow = new URLSearchParams(location.search).get("workflow");
    return workflow && workflow.trim() ? workflow : undefined;
  }

  function buildReadyMessage() {
    const preferredWorkingFilePath = getUrlWorkingFilePath();
    const baseReadyMessage = lastReadyMessage || { type: "ready" };
    const { preferredWorkingFilePath: _ignored, ...readyMessage } =
      baseReadyMessage;
    return {
      ...readyMessage,
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

  function refreshReadyState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendNow(ws, buildReadyMessage());
    flushOutbound();
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
    const delay =
      reconnectDelaysMs[
        Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)
      ];
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

  function reconnectNow(reason) {
    clearReconnectTimer();
    clearConnectWatchdog();
    reconnectAttempt = 0;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      const socket = ws;
      ws = undefined;
      try {
        socket.close(1000, reason);
      } catch {
        /* best-effort */
      }
    }
    connect();
  }

  function refreshConnectionOnForeground(forceReconnect) {
    if (
      pageUnloading ||
      document.visibilityState === "hidden" ||
      connectionBannerShown
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastForegroundRefreshAt < foregroundRefreshDebounceMs) {
      return;
    }
    lastForegroundRefreshAt = now;

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      reconnectAttempt = 0;
      connect();
      return;
    }

    if (ws.readyState === WebSocket.CONNECTING) {
      if (forceReconnect) {
        reconnectNow("foreground revalidate");
      }
      return;
    }

    if (ws.readyState === WebSocket.CLOSING) {
      if (forceReconnect) {
        reconnectNow("foreground revalidate");
      }
      return;
    }

    if (forceReconnect) {
      reconnectNow("foreground revalidate");
      return;
    }

    refreshReadyState();
  }

  function isSocketActive() {
    return (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    );
  }

  function connect() {
    if (pageUnloading || isSocketActive() || connectionBannerShown) return;
    readySentForSocket = false;
    lastSentReadyPreferredWorkingFilePath = undefined;
    // Track whether THIS socket instance ever reached OPEN. Closed without ever
    // opening counts as a connection failure (cert rejection, server unreachable).
    let socketOpened = false;
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
      socketOpened = true;
      consecutiveConnectFailures = 0;
      hideConnectionErrorBanner();
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
      // clearConnectWatchdog() also cancels the watchdog for any socket that was
      // created synchronously by the watchdog's own connect() call before this
      // close event fired (the watchdog sets a new timer in connect()).
      clearConnectWatchdog();
      if (ws === socket) ws = undefined;
      if (!socketOpened) {
        // During an expected server restart (e.g. Rebuild All & Reload) don't
        // count failures toward the banner threshold — the server will be down
        // for the duration of the rebuild + VS Code reload (20-60+ seconds).
        const duringExpectedRestart = Date.now() < serverRestartExpectedUntil;
        if (!duringExpectedRestart) {
          consecutiveConnectFailures++;
          if (consecutiveConnectFailures >= MAX_CONNECT_FAILURES) {
            connectionBannerShown = true;
            clearReconnectTimer();
            // Close any socket that the watchdog's synchronous connect() may have
            // already created before this close event fired.
            if (ws && ws.readyState !== WebSocket.CLOSED) {
              try {
                ws.close();
              } catch {
                /* best-effort */
              }
              ws = undefined;
            }
            showConnectionErrorBanner();
            return;
          }
        }
      }
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

  function showConnectionErrorBanner() {
    const certUrl = location.protocol + "//" + location.host + "/cert";
    const html =
      "<strong>Cannot connect to ctrlyoke server.</strong> " +
      "The server may be offline, or the certificate is not trusted.<br>" +
      "<strong>iOS Safari fix (requires iOS 18.2+):</strong> " +
      '<a href="' +
      certUrl +
      '" style="color:#fca5a5;text-decoration:underline">Download certificate</a>' +
      ", then: (1) install via <em>Settings → General → VPN &amp; Device Management</em>" +
      ", (2) go to <em>Settings → General → About → Certificate Trust Settings</em>" +
      " and toggle on <em>Enable Full Trust For Root Certificates</em>." +
      ' &nbsp;<a href="#" id="fp-conn-retry" style="color:#fca5a5;text-decoration:underline">Retry</a>';

    function appendBanner() {
      if (document.getElementById("fp-conn-error")) return;
      const div = document.createElement("div");
      div.id = "fp-conn-error";
      div.setAttribute(
        "style",
        "position:fixed;top:0;left:0;right:0;z-index:99999;" +
          "background:#7f1d1d;color:#fef2f2;" +
          "padding:10px 16px;font-size:13px;line-height:1.7;text-align:center;" +
          "font-family:system-ui,-apple-system,sans-serif;"
      );
      div.innerHTML = html;
      const retryLink = div.querySelector("#fp-conn-retry");
      if (retryLink) {
        retryLink.addEventListener("click", function (e) {
          e.preventDefault();
          connectionBannerShown = false;
          consecutiveConnectFailures = 0;
          reconnectAttempt = 0;
          var el = document.getElementById("fp-conn-error");
          if (el) el.remove();
          connect();
        });
      }
      (document.body || document.documentElement).appendChild(div);
    }

    if (document.body) {
      appendBanner();
    } else {
      document.addEventListener("DOMContentLoaded", appendBanner, {
        once: true,
      });
    }
  }

  function hideConnectionErrorBanner() {
    var el = document.getElementById("fp-conn-error");
    if (el) el.remove();
    connectionBannerShown = false;
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
    const hiddenDuration = hiddenAtMs ? Date.now() - hiddenAtMs : 0;
    hiddenAtMs = undefined;
    refreshConnectionOnForeground(
      hiddenDuration >= backgroundSocketRevalidateMs
    );
  }

  window.addEventListener("pagehide", pauseForPageExit);
  window.addEventListener("pageshow", resumeAfterPageShow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAtMs = Date.now();
      clearReconnectTimer();
      return;
    }
    pageUnloading = false;
    const hiddenDuration = hiddenAtMs ? Date.now() - hiddenAtMs : 0;
    hiddenAtMs = undefined;
    refreshConnectionOnForeground(
      hiddenDuration >= backgroundSocketRevalidateMs
    );
  });
  window.addEventListener("focus", () => {
    refreshConnectionOnForeground(false);
  });
  window.addEventListener("online", () => {
    refreshConnectionOnForeground(true);
  });

  // Called by React's DEV_RESTARTING handler when a full rebuild + window reload
  // is about to happen. Suppresses the consecutive-failure counter so the shim
  // keeps retrying for the full duration instead of showing the error banner.
  window.__fpExpectServerRestart = function (durationMs) {
    serverRestartExpectedUntil = Date.now() + durationMs;
    // If the banner is already visible from a previous failure burst, hide it
    // and resume retrying — the server may come back during this window.
    if (connectionBannerShown) {
      connectionBannerShown = false;
      consecutiveConnectFailures = 0;
      hideConnectionErrorBanner();
      connect();
    }
  };

  connect();

  window.__ctrlyokeStandalone = true;

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
      writeJson(STATE_KEY, s);
      writeJson(LAST_STATE_KEY, s);
    },
  };
})();
