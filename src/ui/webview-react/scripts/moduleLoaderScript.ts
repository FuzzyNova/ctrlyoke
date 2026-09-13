// Dynamically imports the Vite bundle entry point with watchdog reload timers.
// __cyModuleSrc__ is injected as a const in the wrapping <script type="module">
// by CtrlYokeWebviewProvider._getHtmlForWebview before this IIFE runs.
// No imports; compiled as a standalone IIFE.
declare const __cyModuleSrc__: string;
declare const __cyLogLevels__: {
  WARN: string;
  ERROR: string;
};

type ModuleLoaderWindow = Window &
  typeof globalThis & {
    __ctrlyokeStandalone?: boolean;
    __ctrlyokeReactMounted?: boolean;
    __ctrlyokePanelHandshakeDone?: boolean;
    __ctrlyokeBootstrapLog?: (level: string, message: string) => void;
    __ctrlyokeFlushBootstrapLogs?: () => void;
  };

const ctrlyokeWindow = window as ModuleLoaderWindow;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function log(level: string, message: string): void {
  const fullMessage = `[moduleLoader] ${message}`;
  const logger = ctrlyokeWindow.__ctrlyokeBootstrapLog;
  if (typeof logger === "function") {
    logger(level, fullMessage);
    return;
  }
  if (level === __cyLogLevels__.ERROR) {
    console.error(fullMessage);
    return;
  }
  console.warn(fullMessage);
}

const moduleTimeoutMs = 30_000;
const handshakeTimeoutMs = 20_000;
const recoveryCooldownMs = 10_000;
const recoverySessionKey = "ctrlyoke-panel-module-recovery-at";
const handshakeSessionKey = "ctrlyoke-panel-handshake-reload-at";

// Fires if the Vite bundle never mounts React (import failure, CSP block, etc.).
const timer = window.setTimeout(function () {
  if (!ctrlyokeWindow.__ctrlyokeReactMounted) {
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
        __cyLogLevels__.WARN,
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
if (!ctrlyokeWindow.__ctrlyokeStandalone) {
  window.setTimeout(function () {
    if (
      ctrlyokeWindow.__ctrlyokeReactMounted &&
      !ctrlyokeWindow.__ctrlyokePanelHandshakeDone
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
          __cyLogLevels__.WARN,
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

void import(__cyModuleSrc__)
  .then(function () {
    window.clearTimeout(timer);
    ctrlyokeWindow.__ctrlyokeFlushBootstrapLogs?.();
  })
  .catch(function (error: unknown) {
    window.clearTimeout(timer);
    log(
      __cyLogLevels__.ERROR,
      `dynamic import failed: ${formatUnknownError(error)}`
    );
  });

export {};
