import type { PostMessageFn } from "./WebviewSettingsSync";

/**
 * The originating client's scope for a single inbound webview message.
 *
 * This is captured **once**, when the message is dispatched, and then threaded
 * through every handler as an ordinary value. It deliberately replaces the
 * mutable `clientId` / `scopedPostMessage` fields the router used to swap in and
 * restore around each message: several dispatch entries are intentionally
 * fire-and-forget so long-running execution cannot deadlock the shared route
 * queue, and those handlers keep running after the restore. Any scope read that
 * happened after an `await` therefore saw the *next* (usually panel) client
 * rather than the one that sent the message — so a hosted browser client's
 * failure reply and republished revisions were posted to the panel instead, and
 * that client stayed wedged on a superseded `definitionRevision`.
 *
 * Passing the scope by value makes that drift unrepresentable. Handlers must
 * never reach back to the router for "the current client"; there is no such
 * thing, only the client this message came from.
 */
export interface WebviewClientContext {
  /** Identifies the sending client, e.g. `PANEL_CLIENT_ID` or "browser:1". */
  readonly clientId: string;
  /** Transport back to the sending client, and only that client. */
  readonly postMessage: PostMessageFn;
  /** Convenience wrapper over {@link postMessage}. */
  emit(message: unknown): void;
}

export function createWebviewClientContext(
  clientId: string,
  postMessage: PostMessageFn
): WebviewClientContext {
  return {
    clientId,
    postMessage,
    emit: (message) => postMessage(message),
  };
}
