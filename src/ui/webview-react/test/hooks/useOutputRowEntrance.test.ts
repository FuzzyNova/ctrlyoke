import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputRowEntrance } from "@hooks/useOutputRowEntrance";

const rowsOf = (...keys: string[]) => keys.map((key) => ({ key }));

function buildPane() {
  const scrollElement = document.createElement("div");
  document.body.appendChild(scrollElement);
  const animated: string[] = [];
  const setRenderedRows = (keys: string[]) => {
    scrollElement.replaceChildren(
      ...keys.map((key) => {
        const row = document.createElement("div");
        row.dataset.rowKey = key;
        // jsdom has no Web Animations API.
        row.animate = vi.fn(() => {
          animated.push(key);
          return {} as Animation;
        }) as unknown as HTMLElement["animate"];
        return row;
      })
    );
  };
  return { animated, scrollElement, setRenderedRows };
}

function renderEntrance(
  scrollElement: HTMLDivElement,
  initial: { rows: { key: string }[]; identity?: string; isEnabled?: boolean }
) {
  const autoscrollEnabledRef = { current: true };
  const hook = renderHook(
    ({ rows, identity, isEnabled }) =>
      useOutputRowEntrance({
        autoscrollEnabledRef,
        isEnabled,
        outputRef: { current: scrollElement },
        rowRenderIdentity: identity,
        rows,
      }),
    {
      initialProps: {
        rows: initial.rows,
        identity: initial.identity ?? "live",
        isEnabled: initial.isEnabled ?? true,
      },
    }
  );
  return { ...hook, autoscrollEnabledRef };
}

describe("useOutputRowEntrance", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList)
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("fades rows appended while following live output, not the initial rows", () => {
    const { animated, scrollElement, setRenderedRows } = buildPane();
    setRenderedRows(["a", "b"]);
    const { rerender } = renderEntrance(scrollElement, {
      rows: rowsOf("a", "b"),
    });
    expect(animated).toEqual([]);

    setRenderedRows(["a", "b", "c"]);
    rerender({
      rows: rowsOf("a", "b", "c"),
      identity: "live",
      isEnabled: true,
    });

    expect(animated).toEqual(["c"]);
  });

  it("does not fade a re-keyed row that replaces one in the same slot", () => {
    const { animated, scrollElement, setRenderedRows } = buildPane();
    setRenderedRows(["a", "a:streaming-response"]);
    const { rerender } = renderEntrance(scrollElement, {
      rows: rowsOf("a", "a:streaming-response"),
    });

    setRenderedRows(["a", "a:response"]);
    rerender({
      rows: rowsOf("a", "a:response"),
      identity: "live",
      isEnabled: true,
    });

    expect(animated).toEqual([]);
  });

  it("does not fade rows from a run or filter switch", () => {
    const { animated, scrollElement, setRenderedRows } = buildPane();
    setRenderedRows(["a"]);
    const { rerender } = renderEntrance(scrollElement, { rows: rowsOf("a") });

    setRenderedRows(["x", "y"]);
    rerender({
      rows: rowsOf("x", "y"),
      identity: "history:2",
      isEnabled: true,
    });

    expect(animated).toEqual([]);
  });

  it("does not fade while disabled or with autoscroll released, and never replays later", () => {
    const { animated, scrollElement, setRenderedRows } = buildPane();
    setRenderedRows(["a"]);
    const { rerender, autoscrollEnabledRef } = renderEntrance(scrollElement, {
      rows: rowsOf("a"),
      isEnabled: false,
    });

    setRenderedRows(["a", "b"]);
    rerender({ rows: rowsOf("a", "b"), identity: "live", isEnabled: false });
    rerender({ rows: rowsOf("a", "b"), identity: "live", isEnabled: true });

    autoscrollEnabledRef.current = false;
    setRenderedRows(["a", "b", "c"]);
    rerender({
      rows: rowsOf("a", "b", "c"),
      identity: "live",
      isEnabled: true,
    });

    expect(animated).toEqual([]);
  });
});
