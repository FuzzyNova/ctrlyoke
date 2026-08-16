import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutputSection } from "@components/layout/OutputSection";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

const applyScrollTargetSpy = vi.fn();
const closeFindSpy = vi.fn();
const openFindSpy = vi.fn();
let outputWidth = 1200;
let resizeObserverCallback: (() => void) | null = null;
let outputFindIsOpen = false;
let outputRows = [{ key: "row-1" }];
let outputIsVirtualized = false;
let outputVirtualRows: Array<{ index: number }> = [];

vi.mock("@hooks/useVsCodeApi", () => ({
  getVsCodeApi: () => null,
}));

vi.mock("@hooks/useElementNarrow", () => ({
  useElementNarrow: () => [vi.fn(), false] as const,
}));

vi.mock("@hooks/useOutputExport", () => ({
  useOutputExport: () => ({
    modalOpen: false,
    includeCommand: false,
    includeMetadata: false,
    isStandaloneMode: false,
    stepRange: "",
    stepRangeError: null,
    totalCliSteps: 0,
    openModal: vi.fn(),
    closeModal: vi.fn(),
    confirmExport: vi.fn(),
    setIncludeCommand: vi.fn(),
    setIncludeMetadata: vi.fn(),
    updateStepRange: vi.fn(),
  }),
}));

vi.mock("@hooks/useOutputMinimapModel", () => ({
  useOutputMinimapModel: () => ({
    minimapSteps: [],
    stepScrollFractions: new Map(),
  }),
}));

vi.mock("@hooks/useOutputNavigation", () => ({
  useOutputNavigation: () => ({
    navigationController: {
      scrollToRowIndex: vi.fn(),
      scrollToTarget: vi.fn(),
    },
    navigationPendingRowIndex: null,
  }),
}));

vi.mock("@hooks/useOutputRowsModel", () => ({
  useOutputRowsModel: () => ({
    allMessages: [],
    rows: outputRows,
    uniqueStepTargets: [],
    stepOutputsMap: new Map(),
    lastCliIndexPerStep: new Map(),
    firstRowIndexByTarget: new Map(),
    anyDiffCollapsed: false,
    bashExpansionState: new Map(),
    handleDiffCollapsedChange: vi.fn(),
    handleDiffGapExpand: vi.fn(),
    handleToolCallExpansionChange: vi.fn(),
    handleBashExpansionChange: vi.fn(),
  }),
}));

vi.mock("@hooks/useOutputScrollSeek", () => ({
  useOutputScrollSeek: () => ({
    outputOverscan: 6,
    outputOverscanRef: { current: 6 },
    renderedScrollSeekIndices: new Set<number>(),
    scheduleOverscanRestore: vi.fn(),
    scrollSeekPlaceholderActive: false,
    scrollSeekPlaceholderRef: { current: false },
    scrollSeekRestoreRequestedAtRef: { current: null },
    scrollSeekSettlingUntilRef: { current: null },
    updateScrollSeekForScroll: () => ({
      isFastScroll: false,
      rawFastScroll: false,
      scrollDeltaPx: 0,
      scrollGapMs: 0,
      scrollVelocityPxMs: 0,
      suppressedFastScroll: false,
    }),
    handleWheel: vi.fn(),
    handleTouchStart: vi.fn(),
    handleTouchMove: vi.fn(),
    handleTouchEnd: vi.fn(),
  }),
}));

vi.mock("@hooks/useOutputScrollTarget", () => ({
  useOutputScrollTarget: () => ({
    applyScrollTarget: applyScrollTargetSpy,
    scheduleScrollTargetCommit: vi.fn(),
    setCurrentScrollTarget: vi.fn(),
  }),
}));

vi.mock("@hooks/useOutputUndoActions", () => ({
  useOutputUndoActions: () => ({
    closeMinimapDialog: vi.fn(),
    closeWorkflowDialog: vi.fn(),
    handleFileUndo: vi.fn(),
    handlePromptRedo: vi.fn(),
    handlePromptUndo: vi.fn(),
    handleWorkflowRedo: vi.fn(),
    handleWorkflowUndo: vi.fn(),
    minimapDialogState: null,
    openMinimapRedoDialog: vi.fn(),
    openMinimapUndoDialog: vi.fn(),
    workflowDialogState: null,
    workflowUndoRedoData: { undoEntries: [], redoEntries: [] },
  }),
}));

