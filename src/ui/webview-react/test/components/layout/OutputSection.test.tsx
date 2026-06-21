import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutputSection } from "@components/layout/OutputSection";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";

const applyScrollTargetSpy = vi.fn();
let outputWidth = 1200;
let resizeObserverCallback: (() => void) | null = null;

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
    rows: [{ key: "row-1" }],
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
    isOutputVirtualized: false,
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
    virtualRows: [],
  }),
}));

vi.mock("@hooks/useOutputFind", () => ({
  useOutputFind: () => ({
    state: { isOpen: false, query: "", caseSensitive: false },
    setState: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
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
    onToggleCollapse,
  }: {
    onToggleCollapse: () => void;
  }) => (
    <button type="button" onClick={onToggleCollapse}>
      Collapse output
    </button>
  ),
}));

vi.mock("@components/layout/output-section/OutputPane", () => ({
  OutputPane: ({
    outputRef,
  }: {
    outputRef: React.RefObject<HTMLDivElement | null>;
  }) => (
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
    />
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
    outputWidth = 1200;
    resizeObserverCallback = null;
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
});
