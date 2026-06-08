import React, {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore, type OutputScrollTarget } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { useOutputExport } from "@hooks/useOutputExport";
import { useOutputMinimapModel } from "@hooks/useOutputMinimapModel";
import {
  useOutputNavigation,
  type PendingNavigationState,
} from "@hooks/useOutputNavigation";
import { useOutputRowsModel } from "@hooks/useOutputRowsModel";
import { useOutputScrollTarget } from "@hooks/useOutputScrollTarget";
import { useOutputUndoActions } from "@hooks/useOutputUndoActions";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import {
  MESSAGE_TYPES,
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
  EXECUTION_STATES,
  SESSION_KINDS,
  SETTING_SCOPES,
} from "../../types/messages";
import { type MinimapStep } from "../output/OutputMinimap";
import { TerminalView } from "../output/TerminalView";
import { useTerminalStore } from "@store/terminalStore";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";
import { ExportOutputModal } from "./output-section/ExportOutputModal";
import { OutputSectionHeader } from "./output-section/OutputSectionHeader";
import { OutputPane } from "./output-section/OutputPane";
import { getWheelDeltaPixels } from "./output-section/OutputScrollSeekPlaceholder";
import { OutputUndoDialogs } from "./output-section/OutputUndoDialogs";

import { triggerPanelAnimation } from "@utils/panelAnimation";
import { WebviewLog } from "@utils/logger";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import {
  estimateOutputRowHeight,
  type OutputRenderRow,
  type StructuredEventRow,
} from "@utils/outputRows";
import {
  getOutputProfilerState,
  isOutputProfilingEnabled,
  logOutputProfilerEvent,
  measureOutputPhase,
  shouldLogOutputMeasurement,
  shouldLogOutputScrollFrame,
  shouldLogOutputVirtualRange,
} from "@utils/outputPerformance";
import {
  findRenderedRowElementByKey,
  getMeasuredElementHeight,
  getResizeObserverEntryHeight,
} from "@utils/outputDom";

// Stable empty fallback — avoids infinite re-render from `?? []` returning a new
// array reference on every useSyncExternalStore snapshot call.
const EMPTY_TERMINAL_SESSIONS: TerminalSession[] = [];

// Stable workflowId used for standalone user shell sessions (no active workflow).
const SHELL_WORKFLOW_ID = "_shell";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to keep auto-scroll pinned.
const DIFF_SPLIT_VIEW_MIN_WIDTH = 1024; // minimum output width before diffs use split view.
const OUTPUT_VIRTUALIZER_OVERSCAN = 6; // idle extra rows above/below viewport; 6 gives more pre-render buffer to reduce slow-scroll blank-edge flashes.
const OUTPUT_ACTIVE_SCROLL_OVERSCAN = 2; // extra rows while fast-scroll placeholders are active; lower reduces work during rapid scroll.
const OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN = 0; // first real-row restore renders only viewport rows; extra rows are staged later.
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN = 3; // distinct from active-scroll overscan so staged restore never re-enters placeholder mode.
const OUTPUT_OVERSCAN_RESTORE_DELAY_MS = 250; // idle time after fast scrolling before placeholders swap back to real rows.
const OUTPUT_SCROLL_SEEK_CONTINUE_DELTA_PX = 16; // scroll delta that keeps placeholder mode alive once it has started.
const OUTPUT_SCROLL_SEEK_SLOW_DELTA_PX = 48; // below this delta, treat scrolling as slowing and use the shorter restore delay.
const OUTPUT_SCROLL_SEEK_SLOW_RESTORE_DELAY_MS = 80; // restore delay while scrolling is slowing, so rows start rendering before a dead stop.
const OUTPUT_SCROLL_SEEK_MIN_DELTA_PX = 100; // minimum single-event movement that can trigger placeholder mode by velocity.
const OUTPUT_SCROLL_SEEK_WHEEL_DELTA_PX = 16; // wheel delta that pre-arms placeholder mode before the browser scrolls.
const OUTPUT_SCROLL_SEEK_TOUCH_DELTA_PX = 12; // touch movement that pre-arms placeholder mode before mobile scroll settles.
const OUTPUT_SCROLL_SEEK_MIN_VELOCITY_PX_MS = 0.3; // minimum px/ms velocity for the delta threshold to count as fast scrolling.
const OUTPUT_SCROLL_SEEK_PAGE_FRACTION = 0.9; // viewport fraction moved in one event that always counts as fast scrolling.
const OUTPUT_SCROLL_SEEK_SETTLE_MS = 2000; // time after restore to ignore layout-driven scroll corrections as fast-scroll triggers.
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS = 600; // delay before adding a small buffer after visible rows mount.
const OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS = 1800; // delay before expanding from restore overscan back to normal overscan.
const OUTPUT_USER_SCROLL_INPUT_GRACE_MS = 200; // recent wheel input window that lets real user scrolling bypass settle suppression.
const OUTPUT_SCROLL_TARGET_COMMIT_MAX_RETRIES = 5; // animation-frame retries for capturing a viewport anchor when rows are mid-transition (e.g. scroll-seek placeholder swap).
const OUTPUT_ROW_RESIZE_SCROLL_SUPPRESS_MS = 300; // time to ignore virtualizer scroll correction after user expands row content.
const LARGE_WORKFLOW_ROW_THRESHOLD = 20; // row count where fast-scroll placeholder behavior is enabled.
const NON_VIRTUAL_STAGING_ROW_THRESHOLD = 60; // row count where non-virtual rows mount progressively.
const NON_VIRTUAL_INITIAL_RENDER_ROWS = 24;
const NON_VIRTUAL_RENDER_CHUNK_ROWS = 24;
const MAX_NAV_ALIGNMENT_ATTEMPTS = 8; // max correction passes when aligning minimap/step navigation.
const MAX_NAVIGATION_STABILIZATION_MS = 1000; // time limit for navigation alignment before accepting the current position.
const DEFAULT_OUTPUT_SCROLL_TARGET: OutputScrollTarget = { kind: "bottom" };

interface RowHeightBucketStats {
  sampleCount: number;
  totalMeasured: number;
  totalEstimated: number;
  maxAbsDelta: number;
}

