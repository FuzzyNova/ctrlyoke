// Dynamically imports the Vite bundle entry point with a watchdog reload timer.
// __fpModuleSrc__ is injected as a const in the wrapping <script type="module">
// by FlightPathWebviewProvider._getHtmlForWebview before this IIFE runs.
// No imports — compiled as a standalone IIFE.
declare const __fpModuleSrc__: string;
declare const __fpLogLevels__: {
  DEBUG: string;
  INFO: string;
  WARN: string;
  ERROR: string;
};

type ModuleLoaderWindow = Window &
  typeof globalThis & {
    __flightpathStandalone?: boolean;
    __flightpathReactMounted?: boolean;
    __flightpathPanelHandshakeDone?: boolean;
    __flightpathBootstrapLog?: (level: string, message: string) => void;
    __flightpathFlushBootstrapLogs?: () => void;
  };

const flightpathWindow = window as ModuleLoaderWindow;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function log(level: string, message: string): void {
  const fullMessage = `[moduleLoader] ${message}`;
  const logger = flightpathWindow.__flightpathBootstrapLog;
  if (typeof logger === "function") {
    logger(level, fullMessage);
    return;
  }
  if (level === __fpLogLevels__.ERROR) {
    console.error(fullMessage);
    return;
  }
  if (level === __fpLogLevels__.WARN) {
    console.warn(fullMessage);
    return;
  }
  if (level === __fpLogLevels__.INFO) {
    console.info(fullMessage);
    return;
  }
  console.debug(fullMessage);
}

const moduleTimeoutMs = 30_000;
const handshakeTimeoutMs = 20_000;
const recoveryCooldownMs = 10_000;
const recoverySessionKey = "flightpath-panel-module-recovery-at";
const handshakeSessionKey = "flightpath-panel-handshake-reload-at";
const startupHeartbeatIntervalMs = 5_000;
const startupHeartbeatDurationMs = 35_000;

log(
  __fpLogLevels__.DEBUG,
  `script start moduleSrc=${__fpModuleSrc__} standalone=${Boolean(flightpathWindow.__flightpathStandalone)}`
);
log(
  __fpLogLevels__.DEBUG,
  `arming module-mount watchdog timeoutMs=${moduleTimeoutMs}`
);

const heartbeatStartedAt = Date.now();
const startupHeartbeatTimer = window.setInterval(() => {
  const elapsedMs = Date.now() - heartbeatStartedAt;
  log(
    __fpLogLevels__.DEBUG,
    `startup heartbeat elapsedMs=${elapsedMs} readyState=${document.readyState} visibility=${document.visibilityState} reactMounted=${Boolean(flightpathWindow.__flightpathReactMounted)} handshakeDone=${Boolean(flightpathWindow.__flightpathPanelHandshakeDone)}`
  );
  if (
    elapsedMs >= startupHeartbeatDurationMs ||
    flightpathWindow.__flightpathPanelHandshakeDone
  ) {
    window.clearInterval(startupHeartbeatTimer);
  }
}, startupHeartbeatIntervalMs);

// Fires if the Vite bundle never mounts React (import failure, CSP block, etc.)
const timer = window.setTimeout(function () {
  if (!flightpathWindow.__flightpathReactMounted) {
    const now = Date.now();
    let lastRecoveryAt = 0;
    try {
      lastRecoveryAt = Number(
        sessionStorage.getItem(recoverySessionKey) ?? "0"
      );
    } catch {
      // sessionStorage unavailable
    }
    if (
      !Number.isFinite(lastRecoveryAt) ||
      now - lastRecoveryAt >= recoveryCooldownMs
    ) {
      log(
        __fpLogLevels__.WARN,
        "module-mount watchdog fired before React mount; reloading panel"
      );
      try {
        sessionStorage.setItem(recoverySessionKey, String(now));
      } catch {
        // sessionStorage unavailable
      }
      window.location.reload();
      return;
    }

    log(
      __fpLogLevels__.DEBUG,
      `module-mount watchdog fired within cooldown; skipping reload deltaMs=${now - lastRecoveryAt}`
    );
  }
}, moduleTimeoutMs);

// Handshake watchdog: fires if React mounted (bundle loaded) but the extension
// never sent CLIENT_ID_ASSIGNED. Covers cases like acquireVsCodeApi() failing
// silently after a retained-context reload, which crashes React before
// useMessageHandler can register its listener — leaving the panel permanently
// stuck with no in-React watchdog to save it.
// Skip for standalone (browser) clients — they have their own WebSocket reconnect.
if (!flightpathWindow.__flightpathStandalone) {
  log(
    __fpLogLevels__.DEBUG,
    `arming handshake watchdog timeoutMs=${handshakeTimeoutMs}`
  );
  window.setTimeout(function () {
    if (
      flightpathWindow.__flightpathReactMounted &&
      !flightpathWindow.__flightpathPanelHandshakeDone
    ) {
      const now = Date.now();
      let lastAt = 0;
      try {
        lastAt = Number(sessionStorage.getItem(handshakeSessionKey) ?? "0");
      } catch {
        // sessionStorage unavailable
      }
      if (!Number.isFinite(lastAt) || now - lastAt >= recoveryCooldownMs) {
        log(
          __fpLogLevels__.WARN,
          "handshake watchdog fired after React mount without CLIENT_ID_ASSIGNED; reloading panel"
        );
        try {
          sessionStorage.setItem(handshakeSessionKey, String(now));
        } catch {
          // sessionStorage unavailable
        }
        window.location.reload();
        return;
      }

      log(
        __fpLogLevels__.DEBUG,
        `handshake watchdog fired within cooldown; skipping reload deltaMs=${now - lastAt}`
      );
    }
  }, handshakeTimeoutMs);
}

log(__fpLogLevels__.DEBUG, "starting dynamic import for React bundle");
void import(__fpModuleSrc__)
  .then(function () {
    window.clearTimeout(timer);
    window.clearInterval(startupHeartbeatTimer);
    log(__fpLogLevels__.DEBUG, "dynamic import resolved");
    flightpathWindow.__flightpathFlushBootstrapLogs?.();
  })
  .catch(function (error: unknown) {
    window.clearTimeout(timer);
    window.clearInterval(startupHeartbeatTimer);
    log(
      __fpLogLevels__.ERROR,
      `dynamic import failed: ${formatUnknownError(error)}`
    );
  });

export {};
