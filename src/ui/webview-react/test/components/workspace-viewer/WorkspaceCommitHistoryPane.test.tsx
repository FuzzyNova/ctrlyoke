import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { WorkspaceCommitHistoryPane } from "@components/workspace-viewer/WorkspaceCommitHistoryPane";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceCheckoutBranch,
  workspaceCheckoutCommit,
  workspaceGitRefDiff,
} from "@utils/hostedApi";
import type { WorkspaceCommitLogEntry } from "@root/types/HostedWorkspaceViewerTypes";
import type { PagedCommitHistoryController } from "@hooks/usePagedCommitHistory";
import { GIT_REF_LABEL_TYPES } from "@root/types/DashboardConstants";

vi.mock("@utils/hostedApi", () => ({
  workspaceCheckoutBranch: vi.fn(),
  workspaceCheckoutCommit: vi.fn(),
  workspaceGitRefDiff: vi.fn(),
}));

const commit: WorkspaceCommitLogEntry = {
  hash: "abc1234567890abcdef",
  shortHash: "abc1234",
  subject: "fix: commit view",
  author: "Dev",
  relativeDate: "1 hour ago",
  isHead: true,
  pushed: true,
  refs: [{ name: "main", type: GIT_REF_LABEL_TYPES.LOCAL_BRANCH }],
  isMerge: false,
  parentHashes: [],
};

function commitRow(): HTMLElement {
  const subject = screen.getByText(commit.subject);
  const row = subject.closest("button");
  if (!row) throw new Error("Commit row button not found");
  return row;
}

function testController(
  commits: readonly WorkspaceCommitLogEntry[],
  overrides: Partial<PagedCommitHistoryController> = {}
): PagedCommitHistoryController {
  return {
    repo: undefined,
    branchHint: undefined,
    currentBranch: null,
    detached: false,
    listingId: "test-commit-history",
    totalCount: commits.length,
    pageSize: 30,
    getCommit: (index) => commits[index],
    uniqueLoadedCount: commits.length,
    loadedCount: commits.length,
    loadedOffsets: [0],
    inFlightOffsets: [],
    failedRanges: [],
    initialLoading: false,
    isInitialLoading: false,
    pageLoading: false,
    isLoading: false,
    error: null,
    initialError: null,
    navigateToContext: vi.fn(),
    refresh: vi.fn(),
    retry: vi.fn(),
    retryPage: vi.fn(),
    requestRange: vi.fn(),
    loadRange: vi.fn(),
    onRangeChange: vi.fn(),
    onViewportRangeChange: vi.fn(),
    ...overrides,
  };
}