function getZeroHeightStructuredEventReason(
  row: StructuredEventRow
): string | null {
  switch (row.event.type) {
    case CLI_EVENT_TYPES.TEXT:
      return (row.event.data as { text?: string }).text ? null : "missing-text";
    case CLI_EVENT_TYPES.THINKING:
      return (row.event.data as { text?: string }).text
        ? null
        : "missing-thinking-text";
    case CLI_EVENT_TYPES.FILE_EDIT:
    case CLI_EVENT_TYPES.FILE_WRITE:
    case CLI_EVENT_TYPES.FILE_READ:
    case CLI_EVENT_TYPES.FILE_DELETE:
      return (row.event.data as { path?: string }).path
        ? null
        : "missing-file-path";
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = row.event.data as { server?: string; tool?: string };
      if (!data.server) return "missing-mcp-server";
      return data.tool ? null : "missing-mcp-tool";
    }
    case CLI_EVENT_TYPES.WEB_SEARCH:
      return (row.event.data as { query?: string }).query
        ? null
        : "missing-web-search-query";
    case CLI_EVENT_TYPES.TOOL_CALL:
      return (row.event.data as { name?: string }).name
        ? null
        : "missing-tool-call-name";
    case CLI_EVENT_TYPES.TOOL_RESULT:
      return (row.event.data as { result?: unknown }).result
        ? null
        : "missing-tool-result";
    case CLI_EVENT_TYPES.BASH_COMMAND:
    case CLI_EVENT_TYPES.COMPACTION:
      return null;
    default:
      return "unsupported-structured-event";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getRowHeightBucket(row: OutputRenderRow): string {
  switch (row.rowKind) {
    case "history-banner":
    case "step-anchor":
    case "final-step-label":
    case "status":
    case "cli-header":
    case "prompt":
    case "cli-command":
    case "error":
    case "plain-response":
    case "stats":
      return row.rowKind;
    case "structured-event":
      if (row.diff) {
        return `structured-event:diff:${row.diff.renderPlan.viewType}:${row.diff.isCollapsed ? "collapsed" : "expanded"}`;
      }
      if (row.toolCall) {
        return "structured-event:tool-call";
      }
      if (row.event.type === CLI_EVENT_TYPES.TEXT) {
        const text = (row.event.data as { text?: string }).text ?? "";
        if (/^\|.+\|/m.test(text)) return "structured-event:text:table";
      }
      return `structured-event:${row.event.type}`;
  }
}

/**
 * OutputSection Component
 *
 * Renders all CLI outputs and status messages in chronological order.
 * Features:
 * - Collapsible section header
 * - Auto-scroll toggle
 * - Export to markdown
 * - Empty state display
 * - Streaming indicator support
 * - Output minimap rail for navigation and prompt-level undo
 *
 * Performance notes:
 * - Uses granular Zustand selectors so streaming chunk updates only cause
 *   the streaming CliOutput row to re-render, not the entire list.
 * - CliOutput rows for completed steps are wrapped with React.memo so they
 *   skip reconciliation when their props haven't changed.
 */
const OutputSectionInner: React.FC = () => {
  // ── Granular store selectors ───────────────────────────────────────────────
  // Each selector is independent so only the relevant slice of state triggers
  // a re-render of this component.
  const fileName = useWorkflowStore((s) => s.fileName);
  const executionState = useWorkflowStore((s) => s.executionState);
  const currentStep = useWorkflowStore((s) => s.currentStep);
  const totalSteps = useWorkflowStore((s) => s.totalSteps);
  const steps = useWorkflowStore((s) => s.steps);
  const finalStep = useWorkflowStore((s) => s.finalStep);
  const cliOutputs = useWorkflowStore((s) => s.liveOrderedEntries);
  const liveOrderedEntries = cliOutputs; // alias for clarity
  // streamingChunks changes on every token — keep it isolated so the
  // auto-scroll effect doesn't require rebuilding allMessages.
  const streamingChunks = useWorkflowStore((s) => s.streamingChunks);
  const finalStepStreamingChunks = useWorkflowStore(
    (s) => s.finalStepStreamingChunks
  );
  const historyOutputs = useWorkflowStore((s) => s.historyOutputs);
  const workspaceSnapshots = useWorkflowStore((s) => s.workspaceSnapshots);
  const finalStepWorkspaceSnapshots = useWorkflowStore(
    (s) => s.finalStepWorkspaceSnapshots
  );
  const undoRecords = useWorkflowStore((s) => s.undoRecords);

  const outputCollapsed = useUiStore((s) => s.outputCollapsed);
  const editorCollapsed = useUiStore((s) => s.editorCollapsed);
  const toggleOutputCollapse = useUiStore((s) => s.toggleOutputCollapse);
  const isViewingHistory = useUiStore((s) => s.isViewingHistory);
  const viewingRunIndex = useUiStore((s) => s.viewingRunIndex);
  const availableRuns = useUiStore((s) => s.availableRuns);
  const runTimestamps = useUiStore((s) => s.runTimestamps);
  const runStates = useUiStore((s) => s.runStates);
  const diffsCollapsed = useUiStore((s) => s.diffsCollapsed);
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const expandAllDiffs = useUiStore((s) => s.expandAllDiffs);
  const collapseAllDiffs = useUiStore((s) => s.collapseAllDiffs);
  const outputFontSize = useUiStore((s) => s.outputFontSize);
  const setOutputFontSize = useUiStore((s) => s.setOutputFontSize);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useUiStore((s) => s.setTerminalFontSize);
  const terminalFontSizeScope = useSettingsStore((s) =>
    s.globalSettings.settingSources["terminal.fontSize"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const updateTerminalFontSize = useCallback(
    (size: number) => {
      const next = Math.min(24, Math.max(8, size));
      setTerminalFontSize(next);
      getVsCodeApi()?.postMessage({
        type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
        path: "terminal.fontSize",
        value: next,
        scope: terminalFontSizeScope,
      });
    },
    [setTerminalFontSize, terminalFontSizeScope]
  );

  // Execution mode toggle
  const executionMode = useSettingsStore((s) => s.globalSettings.executionMode);
  const executionModeScope = useSettingsStore((s) =>
    s.globalSettings.settingSources["execution.mode"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const handleExecutionModeChange = useCallback(
    (active: boolean) => {
      const vscode = getVsCodeApi();
      vscode?.postMessage({
        type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
        path: "execution.mode",
        value: active ? EXECUTION_MODES.INTERACTIVE : EXECUTION_MODES.HEADLESS,
        scope: executionModeScope,
      });
    },
    [executionModeScope]
  );

  // Terminal tab state
  const workspaceRoot = useSettingsStore((s) => s.globalSettings.workspaceRoot);
  const activeWorkflowId = useUiStore((s) => s.activeWorkflowId);
  // Use a stable fallback key so standalone shells work even with no active workflow.
  const terminalWorkflowId = activeWorkflowId ?? SHELL_WORKFLOW_ID;
  const workflowScrollTargetId = activeWorkflowId ?? SHELL_WORKFLOW_ID;
  const savedOutputScrollTarget = useUiStore(
    (s) => s.outputScrollTargets[workflowScrollTargetId]
  );
  const setOutputScrollTarget = useUiStore((s) => s.setOutputScrollTarget);
  const activeOutputTab = useUiStore(
    (s) => s.activeOutputTabs[terminalWorkflowId] ?? "output"
  );
  const setActiveOutputTab = useUiStore((s) => s.setActiveOutputTab);
  const terminalActiveWorkflows = useUiStore((s) => s.terminalActiveWorkflows);
  const terminalSessions = useTerminalStore(
    (s) => s.sessions[terminalWorkflowId] ?? EMPTY_TERMINAL_SESSIONS
  );
  const activeTerminalSessionId = useTerminalStore(
    (s) => s.activeSessionIds[terminalWorkflowId] ?? null
  );
  const terminalRailCollapsed = useUiStore((s) => s.terminalRailCollapsed);
  const showTerminalTab = true;
  const terminalSessionActive = terminalActiveWorkflows.has(terminalWorkflowId);

  // Compact terminal header: shown when there is exactly one session (rail is hidden)
  // OR when the session rail is collapsed (user narrowed it). In both cases the full
  // title isn't visible in the rail, so we surface it in the header instead.
  const isTerminalCompact =
    activeOutputTab === "terminal" &&
    terminalSessions.length > 0 &&
    (terminalSessions.length === 1 || terminalRailCollapsed);
  const activeTerminalSession =
    terminalSessions.find((s) => s.id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null;
  const outputVirtualizationRowThreshold = useSettingsStore(
    (s) => s.globalSettings.outputVirtualizationRowThreshold
  );

  const [headerRef, isHeaderNarrow] = useElementNarrow(650);
  const [veryNarrowRef, isHeaderVeryNarrow] = useElementNarrow(400);
  const mergedHeaderRef = useCallback(
    (node: HTMLDivElement | null) => {
      headerRef(node);
      veryNarrowRef(node);
    },
    [headerRef, veryNarrowRef]
  );

  const outputRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const autoscrollEnabled = useRef(true);
  const isProgrammaticScroll = useRef(false);
  const measurementCacheRef = useRef<Map<string, number>>(new Map());
  const rowHeightBucketStatsRef = useRef<Map<string, RowHeightBucketStats>>(
    new Map()
  );
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [outputDiffViewType, setOutputDiffViewType] = useState<
    "split" | "unified"
  >("split");
  const [outputContentWidth, setOutputContentWidth] = useState(0);
  const [outputOverscan, setOutputOverscan] = useState(
    OUTPUT_VIRTUALIZER_OVERSCAN
  );
  const [nonVirtualRenderedRowCount, setNonVirtualRenderedRowCount] =
    useState<number>(Number.MAX_SAFE_INTEGER);
  const [scrollSeekPlaceholderActive, setScrollSeekPlaceholderActiveState] =
    useState(false);
  const measurementVersionRef = useRef(measurementVersion);
  useEffect(() => {
    measurementVersionRef.current = measurementVersion;
  }, [measurementVersion]);
  const outputOverscanRef = useRef(outputOverscan);
  useEffect(() => {
    outputOverscanRef.current = outputOverscan;
  }, [outputOverscan]);
  const scrollSeekStartedAtRef = useRef<number | null>(null);
  const scrollSeekRestoreRequestedAtRef = useRef<number | null>(null);
  const scrollSeekSettlingUntilRef = useRef<number | null>(null);
  const rowResizeScrollSuppressUntilRef = useRef<number | null>(null);
  const lastUserScrollInputAtRef = useRef<number | null>(null);
  const lastTouchYRef = useRef<number | null>(null);
  const scrollSeekPlaceholderRef = useRef(false);
  // Row indices that were already rendered when fast-scroll placeholder mode
  // started; these keep their real content instead of swapping to a placeholder.
  const scrollSeekEntryRenderedIndicesRef = useRef<ReadonlySet<number>>(
    new Set()
  );
  // Stable ref to rowVirtualizer.getVirtualItems(); populated after the
  // virtualizer is created so enterFastScrollOverscan can read it without
  // a forward-reference ordering issue.
  const getVirtualItemsRef = useRef<() => readonly { index: number }[]>(
    () => []
  );
  const measurementVersionFrameRef = useRef<number | null>(null);
  const overscanRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const fullOverscanRestoreTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const overscanRestoreRafRef = useRef<number | null>(null);
  const pendingNavigationRef = useRef<PendingNavigationState | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const nonVirtualRenderFrameRef = useRef<number | null>(null);
  const nonVirtualRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const nonVirtualRenderIdentityRef = useRef<string | null>(null);
  const scrollTargetRef = useRef<OutputScrollTarget>(
    savedOutputScrollTarget ?? DEFAULT_OUTPUT_SCROLL_TARGET
  );
  const applyScrollTargetRef = useRef<
    (phase: string, options?: { force?: boolean }) => {
      resolved: boolean;
      appliedDelta: number;
    }
  >(() => ({ resolved: false, appliedDelta: 0 }));
  const commitScrollTargetFromViewportRef = useRef<(reason: string) => void>(
    () => {}
  );
  const lastScrollEventAtRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastVirtualRangeRef = useRef<string>("");
  const pendingMeasurementCacheRef = useRef<Map<string, number>>(new Map());
  const mountedRowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingMeasurementFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set true during flush so TanStack's rAF-deferred scroll corrections don't
  // re-activate the scroll freeze in handleScroll.
  const isMeasurementFlushInProgressRef = useRef(false);
  // Stable ref to schedulePendingMeasurementFlush — updated each render so
  // updateRowMeasurementCache can call it without a forward-reference dep cycle.
  const schedulePendingMeasurementFlushRef = useRef<() => void>(() => {});
  // Tracks the row count at the last auto-scroll so we can distinguish "new
  // rows arrived" (scroll) from "same rows re-rendered" (don't scroll).
  const lastAutoScrollRowCountRef = useRef(0);
  // Suppresses TanStack Virtual's internal scroll corrections for 1 s after navigation
  // completes. Without this, new rows entering the virtual window post-navigation
  // repeatedly trigger corrections that oscillate the scroll position.
  const postNavSettlingRef = useRef(false);
  const postNavSettlingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const lastRunSelectorObserverHeightRef = useRef<number | null>(null);
  const lastRunSelectorMaxHeightRef = useRef<number | null>(null);

  // Keep --run-selector-max-h in sync with the output section height so the
  // RunSelector dropdown never overflows the panel boundary.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const { observer, disconnect } = createAnimationFrameResizeObserver(
      (entries) => {
        const nextHeight = getResizeObserverEntryHeight(entries[0]);
        if (
          nextHeight != null &&
          lastRunSelectorObserverHeightRef.current != null
        ) {
          if (
            Math.abs(lastRunSelectorObserverHeightRef.current - nextHeight) <
            0.5
          ) {
            return;
          }
        }
        if (nextHeight != null) {
          lastRunSelectorObserverHeightRef.current = nextHeight;
        }
        const headerH = 30; // matches the h-[30px] header
        const available = el.clientHeight - headerH - 8; // 8px breathing room
        const nextMaxHeight = Math.max(80, available);
        if (lastRunSelectorMaxHeightRef.current === nextMaxHeight) {
          return;
        }
        lastRunSelectorMaxHeightRef.current = nextMaxHeight;
        const nextValue = `${nextMaxHeight}px`;
        if (el.style.getPropertyValue("--run-selector-max-h") !== nextValue) {
          el.style.setProperty("--run-selector-max-h", nextValue);
        }
      }
    );
    observer.observe(el);
    return disconnect;
  }, []);

  // Build chronologically sorted list of all messages from the single ordered entries array.
  const isExecutionActive =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

  // Forward refs let useOutputRowsModel call the real invalidation/measurement
  // logic even though that logic is defined later (it depends on rowVirtualizer,
  // which itself depends on `rows`). Same forward-reference pattern as
  // applyScrollTargetRef / commitScrollTargetFromViewportRef below.
  const invalidateMeasuredRowImplRef = useRef<(rowKey: string) => void>(
    () => {}
  );
  const invalidateMeasuredRowForUserResizeImplRef = useRef<
    (rowKey: string) => void
  >(() => {});
  const invalidateMeasuredRowForRowModel = useCallback(
    (rowKey: string) => invalidateMeasuredRowImplRef.current(rowKey),
    []
  );
  const invalidateMeasuredRowForUserResizeForRowModel = useCallback(
    (rowKey: string) => invalidateMeasuredRowForUserResizeImplRef.current(rowKey),
    []
  );
  const handleDiffViewReset = useCallback(() => {
    // Diff row heights change dramatically between expanded and collapsed
    // states; flush stale measured heights before the collapse-state change
    // propagates so minimap positions don't misalign.
    measurementCacheRef.current.clear();
  }, []);

  const {
    allMessages,
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
    anyDiffCollapsed,
    bashExpansionState,
    handleDiffCollapsedChange,
    handleDiffGapExpand,
    handleToolCallExpansionChange,
    handleBashExpansionChange,
  } = useOutputRowsModel({
    isViewingHistory,
    historyOutputs,
    liveOrderedEntries,
    steps,
    finalStep,
    streamingChunks,
    finalStepStreamingChunks,
    isExecutionActive,
    workspaceSnapshots,
    finalStepWorkspaceSnapshots,
    undoRecords,
    diffsCollapsed,
    diffResetVersion,
    outputDiffViewType,
    outputFontSize,
    outputContentWidth,
    invalidateMeasuredRow: invalidateMeasuredRowForRowModel,
    invalidateMeasuredRowForUserResize:
      invalidateMeasuredRowForUserResizeForRowModel,
    onDiffViewReset: handleDiffViewReset,
  });

  const outputExport = useOutputExport({
    allMessages,
    currentStep,
    executionState,
    fileName,
    finalStep,
    historyOrderedEntries: historyOutputs?.orderedEntries,
    isViewingHistory,
    steps,
    totalSteps,
  });

  const effectiveVirtualizationRowThreshold = Math.trunc(
    Number.isFinite(outputVirtualizationRowThreshold)
      ? outputVirtualizationRowThreshold
      : 200
  );
  const isOutputVirtualized =
    effectiveVirtualizationRowThreshold >= 0 &&
    (effectiveVirtualizationRowThreshold === 0 ||
      rows.length >= effectiveVirtualizationRowThreshold);
  const rowRenderIdentity = `${fileName ?? ""}:${
    isViewingHistory ? viewingRunIndex : "live"
  }`;

  const getEstimatedRowHeight = useCallback(
    (row: OutputRenderRow): number => {
      const baseEstimate = estimateOutputRowHeight(
        row,
        outputFontSize,
        outputContentWidth
      );
      const bucket = getRowHeightBucket(row);
      const bucketStats = rowHeightBucketStatsRef.current.get(bucket);
      if (
        !bucketStats ||
        bucketStats.sampleCount < 2 ||
        bucketStats.totalEstimated <= 0
      ) {
        return baseEstimate;
      }

      const averageScale =
        bucketStats.totalMeasured / bucketStats.totalEstimated;
      const clampedScale = clamp(
        averageScale,
        0.5,
        bucket.startsWith("structured-event:diff:") ? 3.5 : 3
      );
      const rawScaled = Math.round(baseEstimate * clampedScale * 100) / 100;
      if (bucket.startsWith("structured-event:diff:")) {
        // Diff heights come from renderPlan which can over- or under-estimate; allow
        // adaptive correction in both directions. clampedScale [0.5, 3.5] bounds it.
        return rawScaled;
      }
      // Allow modest downward correction (to 60% of base) and cap increase at +200px.
      // The +200px cap prevents overcorrection from mixed-size rows in the same bucket.
      return clamp(rawScaled, baseEstimate * 0.6, baseEstimate + 200);
    },
    [outputContentWidth, outputFontSize]
  );

  // Keep live refs so updateRowMeasurementCache doesn't need rows / getEstimatedRowHeight
  // in its own dependency array, preventing ref detach/reattach on every streaming chunk.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const getEstimatedRowHeightRef = useRef(getEstimatedRowHeight);
  getEstimatedRowHeightRef.current = getEstimatedRowHeight;
  const setOutputOverscanMode = useCallback(
    (
      overscan: number,
      reason: "fast-scroll" | "idle",
      details?: Record<string, unknown>,
      // true=activate placeholder, false=deactivate, undefined=no change
      activatePlaceholder?: boolean
    ) => {
      const overscanChanged = outputOverscanRef.current !== overscan;
      const newPlaceholder =
        activatePlaceholder === true
          ? true
          : activatePlaceholder === false
            ? false
            : scrollSeekPlaceholderRef.current;
      const placeholderChanged =
        newPlaceholder !== scrollSeekPlaceholderRef.current;

      if (!overscanChanged && !placeholderChanged) {
        return;
      }

      const now = performance.now();
      const wasPlaceholderActive = scrollSeekPlaceholderRef.current;

      if (overscanChanged) {
        outputOverscanRef.current = overscan;
        setOutputOverscan(overscan);
      }

      if (placeholderChanged) {
        scrollSeekPlaceholderRef.current = newPlaceholder;
        setScrollSeekPlaceholderActiveState(newPlaceholder);
        if (newPlaceholder && !wasPlaceholderActive) {
          scrollSeekStartedAtRef.current = now;
          scrollSeekRestoreRequestedAtRef.current = null;
        } else if (!newPlaceholder && wasPlaceholderActive) {
          scrollSeekRestoreRequestedAtRef.current = now;
        }
      }

      logOutputProfilerEvent("adaptiveOverscan", {
        overscan: outputOverscanRef.current,
        reason,
        placeholder: scrollSeekPlaceholderRef.current,
        scrollSeekDurationMs:
          placeholderChanged &&
          !newPlaceholder &&
          scrollSeekStartedAtRef.current != null
            ? now - scrollSeekStartedAtRef.current
            : undefined,
        ...details,
        rows: rowsRef.current.length,
      });
    },
    []
  );
  const scheduleOverscanRestore = useCallback(
    (delayMs?: number) => {
      if (overscanRestoreTimerRef.current !== null) {
        clearTimeout(overscanRestoreTimerRef.current);
      }
      if (fullOverscanRestoreTimerRef.current !== null) {
        clearTimeout(fullOverscanRestoreTimerRef.current);
        fullOverscanRestoreTimerRef.current = null;
      }
      if (overscanRestoreRafRef.current !== null) {
        cancelAnimationFrame(overscanRestoreRafRef.current);
        overscanRestoreRafRef.current = null;
      }

      overscanRestoreTimerRef.current = setTimeout(() => {
        overscanRestoreTimerRef.current = null;
        scrollSeekEntryRenderedIndicesRef.current = new Set();
        if (scrollSeekPlaceholderRef.current) {
          // Placeholder active: set overscan=0 and deactivate placeholder
          // simultaneously. The restore effect detects !isOutputScrollSeeking
          // and schedules the 0→intermediate→full overscan chain.
          setOutputOverscanMode(
            OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN,
            "idle",
            { phase: "restore-visible-rows" },
            false
          );
        } else {
          // Overscan was pre-armed without placeholder: skip staged restore
          // and return directly to idle overscan.
          setOutputOverscanMode(OUTPUT_VIRTUALIZER_OVERSCAN, "idle", {
            phase: "restore-full-overscan-direct",
          });
        }
      }, delayMs ?? OUTPUT_OVERSCAN_RESTORE_DELAY_MS);
    },
    [setOutputOverscanMode]
  );
  const enterFastScrollOverscan = useCallback(
    (details: Record<string, unknown>) => {
      if (!scrollSeekPlaceholderRef.current) {
        // Snapshot which rows are currently rendered so they keep their real
        // content instead of being swapped to placeholders mid-view.
        scrollSeekEntryRenderedIndicesRef.current = new Set(
          getVirtualItemsRef.current().map((vr) => vr.index)
        );
      }
      setOutputOverscanMode(
        OUTPUT_ACTIVE_SCROLL_OVERSCAN,
        "fast-scroll",
        details,
        true // activate placeholder
      );
      scheduleOverscanRestore();
    },
    [scheduleOverscanRestore, setOutputOverscanMode]
  );
  const scheduleMeasurementVersionBump = useCallback(() => {
    if (measurementVersionFrameRef.current != null) {
      return;
    }

    measurementVersionFrameRef.current = requestAnimationFrame(() => {
      measurementVersionFrameRef.current = null;
      setMeasurementVersion((version) => version + 1);
    });
  }, []);

  useEffect(
    () => () => {
      if (measurementVersionFrameRef.current != null) {
        cancelAnimationFrame(measurementVersionFrameRef.current);
        measurementVersionFrameRef.current = null;
      }
      if (overscanRestoreTimerRef.current !== null) {
        clearTimeout(overscanRestoreTimerRef.current);
        overscanRestoreTimerRef.current = null;
      }
      if (fullOverscanRestoreTimerRef.current !== null) {
        clearTimeout(fullOverscanRestoreTimerRef.current);
        fullOverscanRestoreTimerRef.current = null;
      }
      if (overscanRestoreRafRef.current !== null) {
        cancelAnimationFrame(overscanRestoreRafRef.current);
        overscanRestoreRafRef.current = null;
      }
      if (pendingMeasurementFlushTimerRef.current !== null) {
        clearTimeout(pendingMeasurementFlushTimerRef.current);
        pendingMeasurementFlushTimerRef.current = null;
      }
      if (nonVirtualRenderFrameRef.current !== null) {
        cancelAnimationFrame(nonVirtualRenderFrameRef.current);
        nonVirtualRenderFrameRef.current = null;
      }
      if (nonVirtualRenderTimerRef.current !== null) {
        clearTimeout(nonVirtualRenderTimerRef.current);
        nonVirtualRenderTimerRef.current = null;
      }
    },
    []
  );

  const updateRowMeasurementCache = useCallback(
    (
      element: HTMLDivElement,
      measuredHeight: number,
      source: "dom-read" | "resize-observer"
    ): number => {
      const startedAt = isOutputProfilingEnabled() ? performance.now() : 0;
      const index = Number(element.dataset.index ?? -1);
      const row = rowsRef.current[index];
      if (!row) return measuredHeight;

      const zeroHeightReason =
        row.rowKind === "structured-event"
          ? getZeroHeightStructuredEventReason(row)
          : null;
      if (
        (!Number.isFinite(measuredHeight) || measuredHeight <= 0) &&
        zeroHeightReason == null
      ) {
        return measuredHeight;
      }

      const nextHeight =
        zeroHeightReason != null && measuredHeight <= 0 ? 0 : measuredHeight;
      const rowHeightBucket = getRowHeightBucket(row);
      const estimatedHeight = getEstimatedRowHeightRef.current(row);

      const previousHeight = measurementCacheRef.current.get(row.key);
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - nextHeight) < 1.0
      ) {
        if (startedAt > 0) {
          const durationMs = performance.now() - startedAt;
          if (shouldLogOutputMeasurement(durationMs)) {
            logOutputProfilerEvent("rowMeasurement:unchanged", {
              index,
              rowKey: row.key,
              rowKind: row.rowKind,
              bucket: rowHeightBucket,
              measuredHeight: nextHeight,
              estimatedHeight,
              source,
              durationMs,
            });
          }
        }
        return nextHeight;
      }

      // Freeze layout updates while user is scrolling: store the new height in a
      // pending cache and return the stale height to TanStack so it sees no change
      // (no notify → no re-render → no mid-scroll position jump). handleScroll's
      // idle timer flushes pending into the main cache for one clean layout pass.
      const isScrolling =
        lastScrollEventAtRef.current != null &&
        performance.now() - lastScrollEventAtRef.current < OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
      if (isScrolling) {
        pendingMeasurementCacheRef.current.set(row.key, nextHeight);
        // Self-schedule the flush so it fires even if no further user scroll
        // events arrive (e.g., corrections at initial load freeze measurements
        // but handleScroll never fires again to schedule the flush).
        // Uses a ref to avoid a circular dep with rowVirtualizer.
        schedulePendingMeasurementFlushRef.current();
        return previousHeight !== undefined ? previousHeight : estimatedHeight;
      }

      measurementCacheRef.current.set(row.key, nextHeight);
      const previousBucketStats = rowHeightBucketStatsRef.current.get(
        rowHeightBucket
      ) ?? {
        sampleCount: 0,
        totalMeasured: 0,
        totalEstimated: 0,
        maxAbsDelta: 0,
      };
      rowHeightBucketStatsRef.current.set(rowHeightBucket, {
        sampleCount: previousBucketStats.sampleCount + 1,
        totalMeasured: previousBucketStats.totalMeasured + nextHeight,
        totalEstimated: previousBucketStats.totalEstimated + estimatedHeight,
        maxAbsDelta: Math.max(
          previousBucketStats.maxAbsDelta,
          Math.abs(nextHeight - estimatedHeight)
        ),
      });
      // Log individual outliers so we can find which specific row structures
      // cause the biggest estimation errors (e.g. markdown tables, long bash output).
      if (isOutputProfilingEnabled()) {
        const absDelta = Math.abs(nextHeight - estimatedHeight);
        const pctDelta = estimatedHeight > 0 ? absDelta / estimatedHeight : 0;
        if (absDelta > 40 && pctDelta > 0.10) {
          const extras: Record<string, unknown> = {};
          if (row.rowKind === "structured-event" && row.event.type === CLI_EVENT_TYPES.TEXT) {
            const text = (row.event.data as { text?: string }).text ?? "";
            extras.textLength = text.length;
            extras.hasTable = /^\|.+\|/m.test(text);
            extras.hasCodeBlock = text.includes("```");
            extras.hasList = /^\s*[-*+]\s/m.test(text);
            extras.textPreview = text.slice(0, 100).replace(/\n/g, "↵");
          } else if (row.rowKind === "structured-event" && (row.event.type === CLI_EVENT_TYPES.TOOL_CALL || row.event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL)) {
            const tc = row.event.data as { name?: string; tool?: string; input?: unknown; result?: unknown };
            extras.toolName = tc.name ?? tc.tool ?? "unknown";
            extras.inputLength = tc.input != null ? JSON.stringify(tc.input).length : 0;
            extras.resultLength = tc.result != null ? JSON.stringify(tc.result).length : 0;
          } else if (row.rowKind === "structured-event" && row.event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
            const bc = row.event.data as { command?: string; output?: string; error?: string };
            extras.outputLength = (bc.output ?? "").length;
            extras.errorLength = (bc.error ?? "").length;
          } else if (row.rowKind === "cli-command") {
            const cmd = row as unknown as { command?: string; workingDirectory?: string };
            const fullText = `${cmd.workingDirectory || "workspace"}> ${cmd.command ?? ""}`;
            extras.commandLength = fullText.length;
            extras.commandPreview = fullText.slice(0, 120).replace(/\n/g, "↵");
          }
          logOutputProfilerEvent("rowEstimateOutlier", {
            rowKey: row.key,
            bucket: rowHeightBucket,
            measuredHeight: nextHeight,
            estimatedHeight,
            delta: nextHeight - estimatedHeight,
            pctDelta: Math.round(pctDelta * 100),
            ...extras,
          });
        }
      }
      if (startedAt > 0) {
        const durationMs = performance.now() - startedAt;
        if (shouldLogOutputMeasurement(durationMs)) {
          logOutputProfilerEvent("rowMeasurement:updated", {
            index,
            rowKey: row.key,
            rowKind: row.rowKind,
            bucket: rowHeightBucket,
            measuredHeight: nextHeight,
            estimatedHeight,
            delta: nextHeight - estimatedHeight,
            previousHeight,
            source,
            durationMs,
          });
        }
      }
      scheduleMeasurementVersionBump();
      return nextHeight;
    },
    [scheduleMeasurementVersionBump]
  );

  const measureOutputRowElement = useCallback(
    (element: HTMLDivElement, entry?: ResizeObserverEntry): number => {
      const observerHeight = getResizeObserverEntryHeight(entry);
      const measuredHeight =
        observerHeight ?? getMeasuredElementHeight(element);
      return updateRowMeasurementCache(
        element,
        measuredHeight,
        observerHeight == null ? "dom-read" : "resize-observer"
      );
    },
    [updateRowMeasurementCache]
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => outputRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 48;
      return (
        measurementCacheRef.current.get(row.key) ?? getEstimatedRowHeight(row)
      );
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    measureElement: measureOutputRowElement,
    overscan: outputOverscan,
  });
  getVirtualItemsRef.current = () => rowVirtualizer.getVirtualItems();
  // shouldAdjustScrollPositionOnItemSizeChange is a writable instance property
  // (not a constructor option) on Virtualizer. Suppress scroll corrections
  // during active navigation and for 1 s after to prevent TanStack from
  // adjusting the scroll for measured rows above the viewport, which amplifies
  // reconcileScroll oscillations.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) => {
    const now = performance.now();
    // Suppress scroll correction while the user is actively scrolling —
    // mid-scroll position jumps are more jarring than estimate drift.
    const hasRecentScrollEvent =
      lastScrollEventAtRef.current != null &&
      now - lastScrollEventAtRef.current < OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
    const targetRestore =
      !hasRecentScrollEvent &&
      !isMeasurementFlushInProgressRef.current &&
      pendingNavigationRef.current === null &&
      !postNavSettlingRef.current
        ? applyScrollTargetRef.current("scroll-correction")
        : { resolved: false, appliedDelta: 0 };
    const shouldAdjust =
      !targetRestore.resolved &&
      !hasRecentScrollEvent &&
      !isMeasurementFlushInProgressRef.current &&
      pendingNavigationRef.current === null &&
      !postNavSettlingRef.current &&
      (scrollSeekSettlingUntilRef.current == null ||
        now >= scrollSeekSettlingUntilRef.current) &&
      (rowResizeScrollSuppressUntilRef.current == null ||
        now >= rowResizeScrollSuppressUntilRef.current) &&
      item.start < (outputRef.current?.scrollTop ?? 0);
    if (isOutputProfilingEnabled() && Math.abs(delta) >= 40) {
      const scrollElement = outputRef.current;
      logOutputProfilerEvent("scrollCorrection", {
        itemKey: item.key,
        delta,
        scrollTop: scrollElement?.scrollTop ?? 0,
        overscan: outputOverscanRef.current,
        targetResolved: targetRestore.resolved,
        targetApplied: targetRestore.appliedDelta,
        shouldAdjust,
      });
    }
    return shouldAdjust;
  };

  // React 19 ref callbacks can return a cleanup function.
  // TanStack Virtual owns the ResizeObserver. Our measureElement override above
  // consumes its entries, updates FlightPath's measurement cache, and avoids a
  // second observer plus duplicate DOM layout reads for already-mounted rows.
  const measureRowElement = useCallback(
    (element: HTMLDivElement | null): void | (() => void) => {
      if (!element) return;
      const index = Number(element.dataset.index ?? -1);
      const row = rowsRef.current[index];
      if (row) mountedRowElementsRef.current.set(row.key, element);
      rowVirtualizer.measureElement(element);
      return () => {
        if (row) mountedRowElementsRef.current.delete(row.key);
        rowVirtualizer.measureElement(null);
      };
    },
    [rowVirtualizer]
  );

  const measureStaticRowElement = useCallback(
    (element: HTMLDivElement | null): void | (() => void) => {
      if (!element) return;
      const index = Number(element.dataset.index ?? -1);
      const row = rowsRef.current[index];
      if (row) mountedRowElementsRef.current.set(row.key, element);

      const measure = (entry?: ResizeObserverEntry) => {
        const measuredHeight =
          getResizeObserverEntryHeight(entry) ?? getMeasuredElementHeight(element);
        updateRowMeasurementCache(
          element,
          measuredHeight,
          entry == null ? "dom-read" : "resize-observer"
        );
      };

      measure();
      const resizeObserver = createAnimationFrameResizeObserver((entries) => {
        measure(entries[0]);
      });
      resizeObserver.observer.observe(element);

      return () => {
        if (row) mountedRowElementsRef.current.delete(row.key);
        resizeObserver.disconnect();
      };
    },
    [updateRowMeasurementCache]
  );

  const flushPendingScrollMeasurements = useCallback(() => {
    if (pendingMeasurementCacheRef.current.size === 0) return;
    // Block handleScroll from updating lastScrollEventAtRef during this flush so
    // TanStack's rAF-deferred scroll corrections (shouldAdjustScrollPositionOnItemSizeChange)
    // don't re-activate the freeze for subsequent rows in the loop.
    isMeasurementFlushInProgressRef.current = true;
    if (isOutputProfilingEnabled()) {
      logOutputProfilerEvent("measurementFlush", {
        pendingCount: pendingMeasurementCacheRef.current.size,
        mountedCount: mountedRowElementsRef.current.size,
        targetKind: scrollTargetRef.current.kind,
        targetRowKey:
          scrollTargetRef.current.kind === "row"
            ? scrollTargetRef.current.rowKey
            : undefined,
      });
    }

    for (const [key, height] of pendingMeasurementCacheRef.current) {
      const element = mountedRowElementsRef.current.get(key);
      if (element) {
        // Re-read from DOM: more accurate than the frozen pending value and
        // goes through updateRowMeasurementCache for stats / TanStack notification.
        rowVirtualizer.measureElement(element);
      } else {
        // Row unmounted — write pending height as best estimate for future
        // estimateSize calls until the row re-enters the virtualizer range.
        measurementCacheRef.current.set(key, height);
      }
    }
    pendingMeasurementCacheRef.current.clear();
    // Apply a synchronous target restore first. In practice TanStack processes
    // many measureElement size changes immediately; compensating before the
    // browser paints avoids the visible one-frame jump. Keep rAF follow-ups for
    // size-change work that TanStack/ResizeObserver completes later.
    applyScrollTargetRef.current("measurement-flush-sync");
    requestAnimationFrame(() => {
      const firstFrameRestore =
        applyScrollTargetRef.current("measurement-flush-raf-1");
      requestAnimationFrame(() => {
        const secondFrameRestore =
          applyScrollTargetRef.current("measurement-flush-raf-2");

        requestAnimationFrame(() => {
          if (
            isOutputProfilingEnabled() &&
            (!firstFrameRestore.resolved ||
              !secondFrameRestore.resolved ||
              Math.abs(firstFrameRestore.appliedDelta) >= 1 ||
              Math.abs(secondFrameRestore.appliedDelta) >= 1)
          ) {
            logOutputProfilerEvent("measurementFlushTargetSettled", {
              target: scrollTargetRef.current,
              firstFrameApplied: firstFrameRestore.appliedDelta,
              secondFrameApplied: secondFrameRestore.appliedDelta,
              firstFrameResolved: firstFrameRestore.resolved,
              secondFrameResolved: secondFrameRestore.resolved,
              scrollTop: outputRef.current?.scrollTop,
            });
          }
          isMeasurementFlushInProgressRef.current = false;
        });
      });
    });
  }, [rowVirtualizer]);

  // Schedules the pending-measurement flush for OUTPUT_USER_SCROLL_INPUT_GRACE_MS+50ms.
  // Called from both updateRowMeasurementCache (via ref) and handleScroll, so the flush
  // fires even when no further user scroll events arrive (e.g., measurements frozen by a
  // correction scroll event at initial workflow load).
  const schedulePendingMeasurementFlush = useCallback(() => {
    if (pendingMeasurementFlushTimerRef.current !== null) {
      clearTimeout(pendingMeasurementFlushTimerRef.current);
    }
    pendingMeasurementFlushTimerRef.current = setTimeout(() => {
      pendingMeasurementFlushTimerRef.current = null;
      flushPendingScrollMeasurements();
    }, OUTPUT_USER_SCROLL_INPUT_GRACE_MS + 50);
  }, [flushPendingScrollMeasurements]);
  // Keep the ref up-to-date each render so updateRowMeasurementCache (defined before
  // flushPendingScrollMeasurements to avoid a circular dep) can call it via ref.
  schedulePendingMeasurementFlushRef.current = schedulePendingMeasurementFlush;

  const rowLayout = useMemo(
    () =>
      measureOutputPhase(
        "rowLayout",
        {
          rows: rows.length,
          measurementVersion,
          overscan: outputOverscan,
          virtualizerTotalSize: rowVirtualizer.getTotalSize(),
        },
        () => {
          void measurementVersion;
          if (!isOutputVirtualized) {
            let offset = 0;
            const rowStartsByIndex: number[] = [];
            const rowStartsByKey = new Map<string, number>();
            const rowSizesByKey = new Map<string, number>();

            for (const [index, row] of rows.entries()) {
              const size =
                measurementCacheRef.current.get(row.key) ??
                getEstimatedRowHeight(row);
              rowStartsByIndex[index] = offset;
              rowStartsByKey.set(row.key, offset);
              rowSizesByKey.set(row.key, size);
              offset += size;
            }

            return {
              totalSize: Math.max(offset, 1),
              rowStartsByIndex,
              rowStartsByKey,
              rowSizesByKey,
            };
          }

          let fallbackOffset = 0;
          const rowStartsByIndex: number[] = [];
          const rowStartsByKey = new Map<string, number>();
          const rowSizesByKey = new Map<string, number>();
          const measurementsByKey = new Map(
            rowVirtualizer.measurementsCache
              .filter((item): item is NonNullable<typeof item> => item != null)
              .map((item) => [String(item.key), item] as const)
          );

          for (const [index, row] of rows.entries()) {
            const measurement =
              measurementsByKey.get(row.key) ??
              rowVirtualizer.measurementsCache[index];
            const size =
              measurement?.size ??
              measurementCacheRef.current.get(row.key) ??
              getEstimatedRowHeight(row);
            const start = measurement?.start ?? fallbackOffset;
            rowStartsByIndex[index] = start;
            rowStartsByKey.set(row.key, start);
            rowSizesByKey.set(row.key, size);
            fallbackOffset = start + size;
          }

          return {
            totalSize: Math.max(
              rowVirtualizer.getTotalSize(),
              fallbackOffset,
              1
            ),
            rowStartsByIndex,
            rowStartsByKey,
            rowSizesByKey,
          };
        }
      ),
    [
      getEstimatedRowHeight,
      isOutputVirtualized,
      rows,
      measurementVersion,
      outputContentWidth,
      outputFontSize,
      outputOverscan,
      rowVirtualizer,
    ]
  );

  const {
    applyScrollTarget,
    commitScrollTargetFromViewport,
    scheduleScrollTargetCommit,
    setCurrentScrollTarget,
  } = useOutputScrollTarget({
    applyScrollTargetRef,
    autoscrollEnabledRef: autoscrollEnabled,
    bottomThresholdPx: SCROLL_BOTTOM_THRESHOLD,
    commitMaxRetries: OUTPUT_SCROLL_TARGET_COMMIT_MAX_RETRIES,
    commitScrollTargetFromViewportRef,
    defaultTarget: DEFAULT_OUTPUT_SCROLL_TARGET,
    isProgrammaticScrollRef: isProgrammaticScroll,
    lastScrollEventAtRef,
    lastScrollTopRef,
    lastUserScrollInputAtRef,
    layoutApplyTrigger: `${measurementVersion}:${outputOverscan}:${rows.length}:${scrollSeekPlaceholderActive}`,
    outputOverscanRef,
    outputRef,
    pendingNavigationRef,
    rowLayout,
    rowVirtualizer,
    rowsRef,
    restoreTrigger: rowRenderIdentity,
    savedOutputScrollTarget,
    scrollTargetRef,
    setOutputScrollTarget,
    userScrollInputGraceMs: OUTPUT_USER_SCROLL_INPUT_GRACE_MS,
    workflowScrollTargetId,
  });

  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;

    const updateDiffViewType = () => {
      const width = el.getBoundingClientRect().width;
      const widthChanged =
        outputContentWidth > 0 && Math.abs(outputContentWidth - width) >= 0.5;
      if (widthChanged) {
        applyScrollTarget("width-change");
      }
      setOutputContentWidth((prev) => {
        if (Math.abs(prev - width) < 0.5) return prev;
        return width;
      });
      setOutputDiffViewType((prev) => {
        const nextDiffViewType =
          width >= DIFF_SPLIT_VIEW_MIN_WIDTH ? "split" : "unified";
        if (prev === nextDiffViewType) return prev;
        return nextDiffViewType;
      });
    };

    updateDiffViewType();
    const { observer, disconnect } =
      createAnimationFrameResizeObserver(updateDiffViewType);
    observer.observe(el);
    return disconnect;
  }, [
    activeOutputTab,
    applyScrollTarget,
    outputCollapsed,
    outputContentWidth,
  ]);

  useEffect(() => {
    if (outputContentWidth <= 0) {
      return;
    }
    // Keep a small live buffer during width resize so expanding the pane can
    // reveal nearby rows above/below the pinned row without rendering the full
    // idle range on every pointer move.
    setOutputOverscanMode(OUTPUT_ACTIVE_SCROLL_OVERSCAN, "fast-scroll", {
      phase: "width-resize",
    });
    scheduleOverscanRestore();
  }, [
    outputContentWidth,
    outputDiffViewType,
    outputFontSize,
    scheduleOverscanRestore,
    setOutputOverscanMode,
  ]);

  // When switching between live output and a history run (including when the
  // history run index changes), the same row keys can appear with very different
  // heights — e.g., a row measured as 500 px during a live run where diffs were
  // expanded will still be in the cache when the same run is opened in history
  // view with diffs collapsed (74 px estimate).  Flush the cache so rowLayout
  // re-estimates from scratch for the incoming content.
  const previousIsViewingHistory = useRef(isViewingHistory);
  const previousViewingRunIndex = useRef(viewingRunIndex);
  const previousIsOutputVirtualized = useRef(isOutputVirtualized);
  useEffect(() => {
    const viewChanged =
      previousIsViewingHistory.current !== isViewingHistory ||
      previousViewingRunIndex.current !== viewingRunIndex;
    previousIsViewingHistory.current = isViewingHistory;
    previousViewingRunIndex.current = viewingRunIndex;
    if (!viewChanged) return;

    measurementCacheRef.current.clear();
    setMeasurementVersion((v) => v + 1);
  }, [isViewingHistory, viewingRunIndex]);

  useEffect(() => {
    if (previousIsOutputVirtualized.current === isOutputVirtualized) {
      return;
    }
    previousIsOutputVirtualized.current = isOutputVirtualized;
    pendingMeasurementCacheRef.current.clear();
    measurementCacheRef.current.clear();
    setMeasurementVersion((v) => v + 1);
    if (isOutputVirtualized) {
      rowVirtualizer.measure();
    }
  }, [isOutputVirtualized, rowVirtualizer]);

  useEffect(() => {
    if (nonVirtualRenderFrameRef.current !== null) {
      cancelAnimationFrame(nonVirtualRenderFrameRef.current);
      nonVirtualRenderFrameRef.current = null;
    }
    if (nonVirtualRenderTimerRef.current !== null) {
      clearTimeout(nonVirtualRenderTimerRef.current);
      nonVirtualRenderTimerRef.current = null;
    }

    const shouldStageRows =
      !isOutputVirtualized &&
      rows.length >= NON_VIRTUAL_STAGING_ROW_THRESHOLD;

    if (!shouldStageRows) {
      setNonVirtualRenderedRowCount(Number.MAX_SAFE_INTEGER);
      return;
    }

    const previousIdentity = nonVirtualRenderIdentityRef.current;
    const identityChanged = previousIdentity !== rowRenderIdentity;
    nonVirtualRenderIdentityRef.current = rowRenderIdentity;

    setNonVirtualRenderedRowCount((previous) =>
      Math.min(
        rows.length,
        identityChanged
          ? NON_VIRTUAL_INITIAL_RENDER_ROWS
          : Math.max(previous, NON_VIRTUAL_INITIAL_RENDER_ROWS)
      )
    );

    // Let the output tab/workflow switch paint before mounting the expensive
    // remainder. This is the key difference from a plain overlay: the browser
    // gets a frame to show it before React starts rendering every diff row.
    nonVirtualRenderTimerRef.current = setTimeout(() => {
      nonVirtualRenderTimerRef.current = null;
      const renderNextChunk = () => {
        setNonVirtualRenderedRowCount((previous) => {
          const next = Math.min(
            rows.length,
            previous + NON_VIRTUAL_RENDER_CHUNK_ROWS
          );
          if (next < rows.length) {
            nonVirtualRenderFrameRef.current =
              requestAnimationFrame(renderNextChunk);
          } else {
            nonVirtualRenderFrameRef.current = null;
          }
          return next;
        });
      };

      nonVirtualRenderFrameRef.current = requestAnimationFrame(renderNextChunk);
    }, 0);
  }, [
    isOutputVirtualized,
    rowRenderIdentity,
    rows.length,
  ]);

  // Smart scroll: detect user scrolling away from bottom
  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    if (isProgrammaticScroll.current) {
      // Still update autoscrollEnabled so a user wheel mid-programmatic-scroll
      // correctly disables auto-scroll. Without this, the flag stays true and
      // the auto-scroll effect fires again on the next measurementVersion bump.
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <=
        SCROLL_BOTTOM_THRESHOLD;
      if (autoscrollEnabled.current !== atBottom) {
        WebviewLog.debug(
          "[FP-SCROLL-DEBUG] autoscrollEnabled updated during programmatic scroll",
          {
            from: autoscrollEnabled.current,
            to: atBottom,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            t: performance.now().toFixed(1),
          }
        );
        autoscrollEnabled.current = atBottom;
      } else {
        WebviewLog.debug(
          "[FP-SCROLL-DEBUG] handleScroll suppressed (programmatic) — autoscrollEnabled unchanged",
          {
            autoscrollEnabled: autoscrollEnabled.current,
            scrollTop: el.scrollTop,
            t: performance.now().toFixed(1),
          }
        );
      }
      return;
    }
    // TanStack's rAF-deferred scroll corrections fire during the flush window.
    // Suppress scroll-state updates for those so the freeze isn't re-activated,
    // which would cause partial scroll compensation (only first row compensated).
    if (isMeasurementFlushInProgressRef.current) return;
    const startedAt = performance.now();
    const now = startedAt;
    const previousScrollEventAt = lastScrollEventAtRef.current;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollEventAtRef.current = now;
    lastScrollTopRef.current = el.scrollTop;

    // Reschedule the pending-measurement flush on every scroll event so the
    // timer resets to 250ms after the LAST scroll (not the first).
    if (pendingMeasurementCacheRef.current.size > 0) {
      schedulePendingMeasurementFlush();
    }
    const scrollDeltaPx =
      previousScrollTop == null ? 0 : el.scrollTop - previousScrollTop;
    const absScrollDeltaPx = Math.abs(scrollDeltaPx);
    const scrollGapMs =
      previousScrollEventAt == null ? 0 : now - previousScrollEventAt;
    const scrollVelocityPxMs =
      scrollGapMs > 0 ? absScrollDeltaPx / scrollGapMs : 0;
    const pageDeltaThresholdPx =
      el.clientHeight * OUTPUT_SCROLL_SEEK_PAGE_FRACTION;
    const rawFastScroll =
      isOutputVirtualized &&
      rowsRef.current.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
      (absScrollDeltaPx >= pageDeltaThresholdPx ||
        (absScrollDeltaPx >= OUTPUT_SCROLL_SEEK_MIN_DELTA_PX &&
          scrollVelocityPxMs >= OUTPUT_SCROLL_SEEK_MIN_VELOCITY_PX_MS));
    const isInScrollSeekSettleWindow =
      scrollSeekSettlingUntilRef.current != null &&
      now < scrollSeekSettlingUntilRef.current;
    const hasRecentUserScrollInput =
      lastUserScrollInputAtRef.current != null &&
      now - lastUserScrollInputAtRef.current <=
        OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
    const suppressedFastScroll =
      rawFastScroll && isInScrollSeekSettleWindow && !hasRecentUserScrollInput;
    const isFastScroll = rawFastScroll && !suppressedFastScroll;
    if (isFastScroll) {
      enterFastScrollOverscan({
        scrollDeltaPx,
        scrollVelocityPxMs,
        scrollGapMs,
        pageDeltaThresholdPx,
      });
    } else if (suppressedFastScroll) {
      logOutputProfilerEvent("adaptiveOverscan", {
        overscan: outputOverscanRef.current,
        reason: "idle",
        phase: "suppressed-post-restore-scroll",
        scrollDeltaPx,
        scrollVelocityPxMs,
        scrollGapMs,
        pageDeltaThresholdPx,
        settleRemainingMs: (scrollSeekSettlingUntilRef.current ?? now) - now,
        rows: rowsRef.current.length,
      });
    } else if (
      outputOverscanRef.current === OUTPUT_ACTIVE_SCROLL_OVERSCAN &&
      absScrollDeltaPx >= OUTPUT_SCROLL_SEEK_CONTINUE_DELTA_PX
    ) {
      scheduleOverscanRestore(
        absScrollDeltaPx <= OUTPUT_SCROLL_SEEK_SLOW_DELTA_PX
          ? OUTPUT_SCROLL_SEEK_SLOW_RESTORE_DELAY_MS
          : OUTPUT_OVERSCAN_RESTORE_DELAY_MS
      );
    }
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD;
    if (autoscrollEnabled.current !== atBottom) {
      WebviewLog.debug("[FP-SCROLL-DEBUG] autoscrollEnabled changed", {
        from: autoscrollEnabled.current,
        to: atBottom,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        t: performance.now().toFixed(1),
      });
    }
    autoscrollEnabled.current = atBottom;
    scheduleScrollTargetCommit("user-scroll-settled");
    if (previousScrollEventAt != null) {
      const gapMs = scrollGapMs;
      if (shouldLogOutputScrollFrame(gapMs)) {
        logOutputProfilerEvent("scroll", {
          gapMs,
          scrollDeltaPx,
          scrollVelocityPxMs,
          rawFastScroll,
          isFastScroll,
          suppressedFastScroll,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          atBottom,
          virtualRows: rowVirtualizer.getVirtualItems().length,
          overscan: outputOverscanRef.current,
          scrollSeekPlaceholder: scrollSeekPlaceholderRef.current,
          totalRows: rowsRef.current.length,
        });
      }
    }
    const durationMs = performance.now() - startedAt;
    const profilerState = getOutputProfilerState();
    if (profilerState.enabled && durationMs >= profilerState.slowThresholdMs) {
      logOutputProfilerEvent("scrollHandler", {
        durationMs,
        scrollDeltaPx,
        scrollVelocityPxMs,
        rawFastScroll,
        isFastScroll,
        suppressedFastScroll,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        atBottom,
        virtualRows: rowVirtualizer.getVirtualItems().length,
        overscan: outputOverscanRef.current,
        scrollSeekPlaceholder: scrollSeekPlaceholderRef.current,
        totalRows: rowsRef.current.length,
      });
    }
  }, [
    enterFastScrollOverscan,
    isOutputVirtualized,
    rowVirtualizer,
    scheduleOverscanRestore,
    schedulePendingMeasurementFlush,
    scheduleScrollTargetCommit,
  ]);

  const preArmScrollSeekForInput = useCallback(
    (
      scrollElement: HTMLDivElement,
      inputDeltaPx: number,
      thresholdPx: number,
      phase: "wheel-pre-scroll" | "touch-pre-scroll"
    ) => {
      const now = performance.now();
      lastUserScrollInputAtRef.current = now;
      const absInputDeltaPx = Math.abs(inputDeltaPx);

      if (
        isOutputVirtualized &&
        rowsRef.current.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
        absInputDeltaPx >= thresholdPx
      ) {
        // Lower overscan early so fewer rows are in-flight while the browser
        // scrolls, but do NOT activate placeholders — those only appear once
        // handleScroll confirms genuine fast scroll by velocity/delta.
        setOutputOverscanMode(OUTPUT_ACTIVE_SCROLL_OVERSCAN, "fast-scroll", {
          phase,
          inputDeltaPx,
          scrollDeltaPx: inputDeltaPx,
          scrollVelocityPxMs: undefined,
          scrollGapMs:
            lastScrollEventAtRef.current == null
              ? undefined
              : now - lastScrollEventAtRef.current,
          pageDeltaThresholdPx:
            scrollElement.clientHeight * OUTPUT_SCROLL_SEEK_PAGE_FRACTION,
        });
        scheduleOverscanRestore();
      }
    },
    [
      isOutputVirtualized,
      scheduleOverscanRestore,
      setOutputOverscanMode,
    ]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      preArmScrollSeekForInput(
        event.currentTarget,
        getWheelDeltaPixels(event),
        OUTPUT_SCROLL_SEEK_WHEEL_DELTA_PX,
        "wheel-pre-scroll"
      );
    },
    [preArmScrollSeekForInput]
  );

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      lastUserScrollInputAtRef.current = performance.now();
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    },
    []
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const currentY = event.touches[0]?.clientY;
      const previousY = lastTouchYRef.current;
      lastUserScrollInputAtRef.current = performance.now();
      if (currentY == null || previousY == null) {
        lastTouchYRef.current = currentY ?? null;
        return;
      }

      lastTouchYRef.current = currentY;
      preArmScrollSeekForInput(
        event.currentTarget,
        previousY - currentY,
        OUTPUT_SCROLL_SEEK_TOUCH_DELTA_PX,
        "touch-pre-scroll"
      );
    },
    [preArmScrollSeekForInput]
  );

  const handleTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  const { navigationController, navigationPendingRowIndex } =
    useOutputNavigation({
      autoscrollEnabledRef: autoscrollEnabled,
      finalizeSettlingDelayMs: 1000,
      firstRowIndexByTarget,
      isOutputVirtualized,
      isProgrammaticScrollRef: isProgrammaticScroll,
      lastScrollTopRef,
      maxAlignmentAttempts: MAX_NAV_ALIGNMENT_ATTEMPTS,
      maxStabilizationMs: MAX_NAVIGATION_STABILIZATION_MS,
      measurementVersion,
      measurementVersionRef,
      navigationFrameRef,
      outputRef,
      pendingNavigationRef,
      postNavSettlingRef,
      postNavSettlingTimerRef,
      rowLayout,
      rowVirtualizer,
      rows,
      setCurrentScrollTarget,
    });

  // Auto-scroll effect — only fires for genuine new AI output, not layout changes.
  // measurementVersion is intentionally excluded: virtualizer height corrections
  // are layout-only and must not override the user's scroll position.
  useEffect(() => {
    const prevRowCount = lastAutoScrollRowCountRef.current;
    lastAutoScrollRowCountRef.current = rows.length;

    if (!autoscrollEnabled.current || !outputRef.current || rows.length === 0) {
      return;
    }

    // When execution is not active, only scroll if rows actually increased
    // (e.g. initial content load). Layout-only re-renders keep the same count
    // and must not snap the viewport back to the bottom.
    if (!isExecutionActive && rows.length <= prevRowCount) {
      return;
    }

    WebviewLog.debug(
      "[FP-SCROLL-DEBUG] autoScroll FIRING — scrolling to bottom",
      {
        rows: rows.length,
        prevRowCount,
        isExecutionActive,
        autoscrollEnabled: autoscrollEnabled.current,
        scrollTop: outputRef.current.scrollTop,
        t: performance.now().toFixed(1),
      }
    );
    setCurrentScrollTarget(DEFAULT_OUTPUT_SCROLL_TARGET, "auto-scroll");
    isProgrammaticScroll.current = true;
    if (isOutputVirtualized) {
      rowVirtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    } else {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
    requestAnimationFrame(() => {
      isProgrammaticScroll.current = false;
      WebviewLog.debug("[FP-SCROLL-DEBUG] isProgrammaticScroll cleared", {
        autoscrollEnabled: autoscrollEnabled.current,
        t: performance.now().toFixed(1),
      });
    });
  }, [
    rows,
    streamingChunks,
    finalStepStreamingChunks,
    isExecutionActive,
    isOutputVirtualized,
    rowVirtualizer,
    setCurrentScrollTarget,
  ]);

  useEffect(() => {
    if (activeOutputTab !== "output" || outputCollapsed || !isOutputVirtualized) {
      return;
    }

    requestAnimationFrame(() => {
      rowVirtualizer.measure();
    });
  }, [
    activeOutputTab,
    isOutputVirtualized,
    outputCollapsed,
    rowVirtualizer,
    rows.length,
  ]);

  // Check if there's any output
  const hasOutput = rows.length > 0;
  const nonVirtualVisibleRowCount = isOutputVirtualized
    ? rows.length
    : Math.min(rows.length, nonVirtualRenderedRowCount);
  const nonVirtualRows = isOutputVirtualized
    ? rows
    : rows.slice(0, nonVirtualVisibleRowCount);
  const lastNonVirtualRow = nonVirtualRows[nonVirtualRows.length - 1];
  const nonVirtualRenderedHeight = lastNonVirtualRow
    ? (rowLayout.rowStartsByKey.get(lastNonVirtualRow.key) ?? 0) +
      (rowLayout.rowSizesByKey.get(lastNonVirtualRow.key) ??
        getEstimatedRowHeight(lastNonVirtualRow))
    : 0;
  const nonVirtualSpacerHeight = Math.max(
    0,
    rowLayout.totalSize - nonVirtualRenderedHeight
  );
  const isNonVirtualOutputStaging =
    !isOutputVirtualized && hasOutput && nonVirtualVisibleRowCount < rows.length;
  const isOutputScrollSeeking =
    isOutputVirtualized && scrollSeekPlaceholderActive;
  const virtualRows = isOutputVirtualized
    ? rowVirtualizer.getVirtualItems()
    : [];
  useEffect(() => {
    if (!isOutputVirtualized || !shouldLogOutputVirtualRange()) {
      return;
    }

    const first = virtualRows[0];
    const last = virtualRows[virtualRows.length - 1];
    const signature = `${first?.index ?? -1}:${last?.index ?? -1}:${virtualRows.length}:${rows.length}`;
    if (signature === lastVirtualRangeRef.current) {
      return;
    }

    lastVirtualRangeRef.current = signature;
    logOutputProfilerEvent("virtualRange", {
      firstIndex: first?.index ?? null,
      lastIndex: last?.index ?? null,
      virtualRows: virtualRows.length,
      overscan: outputOverscan,
      scrollSeekPlaceholder: isOutputScrollSeeking,
      totalRows: rows.length,
      totalSize: rowVirtualizer.getTotalSize(),
    });
  }, [
    isOutputScrollSeeking,
    isOutputVirtualized,
    outputOverscan,
    rowVirtualizer,
    rows.length,
    virtualRows,
  ]);

  const handleOutputProfilerRender = useCallback(
    (
      id: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number
    ) => {
      const profilerState = getOutputProfilerState();
      if (
        !profilerState.enabled ||
        actualDuration < profilerState.slowThresholdMs
      ) {
        return;
      }

      logOutputProfilerEvent("reactCommit", {
        id,
        phase,
        actualDuration,
        baseDuration,
        renderToCommitGap: commitTime - startTime,
        virtualRows: virtualRows.length,
        overscan: outputOverscan,
        scrollSeekPlaceholder: isOutputScrollSeeking,
        scrollSeekRestorePendingMs:
          scrollSeekRestoreRequestedAtRef.current != null
            ? commitTime - scrollSeekRestoreRequestedAtRef.current
            : undefined,
        totalRows: rows.length,
        measurementVersion,
      });
    },
    [
      isOutputScrollSeeking,
      measurementVersion,
      outputOverscan,
      rows.length,
      virtualRows.length,
    ]
  );
  const isNavigationTargetVirtualized =
    isOutputVirtualized &&
    navigationPendingRowIndex != null &&
    virtualRows.some((row) => row.index === navigationPendingRowIndex);
  // The overlay is a global navigation/empty-range affordance. Scroll-seek
  // placeholders are different: they replace expensive row DOM while the user
  // is actively scrolling, so avoid stacking the global overlay on top of them.
  const showVirtualizationOverlay =
    !isOutputScrollSeeking &&
    (isNonVirtualOutputStaging ||
      (isOutputVirtualized &&
        ((hasOutput &&
          rows.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
          virtualRows.length === 0) ||
          (navigationPendingRowIndex !== null &&
            !isNavigationTargetVirtualized))));

  useEffect(() => {
    if (isOutputScrollSeeking || !hasOutput) {
      return;
    }

    const restoreRequestedAt = scrollSeekRestoreRequestedAtRef.current;
    const scrollSeekStartedAt = scrollSeekStartedAtRef.current;
    if (restoreRequestedAt == null) {
      return;
    }

    const now = performance.now();
    logOutputProfilerEvent("scrollSeekRowsVisible", {
      restoreToVisibleMs: now - restoreRequestedAt,
      scrollSeekTotalMs:
        scrollSeekStartedAt != null ? now - scrollSeekStartedAt : undefined,
      virtualRows: virtualRows.length,
      overscan: outputOverscan,
      totalRows: rows.length,
      measurementVersion,
    });
    scrollSeekSettlingUntilRef.current = now + OUTPUT_SCROLL_SEEK_SETTLE_MS;
    // Refresh the target from the current viewport before forcing the
    // restore — scrollTargetRef.current may still hold a stale {kind:
    // "bottom"} snapshot from before the user scrolled away (the commit is
    // debounced off scroll activity and may not have fired yet during
    // continuous scrolling). Forcing a stale "bottom" target here is what
    // produces the visible snap-back-to-bottom.
    commitScrollTargetFromViewport("scroll-seek-restore-commit");
    applyScrollTarget("scroll-seek-restore", { force: true });

    // Dump per-bucket accuracy stats so it's easy to see which event types
    // have the largest estimate errors. Sort by maxAbsDelta descending.
    const bucketStatsList = Array.from(
      rowHeightBucketStatsRef.current.entries()
    )
      .filter(([, s]) => s.sampleCount > 0)
      .map(([bucket, s]) => ({
        bucket,
        n: s.sampleCount,
        avgMeasured: Math.round(s.totalMeasured / s.sampleCount),
        avgEstimated: Math.round(s.totalEstimated / s.sampleCount),
        avgDelta: Math.round(
          (s.totalMeasured - s.totalEstimated) / s.sampleCount
        ),
        maxAbsDelta: Math.round(s.maxAbsDelta),
        scaleFactor:
          s.totalEstimated > 0
            ? Math.round((s.totalMeasured / s.totalEstimated) * 100) / 100
            : null,
      }))
      .sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
    logOutputProfilerEvent("rowEstimateStats", { buckets: bucketStatsList });

    if (fullOverscanRestoreTimerRef.current !== null) {
      clearTimeout(fullOverscanRestoreTimerRef.current);
    }
    if (overscanRestoreRafRef.current !== null) {
      cancelAnimationFrame(overscanRestoreRafRef.current);
      overscanRestoreRafRef.current = null;
    }
    if (outputOverscanRef.current === OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN) {
      fullOverscanRestoreTimerRef.current = setTimeout(() => {
        fullOverscanRestoreTimerRef.current = null;
        // Progressive rAF restore: increment overscan one step at a time so each
        // frame only mounts 2 additional rows (1 above + 1 below the viewport).
        // This prevents a batch of large diffs from causing a multi-second freeze
        // compared to the old approach of jumping 0→3 (6 rows) in one step.
        let step = 1;
        const doNextOverscanStep = () => {
          if (overscanRestoreRafRef.current === null) return;
          if (step <= OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN) {
            setOutputOverscanMode(step, "idle", {
              phase: "restore-buffer-step",
              step,
            });
            step++;
            overscanRestoreRafRef.current = requestAnimationFrame(doNextOverscanStep);
          } else {
            overscanRestoreRafRef.current = null;
            fullOverscanRestoreTimerRef.current = setTimeout(() => {
              fullOverscanRestoreTimerRef.current = null;
              setOutputOverscanMode(OUTPUT_VIRTUALIZER_OVERSCAN, "idle", {
                phase: "restore-full-overscan",
              });
            }, OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS);
          }
        };
        overscanRestoreRafRef.current = requestAnimationFrame(doNextOverscanStep);
      }, OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS);
    }
    scrollSeekRestoreRequestedAtRef.current = null;
    scrollSeekStartedAtRef.current = null;
  }, [
    hasOutput,
    isOutputScrollSeeking,
    measurementVersion,
    outputOverscan,
    rows.length,
    applyScrollTarget,
    commitScrollTargetFromViewport,
    setOutputOverscanMode,
    virtualRows.length,
  ]);

  useEffect(() => {
    if (
      activeOutputTab !== "output" ||
      executionState !== EXECUTION_STATES.RUNNING ||
      (!isViewingHistory && !historyOutputs)
    ) {
      return;
    }

    useWorkflowStore.getState().clearHistoryOutputs();
    useUiStore.getState().clearHistoryView();
  }, [
    activeOutputTab,
    activeWorkflowId,
    executionState,
    historyOutputs,
    isViewingHistory,
  ]);

  // History view should keep its undo affordances even if a live workflow is
  // currently active elsewhere; otherwise historical per-diff undo buttons disappear.
  const allowUndoActions = isViewingHistory || !isExecutionActive;

  const outputUndo = useOutputUndoActions({
    allMessages,
    allowUndoActions,
    finalStepWorkspaceSnapshots,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    stepOutputsMap,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  });
  const {
    closeMinimapDialog,
    closeWorkflowDialog,
    handleFileUndo,
    handlePromptRedo,
    handlePromptUndo,
    handleWorkflowRedo,
    handleWorkflowUndo,
    minimapDialogState,
    openMinimapRedoDialog,
    openMinimapUndoDialog,
    workflowDialogState,
    workflowUndoRedoData,
  } = outputUndo;

  const showCompactWorkflowUndoRedoLabels =
    workflowUndoRedoData.undoEntries.length > 0 &&
    workflowUndoRedoData.redoEntries.length > 0;
  const useCompactOutputHeaderLabels =
    isHeaderNarrow || showCompactWorkflowUndoRedoLabels;

  const { minimapSteps, stepScrollFractions } = useOutputMinimapModel({
    allMessages,
    allowUndoActions,
    finalStep,
    finalStepWorkspaceSnapshots,
    firstRowIndexByTarget,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    onOpenMinimapRedoDialog: openMinimapRedoDialog,
    onOpenMinimapUndoDialog: openMinimapUndoDialog,
    outputFontSize,
    rowLayout,
    rows,
    stepOutputsMap,
    steps,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  });

  const { openContextMenu, outputContextMenuPortal } = useOutputContextMenu({
    allMessages,
    stepScrollFractions,
    lastCliIndexPerStep,
  });

  const handleOutputLongPress = useCallback(
    (x: number, y: number) => {
      if (outputRef.current) openContextMenu(x, y, outputRef.current);
    },
    [openContextMenu]
  );
  const outputLongPressHandlers = useLongPress(handleOutputLongPress);
  const handleOutputTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      handleTouchStart(event);
      outputLongPressHandlers.onTouchStart(event);
    },
    [handleTouchStart, outputLongPressHandlers]
  );
  const handleOutputTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      handleTouchMove(event);
      outputLongPressHandlers.onTouchMove(event);
    },
    [handleTouchMove, outputLongPressHandlers]
  );
  const handleOutputTouchEnd = useCallback(
    (_event: React.TouchEvent<HTMLDivElement>) => {
      handleTouchEnd();
      outputLongPressHandlers.onTouchEnd();
    },
    [handleTouchEnd, outputLongPressHandlers]
  );
  const handleOutputTouchCancel = useCallback(
    (_event: React.TouchEvent<HTMLDivElement>) => {
      handleTouchEnd();
      outputLongPressHandlers.onTouchCancel();
    },
    [handleTouchEnd, outputLongPressHandlers]
  );

  const handleBackToLive = useCallback(() => {
    useWorkflowStore.getState().clearHistoryOutputs();
    useUiStore.getState().clearHistoryView();
  }, []);

  const invalidateMeasuredRow = useCallback(
    (rowKey: string) => {
      measurementCacheRef.current.delete(rowKey);
      rowVirtualizer.measure();
      setMeasurementVersion((version) => version + 1);
    },
    [rowVirtualizer]
  );
  invalidateMeasuredRowImplRef.current = invalidateMeasuredRow;

  const invalidateMeasuredRowForUserResize = useCallback(
    (rowKey: string) => {
      rowResizeScrollSuppressUntilRef.current =
        performance.now() + OUTPUT_ROW_RESIZE_SCROLL_SUPPRESS_MS;
      measurementCacheRef.current.delete(rowKey);

      requestAnimationFrame(() => {
        const nextScrollElement = outputRef.current;
        if (!nextScrollElement) {
          setMeasurementVersion((version) => version + 1);
          return;
        }

        const nextRowElement = findRenderedRowElementByKey(
          nextScrollElement,
          rowKey
        );
        if (!nextRowElement) {
          rowVirtualizer.measure();
          setMeasurementVersion((version) => version + 1);
          return;
        }

        rowVirtualizer.measureElement(nextRowElement);
        setMeasurementVersion((version) => version + 1);

        requestAnimationFrame(() => {
          applyScrollTargetRef.current("row-resize", { force: true });
        });
      });
    },
    [rowVirtualizer]
  );
  invalidateMeasuredRowForUserResizeImplRef.current =
    invalidateMeasuredRowForUserResize;

  const handleMinimapStepClick = useCallback(
    (step: MinimapStep) => {
      navigationController.scrollToTarget(
        { kind: step.kind, index: step.stepIndex },
        { behavior: "smooth", align: "start" }
      );
    },
    [navigationController]
  );

  const handleToggleOutputCollapse = useCallback(() => {
    triggerPanelAnimation();
    toggleOutputCollapse();
  }, [toggleOutputCollapse]);

  const handleSelectOutputTab = useCallback(() => {
    setActiveOutputTab(terminalWorkflowId, "output");
  }, [setActiveOutputTab, terminalWorkflowId]);

  const handleSpawnTerminal = useCallback(() => {
    getVsCodeApi()?.postMessage({
      type: MESSAGE_TYPES.TERMINAL_SPAWN_SHELL,
      workflowId: terminalWorkflowId,
      cwd: workspaceRoot || "",
    });
  }, [terminalWorkflowId, workspaceRoot]);

  const handleSelectTerminalTab = useCallback(() => {
    setActiveOutputTab(terminalWorkflowId, "terminal");
    if (terminalSessions.length === 0) {
      handleSpawnTerminal();
    }
  }, [
    handleSpawnTerminal,
    setActiveOutputTab,
    terminalSessions.length,
    terminalWorkflowId,
  ]);

  const terminalCanCloseActiveSession =
    activeTerminalSession?.kind === SESSION_KINDS.SHELL ||
    (activeTerminalSession?.kind === SESSION_KINDS.AI_CLI &&
      !isExecutionActive);

  const handleCloseActiveTerminalSession = useCallback(() => {
    if (!activeTerminalSession) return;

    const vscode = getVsCodeApi();
    if (activeTerminalSession.kind === SESSION_KINDS.SHELL) {
      vscode?.postMessage({
        type: MESSAGE_TYPES.TERMINAL_CLOSE_SHELL,
        workflowId: terminalWorkflowId,
        sessionId: activeTerminalSession.id,
      });
    } else {
      vscode?.postMessage({
        type: MESSAGE_TYPES.TERMINAL_CLOSE_AI_CLI,
        workflowId: terminalWorkflowId,
        sessionId: activeTerminalSession.id,
      });
    }

    terminalRegistry.clearSession(terminalWorkflowId, activeTerminalSession.id);
    useTerminalStore
      .getState()
      .removeSession(terminalWorkflowId, activeTerminalSession.id);

    const remaining =
      useTerminalStore.getState().sessions[terminalWorkflowId] ?? [];
    if (remaining.length === 0) {
      setActiveOutputTab(terminalWorkflowId, "output");
    }
  }, [activeTerminalSession, setActiveOutputTab, terminalWorkflowId]);

  const handleSelectRun = useCallback((runIndex: number) => {
    getVsCodeApi()?.postMessage({
      type: MESSAGE_TYPES.LOAD_RUN_HISTORY,
      runIndex,
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    getVsCodeApi()?.postMessage({
      type: MESSAGE_TYPES.CLEAR_RUN_HISTORY,
    });
  }, []);

  const collapsedHeader = (
    <div
      ref={mergedHeaderRef}
      className="flex flex-row items-center w-full h-[30px] px-2 gap-1 border-b border-panel-border bg-sidebar-bg cursor-pointer select-none text-description-fg hover:text-foreground transition-colors flex-shrink-0"
      onClick={handleToggleOutputCollapse}
      role="button"
      aria-label="Expand output"
      tabIndex={0}
      onKeyDown={(e) =>
        e.key === "Enter" && handleToggleOutputCollapse()
      }
    >
      <i className="codicon codicon-chevron-right text-xs" />
      <i className="codicon codicon-output text-sm" />
      <span className="text-xs font-semibold uppercase tracking-wide">
        Output
      </span>
      <span className="text-xs text-description-fg mx-1">/</span>
      <i className="codicon codicon-terminal text-sm" />
      <span className="text-xs font-semibold uppercase tracking-wide">
        Terminal
      </span>
    </div>
  );

  if (outputCollapsed && editorCollapsed) {
    return collapsedHeader;
  }

  return (
    <section
      ref={sectionRef}
      id="output-section"
      className="min-h-0 flex-1 bg-editor-bg flex flex-col h-full overflow-hidden"
    >
      {/* Section Header */}
      {outputCollapsed ? (
        collapsedHeader
      ) : (
        <OutputSectionHeader
          activeOutputTab={activeOutputTab}
          activeTerminalSession={activeTerminalSession}
          anyDiffCollapsed={anyDiffCollapsed}
          availableRuns={availableRuns}
          currentRunIndex={viewingRunIndex}
          executionModeInteractive={executionMode === EXECUTION_MODES.INTERACTIVE}
          hasOutput={hasOutput}
          isExecutionActive={isExecutionActive}
          isHeaderNarrow={isHeaderNarrow}
          isHeaderVeryNarrow={isHeaderVeryNarrow}
          isTerminalCompact={isTerminalCompact}
          refCallback={mergedHeaderRef}
          runStates={runStates}
          runTimestamps={runTimestamps}
          showTerminalTab={showTerminalTab}
          terminalCanCloseActiveSession={terminalCanCloseActiveSession}
          terminalFontSize={terminalFontSize}
          terminalSessionActive={terminalSessionActive}
          useCompactLabels={useCompactOutputHeaderLabels}
          viewingHistory={isViewingHistory}
          workflowRedoEntries={workflowUndoRedoData.redoEntries}
          workflowUndoEntries={workflowUndoRedoData.undoEntries}
          onBackToLive={handleBackToLive}
          onClearHistory={handleClearHistory}
          onCollapseAllDiffs={collapseAllDiffs}
          onExecutionModeToggle={handleExecutionModeChange}
          onExpandAllDiffs={expandAllDiffs}
          onExport={outputExport.openModal}
          onNewTerminal={handleSpawnTerminal}
          onOutputFontSizeChange={setOutputFontSize}
          onRunSelect={handleSelectRun}
          onSelectOutputTab={handleSelectOutputTab}
          onSelectTerminalTab={handleSelectTerminalTab}
          onTerminalFontSizeChange={updateTerminalFontSize}
          onTerminalSessionClose={handleCloseActiveTerminalSession}
          onToggleCollapse={handleToggleOutputCollapse}
          onWorkflowRedo={handleWorkflowRedo}
          onWorkflowUndo={handleWorkflowUndo}
          outputFontSize={outputFontSize}
        />
      )}

      {/* Output Content: keep both panes mounted so tab switches preserve DOM-heavy output. */}
      <>
        <div
          aria-hidden={activeOutputTab !== "terminal" || outputCollapsed}
          className={`${
            !outputCollapsed && activeOutputTab === "terminal"
              ? "flex"
              : "hidden"
          } flex-row min-h-0 flex-1`}
        >
          <TerminalView workflowId={terminalWorkflowId} />
        </div>
        <OutputPane
          activeOutputTab={activeOutputTab}
          bashExpansionState={bashExpansionState}
          contentHeight={rowLayout.totalSize}
          hasOutput={hasOutput}
          isExecutionActive={isExecutionActive}
          isNavigationTargetVirtualized={isNavigationTargetVirtualized}
          isOutputCollapsed={outputCollapsed}
          isOutputScrollSeeking={isOutputScrollSeeking}
          isOutputVirtualized={isOutputVirtualized}
          minimapSteps={minimapSteps}
          nonVirtualRows={nonVirtualRows}
          nonVirtualSpacerHeight={nonVirtualSpacerHeight}
          outputRef={outputRef}
          renderedScrollSeekIndices={scrollSeekEntryRenderedIndicesRef.current}
          rows={rows}
          showVirtualizationOverlay={showVirtualizationOverlay}
          virtualRows={virtualRows}
          virtualizedTotalSize={rowVirtualizer.getTotalSize()}
          measureRowElement={measureRowElement}
          measureStaticRowElement={measureStaticRowElement}
          onBackToLive={handleBackToLive}
          onBashExpansionChange={handleBashExpansionChange}
          onContextMenuOpen={openContextMenu}
          onDiffCollapsedChange={handleDiffCollapsedChange}
          onDiffGapExpand={handleDiffGapExpand}
          onFileUndo={handleFileUndo}
          onMinimapStepClick={handleMinimapStepClick}
          onOutputProfilerRender={handleOutputProfilerRender}
          onPromptRedo={handlePromptRedo}
          onPromptUndo={handlePromptUndo}
          onScroll={handleScroll}
          onToolCallExpansionChange={handleToolCallExpansionChange}
          onTouchCancel={handleOutputTouchCancel}
          onTouchEnd={handleOutputTouchEnd}
          onTouchMove={handleOutputTouchMove}
          onTouchStart={handleOutputTouchStart}
          onWheel={handleWheel}
        />
      </>

      <OutputUndoDialogs
        minimapDialogState={minimapDialogState}
        workflowDialogState={workflowDialogState}
        onCloseMinimapDialog={closeMinimapDialog}
        onCloseWorkflowDialog={closeWorkflowDialog}
      />

      {/* Output tab right-click context menu */}
      {outputContextMenuPortal}

      {/* Export options modal — used by both VS Code and hosted web server */}
      {outputExport.modalOpen && (
        <ExportOutputModal
          includeCommand={outputExport.includeCommand}
          includeMetadata={outputExport.includeMetadata}
          isStandaloneMode={outputExport.isStandaloneMode}
          stepRange={outputExport.stepRange}
          stepRangeError={outputExport.stepRangeError}
          totalCliSteps={outputExport.totalCliSteps}
          onClose={outputExport.closeModal}
          onConfirm={outputExport.confirmExport}
          onIncludeCommandChange={outputExport.setIncludeCommand}
          onIncludeMetadataChange={outputExport.setIncludeMetadata}
          onStepRangeChange={outputExport.updateStepRange}
        />
      )}
    </section>
  );
};

OutputSectionInner.displayName = "OutputSection";

export const OutputSection = React.memo(OutputSectionInner);
