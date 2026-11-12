import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { useDrawerTransition } from "@hooks/useDrawerTransition";

describe("useDrawerTransition", () => {
  afterEach(() => vi.useRealTimers());

  it("slides in only when the entry is animated", () => {
    const { result } = renderHook(() => useDrawerTransition(vi.fn()));
    act(() => result.current.enter(false));
    expect(result.current.className).toBe("");
    act(() => result.current.enter(true));
    expect(result.current.className).toBe("animate-slide-in-right");
  });

  it("finishes the exit on its own animationend", () => {
    const onExited = vi.fn();
    const { result } = renderHook(() => useDrawerTransition(onExited));
    act(() => result.current.leave());
    expect(result.current.isLeaving).toBe(true);
    expect(result.current.className).toContain("animate-slide-out-right");

    const child = {} as EventTarget;
    const self = {} as EventTarget;
    act(() =>
      result.current.onAnimationEnd({
        target: child,
        currentTarget: self,
      } as unknown as React.AnimationEvent<HTMLElement>)
    );
    expect(onExited).not.toHaveBeenCalled();

    act(() =>
      result.current.onAnimationEnd({
        target: self,
        currentTarget: self,
      } as unknown as React.AnimationEvent<HTMLElement>)
    );
    expect(onExited).toHaveBeenCalledTimes(1);
    expect(result.current.isLeaving).toBe(false);
  });

  it("falls back to a timer when animationend never fires", () => {
    vi.useFakeTimers();
    const onExited = vi.fn();
    const { result } = renderHook(() => useDrawerTransition(onExited));
    act(() => result.current.leave());
    act(() => {
      vi.advanceTimersByTime(321);
    });
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it("reset drops a pending exit without calling onExited", () => {
    vi.useFakeTimers();
    const onExited = vi.fn();
    const { result } = renderHook(() => useDrawerTransition(onExited));
    act(() => result.current.leave());
    act(() => result.current.reset());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onExited).not.toHaveBeenCalled();
    expect(result.current.isLeaving).toBe(false);
  });
});
