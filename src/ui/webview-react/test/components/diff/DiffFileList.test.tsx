import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DIFF_VIEW_TYPES,
  WORKSPACE_ENTRY_KINDS,
  type DiffViewType,
} from "@root/types/DashboardConstants";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import {
  DiffFileList,
  type DiffFileListHandle,
} from "@components/diff/DiffFileList";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({
    collapsed,
    expandedGaps,
    onCollapsedChange,
    onExpandGap,
    viewType,
  }: {
    collapsed?: boolean;
    expandedGaps?: Map<number, number>;
    onCollapsedChange?: (collapsed: boolean) => void;
    onExpandGap?: (gapIndex: number, nextExpandedToLine: number) => void;
    viewType?: DiffViewType;
  }) => (
    <div
      data-testid="diff-view"
      data-test-height={collapsed ? 40 : 140}
      data-view-type={viewType}
    >
      <span data-testid="diff-collapsed">{String(collapsed)}</span>
      <span data-testid="diff-expanded-gaps">
        {String(expandedGaps?.size ?? 0)}
      </span>
      <button
        type="button"
        aria-label="Toggle diff"
        onClick={() => onCollapsedChange?.(!collapsed)}
      />
      <button
        type="button"
        aria-label="Expand gap"
        onClick={() => onExpandGap?.(1, 27)}
      />
    </div>
  ),
}));

const DIFF_SCROLLER_CLASS = "diff-file-list-test-scroller";
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
      if (this.classList.contains(DIFF_SCROLLER_CLASS)) return 120;
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

function makeFile(key: string) {
  return {
    key,
    path: `src/${key}.ts`,
    changeType: "modified" as const,
    source: {
      kind: WORKSPACE_ENTRY_KINDS.CONTENT,
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

function VirtualizedHost({
  fileCount = 100,
  command = { version: 0, collapsed: true },
}: {
  fileCount?: number;
  command?: { version: number; collapsed: boolean };
}): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollContainerRef}
      className={DIFF_SCROLLER_CLASS}
      data-testid="diff-scroll-container"
    >
      <DiffFileList
        groups={[
          {
            key: "files",
            files: Array.from({ length: fileCount }, (_unused, index) =>
              makeFile(`file-${index}`)
            ),
          },
        ]}
        emptyMessage="No files"
        command={command}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

function AnchorVirtualizedHost(): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const diffFileListRef = useRef<DiffFileListHandle>(null);
  const [command, setCommand] = useState<{
    version: number;
    collapsed: boolean;
  }>({ version: 0, collapsed: true });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          diffFileListRef.current?.prepareGlobalLayoutChange();
          setCommand({ version: 1, collapsed: false });
        }}
      >
        Expand all
      </button>
      <div
        ref={scrollContainerRef}
        className={DIFF_SCROLLER_CLASS}
        data-testid="diff-anchor-scroll-container"
        data-command-collapsed={String(command.collapsed)}
      >
        <DiffFileList
          ref={diffFileListRef}
          groups={[
            {
              key: "files",
              files: Array.from({ length: 120 }, (_unused, index) =>
                makeFile(`file-${index}`)
              ),
            },
          ]}
          emptyMessage="No files"
          command={command}
          scrollContainerRef={scrollContainerRef}
        />
      </div>
    </>
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
          (element) =>
            element.getAttribute("data-view-type") === DIFF_VIEW_TYPES.UNIFIED
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
        .every(
          (element) =>
            element.getAttribute("data-view-type") === DIFF_VIEW_TYPES.SPLIT
        )
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

