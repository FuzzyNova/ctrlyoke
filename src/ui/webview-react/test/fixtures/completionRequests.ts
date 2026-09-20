import type { Mock } from "vitest";

/**
 * The most recent posted message matching `predicate`.
 *
 * Completion requests supersede each other: `useCompletionRequest` resolves and
 * forgets the previous in-flight request every time the source is queried
 * again, so only the newest `seq` is still in its pending map. CodeMirror may
 * query more than once for the same document text — an extra activation tick, a
 * re-render, a slow machine — which means a test that answers the *first*
 * matching request answers one the component has already discarded, and the
 * dropdown never appears. That failure is load-dependent, so it surfaces as a
 * flake under a full `npm test` and passes in isolation.
 *
 * Reaching for the last match is therefore not a tie-breaker: it is the only
 * request the component is still listening for.
 */
export function latestPostedMessage<T = Record<string, unknown>>(
  postMessage: Mock,
  predicate: (message: T) => boolean
): T {
  for (let index = postMessage.mock.calls.length - 1; index >= 0; index -= 1) {
    const message = postMessage.mock.calls[index]?.[0] as T | undefined;
    if (message !== undefined && predicate(message)) {
      return message;
    }
  }
  throw new Error("No posted message matched the predicate");
}
