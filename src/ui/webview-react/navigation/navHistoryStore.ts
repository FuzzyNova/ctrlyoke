/**
 * In-memory navigation stack for back/forward controls.
 *
 * This is pure history bookkeeping — it records Route transitions and walks
 * back/forward through them, but does NOT apply routes to any store or the URL.
 * The sync layer (browser History integration / popstate handling) owns
 * applying the Route returned by `back()`/`forward()`. Keeping this store free
 * of side effects makes the stack semantics easy to test and lets the VS Code
 * webview (which has no address bar) share the exact same forward/back model as
 * the hosted browser client.
 *
 * Semantics mirror a browser session-history stack:
 *  - `record` pushes a new entry and clears the forward stack
 *  - recording the current route again is a no-op (no duplicate entries)
 *  - `back`/`forward` move the cursor and return the now-current Route
 */
import { create } from "zustand";
import type { Route } from "./route";
import { routesEqual } from "./route";

interface NavHistoryState {
  /** Entries behind the cursor; last element is the most recent past. */
  past: Route[];
  /** The current location, or null before the first `record`. */
  current: Route | null;
  /** Entries ahead of the cursor; first element is the next `forward`. */
  future: Route[];
}

interface NavHistoryActions {
  /** Record a navigation to `route`, clearing any forward history. */
  record(route: Route): void;
  /** Replace the current route without adding a back/forward step. */
  replace(route: Route): void;
  /** Step back one entry; returns the new current Route, or null at the start. */
  back(): Route | null;
  /** Step forward one entry; returns the new current Route, or null at the tip. */
  forward(): Route | null;
  /** Clear the entire stack. */
  reset(): void;
}

const INITIAL_STATE: NavHistoryState = {
  past: [],
  current: null,
  future: [],
};

export const useNavHistoryStore = create<NavHistoryState & NavHistoryActions>()(
  (set, get) => ({
    ...INITIAL_STATE,

    record(route) {
      const { past, current } = get();
      if (current && routesEqual(current, route)) return;
      set({
        past: current ? [...past, current] : past,
        current: route,
        future: [],
      });
    },

    replace(route) {
      set({ current: route });
    },

    back() {
      const { past, current, future } = get();
      if (past.length === 0) return null;
      const previous = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        current: previous,
        future: current ? [current, ...future] : future,
      });
      return previous;
    },

    forward() {
      const { past, current, future } = get();
      if (future.length === 0) return null;
      const next = future[0];
      set({
        past: current ? [...past, current] : past,
        current: next,
        future: future.slice(1),
      });
      return next;
    },

    reset() {
      set({ ...INITIAL_STATE });
    },
  })
);

/** Selector: whether a `back()` step is possible. */
export const canGoBack = (s: NavHistoryState): boolean => s.past.length > 0;

/** Selector: whether a `forward()` step is possible. */
export const canGoForward = (s: NavHistoryState): boolean =>
  s.future.length > 0;
