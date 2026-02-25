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
    // VS Code API not yet available (early init) — fall back to console
    console[level](message, ...args);
  }
}

export const WebviewLog = {
  debug: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.DEBUG, message, ...args),
  info: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.INFO, message, ...args),
  warn: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.WARN, message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log(LOG_LEVELS.ERROR, message, ...args),
};
