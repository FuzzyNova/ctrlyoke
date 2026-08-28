import { describe, expect, it } from "vitest";
import {
  captureViewportRowAnchor,
  revealActiveFindMatchInRow,
} from "@utils/outputDom";

describe("revealActiveFindMatchInRow", () => {
  it("scrolls to bring the active match into view within a tall row", () => {
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    const markElement = document.createElement("mark");

    rowElement.dataset.rowKey = "row-1";
    rowElement.dataset.index = "0";
    markElement.setAttribute("data-find-active", "true");
    rowElement.appendChild(markElement);
    scrollElement.appendChild(rowElement);
    document.body.appendChild(scrollElement);

    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    let scrollTop = 0;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollElement.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 200,
        height: 200,
      }) as DOMRect;
    rowElement.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 2000,
        height: 2000,
      }) as DOMRect;
    markElement.getBoundingClientRect = () =>
      ({
        top: 1800,
        bottom: 1820,
        height: 20,
      }) as DOMRect;

    const result = revealActiveFindMatchInRow(scrollElement, 0);

    expect(result).toEqual({
      adjusted: true,
      foundMark: true,
      foundRow: true,
      rowKey: "row-1",
      rowViewportOffsetPx: -1710,
    });
    expect(scrollTop).toBe(1710);
  });

  it("returns distinct landed anchors for matches in the same tall row", () => {
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    const firstMark = document.createElement("mark");
    const secondMark = document.createElement("mark");

    rowElement.dataset.rowKey = "row-1";
    rowElement.dataset.index = "0";
    firstMark.setAttribute("data-find-active", "true");
    rowElement.append(firstMark, secondMark);
    scrollElement.appendChild(rowElement);
    document.body.appendChild(scrollElement);

    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    let scrollTop = 0;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollElement.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, height: 200 }) as DOMRect;
    rowElement.getBoundingClientRect = () =>
      ({
        top: -scrollTop,
        bottom: 2000 - scrollTop,
        height: 2000,
      }) as DOMRect;
    firstMark.getBoundingClientRect = () =>
      ({
        top: 300 - scrollTop,
        bottom: 320 - scrollTop,
        height: 20,
      }) as DOMRect;
    secondMark.getBoundingClientRect = () =>
      ({
        top: 1800 - scrollTop,
        bottom: 1820 - scrollTop,
        height: 20,
      }) as DOMRect;

    const firstResult = revealActiveFindMatchInRow(scrollElement, 0);
    expect(scrollTop).toBe(210);
    expect(firstResult.rowViewportOffsetPx).toBe(-210);

    firstMark.removeAttribute("data-find-active");
    secondMark.setAttribute("data-find-active", "true");

    const secondResult = revealActiveFindMatchInRow(scrollElement, 0);
    expect(scrollTop).toBe(1710);
    expect(secondResult.rowViewportOffsetPx).toBe(-1710);

    // Re-applying either landed anchor at its matching scroll position is a
    // no-op. This is the contract consumed by useOutputScrollTarget.
    expect(
      scrollTop +
        (rowElement.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top) -
        secondResult.rowViewportOffsetPx!
    ).toBe(scrollTop);
  });

  it("returns without scrolling when the active match is already visible", () => {
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    const markElement = document.createElement("mark");

    rowElement.dataset.rowKey = "row-1";
    rowElement.dataset.index = "0";
    markElement.setAttribute("data-find-active", "true");
    rowElement.appendChild(markElement);
    scrollElement.appendChild(rowElement);
    document.body.appendChild(scrollElement);

    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    let scrollTop = 250;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollElement.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 200,
        height: 200,
      }) as DOMRect;
    rowElement.getBoundingClientRect = () =>
      ({
        top: -250,
        bottom: 1750,
        height: 2000,
      }) as DOMRect;
    markElement.getBoundingClientRect = () =>
      ({
        top: 80,
        bottom: 100,
        height: 20,
      }) as DOMRect;

    const result = revealActiveFindMatchInRow(scrollElement, 0);

    expect(result).toEqual({
      adjusted: false,
      foundMark: true,
      foundRow: true,
      rowKey: "row-1",
      rowViewportOffsetPx: -250,
    });
    expect(scrollTop).toBe(250);
  });

  it("reveals an active diff match rendered by the nested-token fallback", () => {
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    const activeDiffMark = document.createElement("span");

    rowElement.dataset.rowKey = "row-diff";
    rowElement.dataset.index = "4";
    activeDiffMark.className = "diff-code-mark diff-code-mark-find-active";
    rowElement.appendChild(activeDiffMark);
    scrollElement.appendChild(rowElement);

    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    let scrollTop = 0;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    scrollElement.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, height: 200 }) as DOMRect;
    rowElement.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1000, height: 1000 }) as DOMRect;
    activeDiffMark.getBoundingClientRect = () =>
      ({ top: 700, bottom: 720, height: 20 }) as DOMRect;

    const result = revealActiveFindMatchInRow(scrollElement, 4);

    expect(result).toMatchObject({
      adjusted: true,
      foundMark: true,
      rowKey: "row-diff",
      rowViewportOffsetPx: -610,
    });
    expect(scrollTop).toBe(610);
  });
});

