import { isMainThread, parentPort } from "worker_threads";
import {
  HISTORY_SEARCH_MATCHER_MESSAGE_TYPES,
  RegexHistorySearchMatcher,
  type HistorySearchMatch,
  type HistorySearchMatcherWorkerMessage,
} from "./HistorySearchMatcher";

const port = parentPort;

if (!isMainThread && port) {
  let matcher: RegexHistorySearchMatcher | undefined;

  port.on("message", (message: HistorySearchMatcherWorkerMessage) => {
    if (message.type === HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.INIT) {
      try {
        matcher = new RegexHistorySearchMatcher(message.pattern);
        port.postMessage({
          type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.READY,
        });
      } catch (error) {
        port.postMessage({
          type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.CANDIDATE) {
      if (!matcher) {
        port.postMessage({
          type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.ERROR,
          message: "History search matcher worker was not initialized",
        });
        return;
      }
      const match: HistorySearchMatch | undefined = matcher.find(message.text);
      port.postMessage({
        type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.RESULT,
        requestId: message.requestId,
        match,
      });
      return;
    }
    if (message.type === HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.END) {
      port.close();
    }
  });
}
