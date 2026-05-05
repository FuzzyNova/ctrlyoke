// Dynamically imports the Vite bundle entry point with watchdog reload timers.
// __fpModuleSrc__ is injected as a const in the wrapping <script type="module">
// by FlightPathWebviewProvider._getHtmlForWebview before this IIFE runs.
// No imports; compiled as a standalone IIFE.
declare const __fpModuleSrc__: string;
declare const __fpLogLevels__: {
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
  console.warn(fullMessage);
}

const moduleTimeoutMs = 30_000;
const handshakeTimeoutMs = 20_000;
const recoveryCooldownMs = 10_000;
const recoverySessionKey = "flightpath-panel-module-recovery-at";
const handshakeSessionKey = "flightpath-panel-handshake-reload-at";

// Fires if the Vite bundle never mounts React (import failure, CSP block, etc.).
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
    }
  }
}, moduleTimeoutMs);

// Fires if React mounted but the extension never completed the READY handshake.
// Skip standalone browser clients; their WebSocket bridge owns reconnects.
if (!flightpathWindow.__flightpathStandalone) {
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
      }
    }
  }, handshakeTimeoutMs);
}

void import(__fpModuleSrc__)
  .then(function () {
    window.clearTimeout(timer);
    flightpathWindow.__flightpathFlushBootstrapLogs?.();
  })
  .catch(function (error: unknown) {
    window.clearTimeout(timer);
    log(
      __fpLogLevels__.ERROR,
      `dynamic import failed: ${formatUnknownError(error)}`
    );
  });

export {};
