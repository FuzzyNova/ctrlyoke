import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnchoredPopupPosition } from "@hooks/useAnchoredPopupPosition";

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

function makeAnchor(rect: Partial<DOMRect>): HTMLElement {
  const anchor = document.createElement("button");
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    bottom: 100,
    height: 40,
    left: 100,
    right: 200,
    top: 60,
    width: 100,
    x: 100,
    y: 60,
    toJSON: () => ({}),
    ...rect,
  });
  return anchor;
}

describe("useAnchoredPopupPosition", () => {
  beforeEach(() => setViewport(800, 600));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes drop-up coordinates and clamps the popup horizontally", () => {
    const anchor = makeAnchor({ left: 760, top: 300 });
    const anchorRef = { current: anchor };
    const { result } = renderHook(() =>
      useAnchoredPopupPosition(anchorRef, true, "top", "200px", "400px")
    );

    expect(result.current[0]).toEqual({
      bottom: 304,
      left: 396,
      maxHeight: 296,
      minWidth: 200,
      maxWidth: 400,
    });
  });

  it("computes mirrored drop-down coordinates", () => {
    const anchor = makeAnchor({ bottom: 220, left: 40, top: 180 });
    const anchorRef = { current: anchor };
    const { result } = renderHook(() =>
      useAnchoredPopupPosition(anchorRef, true, "bottom")
    );

    expect(result.current[0]).toEqual({
      top: 224,
      left: 40,
      maxHeight: 376,
      minWidth: undefined,
      maxWidth: 792,
    });
  });

  it("can match the anchor width while respecting viewport constraints", () => {
    const anchor = makeAnchor({ left: 760, width: 100, right: 860 });
    const anchorRef = { current: anchor };
    const { result } = renderHook(() =>
      useAnchoredPopupPosition(
        anchorRef,
        true,
        "bottom",
        undefined,
        "80px",
        true
      )
    );

    expect(result.current[0]).toMatchObject({
      left: 716,
      width: 80,
      maxWidth: 80,
    });
  });

  it("resets the position on close and re-measures when forced", () => {
    const anchor = makeAnchor({ top: 300 });
    const anchorRef = { current: anchor };
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) =>
        useAnchoredPopupPosition(anchorRef, isOpen, "top"),
      { initialProps: { isOpen: true } }
    );
    const initialPosition = result.current[0];

    rerender({ isOpen: false });
    expect(result.current[0]).toBeNull();

    vi.mocked(anchor.getBoundingClientRect).mockReturnValue({
      ...anchor.getBoundingClientRect(),
      top: 400,
    });
    rerender({ isOpen: true });
    act(() => result.current[1]());
    expect(result.current[0]).not.toEqual(initialPosition);
    expect(result.current[0]?.maxHeight).toBe(396);
  });

  it("detaches resize and capture-phase scroll listeners on close", () => {
    const anchor = makeAnchor({});
    const anchorRef = { current: anchor };
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) =>
        useAnchoredPopupPosition(anchorRef, isOpen, "top"),
      { initialProps: { isOpen: true } }
    );

    const resizeListener = addEventListener.mock.calls.find(
      ([type]) => type === "resize"
    )?.[1];
    const scrollListener = addEventListener.mock.calls.find(
      ([type]) => type === "scroll"
    )?.[1];
    expect(resizeListener).toBeDefined();
    expect(scrollListener).toBeDefined();

    rerender({ isOpen: false });

    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeListener);
    expect(removeEventListener).toHaveBeenCalledWith(
      "scroll",
      scrollListener,
      true
    );
  });

  it("detaches listeners on unmount", () => {
    const anchor = makeAnchor({});
    const anchorRef = { current: anchor };
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useAnchoredPopupPosition(anchorRef, true, "bottom")
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
      true
    );
  });

  it("returns null when the anchor has not been measured", () => {
    const anchorRef = { current: null };
    const { result } = renderHook(() =>
      useAnchoredPopupPosition(anchorRef, true, "top")
    );

    act(() => result.current[1]());

    expect(result.current[0]).toBeNull();
  });
});
