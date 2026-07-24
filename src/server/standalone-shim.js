(function () {
  "use strict";

  // Replaced at request time by HostedStandaloneShimScript so message names and
  // timing thresholds remain single-sourced with the TypeScript server.
  const CONNECTION_CONFIG = "__CTRLYOKE_HOSTED_CONNECTION_CONFIG__";

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
  let lastSentReadyPreferredViewAddress;
  let lastReadyMessage;
  let hiddenAtMs;
  let lastForegroundRefreshAt = 0;
  let lastInboundAt = Date.now();
  let lastHeartbeatAt;
  let foregroundProbe;
  const reconnectDelaysMs = [250, 500, 1000, 1500, 2000];
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
    // Send our persistent tabId as the client identity. tabId is stable across a
    // close/reopen of the same tab or PWA (reused from localStorage once the old
    // instance goes stale) yet distinct for genuinely-simultaneous tabs. The server
    // adopts it as the clientId so a reopened PWA is recognized as the SAME client —
    // keeping controller status and its keyed terminal viewport size — instead of
    // getting a fresh id every connection.
    return (
      `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}` +
      `&clientId=${encodeURIComponent(tabId)}`
    );
  }

  function isReadyMessage(msg) {
    return !!msg && msg.type === CONNECTION_CONFIG.readyType;
  }

  function sendNow(socket, msg) {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    if (isReadyMessage(msg)) {
      readySentForSocket = true;
      lastSentReadyPreferredViewAddress = JSON.stringify(
        msg.preferredViewAddress
      );
    }
    return true;
  }

  function connectionLog(level, message, replayOnReconnect) {
    const diagnostic = {
      type: CONNECTION_CONFIG.logMessageType,
      level,
      message: `[standalone-shim] ${message}`,
    };
    const sent =
      ws && ws.readyState === WebSocket.OPEN ? sendNow(ws, diagnostic) : false;
    if (!sent || replayOnReconnect) {
      pendingOutbound.push(diagnostic);
    }
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

  function getUrlViewAddress() {
    const params = new URLSearchParams(location.search);
    const workflowKey = params.get("workflowKey");
    const runRef = params.get("runRef");
    if (!workflowKey || !workflowKey.trim()) return undefined;
    return runRef && runRef.trim()
      ? { workflowKey, kind: "run", runRef }
      : { workflowKey, kind: "draft" };
  }

  function buildReadyMessage() {
    const preferredViewAddress = getUrlViewAddress();
    const baseReadyMessage = lastReadyMessage || {
      type: CONNECTION_CONFIG.readyType,
    };
    const { preferredViewAddress: _ignored, ...readyMessage } =
      baseReadyMessage;
    return {
      ...readyMessage,
      ...(preferredViewAddress ? { preferredViewAddress } : {}),
    };
  }

  function sendReadyIfNeeded(socket) {
    const readyMessage = buildReadyMessage();
    const preferredViewAddress = JSON.stringify(
      readyMessage.preferredViewAddress
    );
    if (
      readySentForSocket &&
      preferredViewAddress === lastSentReadyPreferredViewAddress
    ) {
      return false;
    }
    return sendNow(socket, readyMessage);
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
    sendReadyIfNeeded(ws);
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

    lastInboundAt = Date.now();

    if (msg.type === CONNECTION_CONFIG.heartbeatType) {
      lastHeartbeatAt = lastInboundAt;
      const socket = event.currentTarget || ws;
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendNow(socket, {
          type: CONNECTION_CONFIG.heartbeatAckType,
          id: msg.id,
        });
      }
      return;
    }

    if (msg.type === CONNECTION_CONFIG.heartbeatAckType) {
      if (foregroundProbe && msg.id === foregroundProbe.id) {
        const elapsedMs = Date.now() - foregroundProbe.startedAt;
        window.clearTimeout(foregroundProbe.timer);
        foregroundProbe = undefined;
        connectionLog(
          CONNECTION_CONFIG.logLevels.debug,
          `foreground probe acknowledged afterMs=${elapsedMs}`
        );
        refreshReadyState();
      }
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

  function clearForegroundProbe(socket) {
    if (!foregroundProbe || (socket && foregroundProbe.socket !== socket)) {
      return;
    }
    window.clearTimeout(foregroundProbe.timer);
    foregroundProbe = undefined;
  }

  function startForegroundProbe(reason) {
    if (!ws || ws.readyState !== WebSocket.OPEN || foregroundProbe) return;
    const socket = ws;
    const id = `browser-${tabId}-${Date.now()}-${randomId()}`;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      if (!foregroundProbe || foregroundProbe.id !== id) return;
      foregroundProbe = undefined;
      connectionLog(
        CONNECTION_CONFIG.logLevels.warn,
        `foreground probe timed out reason=${reason} timeoutMs=${CONNECTION_CONFIG.FOREGROUND_PROBE_TIMEOUT_MS} lastInboundAgoMs=${Date.now() - lastInboundAt}`,
        true
      );
      reconnectNow(`foreground probe timeout: ${reason}`);
    }, CONNECTION_CONFIG.FOREGROUND_PROBE_TIMEOUT_MS);
    foregroundProbe = { id, reason, socket, startedAt, timer };
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `foreground probe started reason=${reason} lastInboundAgoMs=${Date.now() - lastInboundAt} lastHeartbeatAgoMs=${lastHeartbeatAt ? Date.now() - lastHeartbeatAt : "none"}`
    );
    if (
      !sendNow(socket, {
        type: CONNECTION_CONFIG.heartbeatType,
        id,
        sentAt: startedAt,
      })
    ) {
      clearForegroundProbe(socket);
      reconnectNow(`foreground probe send failed: ${reason}`);
    }
  }

  function checkInboundLiveness() {
    if (
      pageUnloading ||
      document.visibilityState === "hidden" ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const staleForMs = Date.now() - lastInboundAt;
    if (staleForMs <= CONNECTION_CONFIG.CLIENT_STALE_TIMEOUT_MS) return;
    connectionLog(
      CONNECTION_CONFIG.logLevels.warn,
      `inbound watchdog timed out staleForMs=${staleForMs} thresholdMs=${CONNECTION_CONFIG.CLIENT_STALE_TIMEOUT_MS} lastHeartbeatAgoMs=${lastHeartbeatAt ? Date.now() - lastHeartbeatAt : "none"}`,
      true
    );
    reconnectNow("inbound heartbeat timeout");
  }

  function scheduleReconnect() {
    if (pageUnloading || document.visibilityState === "hidden") {
      connectionLog(
        CONNECTION_CONFIG.logLevels.debug,
        `reconnect deferred pageUnloading=${pageUnloading} visibility=${document.visibilityState}`
      );
      return;
    }
    if (reconnectTimer) return;
    const delay =
      reconnectDelaysMs[
        Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)
      ];
    reconnectAttempt += 1;
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `reconnect scheduled delayMs=${delay} attempt=${reconnectAttempt}`
    );
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
    clearForegroundProbe();
    reconnectAttempt = 0;
    connectionLog(
      CONNECTION_CONFIG.logLevels.warn,
      `forcing reconnect reason=${reason} visibility=${document.visibilityState} lastInboundAgoMs=${Date.now() - lastInboundAt}`,
      true
    );
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

  function refreshConnectionOnForeground(forceReconnect, reason) {
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
        reconnectNow(`foreground revalidate: ${reason}`);
      }
      return;
    }

    if (ws.readyState === WebSocket.CLOSING) {
      if (forceReconnect) {
        reconnectNow(`foreground revalidate: ${reason}`);
      }
      return;
    }

    if (forceReconnect) {
      reconnectNow(`foreground revalidate: ${reason}`);
      return;
    }

    startForegroundProbe(reason);
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
    lastSentReadyPreferredViewAddress = undefined;
    // Track whether THIS socket instance ever reached OPEN. Closed without ever
    // opening counts as a connection failure (cert rejection, server unreachable).
    let socketOpened = false;
    const socket = new WebSocket(getWebSocketUrl());
    ws = socket;
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `connect started attempt=${reconnectAttempt + 1} visibility=${document.visibilityState}`
    );

    // iOS Safari can leave a WebSocket stuck in CONNECTING indefinitely — the
    // server sees a brief connect/close but the browser fires neither open nor
    // close. After 1800ms still CONNECTING, abandon the socket and force a fresh
    // connect so queued READY can actually reach the server.
    clearConnectWatchdog();
    connectWatchdogTimer = window.setTimeout(() => {
      connectWatchdogTimer = undefined;
      if (ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      ws = undefined;
      connectionLog(
        CONNECTION_CONFIG.logLevels.warn,
        "connect watchdog abandoned socket stuck in CONNECTING",
        true
      );
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
      lastInboundAt = Date.now();
      const hasQueuedReady = pendingOutbound.some(isReadyMessage);
      // Register this WebSocket with the extension immediately. Any replay this
      // triggers is buffered below until React posts its own READY, so no state
      // is delivered before useMessageHandler has installed its listener.
      if (!hasQueuedReady) {
        sendReadyIfNeeded(socket);
      }
      flushOutbound();
      connectionLog(
        CONNECTION_CONFIG.logLevels.info,
        `socket opened visibility=${document.visibilityState}`
      );
    });

    socket.addEventListener("message", handleInboundMessage);

    // Reconnect without reloading the page while the document is alive. Safari
    // can fire WebSocket close during refresh/page cache teardown; reconnecting
    // from that stale document creates short-lived sockets that never send READY.
    socket.addEventListener("close", (event) => {
      const wasCurrentSocket = ws === socket;
      if (wasCurrentSocket) {
        clearConnectWatchdog();
        ws = undefined;
      }
      clearForegroundProbe(socket);
      connectionLog(
        CONNECTION_CONFIG.logLevels.warn,
        `socket closed code=${event.code ?? "unknown"} reason=${event.reason || "none"} opened=${socketOpened} current=${wasCurrentSocket} visibility=${document.visibilityState} lastInboundAgoMs=${Date.now() - lastInboundAt}`,
        true
      );
      // A deliberately abandoned socket can close after its replacement is
      // already connecting. Its late close must not cancel that socket's
      // watchdog, increment failure counters, or schedule a duplicate reconnect.
      if (!wasCurrentSocket) return;
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
      connectionLog(
        CONNECTION_CONFIG.logLevels.warn,
        `socket error opened=${socketOpened} current=${ws === socket} visibility=${document.visibilityState}`,
        true
      );
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
    clearForegroundProbe();
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `page exit visibility=${document.visibilityState}`
    );
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
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `pageshow hiddenDurationMs=${hiddenDuration} socketState=${ws?.readyState ?? "none"}`
    );
    refreshConnectionOnForeground(
      hiddenDuration >= CONNECTION_CONFIG.BACKGROUND_REVALIDATE_MS,
      "pageshow"
    );
  }

  window.addEventListener("pagehide", pauseForPageExit);
  window.addEventListener("pageshow", resumeAfterPageShow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAtMs = Date.now();
      clearReconnectTimer();
      clearForegroundProbe();
      connectionLog(
        CONNECTION_CONFIG.logLevels.debug,
        `visibility hidden socketState=${ws?.readyState ?? "none"}`
      );
      return;
    }
    pageUnloading = false;
    const hiddenDuration = hiddenAtMs ? Date.now() - hiddenAtMs : 0;
    hiddenAtMs = undefined;
    connectionLog(
      CONNECTION_CONFIG.logLevels.debug,
      `visibility visible hiddenDurationMs=${hiddenDuration} socketState=${ws?.readyState ?? "none"} lastInboundAgoMs=${Date.now() - lastInboundAt}`
    );
    refreshConnectionOnForeground(
      hiddenDuration >= CONNECTION_CONFIG.BACKGROUND_REVALIDATE_MS,
      "visibilitychange"
    );
  });
  window.addEventListener("focus", () => {
    refreshConnectionOnForeground(false, "focus");
  });
  window.addEventListener("online", () => {
    connectionLog(
      CONNECTION_CONFIG.logLevels.info,
      `network online socketState=${ws?.readyState ?? "none"}`
    );
    refreshConnectionOnForeground(false, "online");
  });
  window.addEventListener("offline", () => {
    connectionLog(
      CONNECTION_CONFIG.logLevels.warn,
      `network offline socketState=${ws?.readyState ?? "none"}`
    );
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

  window.setInterval(
    checkInboundLiveness,
    CONNECTION_CONFIG.CLIENT_WATCHDOG_INTERVAL_MS
  );
  connect();

  window.__ctrlyokeStandalone = true;

  window.vscodeApi = {
    postMessage(msg) {
      if (isReadyMessage(msg)) {
        reactReady = true;
        lastReadyMessage = msg;
        queueMicrotask(flushInbound);
        const duplicateReady =
          readySentForSocket &&
          JSON.stringify(msg.preferredViewAddress) ===
            lastSentReadyPreferredViewAddress;
        if (duplicateReady) return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendNow(ws, msg);
        return;
      }
      // Anything posted while the socket is down is DROPPED, never queued.
      // pendingOutbound is flushed the instant a socket opens, which is exactly
      // when the extension host has just restarted — so queuing user commands
      // here replayed a pre-outage "Re-run"/"Resume" click into a freshly
      // started extension and launched a workflow with no user action at all.
      // Only the READY handshake may wait for a socket (React posts it before
      // the first socket opens); connection diagnostics queue themselves via
      // connectionLog(). The reconnect replays full state anyway, so a dropped
      // command leaves the client consistent rather than silently stale.
      if (isReadyMessage(msg)) {
        pendingOutbound.push(msg);
        return;
      }
      connectionLog(
        CONNECTION_CONFIG.logLevels.warn,
        `dropped outbound message while disconnected type=${msg && msg.type}`,
        true
      );
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
