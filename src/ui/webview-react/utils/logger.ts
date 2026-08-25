import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  type WebviewLogLevel,
} from "@/types/messages";

function log(
  level: WebviewLogLevel,
  message: string,
  ...args: unknown[]
): void {
  const text = args.length > 0 ? `${message} ${JSON.stringify(args)}` : message;
  try {
    getVsCodeApi().postMessage({
      type: MESSAGE_TYPES.LOG_MESSAGE,
      level,
      message: text,
    });
  } catch {
    // VS Code API not yet available (early init) — forward through the
    // injected bootstrap logger if present so the extension session log still
    // captures startup failures before React fully connects.
    if (typeof window !== "undefined") {
      try {
        window.__ctrlyokeBootstrapLog?.(level, text);
        if (window.__ctrlyokeBootstrapLog) {
          return;
        }
      } catch {
        // Fall through to console output.
      }
    }

    if (level === LOG_LEVELS.ERROR) {
      console.error(message, ...args);
      return;
    }
    if (level === LOG_LEVELS.WARN) {
      console.warn(message, ...args);
      return;
    }
    if (level === LOG_LEVELS.INFO) {
      console.info(message, ...args);
      return;
    }
    if (level === LOG_LEVELS.TRACE) {
      console.debug(message, ...args);
      return;
    }
    // console.debug is filtered by default in webview DevTools (Verbose level
    // required), so use console.log to keep debug messages visible.
    console.log(message, ...args);
  }
}

export const WebviewLog = {
  trace: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.TRACE, message, ...args),
  debug: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.DEBUG, message, ...args),
  info: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.INFO, message, ...args),
  warn: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.WARN, message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.ERROR, message, ...args),
};
