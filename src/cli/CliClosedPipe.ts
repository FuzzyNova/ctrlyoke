/**
 * Exit status when the reader of stdout goes away, as in
 * `ctrlyoke history show --json --events | head -3`. The reader asked for
 * less output than the command had; nothing failed, so the command succeeds.
 */
export const CLI_CLOSED_PIPE_EXIT_CODE = 0;

const EPIPE = "EPIPE";

const guardedStreams = new WeakSet<NodeJS.EventEmitter>();

/** Whether an error is the write failure a closed pipe produces. */
export function isClosedPipeError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === EPIPE
  );
}

/**
 * Exit quietly instead of crashing with an unhandled `EPIPE` stack trace when
 * the stream's reader closes early. Node reports the failed write as an
 * `error` event on the stream, not as an exception at the write call, so the
 * guard has to be a listener. Installing it twice on one stream is a no-op;
 * any other stream error is rethrown unchanged.
 */
export function exitQuietlyOnClosedPipe(
  stream: NodeJS.EventEmitter = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on("error", (error: unknown) => {
    if (isClosedPipeError(error)) {
      exit(CLI_CLOSED_PIPE_EXIT_CODE);
      return;
    }
    throw error;
  });
}