describe("DiffFileList virtualization", () => {
  const originalResizeObserver = window.ResizeObserver;

  class MeasuringResizeObserver implements ResizeObserver {
    private readonly targets = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      measuringObservers.push(this);
    }

    observe(target: Element): void {
      this.targets.add(target);
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }

    disconnect(): void {
      this.targets.clear();
    }

    trigger(): void {
      this.callback(
        Array.from(
          this.targets,
          (target) =>
            ({
              target,
              contentRect: {
                width: (target as HTMLElement).offsetWidth,
                height: (target as HTMLElement).offsetHeight,
              },
            }) as ResizeObserverEntry
        ),
        this
      );
    }
  }

  const measuringObservers: MeasuringResizeObserver[] = [];

  beforeEach(() => {
    measuringObservers.length = 0;
    window.ResizeObserver = MeasuringResizeObserver;
  });

  afterEach(() => {
    window.ResizeObserver = originalResizeObserver;
  });

  it("mounts only the viewport plus overscan for a large file list", async () => {
    render(<VirtualizedHost />);

    await waitFor(() => {
      const mountedCount = screen.getAllByTestId("diff-view").length;
      expect(mountedCount).toBeGreaterThan(0);
      expect(mountedCount).toBeLessThan(100);
      expect(screen.getAllByRole("article")[0]).toHaveAttribute(
        "aria-setsize",
        "100"
      );
      expect(screen.getAllByRole("article")[0]).toHaveAttribute(
        "aria-posinset",
        "1"
      );
    });
  });

  it("keeps a focused card mounted until focus moves away from it", async () => {
    render(<VirtualizedHost />);
    const firstToggle = screen.getAllByRole("button", {
      name: "Toggle diff",
    })[0];
    firstToggle.focus();

    const scroller = screen.getByTestId("diff-scroll-container");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 4000,
    });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(screen.getByText("file-0.ts")).toBeInTheDocument();
      expect(screen.getByText("file-50.ts")).toBeInTheDocument();
    });

    const laterToggle = screen
      .getByText("file-50.ts")
      .closest("[data-index]")
      ?.querySelector<HTMLButtonElement>('button[aria-label="Toggle diff"]');
    expect(laterToggle).toBeTruthy();
    laterToggle?.focus();
    await waitFor(() =>
      expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument()
    );
  });

  it("unmounts earlier cards and mounts later cards after scrolling", async () => {
    render(<VirtualizedHost />);
    const scroller = screen.getByTestId("diff-scroll-container");

    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 4000,
    });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument();
      expect(screen.getByText("file-50.ts")).toBeInTheDocument();
    });
  });

  it("replaces a collapsed estimate when a realized card expands", async () => {
    const view = render(<VirtualizedHost />);
    const spacer = () =>
      view.container.querySelector<HTMLDivElement>("div[style*='height']");

    const initialHeight = Number(spacer()?.style.height.replace("px", ""));
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);
    act(() => {
      for (const observer of measuringObservers) observer.trigger();
    });

    await waitFor(() => {
      expect(Number(spacer()?.style.height.replace("px", ""))).toBeGreaterThan(
        initialHeight
      );
    });
  });

  it("preserves local collapse and gap state across virtual remounts", async () => {
    render(<VirtualizedHost command={{ version: 0, collapsed: false }} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand gap" })[0]);

    const scroller = screen.getByTestId("diff-scroll-container");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 4000,
    });
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument()
    );

    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(screen.getByText("file-0.ts")).toBeInTheDocument();
      expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
        "true"
      );
      expect(screen.getAllByTestId("diff-expanded-gaps")[0]).toHaveTextContent(
        "1"
      );
    });
  });

  it("applies a new global reset to local state without mounting every file", async () => {
    const view = render(<VirtualizedHost />);
    fireEvent.click(screen.getAllByRole("button", { name: "Toggle diff" })[0]);

    view.rerender(
      <VirtualizedHost command={{ version: 1, collapsed: false }} />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("diff-view").length).toBeLessThan(100);
      expect(screen.getAllByTestId("diff-collapsed")[0]).toHaveTextContent(
        "false"
      );
    });
  });

  it("restores the first visible file anchor after a global reset", async () => {
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains(DIFF_SCROLLER_CLASS)) {
          return {
            width: 800,
            height: 120,
            x: 0,
            y: 100,
            top: 100,
            right: 800,
            bottom: 220,
            left: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }

        const row = this.closest<HTMLElement>("[data-index]");
        const index = row ? Number(row.dataset.index) : NaN;
        if (Number.isFinite(index)) {
          const container = this.closest<HTMLElement>(
            `.${DIFF_SCROLLER_CLASS}`
          );
          const scrollTop = container?.scrollTop ?? 4000;
          const expansionShift =
            container?.dataset.commandCollapsed === "false" ? 1843.75 : 0;
          const top =
            100 + (index - 50) * 80 + expansionShift - (scrollTop - 4000);
          return {
            width: 800,
            height: 80,
            x: 0,
            y: top,
            top,
            right: 800,
            bottom: top + 80,
            left: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }

        return originalGetBoundingClientRect.call(this);
      });

    try {
      render(<AnchorVirtualizedHost />);
      const scroller = screen.getByTestId("diff-anchor-scroll-container");
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        writable: true,
        value: 4000,
      });
      Object.defineProperty(scroller, "scrollTo", {
        configurable: true,
        value: (options: ScrollToOptions | number, y?: number) => {
          const top =
            typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
          scroller.scrollTop = top;
          fireEvent.scroll(scroller);
        },
      });
      fireEvent.scroll(scroller);

      await waitFor(() =>
        expect(screen.getByText("file-50.ts")).toBeInTheDocument()
      );
      const anchor = screen
        .getByText("file-50.ts")
        .closest<HTMLElement>("[data-diff-file-key]");
      expect(anchor).toBeTruthy();
      expect(anchor?.getBoundingClientRect().top).toBe(100);

      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));

      await waitFor(() => {
        const currentAnchor = screen
          .getByText("file-50.ts")
          .closest<HTMLElement>("[data-diff-file-key]");
        expect(currentAnchor?.getBoundingClientRect().top).toBeCloseTo(100, 0);
      });
      expect(scroller.scrollTop).toBeCloseTo(5843.75, 0);
    } finally {
      getBoundingClientRect.mockRestore();
    }
  });

  it("keeps empty and single-file lists on the direct path", () => {
    const { container, rerender } = render(
      <DiffFileList
        groups={[]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: true }}
      />
    );
    expect(container.querySelector("[data-index]")).not.toBeInTheDocument();

    rerender(
      <DiffFileList
        groups={[{ key: "files", files: [makeFile("only")] }]}
        emptyMessage="No files"
        command={{ version: 0, collapsed: true }}
      />
    );
    expect(screen.getByText("only.ts")).toBeInTheDocument();
    expect(container.querySelector("[data-index]")).not.toBeInTheDocument();
  });
});
