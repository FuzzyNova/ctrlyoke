import { describe, it, expect, beforeEach } from "vitest";
import {
  useBrowserHistoryStore,
  canGoBackBrowser,
  canGoForwardBrowser,
} from "@/navigation/browserHistoryStore";

beforeEach(() => {
  useBrowserHistoryStore.getState().reset();
});

function state() {
  return useBrowserHistoryStore.getState();
}

describe("browserHistoryStore", () => {
  it("starts at idx 0 / length 1 with no back or forward", () => {
    expect(state().idx).toBe(0);
    expect(state().length).toBe(1);
    expect(canGoBackBrowser(state())).toBe(false);
    expect(canGoForwardBrowser(state())).toBe(false);
  });

  it("enables back after advancing to the tip", () => {
    state().set({ idx: 1, length: 2 });
    expect(canGoBackBrowser(state())).toBe(true);
    expect(canGoForwardBrowser(state())).toBe(false);
  });

  it("enables forward when the cursor is behind the tip", () => {
    state().set({ idx: 2, length: 3 });
    state().setIdx(1);
    expect(canGoBackBrowser(state())).toBe(true);
    expect(canGoForwardBrowser(state())).toBe(true);
  });

  it("reset returns to the start", () => {
    state().set({ idx: 3, length: 4 });
    state().reset();
    expect(state().idx).toBe(0);
    expect(state().length).toBe(1);
  });
});
