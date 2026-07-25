import React, { useEffect, useRef, useCallback, useState } from "react";
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
import { useOutputScrollSeek } from "@hooks/useOutputScrollSeek";
import { useOutputScrollTarget } from "@hooks/useOutputScrollTarget";
import { useOutputUndoActions } from "@hooks/useOutputUndoActions";
import { useOutputVirtualization } from "@hooks/useOutputVirtualization";
import { useOutputFind } from "@hooks/useOutputFind";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import {
  MESSAGE_TYPES,
  EXECUTION_MODES,
  EXECUTION_STATES,
  SESSION_KINDS,
  SETTING_SCOPES,
} from "../../types/messages";
import { type MinimapStep } from "../output/OutputMinimap";
import { OutputFindBar } from "../output";
import { TerminalView } from "../output/TerminalView";
import { useTerminalStore } from "@store/terminalStore";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";
import { ExportOutputModal } from "./output-section/ExportOutputModal";
import { OutputSectionHeader } from "./output-section/OutputSectionHeader";
import { OutputPane } from "./output-section/OutputPane";
import { OutputUndoDialogs } from "./output-section/OutputUndoDialogs";

import { triggerPanelAnimation } from "@utils/panelAnimation";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import { toOutputMessageTarget } from "@utils/outputProjection";
import {
  getProfilerState,
  logProfilerEvent,
  shouldLogScrollFrame,
} from "@utils/performanceProfiler";
import { WebviewLog } from "@utils/logger";
import { captureViewportRowAnchor } from "@utils/outputDom";
import {
  LARGE_WORKFLOW_ROW_THRESHOLD,
  OUTPUT_USER_SCROLL_INPUT_GRACE_MS,
} from "@utils/outputScrollConstants";

// Stable empty fallback — avoids infinite re-render from `?? []` returning a new
// array reference on every useSyncExternalStore snapshot call.
const EMPTY_TERMINAL_SESSIONS: TerminalSession[] = [];