vi.mock("@hooks/useOutputVirtualization", () => ({
  useOutputVirtualization: () => ({
    clearMeasurements: vi.fn(),
    getRowEstimateStats: vi.fn(() => []),
    hasPendingMeasurements: () => false,
    handleOutputProfilerRender: vi.fn(),
    invalidateMeasuredRow: vi.fn(),
    invalidateMeasuredRowForUserResize: vi.fn(),
    isNonVirtualOutputStaging: false,
    isOutputScrollSeeking: false,
    isOutputVirtualized: outputIsVirtualized,
    measureRowElement: vi.fn(),
    measureStaticRowElement: vi.fn(),
    measurementVersion: 0,
    measurementVersionRef: { current: 0 },
    nonVirtualRows: [{ key: "row-1" }],
    nonVirtualSpacerHeight: 0,
    rowLayout: {
      totalSize: 0,
      rowStartsByIndex: [],
      rowStartsByKey: new Map(),
      rowSizesByKey: new Map(),
    },
    rowVirtualizer: {
      getTotalSize: () => 0,
      getVirtualItems: () => [],
      measurementsCache: [],
      scrollToIndex: vi.fn(),
    },
    rowsRef: { current: [{ key: "row-1" }] },
    schedulePendingMeasurementFlush: vi.fn(),
    virtualRows: outputVirtualRows,
  }),
}));

vi.mock("@hooks/useOutputFind", () => ({
  useOutputFind: () => ({
    state: { isOpen: outputFindIsOpen, query: "", caseSensitive: false },
    setState: vi.fn(),
    open: openFindSpy,
    close: closeFindSpy,
    search: vi.fn(),
    navigate: vi.fn(),
    handleKeyDown: vi.fn(),
    rowDecorations: new Map(),
    activeMatch: null,
  }),
}));

vi.mock("@utils/createAnimationFrameResizeObserver", () => ({
  createAnimationFrameResizeObserver: (callback: () => void) => {
    resizeObserverCallback = callback;
    return {
      observer: {
        observe: vi.fn(),
      },
      disconnect: vi.fn(),
    };
  },
}));

vi.mock("@components/output", () => ({
  OutputFindBar: () => null,
}));

vi.mock("@components/output/OutputMinimap", () => ({
  OutputMinimap: () => null,
}));

vi.mock("@components/output/TerminalView", () => ({
  TerminalView: () => null,
}));

vi.mock("@components/layout/output-section/ExportOutputModal", () => ({
  ExportOutputModal: () => null,
}));

vi.mock("@components/layout/output-section/OutputSectionHeader", () => ({
  OutputSectionHeader: ({
    isFindOpen,
    onToggleFind,
    onToggleCollapse,
    terminalExecutionRunLabel,
  }: {
    isFindOpen: boolean;
    onToggleFind: () => void;
    onToggleCollapse: () => void;
    terminalExecutionRunLabel: string | null;
  }) => (
    <>
      <button type="button" aria-pressed={isFindOpen} onClick={onToggleFind}>
        Toggle output find
      </button>
      <button type="button" onClick={onToggleCollapse}>
        Collapse output
      </button>
      {terminalExecutionRunLabel && (
        <span data-testid="terminal-execution-run-label">
          {terminalExecutionRunLabel}
        </span>
      )}
    </>
  ),
}));

vi.mock("@components/layout/output-section/OutputPane", () => ({
  OutputPane: ({
    outputRef,
    showVirtualizationOverlay,
    runBanner,
  }: {
    outputRef: React.RefObject<HTMLDivElement | null>;
    showVirtualizationOverlay: boolean;
    runBanner?: {
      runId: number;
      executionState: string;
      tokenTotals?: { total: number };
    };
  }) => (
    <>
      <div
        ref={(node) => {
          if (!node) {
            outputRef.current = null;
            return;
          }
          Object.defineProperty(node, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ width: outputWidth }),
          });
          outputRef.current = node;
        }}
        data-testid="output-pane"
        data-virtualization-overlay={showVirtualizationOverlay}
      />
      {runBanner && (
        <span
          data-testid="run-banner"
          data-run-id={runBanner.runId}
          data-execution-state={runBanner.executionState}
        >
          {runBanner.tokenTotals?.total}
        </span>
      )}
    </>
  ),
}));

vi.mock("@components/layout/output-section/OutputUndoDialogs", () => ({
  OutputUndoDialogs: () => null,
}));

vi.mock("@utils/panelAnimation", () => ({
  triggerPanelAnimation: vi.fn(),
}));

