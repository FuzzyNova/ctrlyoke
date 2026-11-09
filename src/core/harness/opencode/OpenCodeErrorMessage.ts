/** Extract the provider message from OpenCode 1 and 2 error shapes. */
export function getOpenCodeErrorMessage(error: unknown): string | undefined {
  const details = error as
    | { name?: unknown; message?: unknown; data?: { message?: unknown } }
    | undefined;
  const message = details?.data?.message ?? details?.message ?? details?.name;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : undefined;
}