// Stable workflowId used for standalone user shell sessions (no active workflow).
const SHELL_WORKFLOW_ID = "_shell";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to keep auto-scroll pinned.
const DIFF_SPLIT_VIEW_MIN_WIDTH = 1024; // minimum output width before diffs use split view.
const OUTPUT_SCROLL_TARGET_COMMIT_MAX_RETRIES = 5; // animation-frame retries for capturing a viewport anchor when rows are mid-transition (e.g. scroll-seek placeholder swap).
const MAX_NAV_ALIGNMENT_ATTEMPTS = 8; // max correction passes when aligning minimap/step navigation.
const MAX_NAVIGATION_STABILIZATION_MS = 1000; // time limit for navigation alignment before accepting the current position.
const DEFAULT_OUTPUT_SCROLL_TARGET: OutputScrollTarget = { kind: "bottom" };

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
  // Stable identity of the run being displayed. Row measurements are cached by
  // row key, and the same key can have a very different height in another run,
  // so anything keyed on "which run am I looking at" must key on the address —
  // never on a list position, which shifts when runs are deleted.
  const displayedRunRef = useUiStore((s) =>
    s.displayedViewAddress?.kind === "run"
      ? s.displayedViewAddress.runRef
      : null
  );
  // Terminal sessions remain owned by the executing run when the client
  // navigates to a historical run (or the lineage draft). Resolve that run's
  // manifest-backed ID so the terminal context can state the split explicitly
  // without implying that navigation rebound the PTY.
  const terminalExecutionRunLabel = useUiStore((s) => {
    const displayedAddress = s.displayedViewAddress;
    const executionRunRef = s.executionRunRef;
    if (
      !displayedAddress ||
      !executionRunRef ||
      (displayedAddress.kind === "run" &&
        displayedAddress.runRef === executionRunRef)
    ) {
      return null;
    }

    const executionRunId = s.runSummaries.find(
      (summary) => summary.runRef === executionRunRef
    )?.runId;
    return executionRunId === undefined ? null : `Live Run ${executionRunId}`;
  });
  const diffsCollapsed = useUiStore((s) => s.diffsCollapsed);
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const expandAllDiffs = useUiStore((s) => s.expandAllDiffs);
  const collapseAllDiffs = useUiStore((s) => s.collapseAllDiffs);
  const outputFontSize = useUiStore((s) => s.outputFontSize);
  const setOutputFontSize = useUiStore((s) => s.setOutputFontSize);
  const pendingFindRequest = useUiStore((s) => s.pendingFindRequest);
  const setPendingFindRequest = useUiStore((s) => s.setPendingFindRequest);
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
    s.globalSettings.settingSources["defaults.executionMode"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const handleExecutionModeChange = useCallback(
    (active: boolean) => {
      const vscode = getVsCodeApi();
      vscode?.postMessage({
        type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
        path: "defaults.executionMode",
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
  const [outputDiffViewType, setOutputDiffViewType] = useState<
    "split" | "unified"
  >("split");
  const [outputContentWidth, setOutputContentWidth] = useState(0);
  const rowResizeScrollSuppressUntilRef = useRef<number | null>(null);
  const lastUserScrollInputAtRef = useRef<number | null>(null);
  const getVirtualItemsRef = useRef<() => readonly { index: number }[]>(
    () => []
  );
  const pendingNavigationRef = useRef<PendingNavigationState | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const scrollTargetRef = useRef<OutputScrollTarget>(
    savedOutputScrollTarget ?? DEFAULT_OUTPUT_SCROLL_TARGET
  );
  const applyScrollTargetRef = useRef<
    (
      phase: string,
      options?: { force?: boolean }
    ) => {
      resolved: boolean;
      appliedDelta: number;
    }
  >(() => ({ resolved: false, appliedDelta: 0 }));
  const commitScrollTargetFromViewportRef = useRef<(reason: string) => void>(
    () => {}
  );
  // Populated from useOutputVirtualization below; lets the scroll-seek restore
  // (which runs first in source order) drain deferred measurements synchronously
  // before it re-anchors the viewport.
  const flushPendingScrollMeasurementsRef = useRef<() => void>(() => {});
  const lastScrollEventAtRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const measurementVersionRefForScrollSeek = useRef(0);
  const virtualRowsLengthRef = useRef(0);
  const getRowEstimateStatsRef = useRef<() => unknown[]>(() => []);
  // Set true during flush so TanStack's rAF-deferred scroll corrections don't
  // re-activate the scroll freeze in handleScroll.
  const isMeasurementFlushInProgressRef = useRef(false);
  // Tracks the row count at the last auto-scroll so we can distinguish "new
  // rows arrived" (scroll) from "same rows re-rendered" (don't scroll).
  const lastAutoScrollRowCountRef = useRef(0);
  // Collapse hides the output pane with display:none, which reports a transient
  // width of 0. Suppress width/scroll bookkeeping during that transition so we
  // do not re-anchor the viewport against a disappearing pane.
  const suppressOutputLayoutWorkRef = useRef(outputCollapsed);
  // Suppresses TanStack Virtual's internal scroll corrections for 1 s after navigation
  // completes. Without this, new rows entering the virtual window post-navigation
  // repeatedly trigger corrections that oscillate the scroll position.
  const postNavSettlingRef = useRef(false);
  const postNavSettlingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

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
  const clearMeasurementsImplRef = useRef<() => void>(() => {});
  const invalidateMeasuredRowForRowModel = useCallback(
    (rowKey: string) => invalidateMeasuredRowImplRef.current(rowKey),
    []
  );
  const invalidateMeasuredRowForUserResizeForRowModel = useCallback(
    (rowKey: string) =>
      invalidateMeasuredRowForUserResizeImplRef.current(rowKey),
    []
  );
  const handleDiffViewReset = useCallback(() => {
    clearMeasurementsImplRef.current();
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

  const rowRenderIdentity = `${fileName ?? ""}:${
    isViewingHistory ? (displayedRunRef ?? "history") : "live"
  }`;
  const scrollSeekRowsRef = useRef(rows);
  scrollSeekRowsRef.current = rows;
  const isOutputVirtualizedRef = useRef(false);

  const {
    outputOverscan,
    outputOverscanRef,
    renderedScrollSeekIndices,
    scheduleOverscanRestore,
    scrollSeekPlaceholderActive,
    scrollSeekPlaceholderRef,
    scrollSeekRestoreRequestedAtRef,
    scrollSeekSettlingUntilRef,
    updateScrollSeekForScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useOutputScrollSeek({
    applyScrollTargetRef,
    commitScrollTargetFromViewportRef,
    flushPendingScrollMeasurementsRef,
    getRowEstimateStats: () => getRowEstimateStatsRef.current(),
    getVirtualItemsRef,
    hasOutput: rows.length > 0,
    isOutputVirtualizedRef,
    lastScrollEventAtRef,
    lastUserScrollInputAtRef,
    measurementVersion: measurementVersionRefForScrollSeek.current,
    rows,
    rowsRef: scrollSeekRowsRef,
    virtualRowsLength: virtualRowsLengthRef.current,
  });

  const {
    clearMeasurements,
    flushPendingScrollMeasurements,
    getRowEstimateStats,
    hasPendingMeasurements,
    handleOutputProfilerRender,
    invalidateMeasuredRow,
    invalidateMeasuredRowForUserResize,
    isNonVirtualOutputStaging,
    isOutputScrollSeeking,
    isOutputVirtualized,
    measureRowElement,
    measureStaticRowElement,
    measurementVersion,
    measurementVersionRef,
    nonVirtualRows,
    nonVirtualSpacerHeight,
    rowLayout,
    rowVirtualizer,
    rowsRef,
    schedulePendingMeasurementFlush,
    virtualRows,
  } = useOutputVirtualization({
    applyScrollTargetRef,
    getVirtualItemsRef,
    isMeasurementFlushInProgressRef,
    lastScrollEventAtRef,
    outputCollapsed,
    outputContentWidth,
    outputFontSize,
    outputOverscan,
    outputOverscanRef,
    outputRef,
    outputVirtualizationRowThreshold,
    pendingNavigationRef,
    postNavSettlingRef,
    rowRenderIdentity,
    rowResizeScrollSuppressUntilRef,
    rows,
    scrollSeekPlaceholderActive,
    scrollSeekRestoreRequestedAtRef,
    scrollSeekSettlingUntilRef,
    scrollTargetRef,
  });
  flushPendingScrollMeasurementsRef.current = flushPendingScrollMeasurements;

  isOutputVirtualizedRef.current = isOutputVirtualized;
  measurementVersionRefForScrollSeek.current = measurementVersion;
  virtualRowsLengthRef.current = virtualRows.length;
  getRowEstimateStatsRef.current = getRowEstimateStats;
  clearMeasurementsImplRef.current = clearMeasurements;
  invalidateMeasuredRowImplRef.current = invalidateMeasuredRow;
  invalidateMeasuredRowForUserResizeImplRef.current =
    invalidateMeasuredRowForUserResize;

  const {
    applyScrollTarget,
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
    if (!outputCollapsed) {
      suppressOutputLayoutWorkRef.current = false;
    }
  }, [outputCollapsed]);

  useEffect(() => {
    const el = outputRef.current;
    if (!el || outputCollapsed) return;

    const updateDiffViewType = () => {
      if (suppressOutputLayoutWorkRef.current) {
        return;
      }
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
  }, [activeOutputTab, applyScrollTarget, outputCollapsed, outputContentWidth]);

  useEffect(() => {
    if (outputContentWidth <= 0) {
      return;
    }
    // Keep a small live buffer during width resize so expanding the pane can
    // reveal nearby rows above/below the pinned row without rendering the full
    // idle range on every pointer move.
    scheduleOverscanRestore();
  }, [
    outputContentWidth,
    outputDiffViewType,
    outputFontSize,
    scheduleOverscanRestore,
  ]);

  // When switching between live output and a history run (including when the
  // viewed run changes), the same row keys can appear with very different
  // heights — e.g., a row measured as 500 px during a live run where diffs were
  // expanded will still be in the cache when the same run is opened in history
  // view with diffs collapsed (74 px estimate).  Flush the cache so rowLayout
  // re-estimates from scratch for the incoming content.
  const previousIsViewingHistory = useRef(isViewingHistory);
  const previousDisplayedRunRef = useRef(displayedRunRef);
  useEffect(() => {
    const viewChanged =
      previousIsViewingHistory.current !== isViewingHistory ||
      previousDisplayedRunRef.current !== displayedRunRef;
    previousIsViewingHistory.current = isViewingHistory;
    previousDisplayedRunRef.current = displayedRunRef;
    if (!viewChanged) return;

    clearMeasurements();
  }, [clearMeasurements, isViewingHistory, displayedRunRef]);

  // Smart scroll: detect user scrolling away from bottom
  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    if (suppressOutputLayoutWorkRef.current) {
      return;
    }
    if (isProgrammaticScroll.current) {
      // Still update autoscrollEnabled so a user wheel mid-programmatic-scroll
      // correctly disables auto-scroll. Without this, the flag stays true and
      // the auto-scroll effect fires again on the next measurementVersion bump.
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <=
        SCROLL_BOTTOM_THRESHOLD;
      autoscrollEnabled.current = atBottom;
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
    if (hasPendingMeasurements()) {
      schedulePendingMeasurementFlush();
    }
    const {
      isFastScroll,
      rawFastScroll,
      scrollDeltaPx,
      scrollGapMs,
      scrollVelocityPxMs,
      suppressedFastScroll,
    } = updateScrollSeekForScroll(
      el,
      previousScrollEventAt,
      previousScrollTop,
      now
    );
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD;
    autoscrollEnabled.current = atBottom;

    // Immediately track the live scroll position so layout effects always apply
    // the current position, not a stale pre-scroll target. This covers momentum
    // scroll where the debounced commit hasn't fired yet. We only update the ref
    // here; the store write is still deferred via scheduleScrollTargetCommit.
    if (atBottom) {
      scrollTargetRef.current = DEFAULT_OUTPUT_SCROLL_TARGET;
    } else {
      const anchor = captureViewportRowAnchor(el, "visible-top");
      if (anchor) {
        scrollTargetRef.current = {
          kind: "row",
          rowKey: anchor.rowKey,
          viewportOffsetPx: anchor.offsetTop,
        };
      }
    }

    scheduleScrollTargetCommit("user-scroll-settled");
    if (previousScrollEventAt != null) {
      const gapMs = scrollGapMs;
      if (shouldLogScrollFrame(gapMs)) {
        logProfilerEvent("scroll", {
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
    const profilerState = getProfilerState();
    if (profilerState.enabled && durationMs >= profilerState.slowThresholdMs) {
      logProfilerEvent("scrollHandler", {
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
    hasPendingMeasurements,
    outputOverscanRef,
    rowVirtualizer,
    rowsRef,
    schedulePendingMeasurementFlush,
    scheduleScrollTargetCommit,
    scrollSeekPlaceholderRef,
    updateScrollSeekForScroll,
  ]);

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

  const {
    state: findState,
    setState: setFindState,
    open: openFind,
    close: closeFind,
    search: runSearch,
    navigate: navigateFind,
    handleKeyDown: handleFindKeyDown,
    rowDecorations,
    activeMatch,
  } = useOutputFind(
    rows,
    (match) =>
      navigationController.scrollToRowIndex(match.rowIndex, {
        align: "center",
        revealActiveFindMatch: true,
      }),
    pendingFindRequest
      ? {
          query: pendingFindRequest.query,
          preferredTarget: pendingFindRequest.preferredTarget
            ? toOutputMessageTarget(pendingFindRequest.preferredTarget)
            : undefined,
        }
      : null
  );

  useEffect(() => {
    if (pendingFindRequest !== null) {
      setPendingFindRequest(null);
    }
  }, [pendingFindRequest, setPendingFindRequest]);

  const handleOpenFind = useCallback(() => {
    if (activeOutputTab !== "output") {
      setActiveOutputTab(terminalWorkflowId, "output");
    }
    openFind();
  }, [activeOutputTab, openFind, setActiveOutputTab, terminalWorkflowId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }
      // Let CodeMirror handle its own find when a prompt editor is focused —
      // its capture-phase handler runs first and opens the search panel.
      const target = event.target as HTMLElement | null;
      if (target?.closest(".cm-editor")) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handleOpenFind();
    };

    // Capture phase: run before VS Code's webview keydown forwarding and
    // before bubbling reaches anything else, so Ctrl+F is scoped to this view.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [handleOpenFind]);

  // Auto-scroll effect — only fires for genuine new AI output, not layout changes.
  // measurementVersion is intentionally excluded: virtualizer height corrections
  // are layout-only and must not override the user's scroll position.
  useEffect(() => {
    const prevRowCount = lastAutoScrollRowCountRef.current;
    lastAutoScrollRowCountRef.current = rows.length;

    if (
      suppressOutputLayoutWorkRef.current ||
      !autoscrollEnabled.current ||
      !outputRef.current ||
      rows.length === 0
    ) {
      return;
    }

    // When execution is not active, only scroll if rows actually increased
    // (e.g. initial content load). Layout-only re-renders keep the same count
    // and must not snap the viewport back to the bottom.
    if (!isExecutionActive && rows.length <= prevRowCount) {
      return;
    }

    setCurrentScrollTarget(DEFAULT_OUTPUT_SCROLL_TARGET, "auto-scroll");
    applyScrollTarget("auto-scroll");
  }, [
    applyScrollTarget,
    rows,
    streamingChunks,
    finalStepStreamingChunks,
    isExecutionActive,
    setCurrentScrollTarget,
  ]);

  const hasOutput = rows.length > 0;
  const isNavigationTargetVirtualized =
    isOutputVirtualized &&
    navigationPendingRowIndex != null &&
    virtualRows.some((row) => row.index === navigationPendingRowIndex);
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
    onOpenFind: handleOpenFind,
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
    suppressOutputLayoutWorkRef.current = !outputCollapsed;
    triggerPanelAnimation();
    toggleOutputCollapse();
  }, [outputCollapsed, toggleOutputCollapse]);

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

  useEffect(() => {
    WebviewLog.debug(
      `[OutputSection] terminal pane wf=${terminalWorkflowId.slice(0, 8)} activeTab=${activeOutputTab} ` +
        `outputCollapsed=${outputCollapsed} terminalSessions=${terminalSessions.length} ` +
        `activeSession=${activeTerminalSessionId?.slice(0, 8) ?? "none"} terminalActive=${terminalSessionActive}`
    );
  }, [
    activeOutputTab,
    activeTerminalSessionId,
    outputCollapsed,
    terminalSessionActive,
    terminalSessions.length,
    terminalWorkflowId,
  ]);

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

  const handleFindQueryChange = useCallback(
    (query: string) => {
      runSearch(query);
    },
    [runSearch]
  );

  const handleFindCaseSensitiveToggle = useCallback(() => {
    setFindState((previous) => ({
      ...previous,
      caseSensitive: !previous.caseSensitive,
    }));
  }, [setFindState]);

  const findBar = (
    <OutputFindBar
      state={findState}
      onQueryChange={handleFindQueryChange}
      onNavigate={navigateFind}
      onToggleCaseSensitive={handleFindCaseSensitiveToggle}
      onClose={closeFind}
      onKeyDown={handleFindKeyDown}
    />
  );

  const collapsedHeader = (
    <div
      ref={mergedHeaderRef}
      className="flex flex-row items-center w-full h-[30px] px-2 gap-1 border-b border-panel-border bg-sidebar-bg cursor-pointer select-none text-description-fg hover:text-foreground transition-colors flex-shrink-0"
      onClick={handleToggleOutputCollapse}
      role="button"
      aria-label="Expand output"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleToggleOutputCollapse()}
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
          executionModeInteractive={
            executionMode === EXECUTION_MODES.INTERACTIVE
          }
          hasOutput={hasOutput}
          isExecutionActive={isExecutionActive}
          isHeaderNarrow={isHeaderNarrow}
          isHeaderVeryNarrow={isHeaderVeryNarrow}
          isTerminalCompact={isTerminalCompact}
          refCallback={mergedHeaderRef}
          showTerminalTab={showTerminalTab}
          terminalCanCloseActiveSession={terminalCanCloseActiveSession}
          terminalExecutionRunLabel={terminalExecutionRunLabel}
          terminalFontSize={terminalFontSize}
          terminalSessionActive={terminalSessionActive}
          useCompactLabels={useCompactOutputHeaderLabels}
          workflowRedoEntries={workflowUndoRedoData.redoEntries}
          workflowUndoEntries={workflowUndoRedoData.undoEntries}
          onCollapseAllDiffs={collapseAllDiffs}
          onExecutionModeToggle={handleExecutionModeChange}
          onExpandAllDiffs={expandAllDiffs}
          onExport={outputExport.openModal}
          onNewTerminal={handleSpawnTerminal}
          onOutputFontSizeChange={setOutputFontSize}
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

      {/* Output Content: keep both panes mounted so tab switches preserve DOM-heavy output.
          Both panes are absolutely positioned to fill this wrapper so the inactive pane
          stays at its real size (visibility:hidden) instead of collapsing to 0×0 (display:none),
          which would break xterm's column fit and force a manual resize on tab switch. */}
      <div className="relative flex-row min-h-0 flex-1 flex">
        <div
          aria-hidden={activeOutputTab !== "terminal" || outputCollapsed}
          className={`absolute inset-0 flex flex-row min-h-0 ${
            !outputCollapsed && activeOutputTab === "terminal"
              ? ""
              : "invisible pointer-events-none"
          }`}
        >
          <TerminalView workflowId={terminalWorkflowId} />
        </div>
        <OutputPane
          activeOutputTab={activeOutputTab}
          activeMatch={activeMatch}
          bashExpansionState={bashExpansionState}
          contentHeight={rowLayout.totalSize}
          findBar={findBar}
          findDecorations={rowDecorations}
          findQuery={findState.isOpen ? findState.query : undefined}
          findCaseSensitive={findState.caseSensitive}
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
          renderedScrollSeekIndices={renderedScrollSeekIndices}
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
      </div>

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
