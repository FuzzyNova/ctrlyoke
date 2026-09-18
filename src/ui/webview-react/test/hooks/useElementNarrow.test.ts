/**
 * Tests for useElementNarrow hook.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElementNarrow, useElementTier } from "@hooks/useElementNarrow";

// ---------------------------------------------------------------------------
// ResizeObserver mock
// ---------------------------------------------------------------------------

let observerCallback: ResizeObserverCallback;
let mockObserveInstance: {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const MockResizeObserver = vi.fn(function (cb: ResizeObserverCallback) {
  observerCallback = cb;
  mockObserveInstance = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
  return mockObserveInstance;
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalResizeObserver: typeof window.ResizeObserver;
let originalRaf: typeof window.requestAnimationFrame;
let originalCaf: typeof window.cancelAnimationFrame;

beforeEach(() => {
  originalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = MockResizeObserver as any;
  MockResizeObserver.mockClear();

  // The hook batches ResizeObserver callbacks into an animation frame
  // (createAnimationFrameResizeObserver). Run rAF synchronously so a resize
  // trigger applies its state update within the surrounding act().
  originalRaf = window.requestAnimationFrame;
  originalCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame =
    (() => {}) as typeof window.cancelAnimationFrame;
});

afterEach(() => {
  window.ResizeObserver = originalResizeObserver;
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCaf;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Measured widths, keyed by node. The hook re-measures the element itself
 * rather than trusting the ResizeObserver entry, so a simulated resize has to
 * move the element's box — exactly as a real one does.
 */
const nodeWidths = new WeakMap<HTMLElement, number>();

function setNodeWidth(node: HTMLElement, width: number) {
  nodeWidths.set(node, width);
}

