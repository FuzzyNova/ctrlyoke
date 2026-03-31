/**
 * Tests for useMediaQuery and useIsMobile hooks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery, useIsMobile } from "@hooks/useMediaQuery";

// ---------------------------------------------------------------------------
// matchMedia mock
// ---------------------------------------------------------------------------

function mockMatchMedia(matches: boolean) {
  const listeners: Array<(e: any) => void> = [];
  const mql = {
    matches,
    media: "",
    addEventListener: vi.fn((_event: string, cb: (e: any) => void) =>
      listeners.push(cb)
    ),
    removeEventListener: vi.fn((_event: string, cb: (e: any) => void) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    dispatchEvent: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    mql,
    listeners,
    triggerChange: (newMatches: boolean) => {
      mql.matches = newMatches;
      listeners.forEach((cb) => cb({ matches: newMatches }));
    },
  };
}

// ---------------------------------------------------------------------------
// useMediaQuery
// ---------------------------------------------------------------------------

describe("useMediaQuery", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("returns true when media query matches", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(true);
  });

  it("returns false when media query does not match", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));
    expect(result.current).toBe(false);
  });

  it("updates when media query changes", () => {
    const { triggerChange } = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 639px)"));

    expect(result.current).toBe(false);

    act(() => {
      triggerChange(true);
    });

    expect(result.current).toBe(true);
  });

  it("cleans up listener on unmount", () => {
    const { mql } = mockMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 639px)"));

    expect(mql.addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });

  it("passes the query string to window.matchMedia", () => {
    mockMatchMedia(false);
    renderHook(() => useMediaQuery("(min-width: 1024px)"));

    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
  });

  it("re-subscribes when query changes", () => {
    const { mql } = mockMatchMedia(false);
    const { rerender } = renderHook(
      ({ query }) => useMediaQuery(query),
      { initialProps: { query: "(max-width: 639px)" } }
    );

    const initialRemoveCalls = mql.removeEventListener.mock.calls.length;

    rerender({ query: "(min-width: 1024px)" });

    // Old listener removed, new one added
    expect(mql.removeEventListener.mock.calls.length).toBeGreaterThan(
      initialRemoveCalls
    );
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
  });
});

// ---------------------------------------------------------------------------
// useIsMobile
// ---------------------------------------------------------------------------

describe("useIsMobile", () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("returns true for narrow viewport", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 639px)");
  });

  it("returns false for wide viewport", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });
});
