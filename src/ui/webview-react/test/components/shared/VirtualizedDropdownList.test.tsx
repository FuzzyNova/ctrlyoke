/**
 * Tests for VirtualizedDropdownList.
 *
 * jsdom performs no layout, so the virtualizer's `offsetHeight`-based
 * measurement is stubbed to give the scroll container a real height —
 * without it @tanstack/react-virtual sees a zero-height viewport and renders
 * nothing, which would mask the very behavior under test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { VirtualizedDropdownList } from "@components/shared/VirtualizedDropdownList";

const SCROLLER_CLASS = "test-scroller";
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
      return this.classList.contains(SCROLLER_CLASS) ? 400 : 36;
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

/**
 * Mirrors the real usage: the scroll container is owned by the *parent*, and
 * its ref is handed down. That ordering is what makes the parent's ref still
 * null during the list's own mount layout effect.
 */
function Host({ count }: { count: number }): React.ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const items = Array.from({ length: count }, (_unused, index) => index);
  return (
    <div ref={scrollContainerRef} className={SCROLLER_CLASS}>
      <VirtualizedDropdownList
        items={items}
        getItemKey={(item) => `row-${item}`}
        scrollContainerRef={scrollContainerRef}
        renderItem={(item) => <div>Row {item}</div>}
      />
    </div>
  );
}

describe("VirtualizedDropdownList", () => {
  it("renders rows directly below the virtualization threshold", () => {
    render(<Host count={5} />);
    expect(screen.getByText("Row 0")).toBeInTheDocument();
    expect(screen.getByText("Row 4")).toBeInTheDocument();
  });

  it("renders rows on mount when virtualized, with no further re-render", () => {
    // Regression: the virtualizer resolves its scroll element in a layout
    // effect that runs *before* the parent's ref is attached, so a list that
    // mounts with already-final props (e.g. the workflow list remounting when
    // the run panel's Back button returns to it) rendered zero rows and stayed
    // blank until some unrelated re-render happened to occur.
    render(<Host count={80} />);
    expect(screen.getByText("Row 0")).toBeInTheDocument();
  });
});
