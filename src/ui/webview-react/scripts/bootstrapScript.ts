// Captured before the React bundle loads so the retained-panel reconnect path
// can reuse the latest API object. No imports; compiled as a standalone IIFE.
declare const __cyLogMessageType__: string;
declare const __cyLogLevels__: {
  WARN: string;
  ERROR: string;
};

type BootstrapLogLevel = string;
type BootstrapLogEntry = {
  level: BootstrapLogLevel;
  message: string;
};
type VsCodeApiLike = {
  postMessage?: (message: unknown) => void;
};
type CtrlYokeBootstrapWindow = Window &
  typeof globalThis & {
    vscodeApi?: VsCodeApiLike;
    acquireVsCodeApi?: () => VsCodeApiLike;
    __ctrlyokeBootstrapLogInstalled?: boolean;
    __ctrlyokeBootstrapLogQueue?: BootstrapLogEntry[];
    __ctrlyokeBootstrapLog?: (
      level: BootstrapLogLevel,
      message: string
    ) => void;
    __ctrlyokeFlushBootstrapLogs?: () => void;
  };

const ctrlyokeWindow = window as CtrlYokeBootstrapWindow;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Browsers surface ResizeObserver delivery deferrals through the global
 * `error` event even though no exception escaped application code. The
 * observer will retry delivery on the next frame, so retain the diagnostic
 * without classifying it as an application failure.
 */
function isResizeObserverDeliveryWarning(message: string): boolean {
  return (
    message ===
      "ResizeObserver loop completed with undelivered notifications." ||
    message === "ResizeObserver loop limit exceeded"
  );
}

function writeConsole(level: BootstrapLogLevel, message: string): void {
  if (level === __cyLogLevels__.ERROR) {
    console.error(message);
    return;
  }
  console.warn(message);
}

function tryPostBootstrapLog(entry: BootstrapLogEntry): boolean {
  const api = ctrlyokeWindow.vscodeApi;
  if (!api || typeof api.postMessage !== "function") {
    return false;
  }
  api.postMessage({
    type: __cyLogMessageType__,
    level: entry.level,
    message: entry.message,
  });
  return true;
}

function installBootstrapLogger(): void {
  if (ctrlyokeWindow.__ctrlyokeBootstrapLogInstalled) {
    return;
  }

  ctrlyokeWindow.__ctrlyokeBootstrapLogInstalled = true;
  const queue =
    ctrlyokeWindow.__ctrlyokeBootstrapLogQueue ??
    (ctrlyokeWindow.__ctrlyokeBootstrapLogQueue = []);

  const enqueueOrPost = (level: BootstrapLogLevel, message: string): void => {
    const prefixedMessage = `[bootstrap] ${message}`;
    if (level !== __cyLogLevels__.WARN && level !== __cyLogLevels__.ERROR) {
      console.debug(prefixedMessage);
      return;
    }

    const entry = {
      level,
      message: prefixedMessage,
    };
    if (!tryPostBootstrapLog(entry)) {
      queue.push(entry);
    }
    writeConsole(level, entry.message);
  };

  ctrlyokeWindow.__ctrlyokeBootstrapLog = enqueueOrPost;
  ctrlyokeWindow.__ctrlyokeFlushBootstrapLogs = () => {
    if (queue.length === 0) {
      return;
    }
    let writeIndex = 0;
    for (const entry of queue) {
      if (!tryPostBootstrapLog(entry)) {
        queue[writeIndex++] = entry;
      }
    }
    queue.length = writeIndex;
  };

  window.addEventListener("error", (event) => {
    const message = event.message || "(no message)";
    const isDeliveryWarning = isResizeObserverDeliveryWarning(message);
    enqueueOrPost(
      isDeliveryWarning ? __cyLogLevels__.WARN : __cyLogLevels__.ERROR,
      `${isDeliveryWarning ? "browser warning" : "window error"}: ${message} at ${event.filename || "(unknown)"}:${event.lineno || 0}:${event.colno || 0}`
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    enqueueOrPost(
      __cyLogLevels__.ERROR,
      `unhandled rejection: ${formatUnknownError(event.reason)}`
    );
  });
}

installBootstrapLogger();

if (typeof ctrlyokeWindow.acquireVsCodeApi !== "function") {
  if (!ctrlyokeWindow.vscodeApi) {
    ctrlyokeWindow.__ctrlyokeBootstrapLog?.(
      __cyLogLevels__.WARN,
      "window.acquireVsCodeApi is unavailable before React bootstrap"
    );
  }
} else if (!ctrlyokeWindow.vscodeApi) {
  try {
    ctrlyokeWindow.vscodeApi = ctrlyokeWindow.acquireVsCodeApi();
    ctrlyokeWindow.__ctrlyokeFlushBootstrapLogs?.();
  } catch (error) {
    ctrlyokeWindow.__ctrlyokeBootstrapLog?.(
      __cyLogLevels__.ERROR,
      `acquireVsCodeApi() threw: ${formatUnknownError(error)}`
    );
  }
}

export {};
