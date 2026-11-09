import { NODE_ERROR_CODES } from "../types/DashboardConstants";
import { hasErrnoCode } from "./ErrorUtils";
/** Return whether a child-process error represents a timeout. */
export function isSubprocessTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const subprocessError = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    originalError?: unknown;
  };
  if (
    hasErrnoCode(subprocessError, NODE_ERROR_CODES.ETIMEDOUT) ||
    (subprocessError.killed === true &&
      typeof subprocessError.signal === "string")
  ) {
    return true;
  }
  return subprocessError.originalError !== undefined
    ? isSubprocessTimeoutError(subprocessError.originalError)
    : false;
}