function renderPane(
  commits = [commit],
  overrides: Partial<PagedCommitHistoryController> = {},
  props: { isMobile?: boolean; onRefresh?: () => void } = {}
) {
  const state = useWorkspaceViewerStore.getState();
  return render(
    <WorkspaceCommitHistoryPane
      isMobile={props.isMobile}
      onRefresh={props.onRefresh ?? vi.fn()}
      controller={testController(commits, {
        currentBranch: state.currentBranch,
        detached: state.detached,
        ...overrides,
      })}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workspaceGitRefDiff).mockResolvedValue({ unifiedDiff: "" });
  useWorkspaceViewerStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceCommitHistoryPane", () => {
  it("opens the mobile diff pane without fetching the full diff", () => {
    renderPane();

    fireEvent.click(commitRow());

    expect(useWorkspaceViewerStore.getState().mobileDiffVisible).toBe(true);
    expect(useWorkspaceViewerStore.getState().diffRef).toBe(`~${commit.hash}`);
    expect(workspaceGitRefDiff).not.toHaveBeenCalled();
  });

  it("outlines the commit currently shown in the diff pane", () => {
    useWorkspaceViewerStore.setState({ diffRef: `~${commit.hash}` });
    renderPane();

    expect(commitRow().className).toContain("fp-list-row-selected");
  });

  it("does not outline any commit when a non-commit ref is viewed", () => {
    useWorkspaceViewerStore.setState({ diffRef: "~diff" });
    renderPane();

    expect(commitRow().className).not.toContain("fp-list-row-selected");
  });

  it("opens the context menu on long press without also opening the diff", () => {
    vi.useFakeTimers();
    renderPane();

    const row = commitRow();
    fireEvent.touchStart(row, {
      touches: [{ clientX: 24, clientY: 36 }],
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText("Copy Hash")).toBeInTheDocument();

    fireEvent.click(row);

    expect(useWorkspaceViewerStore.getState().mobileDiffVisible).toBe(false);
    expect(workspaceGitRefDiff).not.toHaveBeenCalled();
  });

  it("shows the current branch name in the header", () => {
    useWorkspaceViewerStore.setState({
      currentBranch: "main",
      detached: false,
    });
    renderPane();

    const branchChip = screen.getByTitle("Current branch: main");
    expect(branchChip).toBeInTheDocument();
    expect(branchChip).toHaveTextContent("main");
  });

  it("shows a detached indicator when no current branch", () => {
    useWorkspaceViewerStore.setState({ currentBranch: null, detached: true });
    renderPane();

    expect(screen.getByText("detached")).toBeInTheDocument();
    expect(screen.getByText("Detached HEAD")).toBeInTheDocument();
  });

  it("refreshes the paged controller from the pane refresh button", () => {
    const controllerRefresh = vi.fn();
    const paneRefresh = vi.fn();
    const controller = testController([commit], { refresh: controllerRefresh });
    render(
      <WorkspaceCommitHistoryPane
        onRefresh={paneRefresh}
        controller={controller}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh commit history" })
    );

    expect(controllerRefresh).toHaveBeenCalledOnce();
    expect(paneRefresh).toHaveBeenCalledOnce();
  });

  it("returns from detached HEAD through the windowed history banner", async () => {
    vi.mocked(workspaceCheckoutBranch).mockResolvedValue({
      branch: "main",
    });
    const controllerRefresh = vi.fn();
    const paneRefresh = vi.fn();
    const controller = testController([commit], {
      currentBranch: null,
      detached: true,
      refresh: controllerRefresh,
    });
    useWorkspaceViewerStore.setState({
      currentBranch: null,
      detached: true,
      previousBranch: "main",
    });
    render(
      <WorkspaceCommitHistoryPane
        onRefresh={paneRefresh}
        controller={controller}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Return to main" }));

    await waitFor(() =>
      expect(workspaceCheckoutBranch).toHaveBeenCalledWith({
        branch: "main",
        repo: undefined,
      })
    );
    expect(useWorkspaceViewerStore.getState().previousBranch).toBeNull();
    expect(controllerRefresh).toHaveBeenCalledOnce();
    expect(paneRefresh).toHaveBeenCalledOnce();
  });

  it("renders ref pills from commit decorations", () => {
    renderPane([
      {
        ...commit,
        refs: [
          { name: "main", type: GIT_REF_LABEL_TYPES.LOCAL_BRANCH },
          {
            name: "origin/main",
            type: GIT_REF_LABEL_TYPES.REMOTE_BRANCH,
          },
        ],
      },
    ]);

    // "main" appears both in the header branch chip and as a ref pill.
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
    // In-sync remote ref shares the row with its local branch, so it's
    // collapsed to just a cloud icon (no "origin/main" text).
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
    expect(screen.getByTitle("origin/main")).toBeInTheDocument();
  });

  it("shows the full remote branch name when not sharing a row with a local branch ref", () => {
    renderPane([
      {
        ...commit,
        refs: [
          { name: "origin/main", type: GIT_REF_LABEL_TYPES.REMOTE_BRANCH },
        ],
      },
    ]);

    expect(screen.getByText("origin/main")).toBeInTheDocument();
  });

  it("renders merge history as multiple SVG lanes", () => {
    const merge = {
      ...commit,
      hash: "merge",
      shortHash: "merge00",
      subject: "merge feature",
      isMerge: true,
      parentHashes: ["main-parent", "feature-parent"],
    };
    const mainParent = {
      ...commit,
      hash: "main-parent",
      shortHash: "main000",
      isHead: false,
      refs: [],
      parentHashes: ["base"],
    };
    const featureParent = {
      ...mainParent,
      hash: "feature-parent",
      shortHash: "feat000",
      subject: "feature work",
      parentHashes: ["base"],
    };
    const base = {
      ...mainParent,
      hash: "base",
      shortHash: "base000",
      subject: "base commit",
      parentHashes: [],
    };
    renderPane([merge, mainParent, featureParent, base]);

    expect(screen.getAllByTestId(/^commit-graph-svg-/)).toHaveLength(4);
    expect(
      screen.getByTestId("commit-graph-svg-merge").querySelectorAll("path")
        .length
    ).toBeGreaterThan(1);
    expect(
      screen.getByTestId("commit-graph-surface").getAttribute("viewBox")
    ).toBe("0 0 42 96");
    expect(
      screen.getByTestId("commit-graph-svg-merge").querySelectorAll("circle")
        .length
    ).toBe(2);
  });

  it("falls back to a fixed lane cap before the pane width is measured", () => {
    // jsdom reports zero layout size until something stubs
    // getBoundingClientRect, so this exercises the pre-measurement fallback
    // path rather than the percentage-of-parent cap.
    const parentHashes = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const parents = parentHashes.map((hash) => ({
      ...commit,
      hash,
      shortHash: hash,
      isHead: false,
      refs: [],
      parentHashes: [],
    }));
    const view = renderPane([
      {
        ...commit,
        hash: "octopus",
        shortHash: "octopus",
        isMerge: true,
        parentHashes,
      },
      ...parents,
    ]);
    const rail = screen.getByTestId("commit-graph-rail");
    expect(rail.className).toContain("overflow-x-auto");
    expect(rail.className).toContain("overflow-y-visible");
    expect(rail.style.width).toBe("84px");

    view.rerender(
      <WorkspaceCommitHistoryPane
        onRefresh={vi.fn()}
        controller={testController(
          [
            {
              ...commit,
              hash: "octopus",
              shortHash: "octopus",
              isMerge: true,
              parentHashes,
            },
            ...parents,
          ],
          {
            currentBranch: useWorkspaceViewerStore.getState().currentBranch,
            detached: useWorkspaceViewerStore.getState().detached,
          }
        )}
        isMobile
      />
    );
    expect(screen.getByTestId("commit-graph-rail").style.width).toBe("56px");
  });

  it("grows the graph rail up to 50% of the measured pane width once known", () => {
    const parentHashes = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const parents = parentHashes.map((hash) => ({
      ...commit,
      hash,
      shortHash: hash,
      isHead: false,
      refs: [],
      parentHashes: [],
    }));
    const commits = [
      {
        ...commit,
        hash: "octopus",
        shortHash: "octopus",
        isMerge: true,
        parentHashes,
      },
      ...parents,
    ];
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    const stubPaneWidth = (width: number) => {
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect"
      ).mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "commit-history-scroll-container") {
          return {
            width,
            height: 400,
            top: 0,
            left: 0,
            right: width,
            bottom: 400,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      });
    };

    try {
      // A narrow 40px pane buckets down to 28px measured width; 50% of that
      // (14px, one lane) is far below the fixed 84px fallback cap, proving
      // the percentage rule — not the old lane cap — is now in control.
      stubPaneWidth(40);
      const narrow = renderPane(commits);
      expect(screen.getByTestId("commit-graph-rail").style.width).toBe("14px");
      const surfaceWidthWhenNarrow = Number(
        screen.getByTestId("commit-graph-surface").getAttribute("width")
      );
      expect(surfaceWidthWhenNarrow).toBeGreaterThan(14);
      narrow.unmount();

      // A pane wide enough that 50% exceeds the graph's natural content
      // width should show the whole graph with no clamping (no scrollbar
      // needed).
      stubPaneWidth(2000);
      renderPane(commits);
      const rail = screen.getByTestId("commit-graph-rail");
      const surface = screen.getByTestId("commit-graph-surface");
      expect(rail.style.width).toBe(`${surface.getAttribute("width")}px`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("dims commits that are ahead of the detached HEAD", () => {
    const head = {
      ...commit,
      hash: "head",
      shortHash: "head000",
      isHead: true,
    };
    const ahead = {
      ...commit,
      hash: "ahead",
      shortHash: "ahead00",
      subject: "feat: newer than head",
      isHead: false,
    };
    useWorkspaceViewerStore.setState({ detached: true });
    renderPane([ahead, head]);

    // The ahead commit's SVG rail row is dimmed via opacity-60.
    expect(
      screen.getByTestId("commit-graph-svg-ahead").getAttribute("class")
    ).toContain("opacity-60");
  });

  it("renders the checkout-confirm modal elevated above the workspace viewer", () => {
    vi.useFakeTimers();
    // A non-HEAD commit so the "Checkout Commit" item is enabled.
    renderPane([{ ...commit, isHead: false }]);

    fireEvent.touchStart(commitRow(), {
      touches: [{ clientX: 24, clientY: 36 }],
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Checkout Commit (Detach HEAD)" })
    );

    // Regression guard: the confirm dialog must use the elevated z-layer so it
    // is not hidden behind the full-screen workspace viewer (z-workspace-viewer).
    expect(document.querySelector(".z-viewer-modal")).not.toBeNull();
  });

  it("checks out the selected commit from the windowed context menu", async () => {
    vi.mocked(workspaceCheckoutCommit).mockResolvedValue({ detached: true });
    const controllerRefresh = vi.fn();
    const paneRefresh = vi.fn();
    const controller = testController([{ ...commit, isHead: false }], {
      currentBranch: "main",
      refresh: controllerRefresh,
    });
    useWorkspaceViewerStore.setState({
      currentBranch: "main",
      detached: false,
    });
    render(
      <WorkspaceCommitHistoryPane
        onRefresh={paneRefresh}
        controller={controller}
      />
    );

    fireEvent.contextMenu(commitRow());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Checkout Commit (Detach HEAD)",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));

    await waitFor(() =>
      expect(workspaceCheckoutCommit).toHaveBeenCalledWith({
        hash: commit.hash,
        repo: undefined,
      })
    );
    expect(useWorkspaceViewerStore.getState().previousBranch).toBe("main");
    expect(useWorkspaceViewerStore.getState().detached).toBe(true);
    expect(controllerRefresh).toHaveBeenCalledOnce();
    expect(paneRefresh).toHaveBeenCalledOnce();
  });

  it("keeps sparse placeholder rows indexed in the full virtual sequence", () => {
    const commits = [commit, { ...commit, hash: "second", subject: "second" }];
    const controller = testController(commits, {
      totalCount: 40,
      pageSize: 3,
      loadedOffsets: [0, 6],
      getCommit: (index) => (index < 2 ? commits[index] : undefined),
    });
    render(
      <WorkspaceCommitHistoryPane onRefresh={vi.fn()} controller={controller} />
    );

    const placeholder = document.querySelector<HTMLElement>(
      '[data-index="2"][data-virtual-placeholder="true"]'
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute("role", "listitem");
    expect(placeholder).toHaveAttribute("aria-posinset", "3");
    expect(placeholder).toHaveAttribute("aria-setsize", "40");
    expect(
      screen
        .getByTestId(`commit-row-${commit.hash}`)
        .closest('[role="listitem"]')
    ).toHaveAttribute("aria-posinset", "1");
  });

  it("mounts only realized and overscan rows for a large history", () => {
    const commits = Array.from({ length: 1000 }, (_, index) => ({
      ...commit,
      hash: `large-${index}`,
      shortHash: `large-${index}`,
      subject: `Large commit ${index}`,
      isHead: index === 0,
      refs: [],
      parentHashes: index === 999 ? [] : [`large-${index + 1}`],
    }));

    renderPane(commits);

    expect(screen.getAllByTestId(/^commit-row-/).length).toBeLessThan(30);
    expect(screen.getAllByTestId(/^commit-row-/).length).toBeLessThan(
      commits.length
    );
    expect(screen.getByTestId("commit-graph-surface")).toBeInTheDocument();
  });

  it("keeps a commit's graph position stable after scrolling it out and back", async () => {
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "commit-history-scroll-container"
          ? 120
          : (originalOffsetHeight?.get?.call(this) ?? 0);
      },
    });

    try {
      const commits = Array.from({ length: 1000 }, (_, index) => ({
        ...commit,
        hash: `stable-${index}`,
        shortHash: `stable-${index}`,
        subject: `Stable commit ${index}`,
        isHead: index === 0,
        refs: [],
        parentHashes: index === 999 ? [] : [`stable-${index + 1}`],
      }));
      const targetIndex = 5;
      commits[targetIndex] = {
        ...commits[targetIndex],
        isHead: false,
        isMerge: true,
        parentHashes: ["stable-6", "stable-7"],
      };
      commits[targetIndex + 1] = {
        ...commits[targetIndex + 1],
        parentHashes: [],
      };
      commits[targetIndex + 2] = {
        ...commits[targetIndex + 2],
        parentHashes: [],
      };
      const targetHash = commits[targetIndex].hash;
      renderPane(commits);

      const graphBefore = screen.getByTestId(`commit-graph-svg-${targetHash}`);
      const before = {
        transform: graphBefore.getAttribute("transform"),
        paths: [...graphBefore.querySelectorAll("path")].map((path) => ({
          d: path.getAttribute("d"),
          className: path.getAttribute("class"),
        })),
      };
      const scroller = screen.getByTestId("commit-history-scroll-container");

      act(() => {
        scroller.scrollTop = 5000;
        fireEvent.scroll(scroller);
      });
      await waitFor(() =>
        expect(
          screen.queryByTestId(`commit-graph-svg-${targetHash}`)
        ).not.toBeInTheDocument()
      );

      act(() => {
        scroller.scrollTop = targetIndex * 24;
        fireEvent.scroll(scroller);
      });
      await waitFor(() =>
        expect(
          screen.getByTestId(`commit-graph-svg-${targetHash}`)
        ).toBeInTheDocument()
      );

      const graphAfter = screen.getByTestId(`commit-graph-svg-${targetHash}`);
      expect({
        transform: graphAfter.getAttribute("transform"),
        paths: [...graphAfter.querySelectorAll("path")].map((path) => ({
          d: path.getAttribute("d"),
          className: path.getAttribute("class"),
        })),
      }).toEqual(before);
    } finally {
      if (originalOffsetHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetHeight",
          originalOffsetHeight
        );
      }
    }
  });

  it("keeps a merge elbow visible when its parent is outside the realized window", () => {
    const merge = {
      ...commit,
      hash: "windowed-merge",
      shortHash: "windowed",
      subject: "windowed merge",
      isHead: false,
      isMerge: true,
      refs: [],
      parentHashes: ["windowed-main-parent", "windowed-feature-parent"],
    };
    const commits = [
      merge,
      ...Array.from({ length: 40 }, (_, index) => ({
        ...commit,
        hash: `windowed-${index}`,
        shortHash: `windowed-${index}`,
        subject: `Windowed commit ${index}`,
        isHead: index === 0,
        refs: [],
        parentHashes: [],
      })),
    ];

    renderPane(commits);

    expect(
      screen.queryByTestId("commit-graph-svg-windowed-main-parent")
    ).not.toBeInTheDocument();
    const mergeGraph = screen.getByTestId("commit-graph-svg-windowed-merge");
    expect(mergeGraph.querySelectorAll("path").length).toBeGreaterThan(1);
    expect(
      [...mergeGraph.querySelectorAll("path")].some((path) =>
        path.getAttribute("d")?.includes("A")
      )
    ).toBe(true);
  });
});
