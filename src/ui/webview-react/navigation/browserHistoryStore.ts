/**
 * Tracks our position within the browser session history so the back/forward
 * controls can show correct enabled states — the History API exposes no way to
 * query whether a back/forward step is possible.
 *
 * `idx` is the current entry's index (stamped into `history.state`); `length`
 * is one past the furthest index reached. A new navigation truncates forward
 * history, mirroring the browser.
 */
import { create } from "zustand";

interface BrowserHistoryState {
  idx: number;
  length: number;
}

interface BrowserHistoryActions {
  /** Set both index and length (used on a forward-truncating push). */
  set(next: BrowserHistoryState): void;
  /** Move the cursor without changing length (used on popstate). */
  setIdx(idx: number): void;
  reset(): void;
}

const INITIAL_STATE: BrowserHistoryState = { idx: 0, length: 1 };

export const useBrowserHistoryStore = create<
  BrowserHistoryState & BrowserHistoryActions
>()((set) => ({
  ...INITIAL_STATE,
  set: (next) => set(next),
  setIdx: (idx) => set({ idx }),
  reset: () => set({ ...INITIAL_STATE }),
}));

export const canGoBackBrowser = (s: BrowserHistoryState): boolean => s.idx > 0;

export const canGoForwardBrowser = (s: BrowserHistoryState): boolean =>
  s.idx < s.length - 1;