vi.mock("@hooks/useOutputContextMenu", () => ({
  useOutputContextMenu: () => ({
    openContextMenu: vi.fn(),
    outputContextMenuPortal: null,
  }),
}));

vi.mock("@hooks/useLongPress", () => ({
  useLongPress: () => ({
    onTouchStart: vi.fn(),
    onTouchMove: vi.fn(),
    onTouchEnd: vi.fn(),
    onTouchCancel: vi.fn(),
  }),
}));

vi.mock("@utils/outputProjection", () => ({
  toOutputMessageTarget: (target: unknown) => target,
}));

vi.mock("@utils/performanceProfiler", () => ({
  getProfilerState: () => ({ enabled: false, slowThresholdMs: 50 }),
  logProfilerEvent: vi.fn(),
  shouldLogScrollFrame: () => false,
  shouldLogScrollAttribution: () => false,
}));

vi.mock("@utils/logger", () => ({
  WebviewLog: { debug: vi.fn() },
}));

vi.mock("@utils/outputDom", () => ({
  captureViewportRowAnchor: vi.fn(() => null),
  getResizeObserverEntryHeight: vi.fn(() => null),
}));

function resetStores() {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useTerminalStore.setState({ sessions: {}, activeSessionIds: {} });
  useUiStore.setState({
    outputCollapsed: false,
    editorCollapsed: false,
    loadedWorkflows: [],
    activeWorkflowId: null,
  });
}

