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
    subprocessError.code === "ETIMEDOUT" ||
    (subprocessError.killed === true && typeof subprocessError.signal === "string")
  ) {
    return true;
  }
  return subprocessError.originalError !== undefined
    ? isSubprocessTimeoutError(subprocessError.originalError)
    : false;
}
