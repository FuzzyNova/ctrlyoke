import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  VirtualizedPagedList,
  type VirtualizedListRange,
} from "@components/shared";

const SCROLLER_CLASS = "virtualized-paged-list-test-scroller";

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
      return this.classList.contains(SCROLLER_CLASS) ? 100 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 400,
  });
});

function restoreLayoutProperties(): void {
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
}

afterAll(restoreLayoutProperties);

function Host({
  count,
  listingId = "listing-a",
  loadedIndexes = [0, 1, 2],
  onRangeChange,
  scrollToIndex = null,
}: {
  count: number;
  listingId?: string;
  loadedIndexes?: number[];
  onRangeChange?: (range: VirtualizedListRange) => void;
  scrollToIndex?: number | null;
}): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loaded = new Map(
    loadedIndexes.map((index) => [index, { path: `src/file-${index}.ts` }])
  );

  return (
    <div ref={scrollContainerRef} className={SCROLLER_CLASS}>
      <VirtualizedPagedList
        totalCount={count}
        listingId={listingId}
        getItem={(index) => loaded.get(index)}
        getItemKey={(item) => item.path}
        renderItem={(item, index) => (
          <button data-row-key={item.path} data-test-index={index}>
            Loaded {index}
          </button>
        )}
        renderPlaceholder={(index) => (
          <div data-placeholder-index={index}>Loading {index}</div>
        )}
        scrollContainerRef={scrollContainerRef}
        estimateItemSize={() => 20}
        overscan={2}
        onRangeChange={onRangeChange}
        scrollToIndex={scrollToIndex}
      />
    </div>
  );
}

describe("VirtualizedPagedList", () => {
  it("mounts only a bounded number of rows for a very large listing", () => {
    render(<Host count={100_000} />);

    expect(screen.getAllByText(/^(Loaded|Loading) /).length).toBeLessThan(20);
    expect(screen.getByText("Loaded 0")).toBeInTheDocument();
    expect(screen.getByText("Loading 3")).toBeInTheDocument();
  });

  it("reports visible and overscan ranges once and repeats after a listing change", async () => {
    const onRangeChange = vi.fn<(range: VirtualizedListRange) => void>();
    const view = render(<Host count={1000} onRangeChange={onRangeChange} />);

    await waitFor(() => expect(onRangeChange).toHaveBeenCalledOnce());
    const firstRange = onRangeChange.mock.calls[0][0];
    expect(firstRange.visibleStartIndex).toBe(0);
    expect(firstRange.overscanStartIndex).toBe(0);
    expect(firstRange.overscanEndIndex).toBeGreaterThanOrEqual(
      firstRange.visibleEndIndex
    );

    view.rerender(
      <Host count={1000} listingId="listing-b" onRangeChange={onRangeChange} />
    );
    await waitFor(() => expect(onRangeChange).toHaveBeenCalledTimes(2));
  });

  it("jumps directly to a far absolute index", async () => {
    const onRangeChange = vi.fn<(range: VirtualizedListRange) => void>();
    render(
      <Host count={10_000} onRangeChange={onRangeChange} scrollToIndex={9999} />
    );

    await waitFor(() =>
      expect(
        onRangeChange.mock.calls.some(
          ([range]) => range.visibleEndIndex >= 9999
        )
      ).toBe(true)
    );
  });

  it("keeps a placeholder's stable row estimate when its entry loads", async () => {
    const view = render(<Host count={100} loadedIndexes={[0, 1, 2]} />);
    const scroller = view.container.querySelector<HTMLElement>(
      `.${SCROLLER_CLASS}`
    );
    expect(scroller).not.toBeNull();
    if (!scroller) return;

    scroller.scrollTop = 20;
    fireEvent.scroll(scroller);
    const before = scroller.scrollTop;

    view.rerender(<Host count={100} loadedIndexes={[0, 1, 2, 3]} />);

    await waitFor(() => expect(screen.getByText("Loaded 3")).toBeVisible());
    expect(scroller.scrollTop).toBe(before);
  });

  it("retains a focused row when scrolling it outside the normal range", async () => {
    const view = render(
      <Host
        count={1000}
        loadedIndexes={Array.from({ length: 20 }, (_, i) => i)}
      />
    );
    const firstRow = screen.getByText("Loaded 0");
    firstRow.focus();

    const scroller = view.container.querySelector<HTMLElement>(
      `.${SCROLLER_CLASS}`
    );
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    scroller.scrollTop = 19_000;
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(screen.getByText("Loaded 0")).toBeInTheDocument()
    );
  });

  it("renders the first sparse rows on mount with a parent-owned ref", () => {
    render(<Host count={1000} />);
    expect(screen.getByText("Loaded 0")).toBeInTheDocument();
  });
});