describe("OutputSection", () => {
  beforeEach(() => {
    resetStores();
    applyScrollTargetSpy.mockReset();
    closeFindSpy.mockReset();
    openFindSpy.mockReset();
    outputWidth = 1200;
    outputFindIsOpen = false;
    outputRows = [{ key: "row-1" }];
    outputIsVirtualized = false;
    outputVirtualRows = [];
    resizeObserverCallback = null;
  });

  it("does not restore the rendering overlay for an appended virtual row", () => {
    outputRows = Array.from({ length: 20 }, (_, index) => ({
      key: `row-${index}`,
    }));
    outputIsVirtualized = true;
    outputVirtualRows = [{ index: 0 }];

    const { rerender } = render(<OutputSection />);
    expect(screen.getByTestId("output-pane")).toHaveAttribute(
      "data-virtualization-overlay",
      "false"
    );

    outputRows = [...outputRows, { key: "row-20" }];
    outputVirtualRows = [];
    rerender(<OutputSection />);

    expect(screen.getByTestId("output-pane")).toHaveAttribute(
      "data-virtualization-overlay",
      "false"
    );
  });

  it("shows the rendering overlay before the first virtual range is ready", () => {
    outputRows = Array.from({ length: 20 }, (_, index) => ({
      key: `row-${index}`,
    }));
    outputIsVirtualized = true;

    render(<OutputSection />);

    expect(screen.getByTestId("output-pane")).toHaveAttribute(
      "data-virtualization-overlay",
      "true"
    );
  });

  it("skips width-change scroll restoration while collapsing the output pane", () => {
    render(<OutputSection />);

    expect(
      screen.getByRole("button", { name: "Collapse output" })
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Collapse output" }));
    outputWidth = 0;

    act(() => {
      resizeObserverCallback?.();
    });

    expect(useUiStore.getState().outputCollapsed).toBe(true);
    expect(applyScrollTargetSpy).not.toHaveBeenCalledWith("width-change");
  });

  it("routes live auto-scroll through the shared scroll target", () => {
    render(<OutputSection />);

    expect(applyScrollTargetSpy).toHaveBeenCalledWith("auto-scroll");
  });

  it("opens and closes output find from the header toggle", () => {
    const { unmount } = render(<OutputSection />);
    const findButton = screen.getByRole("button", {
      name: "Toggle output find",
    });

    fireEvent.click(findButton);
    expect(openFindSpy).toHaveBeenCalledOnce();
    expect(closeFindSpy).not.toHaveBeenCalled();

    outputFindIsOpen = true;
    unmount();
    render(<OutputSection />);

    const openFindButton = screen.getByRole("button", {
      name: "Toggle output find",
    });
    expect(openFindButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(openFindButton);
    expect(closeFindSpy).toHaveBeenCalledOnce();
  });

  it("labels terminal ownership with the exact executing run ID while viewing another run", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-historical" as never,
      },
      executionRunRef: "run-live",
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-live" as never,
          runId: 1042,
          startedAt: 1042,
          executionState: "running" as never,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-historical" as never,
          runId: 1031,
          startedAt: 1031,
          executionState: "completed" as never,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });

    render(<OutputSection />);

    expect(
      screen.getByTestId("terminal-execution-run-label")
    ).toHaveTextContent("Live Run 1042");
  });

  it("does not add an execution label while the executing run is viewed", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-live" as never,
      },
      executionRunRef: "run-live",
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-live" as never,
          runId: 1042,
          startedAt: 1042,
          executionState: "running" as never,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });

    render(<OutputSection />);

    expect(
      screen.queryByTestId("terminal-execution-run-label")
    ).not.toBeInTheDocument();
  });

  it("shows the active workflow's live totals while viewing live output", () => {
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
      loadedWorkflows: [
        {
          id: "workflow-1",
          workflowName: "Live workflow",
          filePath: "workflow.prompt.md",
          executionState: "running" as never,
          currentStep: 1,
          totalSteps: 2,
          startedAt: 2000,
          tokenTotals: {
            total: 5_000,
            coverage: "complete" as never,
            reportedAttemptCount: 1,
            attemptCount: 1,
            isFinal: false,
            byHarness: {},
            byLocalDay: {},
          },
        },
      ],
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-live" as never,
      },
      executionRunRef: "run-live" as never,
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-live" as never,
          runId: 7,
          startedAt: 2000,
          executionState: "running" as never,
          definitionRevision: 1,
          stepCount: 2,
          hasMixedHarnesses: false,
          hasMixedModels: false,
          // Stale snapshot totals — the live banner should prefer the
          // workflow's own live-updating totals over this manifest snapshot.
          tokenTotals: {
            total: 999,
            coverage: "complete" as never,
            reportedAttemptCount: 1,
            attemptCount: 1,
            isFinal: false,
            byHarness: {},
            byLocalDay: {},
          },
        },
      ],
    });

    render(<OutputSection />);

    const banner = screen.getByTestId("run-banner");
    expect(banner).toHaveAttribute("data-run-id", "7");
    expect(banner).toHaveTextContent("5000");
  });

  it("keeps the current run banner after the terminal workflow leaves the live list", () => {
    useWorkflowStore.setState({ executionState: "completed" as never });
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
      loadedWorkflows: [],
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-completed" as never,
      },
      executionRunRef: "run-completed" as never,
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-completed" as never,
          runId: 8,
          startedAt: 3000,
          executionState: "running" as never,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
        },
      ],
    });

    render(<OutputSection />);

    expect(screen.getByTestId("run-banner")).toHaveAttribute(
      "data-run-id",
      "8"
    );
    expect(screen.getByTestId("run-banner")).toHaveAttribute(
      "data-execution-state",
      "completed"
    );
  });

  it("shows the viewed historical run's totals instead of the executing run's", () => {
    useUiStore.setState({
      activeWorkflowId: "workflow-1",
      loadedWorkflows: [
        {
          id: "workflow-1",
          workflowName: "Live workflow",
          filePath: "workflow.prompt.md",
          executionState: "running" as never,
          currentStep: 1,
          totalSteps: 2,
          tokenTotals: {
            total: 5_000,
            coverage: "complete" as never,
            reportedAttemptCount: 1,
            attemptCount: 1,
            isFinal: false,
            byHarness: {},
            byLocalDay: {},
          },
        },
      ],
      displayedViewAddress: {
        workflowKey: "workflow-1" as never,
        kind: "run",
        runRef: "run-historical" as never,
      },
      executionRunRef: "run-live",
      runSummaries: [
        {
          workflowKey: "workflow-1" as never,
          runRef: "run-historical" as never,
          runId: 1031,
          startedAt: 1031,
          executionState: "completed" as never,
          definitionRevision: 1,
          stepCount: 1,
          hasMixedHarnesses: false,
          hasMixedModels: false,
          tokenTotals: {
            total: 410_000,
            coverage: "complete" as never,
            reportedAttemptCount: 1,
            attemptCount: 1,
            isFinal: true,
            byHarness: {},
            byLocalDay: {},
          },
        },
      ],
    });
    useUiStore.getState().setHistoryView();

    render(<OutputSection />);

    const banner = screen.getByTestId("run-banner");
    expect(banner).toHaveAttribute("data-run-id", "1031");
    expect(banner).toHaveTextContent("410000");
  });
});
