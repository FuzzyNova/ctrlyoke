import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { HistorySearchDrawer } from "@components/search/HistorySearchDrawer";
import { useWorkflowStore } from "@store/workflowStore";
import {
  ALL_HISTORY_EVENT_KINDS,
  DEFAULT_HISTORY_SEARCH_FILTERS,
  useUiStore,
  type HistorySearchFilterState,
} from "@store/uiStore";
import {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
} from "@utils/dateRangeFilter";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";

const postMessage = vi.mocked(window.vscodeApi!.postMessage);

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
      return this.classList.contains("overflow-y-auto") ? 100 : 20;
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

const result = {
  workflowKey: "workflow-1" as never,
  runRef: "run-1" as never,
  workflowName: "Search Workflow",
  runId: 3,
  startedAt: 1234,
  executionState: "completed",
  target: { kind: "queue" as const, stepIndex: 0 },
  eventKind: "response" as const,
  matchField: "content" as const,
  matchSnippet: "needle found here",
  matchContext: "Prompt 1",
};

function results(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    ...result,
    runRef: `run-${index}` as never,
    runId: index,
  }));
}

function renderSearch(
  filters: HistorySearchFilterState = DEFAULT_HISTORY_SEARCH_FILTERS
) {
  useUiStore.getState().openHistorySearch();
  useUiStore.getState().setHistorySearchFilters({
    ...filters,
    eventKinds: [...filters.eventKinds],
    harnesses: [...filters.harnesses],
    executionStates: [...filters.executionStates],
    dateRange: { ...filters.dateRange },
  });
  useUiStore.getState().setHistorySearchQuery("needle");
  const view = render(<HistorySearchDrawer />);

  act(() => {
    vi.advanceTimersByTime(400);
  });
  postMessage.mockClear();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  useUiStore.getState().resetUi();
  useWorkflowStore.setState({ workflowName: null });
  postMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HistorySearchDrawer filters", () => {
  it("sends no narrowing filters while every option is still selected", () => {
    useUiStore.getState().openHistorySearch();
    useUiStore.getState().setHistorySearchQuery("needle");
    render(<HistorySearchDrawer />);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    // A full selection must not reach the backend as a filter. `harnesses` is
    // the dangerous one: the backend drops documents with no harness whenever
    // that filter is present, and status messages plus script/pre-condition/
    // end-condition output legitimately have none. Sending the complete list
    // would hide all of them with no filter actually turned on.
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {},
    });
  });

  it("re-issues a filtered search immediately and clears the cursor", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults([], false, {
        totalCount: 2450,
        nextCursor: "stale-cursor",
        hasMore: true,
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "History search filters" })
    );
    fireEvent.click(screen.getByRole("button", { name: "All Events" }));
    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        eventKinds: ALL_HISTORY_EVENT_KINDS.filter((kind) => kind !== "prompt"),
      },
    });
    expect(useUiStore.getState().historySearchNextCursor).toBeUndefined();
    expect(useUiStore.getState().historySearchResults).toEqual([]);
  });

  it("includes active filters when loading another page", () => {
    const view = renderSearch({
      ...DEFAULT_HISTORY_SEARCH_FILTERS,
      pathContains: "src/ui",
    });
    act(() => {
      useUiStore.getState().setHistorySearchResults(results(40), false, {
        totalCount: 100,
        nextCursor: "next-cursor",
        hasMore: true,
      });
    });

    const scroller =
      view.container.querySelector<HTMLElement>(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    if (!scroller) return;

    act(() => {
      scroller.scrollTop = 5000;
      fireEvent.scroll(scroller);
      fireEvent.scroll(scroller);
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      cursor: "next-cursor",
      filters: {
        pathContains: "src/ui",
      },
    });
  });

  it("does not render a Load more button when more results are available", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults(results(40), false, {
        totalCount: 100,
        nextCursor: "next-cursor",
        hasMore: true,
      });
    });

    expect(
      screen.queryByRole("button", { name: "Load more" })
    ).not.toBeInTheDocument();
  });

  it("renders placeholders for trailing results that are not loaded yet", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 100,
        hasMore: false,
      });
    });

    expect(
      document.querySelector('[data-history-search-placeholder="true"]')
    ).toBeInTheDocument();
  });

  it("keeps loaded results when reopening after navigating to a result", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 1,
        hasMore: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Search Workflow/ }));
    postMessage.mockClear();

    act(() => {
      useUiStore.getState().openHistorySearch();
    });

    expect(screen.getByText("needle found here")).toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.SEARCH_HISTORY })
    );
  });

  it("re-issues immediately when the harness filter changes", () => {
    renderSearch();
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters" })
    );
    fireEvent.click(screen.getByRole("button", { name: "All Harnesses" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        harnesses: ALL_WORKFLOW_HARNESSES.filter(
          (harness) => harness !== HARNESS_IDS.CLAUDE_CLI
        ),
      },
    });
  });

  it("re-issues immediately when the run outcome filter changes", () => {
    renderSearch();
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters" })
    );
    fireEvent.click(screen.getByRole("button", { name: "All Outcomes" }));
    fireEvent.click(
      screen.getByRole("button", { name: EXECUTION_STATES.ERROR })
    );

    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        executionStates: ALL_WORKFLOW_STATES.filter(
          (state) => state !== EXECUTION_STATES.ERROR
        ),
      },
    });
  });

  it("debounces file path changes", () => {
    renderSearch();
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters" })
    );
    const pathInput = screen.getByRole("textbox", {
      name: "File path contains",
    });

    fireEvent.change(pathInput, { target: { value: "webview-react" } });
    expect(postMessage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(postMessage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        pathContains: "webview-react",
      },
    });
  });

  it("hides workflow scope without a lineage and sends its key when checked", () => {
    renderSearch();
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters" })
    );
    expect(
      screen.queryByRole("checkbox", { name: /This workflow only/ })
    ).not.toBeInTheDocument();

    act(() => {
      useUiStore.setState({
        displayedViewAddress: {
          workflowKey: "workflow-1" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-1" as never,
        },
      });
      useWorkflowStore.setState({ workflowName: "Search Workflow" });
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "This workflow only: Search Workflow",
      })
    );

    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        workflowKeys: ["workflow-1"],
      },
    });
  });

  it("shows the number of non-default active filters", () => {
    renderSearch({
      ...DEFAULT_HISTORY_SEARCH_FILTERS,
      eventKinds: ALL_HISTORY_EVENT_KINDS.slice(0, -1),
      pathContains: "src/ui",
    });

    const filterButton = screen.getByRole("button", {
      name: "History search filters (2 active)",
    });
    expect(filterButton).toHaveTextContent("2");
  });

  it("resets filters with clear-all and re-issues the default search", () => {
    renderSearch({
      ...DEFAULT_HISTORY_SEARCH_FILTERS,
      eventKinds: ALL_HISTORY_EVENT_KINDS.slice(0, -1),
      harnesses: ALL_WORKFLOW_HARNESSES.slice(0, -1),
      executionStates: ALL_WORKFLOW_STATES.slice(0, -1),
      pathContains: "src/ui",
      dateRange: {
        preset: "custom",
        from: "2026-01-01",
        to: "2026-01-02",
      },
      workflowOnly: true,
    });
    act(() => {
      useUiStore.getState().setHistorySearchResults([], false, {
        nextCursor: "stale-cursor",
        hasMore: true,
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters (8 active)" })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear history search filters" })
    );

    expect(useUiStore.getState().historySearchFilters).toEqual(
      expect.objectContaining({
        pathContains: "",
        workflowOnly: false,
      })
    );
    expect(useUiStore.getState().historySearchNextCursor).toBeUndefined();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {},
    });
  });

  it("adds the filtered suffix only when a filter is active", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 2450,
        hasMore: false,
      });
    });
    expect(screen.getByText("Showing 1 of 2450")).not.toHaveTextContent(
      "(filtered)"
    );

    act(() => {
      useUiStore.getState().setHistorySearchFilters({
        ...DEFAULT_HISTORY_SEARCH_FILTERS,
        pathContains: "src/ui",
      });
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 2450,
        hasMore: false,
      });
    });
    expect(
      screen.getByText("Showing 1 of 2450 (filtered)")
    ).toBeInTheDocument();
  });

  it("shows when the search is using the fallback index path", () => {
    renderSearch();
    act(() => {
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 1,
        hasMore: false,
        indexState: "fallback",
      });
    });

    expect(screen.getByText("Using fallback search")).toBeInTheDocument();
  });
});
