import { useRef, type ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DIFF_FILE_LIST_VIRTUALIZATION_OVERSCAN,
  DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD,
  DiffFileList,
} from "@components/diff/DiffFileList";
import {
  DIFF_FILE_FIXTURE_SIZES,
  createDiffFileFixture,
} from "../../fixtures/diffFileFixture";

const diffViewUnmountCount = vi.hoisted(() => ({ value: 0 }));

vi.mock("@components/output/DiffView", async () => {
  const ReactModule = await import("react");

  return {
    DiffView: ({ collapsed }: { collapsed?: boolean }) => {
      ReactModule.useEffect(
        () => () => {
          diffViewUnmountCount.value++;
        },
        []
      );

      const height = collapsed ? 48 : 128;
      return ReactModule.createElement(
        "div",
        { "data-testid": "diff-view", "data-test-height": height },
        ReactModule.createElement("table", undefined),
        ReactModule.createElement("span", undefined, String(collapsed))
      );
    },
  };
});

const SCROLLER_CLASS = "diff-fixture-scroller";
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth"
);
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains(SCROLLER_CLASS)) return 180;
      const measuredChild =
        this.querySelector<HTMLElement>("[data-test-height]");
      return Number(
        this.dataset.testHeight ?? measuredChild?.dataset.testHeight ?? 24
      );
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const isScroller = this.classList.contains(SCROLLER_CLASS);
    const measuredChild = this.querySelector<HTMLElement>("[data-test-height]");
    const height = isScroller
      ? 180
      : Number(
          this.dataset.testHeight ?? measuredChild?.dataset.testHeight ?? 24
        );
    return {
      width: 800,
      height,
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
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
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

class TrackingResizeObserver implements ResizeObserver {
  static instances: TrackingResizeObserver[] = [];
  private readonly targets = new Set<Element>();
  readonly disconnect = vi.fn(() => {
    this.targets.clear();
  });
  readonly observe = vi.fn((target: Element) => {
    this.targets.add(target);
  });
  readonly unobserve = vi.fn((target: Element) => {
    this.targets.delete(target);
  });

  constructor(_callback: ResizeObserverCallback) {
    TrackingResizeObserver.instances.push(this);
  }

  get activeTargetCount(): number {
    return this.targets.size;
  }
}

function FixtureHost({
  fileCount,
  collapsed,
  version = 0,
}: {
  fileCount: number;
  collapsed: boolean;
  version?: number;
}): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollContainerRef} className={SCROLLER_CLASS}>
      <DiffFileList
        groups={createDiffFileFixture(fileCount)}
        emptyMessage="No files"
        command={{ version, collapsed }}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

async function waitForMountedDiffs(): Promise<number> {
  await waitFor(() => {
    expect(screen.getAllByTestId("diff-view").length).toBeGreaterThan(0);
  });
  return screen.getAllByTestId("diff-view").length;
}

describe("diff-file virtualization acceptance", () => {
  beforeEach(() => {
    TrackingResizeObserver.instances = [];
    window.ResizeObserver = TrackingResizeObserver;
    diffViewUnmountCount.value = 0;
  });

  it("keeps mounted cards and DOM size flat from 60 to 120 to 240 files", async () => {
    const mountedCounts: number[] = [];
    const domCounts: number[] = [];

    for (const fileCount of DIFF_FILE_FIXTURE_SIZES) {
      const view = render(
        <FixtureHost fileCount={fileCount} collapsed={true} />
      );
      mountedCounts.push(await waitForMountedDiffs());
      domCounts.push(view.container.querySelectorAll("*").length);
      view.unmount();
    }

    expect(DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD).toBeLessThan(
      DIFF_FILE_FIXTURE_SIZES[0]
    );
    expect(mountedCounts).toEqual([6, 6, 6]);
    expect(
      Math.max(...mountedCounts) - Math.min(...mountedCounts)
    ).toBeLessThanOrEqual(DIFF_FILE_LIST_VIRTUALIZATION_OVERSCAN + 2);
    expect(Math.max(...domCounts) - Math.min(...domCounts)).toBeLessThanOrEqual(
      12
    );
  });

  it("does not mount offscreen cards when Expand all changes every estimate", async () => {
    const view = render(
      <FixtureHost fileCount={120} collapsed={true} version={0} />
    );
    const beforeExpand = await waitForMountedDiffs();

    view.rerender(
      <FixtureHost fileCount={120} collapsed={false} version={1} />
    );
    const afterExpand = await waitForMountedDiffs();

    expect(afterExpand).toBeLessThanOrEqual(beforeExpand);
    expect(afterExpand).toBeLessThan(120);
  });

  it("releases mounted diff trees and every list observer when the dialog unmounts", async () => {
    const view = render(<FixtureHost fileCount={120} collapsed={false} />);
    await waitForMountedDiffs();
    expect(TrackingResizeObserver.instances.length).toBeGreaterThan(0);

    const mountedBeforeUnmount = screen.getAllByTestId("diff-view").length;
    act(() => view.unmount());

    expect(mountedBeforeUnmount).toBeGreaterThan(0);
    expect(diffViewUnmountCount.value).toBe(mountedBeforeUnmount);
    expect(
      TrackingResizeObserver.instances.every(
        (observer) => observer.activeTargetCount === 0
      )
    ).toBe(true);
    expect(
      TrackingResizeObserver.instances.some(
        (observer) => observer.disconnect.mock.calls.length > 0
      )
    ).toBe(true);
  });
});
