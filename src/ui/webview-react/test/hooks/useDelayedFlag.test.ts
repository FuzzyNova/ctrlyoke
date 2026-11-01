import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "@hooks/useDelayedFlag";

describe("useDelayedFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns true only after the value has stayed true for the delay", () => {
    const { result } = renderHook(({ value }) => useDelayedFlag(value, 500), {
      initialProps: { value: true },
    });

    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("never turns true for a value that drops back before the delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDelayedFlag(value, 500),
      { initialProps: { value: true } }
    );

    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ value: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(false);
  });

  it("turns false in the same render the value does", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDelayedFlag(value, 500),
      { initialProps: { value: true } }
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(true);

    rerender({ value: false });

    expect(result.current).toBe(false);
  });
});
