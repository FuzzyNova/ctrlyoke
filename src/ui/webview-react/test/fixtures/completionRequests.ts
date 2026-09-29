import { waitFor } from "@testing-library/react";
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

interface AnswerLatestRequestOptions<TRequest extends { seq: number }> {
  postMessage: Mock;
  /** Selects the completion requests this answer is for. */
  isRequest: (message: TRequest) => boolean;
  /** The response message for `request`; it must echo `request.seq`. */
  respond: (request: TRequest) => unknown;
  /** Throws until the answered completions are visible. */
  until: () => void;
}

/**
 * Answer the newest matching completion request, and keep answering whichever
 * request is newest until `until` passes.
 *
 * Answering once is not enough under load: CodeMirror can query the source
 * again *after* the test has answered (a late activation tick for the last
 * keystroke), which discards the answered request before its result renders
 * (see `latestPostedMessage`). Re-answering on every `waitFor` poll tracks the
 * component instead of racing its scheduler. Each request is answered once, so
 * a component that ignores its own current `seq` still fails.
 */
export async function answerLatestRequestUntil<
  TRequest extends { seq: number },
>({
  postMessage,
  isRequest,
  respond,
  until,
}: AnswerLatestRequestOptions<TRequest>): Promise<void> {
  const answered = new Set<number>();
  await waitFor(() => {
    const request = latestPostedMessage<TRequest>(postMessage, isRequest);
    if (!answered.has(request.seq)) {
      answered.add(request.seq);
      // A plain dispatch, not fireEvent: fireEvent wraps the event in act(),
      // which React rejects while waitFor is polling.
      window.dispatchEvent(
        new MessageEvent("message", { data: respond(request) })
      );
    }
    until();
  });
}
