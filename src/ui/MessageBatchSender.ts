import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  BatchedDashboardMessage,
  MessageBatchMessage,
} from "../types/WebviewMessageTypes";
import type { PostMessageFn } from "./WebviewSettingsSync";

/**
 * Runs `emit` with a collecting send function and delivers everything it sent
 * through `send` as ONE `MESSAGE_BATCH` message, in emission order.
 *
 * Each inbound message is its own task in the webview, so React renders after
 * every one of them; a burst such as a live output replay (one `CLI_OUTPUT`
 * per completed attempt) would otherwise rebuild the whole output row model
 * once per message. The webview dispatches the batch's members in order
 * within one render.
 *
 * `emit` must send synchronously — anything it sends after returning (from a
 * promise continuation) still goes straight to `send`, unbatched, so it is
 * never lost but may then arrive after the batch. A lone message is sent as
 * itself, and nothing is sent when `emit` sends nothing. If `emit` throws,
 * what it already sent is still delivered before the error propagates.
 *
 * Redaction is unaffected: the panel and hosted transports redact the whole
 * outgoing value recursively, members included.
 */
export function sendAsMessageBatch(
  send: PostMessageFn,
  emit: (batchSend: PostMessageFn) => void
): void {
  let collected: BatchedDashboardMessage[] | undefined = [];
  const batchSend: PostMessageFn = (message) => {
    if (collected) {
      collected.push(message);
    } else {
      send(message);
    }
  };
  try {
    emit(batchSend);
  } finally {
    const messages = collected;
    collected = undefined;
    if (messages.length === 1) {
      send(messages[0]);
    } else if (messages.length > 1) {
      const batch: MessageBatchMessage = {
        type: MESSAGE_TYPES.MESSAGE_BATCH,
        messages,
      };
      send(batch);
    }
  }
}
