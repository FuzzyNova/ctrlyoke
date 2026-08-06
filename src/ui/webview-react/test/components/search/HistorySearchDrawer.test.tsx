import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HistorySearchDrawer } from "@components/search/HistorySearchDrawer";
import {
  ALL_HISTORY_EVENT_KINDS,
  DEFAULT_HISTORY_SEARCH_FILTERS,
  useUiStore,
} from "@store/uiStore";
import {
  ALL_WORKFLOW_HARNESSES,
  ALL_WORKFLOW_STATES,
} from "@utils/dateRangeFilter";
import { MESSAGE_TYPES } from "@/types/messages";

const postMessage = vi.mocked(window.vscodeApi!.postMessage);

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

function renderSearch(filters = DEFAULT_HISTORY_SEARCH_FILTERS) {
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
  postMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HistorySearchDrawer filters", () => {
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
        harnesses: ALL_WORKFLOW_HARNESSES,
        executionStates: ALL_WORKFLOW_STATES,
      },
    });
    expect(useUiStore.getState().historySearchNextCursor).toBeUndefined();
    expect(useUiStore.getState().historySearchResults).toEqual([]);
  });

  it("includes active filters when loading another page", () => {
    renderSearch({
      ...DEFAULT_HISTORY_SEARCH_FILTERS,
      pathContains: "src/ui",
    });
    act(() => {
      useUiStore.getState().setHistorySearchResults([result], false, {
        totalCount: 51,
        nextCursor: "next-cursor",
        hasMore: true,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      cursor: "next-cursor",
      filters: {
        eventKinds: ALL_HISTORY_EVENT_KINDS,
        harnesses: ALL_WORKFLOW_HARNESSES,
        executionStates: ALL_WORKFLOW_STATES,
        pathContains: "src/ui",
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
    });
    act(() => {
      useUiStore.getState().setHistorySearchResults([], false, {
        nextCursor: "stale-cursor",
        hasMore: true,
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "History search filters (1 active)" })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Clear history search filters" })
    );

    expect(useUiStore.getState().historySearchFilters).toEqual(
      expect.objectContaining({
        eventKinds: ALL_HISTORY_EVENT_KINDS,
        harnesses: ALL_WORKFLOW_HARNESSES,
        executionStates: ALL_WORKFLOW_STATES,
        pathContains: "",
        workflowOnly: false,
      })
    );
    expect(useUiStore.getState().historySearchNextCursor).toBeUndefined();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.SEARCH_HISTORY,
      query: "needle",
      limit: 50,
      filters: {
        eventKinds: ALL_HISTORY_EVENT_KINDS,
        harnesses: ALL_WORKFLOW_HARNESSES,
        executionStates: ALL_WORKFLOW_STATES,
      },
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
});
