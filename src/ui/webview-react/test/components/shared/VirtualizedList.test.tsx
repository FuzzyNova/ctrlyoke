import { render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualizedList } from "@components/shared/VirtualizedList";

const SCROLLER_CLASS = "virtualized-list-test-scroller";
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth"
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains(SCROLLER_CLASS)) return 100;
      const measuredChild =
        this.querySelector<HTMLElement>("[data-test-height]");
      return Number(
        this.dataset.testHeight ?? measuredChild?.dataset.testHeight ?? 20
      );
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 400,
  });
});

afterAll(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight
    );
  }
  if (originalOffsetWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      originalOffsetWidth
    );
  }
});

function Host({
  count,
  estimate = 20,
  layoutResetKey,
  rowHeight = 20,
  scrollToKey = null,
  threshold = 5,
}: {
  count: number;
  estimate?: number;
  layoutResetKey?: string | number;
  rowHeight?: number;
  scrollToKey?: string | null;
  threshold?: number;
}): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const items = Array.from({ length: count }, (_unused, index) => index);

  return (
    <div ref={scrollContainerRef} className={SCROLLER_CLASS}>
      <VirtualizedList
        items={items}
        getItemKey={(item) => `row-${item}`}
        renderItem={(item) => (
          <div
            data-row-key={`row-${item}`}
            data-scroll-key={`row-${item}`}
            data-test-height={rowHeight}
          >
            Row {item}
          </div>
        )}
        scrollContainerRef={scrollContainerRef}
        estimateItemSize={() => estimate}
        threshold={threshold}
        overscan={1}
        layoutResetKey={layoutResetKey}
        scrollToKey={scrollToKey}
      />
    </div>
  );
}

describe("VirtualizedList", () => {
  it("renders every item directly below the threshold", () => {
    const { container } = render(<Host count={4} threshold={5} />);

    expect(screen.getAllByText(/^Row /)).toHaveLength(4);
    expect(container.querySelector("[data-index]")).not.toBeInTheDocument();
  });

  it("renders a measured virtual spacer at and above the threshold", async () => {
    const { container } = render(
      <Host count={6} threshold={5} estimate={30} rowHeight={40} />
    );

    expect(screen.getByText("Row 0")).toBeInTheDocument();
    const spacer = container.querySelector<HTMLDivElement>(
      "div[style*='height']"
    );
    expect(spacer).toHaveStyle({ position: "relative", width: "100%" });
    expect(spacer?.querySelector("[data-index='0']")).toHaveStyle({
      position: "absolute",
      transform: "translateY(0px)",
    });
    await waitFor(() =>
      expect(Number(spacer?.style.height.replace("px", ""))).toBeGreaterThan(
        180
      )
    );
  });

  it("renders virtual rows on first mount with the parent-owned ref", () => {
    render(<Host count={80} threshold={5} />);

    expect(screen.getByText("Row 0")).toBeInTheDocument();
  });

  it("does not render stale indexes after the item count shrinks", async () => {
    const view = render(<Host count={80} threshold={5} />);
    expect(screen.getByText("Row 0")).toBeInTheDocument();

    view.rerender(<Host count={1} threshold={5} />);

    await waitFor(() => {
      expect(screen.getByText("Row 0")).toBeInTheDocument();
      expect(screen.queryByText("Row 79")).not.toBeInTheDocument();
    });
  });

  it("replaces estimates with measured row sizes", async () => {
    const { container } = render(
      <Host count={6} threshold={5} estimate={10} rowHeight={45} />
    );
    const spacer = container.querySelector<HTMLDivElement>(
      "div[style*='height']"
    );

    await waitFor(() => expect(spacer).toHaveStyle({ height: "270px" }));
  });

  it("invalidates measurements when layoutResetKey changes", async () => {
    const view = render(
      <Host
        count={6}
        threshold={5}
        estimate={10}
        layoutResetKey="collapsed"
        rowHeight={30}
      />
    );
    const getSpacer = () =>
      view.container.querySelector<HTMLDivElement>("div[style*='height']");

    await waitFor(() => expect(getSpacer()).toHaveStyle({ height: "180px" }));

    view.rerender(
      <Host
        count={6}
        threshold={5}
        estimate={50}
        layoutResetKey="expanded"
        rowHeight={60}
      />
    );

    await waitFor(() => expect(getSpacer()).toHaveStyle({ height: "300px" }));
  });

  it("scrolls a non-virtual target once", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const view = render(<Host count={4} threshold={5} scrollToKey="row-2" />);
      expect(scrollIntoView).toHaveBeenCalledOnce();

      view.rerender(<Host count={4} threshold={5} scrollToKey="row-2" />);
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
