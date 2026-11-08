import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";

function buttonRefAt(top: number, bottom: number) {
  const button = document.createElement("button");
  button.getBoundingClientRect = () =>
    ({
      top,
      bottom,
      left: 10,
      right: 50,
      width: 40,
      height: bottom - top,
      x: 10,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  return { current: button };
}

describe("useDropdownPortalPosition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens below when the visible area has room", () => {
    vi.stubGlobal("innerHeight", 800);
    // One stable ref: a new ref per render would re-run the hook's effect.
    const ref = buttonRefAt(100, 130);
    const { result } = renderHook(() =>
      useDropdownPortalPosition(ref, true, "300px")
    );
    expect(result.current).toMatchObject({ top: 134, maxHeight: 300 });
  });

  it("flips above when the on-screen keyboard covers the space below", () => {
    // iOS keeps the layout viewport at full height while the keyboard is up;
    // only the visual viewport shrinks. Measured against innerHeight there
    // would be ~370px below the button, all of it behind the keyboard.
    vi.stubGlobal("innerHeight", 800);
    const visualViewport = Object.assign(new EventTarget(), {
      height: 450,
      offsetTop: 0,
    });
    vi.stubGlobal("visualViewport", visualViewport);

    const ref = buttonRefAt(400, 430);
    const { result } = renderHook(() =>
      useDropdownPortalPosition(ref, true, "300px")
    );

    expect(result.current?.top).toBeUndefined();
    expect(result.current).toMatchObject({ bottom: 404, maxHeight: 300 });
  });
});
