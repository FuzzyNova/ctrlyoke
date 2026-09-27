/** A Node-style filesystem error carrying `code`, for simulating fs failures. */
export function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