describe("captureViewportRowAnchor", () => {
  const CONTAINER_TOP = 0;
  const CONTAINER_HEIGHT = 586;

  /** Builds a pane whose rows are laid out at the given viewport tops. */
  function buildPane(
    rows: { key: string; top: number; height: number }[]
  ): HTMLDivElement {
    const scrollElement = document.createElement("div");
    scrollElement.getBoundingClientRect = () =>
      ({
        top: CONTAINER_TOP,
        bottom: CONTAINER_TOP + CONTAINER_HEIGHT,
        height: CONTAINER_HEIGHT,
      }) as DOMRect;

    for (const row of rows) {
      const element = document.createElement("div");
      element.dataset.rowKey = row.key;
      element.getBoundingClientRect = () =>
        ({
          top: row.top,
          bottom: row.top + row.height,
          height: row.height,
        }) as DOMRect;
      scrollElement.appendChild(element);
    }
    return scrollElement;
  }

  // The mode name is the contract. Scoring against the viewport centre (as this
  // did until 2026-08-13) commits anchors hundreds of pixels down the pane,
  // which widens the band of rows that can displace the anchor without
  // qualifying for a same-paint correction — the "jump to B, snap back" flash.
  it("anchors the topmost fully visible row, not the most central one", () => {
    const anchor = captureViewportRowAnchor(
      buildPane([
        { key: "row-above", top: -180, height: 200 },
        { key: "row-top", top: 20, height: 120 },
        { key: "row-centre", top: 280, height: 120 },
      ]),
      "visible-top"
    );

    expect(anchor?.rowKey).toBe("row-top");
    expect(anchor?.offsetTop).toBe(20);
  });

  // A tall row's top can sit far above the fold while its centre sits near it,
  // which is how the old scoring produced anchor offsets like -2261.
  it("never anchors a row that starts above the fold when one starts inside", () => {
    const anchor = captureViewportRowAnchor(
      buildPane([
        { key: "row-tall", top: -2000, height: 2400 },
        { key: "row-visible", top: 400, height: 100 },
      ]),
      "visible-top"
    );

    expect(anchor?.rowKey).toBe("row-visible");
    expect(anchor?.offsetTop).toBeGreaterThanOrEqual(0);
  });

  // Only when nothing starts inside the viewport does the straddling row win,
  // and then a negative offset is the honest answer rather than a symptom.
  it("falls back to a straddling row when none starts inside the viewport", () => {
    const anchor = captureViewportRowAnchor(
      buildPane([{ key: "row-tall", top: -2000, height: 2400 }]),
      "visible-top"
    );

    expect(anchor?.rowKey).toBe("row-tall");
    expect(anchor?.offsetTop).toBe(-2000);
  });

  it("still scores by the centre in center-point mode", () => {
    const anchor = captureViewportRowAnchor(
      buildPane([
        { key: "row-top", top: 0, height: 40 },
        { key: "row-centre", top: 260, height: 60 },
      ]),
      "center-point"
    );

    expect(anchor?.rowKey).toBe("row-centre");
  });

  it("returns null for an empty pane", () => {
    expect(captureViewportRowAnchor(buildPane([]), "visible-top")).toBeNull();
  });
});
