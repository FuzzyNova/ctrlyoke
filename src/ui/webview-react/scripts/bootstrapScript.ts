// Captured before the React bundle loads so the retained-panel reconnect path
// can reuse the latest API object. No imports — compiled as a standalone IIFE.
declare const __fpLogMessageType__: string;
declare const __fpLogLevels__: {
  DEBUG: string;
  INFO: string;
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
type FlightPathBootstrapWindow = Window &
  typeof globalThis & {
    vscodeApi?: VsCodeApiLike;
    acquireVsCodeApi?: () => VsCodeApiLike;
    __flightpathStandalone?: boolean;
    __flightpathBootstrapLogInstalled?: boolean;
    __flightpathBootstrapLogQueue?: BootstrapLogEntry[];
    __flightpathBootstrapLog?: (
      level: BootstrapLogLevel,
      message: string
    ) => void;
    __flightpathFlushBootstrapLogs?: () => void;
  };

const flightpathWindow = window as FlightPathBootstrapWindow;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function writeConsole(level: BootstrapLogLevel, message: string): void {
  if (level === __fpLogLevels__.ERROR) {
    console.error(message);
    return;
  }
  if (level === __fpLogLevels__.WARN) {
    console.warn(message);
    return;
  }
  if (level === __fpLogLevels__.INFO) {
    console.info(message);
    return;
  }
  console.debug(message);
}

function tryPostBootstrapLog(entry: BootstrapLogEntry): boolean {
  const api = flightpathWindow.vscodeApi;
  if (!api || typeof api.postMessage !== "function") {
    return false;
  }
  api.postMessage({
    type: __fpLogMessageType__,
    level: entry.level,
    message: entry.message,
  });
  return true;
}

function installBootstrapLogger(): void {
  if (flightpathWindow.__flightpathBootstrapLogInstalled) {
    return;
  }

  flightpathWindow.__flightpathBootstrapLogInstalled = true;
  const queue =
    flightpathWindow.__flightpathBootstrapLogQueue ??
    (flightpathWindow.__flightpathBootstrapLogQueue = []);

  const enqueueOrPost = (level: BootstrapLogLevel, message: string): void => {
    const entry = {
      level,
      message: `[bootstrap] ${message}`,
    };
    if (!tryPostBootstrapLog(entry)) {
      queue.push(entry);
    }
    writeConsole(level, entry.message);
  };

  flightpathWindow.__flightpathBootstrapLog = enqueueOrPost;
  flightpathWindow.__flightpathFlushBootstrapLogs = () => {
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
    enqueueOrPost(
      __fpLogLevels__.ERROR,
      `window error: ${event.message || "(no message)"} at ${event.filename || "(unknown)"}:${event.lineno || 0}:${event.colno || 0}`
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    enqueueOrPost(
      __fpLogLevels__.ERROR,
      `unhandled rejection: ${formatUnknownError(event.reason)}`
    );
  });

  document.addEventListener("readystatechange", () => {
    enqueueOrPost(
      __fpLogLevels__.DEBUG,
      `document readyState=${document.readyState}`
    );
  });

  window.addEventListener("DOMContentLoaded", () => {
    enqueueOrPost(__fpLogLevels__.DEBUG, "DOMContentLoaded");
  });

  window.addEventListener("load", () => {
    enqueueOrPost(__fpLogLevels__.DEBUG, "window load");
  });

  window.addEventListener("pageshow", (event) => {
    enqueueOrPost(
      __fpLogLevels__.DEBUG,
      `pageshow persisted=${event.persisted}`
    );
  });

  window.addEventListener("pagehide", (event) => {
    enqueueOrPost(
      __fpLogLevels__.WARN,
      `pagehide persisted=${event.persisted}`
    );
  });

  window.addEventListener("beforeunload", () => {
    enqueueOrPost(__fpLogLevels__.WARN, "beforeunload");
  });

  document.addEventListener("visibilitychange", () => {
    enqueueOrPost(
      __fpLogLevels__.DEBUG,
      `visibilitychange state=${document.visibilityState}`
    );
  });
}

installBootstrapLogger();
const bootstrapLog = flightpathWindow.__flightpathBootstrapLog;

bootstrapLog?.(
  __fpLogLevels__.DEBUG,
  `bootstrap script start standalone=${Boolean(flightpathWindow.__flightpathStandalone)}`
);

if (flightpathWindow.vscodeApi) {
  bootstrapLog?.(
    __fpLogLevels__.DEBUG,
    "window.vscodeApi already present before acquireVsCodeApi()"
  );
}

if (typeof flightpathWindow.acquireVsCodeApi !== "function") {
  bootstrapLog?.(
    __fpLogLevels__.WARN,
    "window.acquireVsCodeApi is unavailable before React bootstrap"
  );
} else if (!flightpathWindow.vscodeApi) {
  bootstrapLog?.(__fpLogLevels__.DEBUG, "calling acquireVsCodeApi()");
  try {
    flightpathWindow.vscodeApi = flightpathWindow.acquireVsCodeApi();
    bootstrapLog?.(
      __fpLogLevels__.DEBUG,
      flightpathWindow.vscodeApi
        ? "acquireVsCodeApi() succeeded"
        : "acquireVsCodeApi() returned no API object"
    );
    flightpathWindow.__flightpathFlushBootstrapLogs?.();
  } catch (error) {
    bootstrapLog?.(
      __fpLogLevels__.ERROR,
      `acquireVsCodeApi() threw: ${formatUnknownError(error)}`
    );
  }
}

export {};
