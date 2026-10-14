// Dynamically imports the Vite bundle entry point with watchdog recovery timers.
// __cyModuleSrc__ and __cyPanelReloadRequestType__ are injected as consts in the
// wrapping <script type="module"> by CtrlYokeWebviewProvider._getHtmlForWebview
// before this IIFE runs. No imports; compiled as a standalone IIFE.
declare const __cyModuleSrc__: string;
declare const __cyPanelReloadRequestType__: string;
declare const __cyLogLevels__: {
  WARN: string;
  ERROR: string;
};

type ModuleLoaderWindow = Window &
  typeof globalThis & {
    vscodeApi?: { postMessage?: (message: unknown) => void };
    __ctrlyokeStandalone?: boolean;
    __ctrlyokeReactMounted?: boolean;
    __ctrlyokePanelHandshakeDone?: boolean;
    __ctrlyokeRetryPanelHandshake?: () => void;
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

// Fires if the Vite bundle never mounts React (import failure, CSP block, etc.).
// Nothing in this page can recover it: a VS Code webview's content frame is
// VS Code's empty fake.html with our HTML document.write()n into it, so
// location.reload() blanks the panel for good. Ask the extension to reassign
// webview.html instead; it owns the rate limit, so a bundle that never mounts
// cannot put the panel into a rebuild loop.
const timer = window.setTimeout(function () {
  if (!ctrlyokeWindow.__ctrlyokeReactMounted) {
    log(
      __cyLogLevels__.WARN,
      "module-mount watchdog fired before React mount; requesting a panel rebuild"
    );
    try {
      ctrlyokeWindow.vscodeApi?.postMessage?.({
        type: __cyPanelReloadRequestType__,
      });
    } catch (error) {
      log(
        __cyLogLevels__.ERROR,
        `panel rebuild request failed: ${formatUnknownError(error)}`
      );
    }
  }
}, moduleTimeoutMs);

// Fires if React mounted but the extension never completed the READY handshake.
// Skip standalone browser clients; their WebSocket bridge owns reconnects.
// It re-runs the handshake in place rather than reloading: a reload of a VS Code
// webview's content frame loads VS Code's empty fake.html and never comes back.
if (!ctrlyokeWindow.__ctrlyokeStandalone) {
  window.setTimeout(function () {
    if (
      ctrlyokeWindow.__ctrlyokeReactMounted &&
      !ctrlyokeWindow.__ctrlyokePanelHandshakeDone
    ) {
      log(
        __cyLogLevels__.WARN,
        "handshake watchdog fired after React mount without CLIENT_ID_ASSIGNED; re-sending READY"
      );
      ctrlyokeWindow.__ctrlyokeRetryPanelHandshake?.();
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
