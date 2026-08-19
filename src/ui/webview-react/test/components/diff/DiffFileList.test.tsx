import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffFileList } from "@components/diff/DiffFileList";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ viewType }: { viewType?: "split" | "unified" }) => (
    <div data-testid="diff-view" data-view-type={viewType} />
  ),
}));

function makeFile(key: string) {
  return {
    key,
    path: `src/${key}.ts`,
    changeType: "modified" as const,
    source: {
      kind: "content" as const,
      oldContent: "before",
      newContent: "after",
    },
  };
}

function renderList() {
  return render(
    <DiffFileList
      groups={[{ key: "files", files: [makeFile("one"), makeFile("two")] }]}
      emptyMessage="No files"
      command={{ version: 0, collapsed: false }}
    />
  );
}

describe("DiffFileList responsive ownership", () => {
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = window.ResizeObserver;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: 800,
          height: 100,
          x: 0,
          y: 0,
          top: 0,
          right: 800,
          bottom: 100,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    window.ResizeObserver = originalResizeObserver;
  });

  it("passes unified view type to every card in a narrow list", () => {
    renderList();

    expect(screen.getAllByTestId("diff-view")).toHaveLength(2);
    expect(
      screen
        .getAllByTestId("diff-view")
        .every(
          (element) => element.getAttribute("data-view-type") === "unified"
        )
    ).toBe(true);
  });

  it("passes split view type to every card in a wide list", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect);

    renderList();

    expect(
      screen
        .getAllByTestId("diff-view")
        .every((element) => element.getAttribute("data-view-type") === "split")
    ).toBe(true);
  });

  it("installs one responsive observer for the whole list", () => {
    const observerCount = vi.fn();
    class CountingResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        observerCount();
      }

      observe(_target: Element, _options?: ResizeObserverOptions) {}
      unobserve(_target: Element) {}
      disconnect() {}
    }
    window.ResizeObserver = CountingResizeObserver;

    renderList();

    expect(observerCount).toHaveBeenCalledOnce();
  });
});
