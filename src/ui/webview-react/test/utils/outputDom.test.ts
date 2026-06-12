import { describe, expect, it } from "vitest";
import { revealActiveFindMatchInRow } from "@utils/outputDom";

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
      rowViewportOffsetPx: 0,
    });
    expect(scrollTop).toBe(1710);
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
});
