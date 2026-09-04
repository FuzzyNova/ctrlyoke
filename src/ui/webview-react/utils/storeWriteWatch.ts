import { WebviewLog } from "./logger";

/**
 * Diagnostic-only watcher for zustand stores that are read via a
 * no-selector `useXStore()` call somewhere in the tree (see
 * webview-react-store.instructions.md's stable-selector gotcha) — any write
 * to a watched store re-renders every one of those subscribers, so a runaway
 * writer anywhere in the app can masquerade as a bug in an unrelated,
 * unmemoized component (e.g. EditorFooter's quick pickers).
 *
 * Logs every write at TRACE (only persisted when the user has enabled
 * ctrlyoke's Trace log level + `ctrlyoke.enableDiagnosticLogs`, so this is
 * safe to leave attached to a production install) and escalates to WARN
 * the moment a store crosses a burst threshold, so the culprit shows up in
 * `.ctrlyoke/logs/` even without trawling a huge trace log by hand.
 */
export function watchStoreWrites<T extends object>(
  store: {
    subscribe: (listener: (state: T, prevState: T) => void) => () => void;
  },
  name: string,
  { burstThreshold = 15, windowMs = 500 } = {}
): () => void {
  let windowStart = Date.now();
  let windowCount = 0;
  let burstLogged = false;

  return store.subscribe((state, prevState) => {
    const prevRecord = prevState as Record<string, unknown>;
    const nextRecord = state as Record<string, unknown>;
    const changedKeys: string[] = [];
    const keys = new Set([
      ...Object.keys(prevRecord),
      ...Object.keys(nextRecord),
    ]);
    for (const key of keys) {
      if (!Object.is(prevRecord[key], nextRecord[key])) {
        changedKeys.push(key);
      }
    }
    if (changedKeys.length === 0) return;

    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      windowCount = 0;
      burstLogged = false;
    }
    windowCount += 1;

    WebviewLog.trace(
      `[StoreWatch] ${name} changed: [${changedKeys.join(", ")}] (${windowCount} writes in current ${windowMs}ms window)`
    );

    if (windowCount >= burstThreshold && !burstLogged) {
      burstLogged = true;
      WebviewLog.warn(
        `[StoreWatch] BURST: ${name} updated ${windowCount}x within ${windowMs}ms — likely re-render storm. Most recently changed keys: [${changedKeys.join(", ")}]`
      );
    }
  });
}
