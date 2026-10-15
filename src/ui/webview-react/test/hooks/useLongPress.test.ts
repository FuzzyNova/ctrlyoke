import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "@hooks/useLongPress";

function touchEvent(touchCount: number): React.TouchEvent {
  const touches = Array.from({ length: touchCount }, (_, index) => ({
    clientX: 10 + index,
    clientY: 20 + index,
  }));
  return {
    touches: Object.assign(touches, { item: (index: number) => touches[index] }),
    target: null,
    currentTarget: null,
  } as unknown as React.TouchEvent;
}

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a pending timer when a second touch starts", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback));

    act(() => {
      result.current.onTouchStart(touchEvent(1));
      result.current.onTouchStart(touchEvent(2));
      result.current.onTouchEnd();
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("clears a pending timer when the hook unmounts", () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress(callback));

    act(() => result.current.onTouchStart(touchEvent(1)));
    unmount();

    act(() => vi.advanceTimersByTime(500));
    expect(callback).not.toHaveBeenCalled();
  });
});