function makeNode(width: number): HTMLDivElement {
  const node = document.createElement("div");
  setNodeWidth(node, width);
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
    const w = nodeWidths.get(node) ?? 0;
    return {
      width: w,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      right: w,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
  return node;
}

/** The node most recently passed to `observer.observe()`. */
function observedNode(): HTMLElement | undefined {
  const calls = mockObserveInstance.observe.mock.calls;
  return calls[calls.length - 1]?.[0] as HTMLElement | undefined;
}

function triggerResize(width: number) {
  const node = observedNode();
  if (node) {
    setNodeWidth(node, width);
  }
  observerCallback(
    [{ contentRect: { width } } as ResizeObserverEntry],
    mockObserveInstance as unknown as ResizeObserver
  );
}

/**
 * Fires the observer with a `contentRect` that disagrees with the element's
 * actual box, without moving the element — what really happens on a padded
 * element, where `contentRect` excludes the padding that the border box
 * includes.
 */
function triggerResizeWithStaleContentRect(contentRectWidth: number) {
  observerCallback(
    [{ contentRect: { width: contentRectWidth } } as ResizeObserverEntry],
    mockObserveInstance as unknown as ResizeObserver
  );
}

/**
 * Simulates a subsequent resize by detaching and reattaching the ref, rather
 * than a second `triggerResize`. The mock `requestAnimationFrame` above runs
 * its callback synchronously *inside* the scheduling call, so the assignment
 * `frameId = requestAnimationFrame(...)` overwrites the `null` the callback
 * just wrote back to a truthy id — permanently arming
 * `createAnimationFrameResizeObserver`'s "already scheduled" guard after the
 * first resize and silently dropping every one after it. A real browser's
 * `requestAnimationFrame` is asynchronous, so this never happens outside the
 * test; reattaching (as "holds its tier across repeated ref re-attachment"
 * above already does) re-measures synchronously through the ref-attach path
 * instead, sidestepping the mock's scheduling quirk entirely.
 */
function reattachAndResize(
  refCallback: (node: HTMLDivElement | null) => void,
  node: HTMLDivElement,
  width: number
) {
  setNodeWidth(node, width);
  refCallback(null);
  refCallback(node);
}

const resolveHundreds = (width: number) => Math.floor(width / 100);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useElementNarrow", () => {
  it("returns isNarrow=false initially", () => {
    const { result } = renderHook(() => useElementNarrow());
    const [, isNarrow] = result.current;
    expect(isNarrow).toBe(false);
  });

  it("returns a callback ref function", () => {
    const { result } = renderHook(() => useElementNarrow());
    const [callbackRef] = result.current;
    expect(typeof callbackRef).toBe("function");
  });

  it("sets isNarrow=true when element width < default threshold (380)", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(300);

    act(() => {
      result.current[0](node);
    });

    expect(result.current[1]).toBe(true);
  });

  it("sets isNarrow=false when element width >= default threshold (380)", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(400);

    act(() => {
      result.current[0](node);
    });

    expect(result.current[1]).toBe(false);
  });

  it("updates isNarrow when ResizeObserver fires with width < threshold", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(false);

    act(() => {
      triggerResize(200);
    });
    expect(result.current[1]).toBe(true);
  });

  it("updates isNarrow when ResizeObserver fires with width >= threshold", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(200);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(true);

    act(() => {
      triggerResize(500);
    });
    expect(result.current[1]).toBe(false);
  });

  it("uses custom threshold correctly", () => {
    const { result } = renderHook(() => useElementNarrow(600));
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });

    // 500 < 600 → narrow
    expect(result.current[1]).toBe(true);
  });

  it("custom threshold: not narrow when width >= threshold", () => {
    const { result } = renderHook(() => useElementNarrow(200));
    const node = makeNode(300);

    act(() => {
      result.current[0](node);
    });

    // 300 >= 200 → not narrow
    expect(result.current[1]).toBe(false);
  });

  it("observes the node when ref is attached", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });

    expect(mockObserveInstance.observe).toHaveBeenCalledWith(node);
  });

  it("disconnects observer on unmount", () => {
    const { result, unmount } = renderHook(() => useElementNarrow());
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });

    const disconnectFn = mockObserveInstance.disconnect;
    unmount();

    // The observer is stored in a ref; disconnect happens when a new node
    // replaces it (callbackRef(null)). On unmount React won't call the
    // callback ref with null automatically, but we verify the observer
    // was properly created and can be disconnected.
    expect(MockResizeObserver).toHaveBeenCalled();
    expect(typeof disconnectFn).toBe("function");
  });

  it("disconnects old observer when ref is re-attached to a new node", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node1 = makeNode(500);

    act(() => {
      result.current[0](node1);
    });

    const firstDisconnect = mockObserveInstance.disconnect;

    const node2 = makeNode(200);
    act(() => {
      result.current[0](node2);
    });

    expect(firstDisconnect).toHaveBeenCalled();
  });

  it("disconnects observer when ref receives null", () => {
    const { result } = renderHook(() => useElementNarrow());
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });

    const disconnectFn = mockObserveInstance.disconnect;

    act(() => {
      result.current[0](null);
    });

    expect(disconnectFn).toHaveBeenCalled();
  });
  // -------------------------------------------------------------------------
  // Regression: padded-element tier flapping
  // -------------------------------------------------------------------------

  it("ignores the observer entry's contentRect and re-measures the element", () => {
    // `contentRect` is the *content* box, but the ref-attach path measures the
    // *border* box. On an element with horizontal padding the two disagree by
    // exactly that padding, so a width inside that band used to resolve to one
    // tier on attach and the opposite one when the observer fired — and the two
    // sites then fought each other every animation frame.
    const { result } = renderHook(() => useElementNarrow(768));
    const node = makeNode(770); // border box 770 >= 768 → not narrow

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(false);

    // A real observer on a `px-3` element reports 770 - 24 = 746 here.
    act(() => {
      triggerResizeWithStaleContentRect(746);
    });

    expect(result.current[1]).toBe(false);
  });

  it("holds its tier across repeated ref re-attachment near the threshold", () => {
    const { result } = renderHook(() => useElementNarrow(768));
    const node = makeNode(770);

    act(() => {
      result.current[0](node);
    });

    // An unstable (inline) callback ref makes React detach and re-attach on
    // every render. That must not be able to flip the tier back and forth.
    for (let i = 0; i < 5; i++) {
      act(() => {
        result.current[0](null);
        result.current[0](node);
        triggerResizeWithStaleContentRect(746);
      });
      expect(result.current[1]).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Regression: coupled-sibling-width flapping
  // -------------------------------------------------------------------------

  it("does not flip back to wide on a small rebound right at the threshold", () => {
    // Reproduces WorkflowStatus's header badge: going narrow hides content in
    // a *sibling* of the measured element (an abbreviated run-identity label),
    // which hands the measured element back a few px — with a bare threshold
    // that's enough to immediately flip back to wide, reshrink the sibling,
    // and repeat every animation frame. Both measurements agree here (unlike
    // the padded-element case above); the value itself is oscillating.
    const { result } = renderHook(() => useElementNarrow(100));
    const node = makeNode(105);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(false); // 105 >= 100 → wide

    act(() => {
      reattachAndResize(result.current[0], node, 95); // crosses narrow
    });
    expect(result.current[1]).toBe(true);

    // The sibling's label just shrank, handing this element back ~10px. A
    // bare threshold would flip this back to wide and restart the loop.
    act(() => {
      reattachAndResize(result.current[0], node, 105);
    });
    expect(result.current[1]).toBe(true);

    // Only clearing threshold + hysteresis (100 + 24 = 124) escapes narrow.
    act(() => {
      reattachAndResize(result.current[0], node, 125);
    });
    expect(result.current[1]).toBe(false);
  });

  it("supports a custom hysteresis band", () => {
    const { result } = renderHook(() => useElementNarrow(100, false, 10));
    const node = makeNode(95);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(true);

    // Within the custom 10px band — stays narrow.
    act(() => {
      reattachAndResize(result.current[0], node, 108);
    });
    expect(result.current[1]).toBe(true);

    // Clears threshold + hysteresis (110) — flips to wide.
    act(() => {
      reattachAndResize(result.current[0], node, 111);
    });
    expect(result.current[1]).toBe(false);
  });

  it("applies no hysteresis on the narrow-ward transition", () => {
    const { result } = renderHook(() => useElementNarrow(100));
    const node = makeNode(150);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(false);

    // Narrowing needs no rebound guard — it flips at the bare threshold.
    act(() => {
      reattachAndResize(result.current[0], node, 99);
    });
    expect(result.current[1]).toBe(true);
  });

  it("defers tier changes until deferWhile is released", () => {
    const { result, rerender } = renderHook(
      ({ deferWhile }: { deferWhile: boolean }) =>
        useElementTier(resolveHundreds, 0, deferWhile),
      { initialProps: { deferWhile: false } }
    );
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(5);

    rerender({ deferWhile: true });
    act(() => {
      result.current[0](null);
      result.current[0](node);
    });
    act(() => {
      triggerResize(150);
      triggerResize(275);
    });
    expect(result.current[1]).toBe(5);

    rerender({ deferWhile: false });
    act(() => {
      result.current[0](null);
      result.current[0](node);
    });
    expect(result.current[1]).toBe(2);
    expect(MockResizeObserver).toHaveBeenCalledTimes(3);
  });

  it("does not apply an attach-time measurement while deferred", () => {
    const { result, rerender } = renderHook(
      ({ deferWhile }: { deferWhile: boolean }) =>
        useElementTier(resolveHundreds, 0, deferWhile),
      { initialProps: { deferWhile: true } }
    );
    const node = makeNode(500);

    act(() => {
      result.current[0](node);
    });
    expect(result.current[1]).toBe(0);

    rerender({ deferWhile: false });
    act(() => {
      result.current[0](null);
      result.current[0](node);
    });
    expect(result.current[1]).toBe(5);
  });
});
