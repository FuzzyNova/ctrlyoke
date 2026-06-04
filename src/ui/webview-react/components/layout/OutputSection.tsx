import React, {
  Profiler,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { OutputRow } from "../output";
import { Modal } from "../shared";
import {
  RunSelector,
  IconToggleButton,
  ExpandCollapseAllDiffsButton,
} from "../shared";
import { TerminalSessionIcon } from "../output/TerminalSessionIcon";
import { generateId } from "@utils/string";
import {
  generateMarkdownExport,
  type ExportOptions,
} from "@utils/markdownExport";
import { parseRangeNotation } from "@root/utils/RangeNotationParser";
import {
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import type { CliOutput as CliOutputType } from "../../types/cliEvents";
import type {
  WorkspaceSnapshot,
  UndoRecord,
  UndoExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import {
  MESSAGE_TYPES,
  CLI_EVENT_TYPES,
  EXECUTION_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  SESSION_KINDS,
  STEP_TYPES,
  SETTING_SCOPES,
} from "../../types/messages";
import {
  OutputMinimap,
  type MinimapStep,
  type MinimapDiffBlock,
} from "../output/OutputMinimap";
import { UndoChangesDialog } from "../output/UndoChangesDialog";
import type { WorkflowStepEntry } from "../output/UndoChangesDialog";
import { TerminalView } from "../output/TerminalView";
import { useTerminalStore } from "@store/terminalStore";
import type { TerminalSession } from "@store/terminalStore";
import { terminalRegistry } from "../../terminalRegistry";

// Stable empty fallback — avoids infinite re-render from `?? []` returning a new
// array reference on every useSyncExternalStore snapshot call.
const EMPTY_TERMINAL_SESSIONS: TerminalSession[] = [];

// Stable workflowId used for standalone user shell sessions (no active workflow).
const SHELL_WORKFLOW_ID = "_shell";
import {
  buildUndoDialogInputForPrompt,
  buildUndoCandidatesForOutputs,
  buildUndoDialogInputForSpecificEvent,
  computePromptUndoActions,
  sameFilePath,
  type UndoDialogInput,
} from "../../utils/promptUndo";
import type { UndoFileInstruction } from "../../types/messages";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { WebviewLog } from "@utils/logger";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import {
  buildOutputRows,
  estimateOutputDiffBlockHeight,
  estimateOutputRowHeight,
  type CliHeaderRow,
  type OutputRenderRow,
  type StructuredEventRow,
} from "@utils/outputRows";
import { setActiveOutputNavigationController } from "@utils/outputNavigation";
import type { OutputRowFileUndoRequest } from "../output/OutputRow";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";
import {
  DEFAULT_TOOL_CALL_EXPANSION_STATE,
  type ToolCallExpansionSection,
  type ToolCallExpansionState,
} from "@utils/toolCallLayout";
import type {
  BashOutputExpansionSection,
  BashOutputExpansionState,
} from "../output/BashOutput";
import {
  getOutputProfilerState,
  isOutputProfilingEnabled,
  logOutputProfilerEvent,
  measureOutputPhase,
  shouldLogOutputMeasurement,
  shouldLogOutputScrollFrame,
  shouldLogOutputVirtualRange,
} from "@utils/outputPerformance";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to keep auto-scroll pinned.
const DIFF_SPLIT_VIEW_MIN_WIDTH = 1024; // minimum output width before diffs use split view.
const OUTPUT_VIRTUALIZER_OVERSCAN = 8; // normal extra rows rendered above/below viewport; higher is smoother but heavier.
const OUTPUT_ACTIVE_SCROLL_OVERSCAN = 2; // extra rows while fast-scroll placeholders are active; lower reduces work during rapid scroll.
const OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN = 0; // first real-row restore renders only viewport rows; extra rows are staged later.
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN = 3; // distinct from active-scroll overscan so staged restore never re-enters placeholder mode.
const OUTPUT_OVERSCAN_RESTORE_DELAY_MS = 250; // idle time after fast scrolling before placeholders swap back to real rows.
const OUTPUT_SCROLL_SEEK_CONTINUE_DELTA_PX = 16; // scroll delta that keeps placeholder mode alive once it has started.
const OUTPUT_SCROLL_SEEK_SLOW_DELTA_PX = 48; // below this delta, treat scrolling as slowing and use the shorter restore delay.
const OUTPUT_SCROLL_SEEK_SLOW_RESTORE_DELAY_MS = 80; // restore delay while scrolling is slowing, so rows start rendering before a dead stop.
const OUTPUT_SCROLL_SEEK_MIN_DELTA_PX = 300; // minimum single-event movement that can trigger placeholder mode by velocity.
const OUTPUT_SCROLL_SEEK_MIN_VELOCITY_PX_MS = 2; // minimum px/ms velocity for the delta threshold to count as fast scrolling.
const OUTPUT_SCROLL_SEEK_PAGE_FRACTION = 0.9; // viewport fraction moved in one event that always counts as fast scrolling.
const OUTPUT_SCROLL_SEEK_SETTLE_MS = 2000; // time after restore to ignore layout-driven scroll corrections as fast-scroll triggers.
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS = 600; // delay before adding a small buffer after visible rows mount.
const OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS = 1800; // delay before expanding from restore overscan back to normal overscan.
const OUTPUT_USER_SCROLL_INPUT_GRACE_MS = 200; // recent wheel input window that lets real user scrolling bypass settle suppression.
const OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS = 1200; // text rows shorter than this render directly during scroll seek.
const OUTPUT_ROW_RESIZE_SCROLL_SUPPRESS_MS = 300; // time to ignore virtualizer scroll correction after user expands row content.
const LARGE_WORKFLOW_ROW_THRESHOLD = 20; // row count where fast-scroll placeholder behavior is enabled.
const MAX_NAV_ALIGNMENT_ATTEMPTS = 8; // max correction passes when aligning minimap/step navigation.
const MAX_NAVIGATION_STABILIZATION_MS = 1000; // time limit for navigation alignment before accepting the current position.
const DEFAULT_BASH_OUTPUT_EXPANSION_STATE: BashOutputExpansionState = {
  outputExpanded: false,
  errorExpanded: false,
};

interface RowHeightBucketStats {
  sampleCount: number;
  totalMeasured: number;
  totalEstimated: number;
  maxAbsDelta: number;
}

function getMeasuredElementHeight(element: HTMLElement): number {
  return Math.max(
    element.getBoundingClientRect().height,
    element.offsetHeight,
    element.scrollHeight
  );
}

function getResizeObserverEntryHeight(
  entry: ResizeObserverEntry | undefined
): number | null {
  const borderBox = entry?.borderBoxSize?.[0];
  if (borderBox) {
    return borderBox.blockSize;
  }

  const contentBox = entry?.contentBoxSize?.[0];
  if (contentBox) {
    return contentBox.blockSize;
  }

  return entry?.contentRect.height ?? null;
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

function getStepName(
  step: WorkflowStep | null | undefined,
  fallback: string
): string {
  const name = step?.name?.trim();
  return name || fallback;
}

function getQueueStepFallbackName(
  step: WorkflowStep | null | undefined,
  stepIndex: number
): string {
  return step?.type === STEP_TYPES.SCRIPT
    ? `Script ${stepIndex + 1}`
    : `Prompt ${stepIndex + 1}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findRenderedRowElement(
  scrollElement: HTMLDivElement,
  rowIndex: number
): HTMLDivElement | null {
  return scrollElement.querySelector<HTMLDivElement>(
    `[data-index="${rowIndex}"]`
  );
}

function findRenderedRowElementByKey(
  scrollElement: HTMLDivElement,
  rowKey: string
): HTMLDivElement | null {
  return (
    Array.from(
      scrollElement.querySelectorAll<HTMLDivElement>("[data-row-key]")
    ).find((element) => element.dataset.rowKey === rowKey) ?? null
  );
}

function alignRowElementToViewport(
  scrollElement: HTMLDivElement,
  rowElement: HTMLElement,
  align: "start" | "end"
): boolean {
  const containerRect = scrollElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const delta =
    align === "end"
      ? rowRect.bottom - containerRect.bottom
      : rowRect.top - containerRect.top;

  if (Math.abs(delta) < 2) {
    return true;
  }

  const maxScroll = Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.clientHeight
  );
  scrollElement.scrollTop = Math.max(
    0,
    Math.min(maxScroll, scrollElement.scrollTop + delta)
  );
  return false;
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
      return `structured-event:${row.event.type}`;
  }
}

function getScrollSeekRowLabel(row: OutputRenderRow): string {
  switch (row.rowKind) {
    case "structured-event":
      if (row.diff) {
        return row.diff.renderPlan.viewType === "split"
          ? "Diff"
          : "Unified diff";
      }
      if (row.toolCall) {
        return "Tool call";
      }
      return row.event.type;
    case "cli-header":
      return row.stepLabel;
    case "cli-command":
      return "Command";
    case "plain-response":
      return "Response";
    case "prompt":
      return "Prompt";
    case "status":
      return "Status";
    case "stats":
      return "Stats";
    case "error":
      return "Error";
    case "history-banner":
      return "History";
    case "step-anchor":
      return "Step";
    case "final-step-label":
      return row.label;
  }
}

function shouldRenderScrollSeekPlaceholder(row: OutputRenderRow): boolean {
  switch (row.rowKind) {
    case "plain-response":
      return row.text.length >= OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS;
    case "structured-event":
      if (row.diff || row.toolCall) {
        return true;
      }

      switch (row.event.type) {
        case CLI_EVENT_TYPES.BASH_COMMAND:
        case CLI_EVENT_TYPES.FILE_EDIT:
        case CLI_EVENT_TYPES.FILE_WRITE:
        case CLI_EVENT_TYPES.FILE_READ:
        case CLI_EVENT_TYPES.FILE_DELETE:
        case CLI_EVENT_TYPES.MCP_TOOL_CALL:
        case CLI_EVENT_TYPES.TOOL_CALL:
        case CLI_EVENT_TYPES.TOOL_RESULT:
          return true;
        case CLI_EVENT_TYPES.TEXT:
        case CLI_EVENT_TYPES.THINKING: {
          const data = row.event.data as { text?: string };
          return (
            (data.text?.length ?? 0) >=
            OUTPUT_SCROLL_SEEK_TEXT_PLACEHOLDER_MIN_CHARS
          );
        }
        default:
          return false;
      }
    default:
      return false;
  }
}

const OutputScrollSeekPlaceholder: React.FC<{
  row: OutputRenderRow;
  height: number;
}> = ({ row, height }) => (
  <div
    className="px-2 py-1 text-[length:var(--fp-output-font-size-xs)] text-description-fg"
    style={{
      height: `${Math.max(1, height)}px`,
      contain: "layout paint style",
    }}
  >
    <div className="h-full min-h-6 rounded border border-panel-border bg-sidebar-bg/40 px-2 py-1 overflow-hidden">
      <span className="opacity-80">
        Rendering {getScrollSeekRowLabel(row)}...
      </span>
    </div>
  </div>
);

interface MinimapDialogState {
  mode: "undo" | "redo";
  target: UndoExecutionTarget;
  workspacePath: string;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
  requestId: string;
}

interface WorkflowDialogState {
  mode: "undo" | "redo";
  workspacePath: string;
  entries: WorkflowStepEntry[];
  requestId: string;
}

interface PendingNavigationState {
  rowIndex: number;
  align: "start" | "end";
  targetKind: OutputMessage["target"]["kind"];
  targetIndex: number;
  requestedBehavior: ScrollBehavior;
  effectiveBehavior: ScrollBehavior;
  startedAt: number;
  lastMeasuredVersion: number;
  lastMeasurementChangeAt: number;
  attempts: number;
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
export const OutputSection: React.FC = () => {
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
  const previousDiffResetVersion = useRef(diffResetVersion);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [diffCollapseState, setDiffCollapseState] = useState<
    Map<string, boolean>
  >(new Map());
  const [diffExpansionState, setDiffExpansionState] = useState<
    Map<string, DiffGapExpansionState>
  >(new Map());
  const [toolCallExpansionState, setToolCallExpansionState] = useState<
    Map<string, ToolCallExpansionState>
  >(new Map());
  const [bashExpansionState, setBashExpansionState] = useState<
    Map<string, BashOutputExpansionState>
  >(new Map());
  const [outputDiffViewType, setOutputDiffViewType] = useState<
    "split" | "unified"
  >("split");
  const [outputContentWidth, setOutputContentWidth] = useState(0);
  const [navigationPendingRowIndex, setNavigationPendingRowIndex] = useState<
    number | null
  >(null);
  const [outputOverscan, setOutputOverscan] = useState(
    OUTPUT_VIRTUALIZER_OVERSCAN
  );
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
  const measurementVersionFrameRef = useRef<number | null>(null);
  const overscanRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const fullOverscanRestoreTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const pendingNavigationRef = useRef<PendingNavigationState | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const lastScrollEventAtRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastVirtualRangeRef = useRef<string>("");
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

  // Shared prompt-level undo/redo dialog (owned here, triggered from minimap)
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);

  // Workflow-level undo/redo dialog (aggregates all prompt-level changes)
  const [workflowDialogState, setWorkflowDialogState] =
    useState<WorkflowDialogState | null>(null);

  // Export modal state
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportIncludeCommand, setExportIncludeCommand] = useState(true);
  const [exportIncludeMetadata, setExportIncludeMetadata] = useState(true);
  const [exportStepRange, setExportStepRange] = useState("");
  const [exportStepRangeError, setExportStepRangeError] = useState(false);

  // Keep --run-selector-max-h in sync with the output section height so the
  // RunSelector dropdown never overflows the panel boundary.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const headerH = 30; // matches the h-[30px] header
      const available = el.clientHeight - headerH - 8; // 8px breathing room
      el.style.setProperty(
        "--run-selector-max-h",
        `${Math.max(80, available)}px`
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build chronologically sorted list of all messages from the single ordered entries array.
  const allMessages = useMemo((): OutputMessage[] => {
    if (isViewingHistory && historyOutputs) {
      return mapOrderedHistoryEntriesToMessages(historyOutputs.orderedEntries);
    }
    return mapOrderedHistoryEntriesToMessages(liveOrderedEntries);
  }, [isViewingHistory, historyOutputs, liveOrderedEntries]);

  const isExecutionActive =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

  const {
    rows,
    uniqueStepTargets,
    stepOutputsMap,
    lastCliIndexPerStep,
    firstRowIndexByTarget,
  } = useMemo(
    () =>
      measureOutputPhase(
        "buildOutputRows",
        {
          messages: allMessages.length,
          steps: steps.length,
          history: isViewingHistory,
          outputContentWidth,
          outputFontSize,
        },
        () =>
          buildOutputRows({
            allMessages,
            steps,
            finalStep,
            streamingChunks,
            finalStepStreamingChunks,
            isExecutionActive,
            allowUndoActions:
              isViewingHistory ||
              !(
                executionState === EXECUTION_STATES.RUNNING ||
                executionState === EXECUTION_STATES.CANCELLING
              ),
            isViewingHistory,
            historyOutputs,
            workspaceSnapshots,
            finalStepWorkspaceSnapshots,
            undoRecords,
            diffCollapseState,
            diffExpansionState,
            toolCallExpansionState,
            defaultDiffCollapsed: diffsCollapsed,
            diffViewType: outputDiffViewType,
            outputFontSize,
            outputContentWidth,
          })
      ),
    [
      allMessages,
      steps,
      finalStep,
      streamingChunks,
      finalStepStreamingChunks,
      isExecutionActive,
      isViewingHistory,
      historyOutputs,
      workspaceSnapshots,
      finalStepWorkspaceSnapshots,
      undoRecords,
      diffCollapseState,
      diffExpansionState,
      toolCallExpansionState,
      diffsCollapsed,
      outputDiffViewType,
      outputFontSize,
      outputContentWidth,
      executionState,
    ]
  );

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
        0.75,
        bucket.startsWith("structured-event:diff:") ? 3.5 : 3
      );
      const rawScaled = Math.round(baseEstimate * clampedScale * 100) / 100;
      if (bucket.startsWith("structured-event:diff:")) {
        return Math.max(baseEstimate, rawScaled);
      }
      // Cap the bucket correction at +200px for non-diff rows. The scale factor is
      // derived from a mix of row sizes; small rows with many short paragraphs produce
      // high scale factors that would wildly overestimate large text-heavy rows if
      // applied proportionally.
      return clamp(rawScaled, baseEstimate, baseEstimate + 200);
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
      details?: Record<string, unknown>
    ) => {
      if (outputOverscanRef.current === overscan) {
        return;
      }

      const now = performance.now();
      const wasScrollSeeking =
        outputOverscanRef.current === OUTPUT_ACTIVE_SCROLL_OVERSCAN;
      const isScrollSeeking = overscan === OUTPUT_ACTIVE_SCROLL_OVERSCAN;
      outputOverscanRef.current = overscan;
      setOutputOverscan(overscan);
      if (isScrollSeeking && !wasScrollSeeking) {
        scrollSeekStartedAtRef.current = now;
        scrollSeekRestoreRequestedAtRef.current = null;
      } else if (!isScrollSeeking && wasScrollSeeking) {
        scrollSeekRestoreRequestedAtRef.current = now;
      }
      logOutputProfilerEvent("adaptiveOverscan", {
        overscan,
        reason,
        scrollSeekDurationMs:
          !isScrollSeeking && scrollSeekStartedAtRef.current != null
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

      overscanRestoreTimerRef.current = setTimeout(() => {
        overscanRestoreTimerRef.current = null;
        setOutputOverscanMode(OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN, "idle", {
          phase: "restore-visible-rows",
        });
      }, delayMs ?? OUTPUT_OVERSCAN_RESTORE_DELAY_MS);
    },
    [setOutputOverscanMode]
  );
  const enterFastScrollOverscan = useCallback(
    (details: Record<string, unknown>) => {
      setOutputOverscanMode(
        OUTPUT_ACTIVE_SCROLL_OVERSCAN,
        "fast-scroll",
        details
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
        Math.abs(previousHeight - nextHeight) < 0.5
      ) {
        if (startedAt > 0) {
          const durationMs = performance.now() - startedAt;
          if (shouldLogOutputMeasurement(durationMs)) {
            logOutputProfilerEvent("rowMeasurement:unchanged", {
              index,
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
      if (startedAt > 0) {
        const durationMs = performance.now() - startedAt;
        if (shouldLogOutputMeasurement(durationMs)) {
          logOutputProfilerEvent("rowMeasurement:updated", {
            index,
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
  // shouldAdjustScrollPositionOnItemSizeChange is a writable instance property
  // (not a constructor option) on Virtualizer. Suppress scroll corrections
  // during active navigation and for 1 s after to prevent TanStack from
  // adjusting the scroll for measured rows above the viewport, which amplifies
  // reconcileScroll oscillations.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
    pendingNavigationRef.current === null &&
    !postNavSettlingRef.current &&
    (scrollSeekSettlingUntilRef.current == null ||
      performance.now() >= scrollSeekSettlingUntilRef.current) &&
    (rowResizeScrollSuppressUntilRef.current == null ||
      performance.now() >= rowResizeScrollSuppressUntilRef.current) &&
    item.start < (outputRef.current?.scrollTop ?? 0);

  // React 19 ref callbacks can return a cleanup function.
  // TanStack Virtual owns the ResizeObserver. Our measureElement override above
  // consumes its entries, updates FlightPath's measurement cache, and avoids a
  // second observer plus duplicate DOM layout reads for already-mounted rows.
  const measureRowElement = useCallback(
    (element: HTMLDivElement | null): void | (() => void) => {
      if (!element) return;
      rowVirtualizer.measureElement(element);
      return () => rowVirtualizer.measureElement(null);
    },
    [rowVirtualizer]
  );

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
          let fallbackOffset = 0;
          const rowStartsByIndex: number[] = [];
          const rowStartsByKey = new Map<string, number>();
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
          };
        }
      ),
    [
      getEstimatedRowHeight,
      rows,
      measurementVersion,
      outputContentWidth,
      outputFontSize,
      outputOverscan,
      rowVirtualizer,
    ]
  );
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;

    const updateDiffViewType = () => {
      const width = el.getBoundingClientRect().width;
      setOutputContentWidth((prev) => {
        if (Math.abs(prev - width) < 0.5) {
          return prev;
        }
        return width;
      });
      const nextDiffViewType =
        width >= DIFF_SPLIT_VIEW_MIN_WIDTH ? "split" : "unified";
      setOutputDiffViewType((prev) => {
        if (prev === nextDiffViewType) return prev;
        return nextDiffViewType;
      });
    };

    updateDiffViewType();
    const observer = new ResizeObserver(updateDiffViewType);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeOutputTab, outputCollapsed]);

  useEffect(() => {
    if (outputContentWidth <= 0) {
      return;
    }
    measurementCacheRef.current.clear();
    rowHeightBucketStatsRef.current.clear();
    rowVirtualizer.measure();
    setMeasurementVersion((version) => version + 1);
  }, [outputContentWidth, outputDiffViewType, outputFontSize, rowVirtualizer]);

  const stepScrollFractions = useMemo(() => {
    return measureOutputPhase(
      "stepScrollFractions",
      { targets: uniqueStepTargets.length, rows: rows.length },
      () => {
        const fractions = new Map<string, number>();
        const totalSize = Math.max(1, rowLayout.totalSize);

        for (const target of uniqueStepTargets) {
          const targetKey = `${target.kind}:${target.index}`;
          const rowIndex = firstRowIndexByTarget.get(targetKey);
          if (rowIndex === undefined) continue;
          fractions.set(
            targetKey,
            rowLayout.rowStartsByIndex[rowIndex] / totalSize
          );
        }

        return fractions;
      }
    );
  }, [firstRowIndexByTarget, rowLayout, rows.length, uniqueStepTargets]);

  const hasDiffRows = useMemo(
    () =>
      rows.some(
        (row) => row.rowKind === "structured-event" && row.diff !== undefined
      ),
    [rows]
  );

  const anyDiffCollapsed = useMemo(
    () =>
      hasDiffRows &&
      rows.some(
        (row) =>
          row.rowKind === "structured-event" && row.diff?.isCollapsed === true
      ),
    [hasDiffRows, rows]
  );

  useEffect(() => {
    const diffKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" && row.diff ? [row.diff.key] : []
      )
    );
    const toolCallRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" && row.toolCall ? [row.key] : []
      )
    );
    const bashRowKeys = new Set(
      rows.flatMap((row) =>
        row.rowKind === "structured-event" &&
        row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
          ? [row.key]
          : []
      )
    );

    setDiffCollapseState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!diffKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      for (const key of diffKeys) {
        if (!next.has(key)) {
          next.set(key, diffsCollapsed);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setDiffExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!diffKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setToolCallExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!toolCallRowKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setBashExpansionState((previous) => {
      let changed = false;
      const next = new Map(previous);

      for (const key of [...next.keys()]) {
        if (!bashRowKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [rows, diffsCollapsed]);

  useEffect(() => {
    if (previousDiffResetVersion.current === diffResetVersion) {
      return;
    }
    previousDiffResetVersion.current = diffResetVersion;

    // Diff row heights change dramatically between expanded and collapsed states.
    // Stale measured heights from the previous state would misalign minimap
    // positions, so flush the cache before the collapse-state change propagates.
    measurementCacheRef.current.clear();
    setDiffExpansionState((previous) =>
      previous.size === 0 ? previous : new Map()
    );

    setDiffCollapseState((previous) => {
      if (previous.size === 0) return previous;
      const next = new Map(previous);
      for (const key of next.keys()) {
        next.set(key, diffsCollapsed);
      }
      return next;
    });
  }, [diffResetVersion, diffsCollapsed]);

  // When switching between live output and a history run (including when the
  // history run index changes), the same row keys can appear with very different
  // heights — e.g., a row measured as 500 px during a live run where diffs were
  // expanded will still be in the cache when the same run is opened in history
  // view with diffs collapsed (74 px estimate).  Flush the cache so rowLayout
  // re-estimates from scratch for the incoming content.
  const previousIsViewingHistory = useRef(isViewingHistory);
  const previousViewingRunIndex = useRef(viewingRunIndex);
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
    const startedAt = performance.now();
    const now = startedAt;
    const previousScrollEventAt = lastScrollEventAtRef.current;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollEventAtRef.current = now;
    lastScrollTopRef.current = el.scrollTop;
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
          scrollSeekPlaceholder:
            outputOverscanRef.current === OUTPUT_ACTIVE_SCROLL_OVERSCAN,
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
        scrollSeekPlaceholder:
          outputOverscanRef.current === OUTPUT_ACTIVE_SCROLL_OVERSCAN,
        totalRows: rowsRef.current.length,
      });
    }
  }, [enterFastScrollOverscan, rowVirtualizer, scheduleOverscanRestore]);

  const clearNavigationFrame = useCallback(() => {
    if (navigationFrameRef.current != null) {
      cancelAnimationFrame(navigationFrameRef.current);
      navigationFrameRef.current = null;
    }
  }, []);

  const finalizePendingNavigation = useCallback(() => {
    clearNavigationFrame();
    pendingNavigationRef.current = null;
    setNavigationPendingRowIndex(null);
    isProgrammaticScroll.current = false;

    // Settle TanStack Virtual's internal reconcileScroll loop immediately.
    // scrollToIndex leaves an active scrollState that keeps re-calculating the
    // target row position on every animation frame for up to 5 s. By calling
    // scrollToOffset with the confirmed landing position, we replace the
    // index-based scrollState with an offset-based one whose targetOffset ≈
    // scrollOffset, satisfying approxEqual on the next rAF so reconcileScroll
    // clears scrollState and stops issuing corrective scrolls.
    const landingScrollTop = outputRef.current?.scrollTop ?? 0;
    rowVirtualizer.scrollToOffset(landingScrollTop, { behavior: "auto" });

    // Start the post-navigation settling window. During this window
    // shouldAdjustScrollPositionOnItemSizeChange returns false, preventing
    // TanStack Virtual from issuing scroll corrections as newly-rendered rows
    // near the destination get measured. Without this, correction feedback
    // loops cause the scroll position to oscillate for several seconds.
    postNavSettlingRef.current = true;
    if (postNavSettlingTimerRef.current !== null) {
      clearTimeout(postNavSettlingTimerRef.current);
    }
    postNavSettlingTimerRef.current = setTimeout(() => {
      postNavSettlingRef.current = false;
      postNavSettlingTimerRef.current = null;
    }, 1000);
  }, [clearNavigationFrame, rowVirtualizer]);

  const schedulePendingNavigationStabilization = useCallback(() => {
    clearNavigationFrame();
    navigationFrameRef.current = requestAnimationFrame(() => {
      navigationFrameRef.current = null;
      const pending = pendingNavigationRef.current;
      if (!pending) {
        return;
      }

      const now = performance.now();
      const currentMeasurementVersion = measurementVersionRef.current;
      if (currentMeasurementVersion !== pending.lastMeasuredVersion) {
        pending.lastMeasuredVersion = currentMeasurementVersion;
        pending.lastMeasurementChangeAt = now;
      }

      const scrollElement = outputRef.current;
      if (!scrollElement) {
        finalizePendingNavigation();
        return;
      }

      const rowElement = findRenderedRowElement(
        scrollElement,
        pending.rowIndex
      );
      if (!rowElement) {
        if (
          pending.attempts >= MAX_NAV_ALIGNMENT_ATTEMPTS ||
          now - pending.startedAt >= MAX_NAVIGATION_STABILIZATION_MS
        ) {
          finalizePendingNavigation();
          return;
        }

        pending.attempts += 1;
        rowVirtualizer.scrollToIndex(pending.rowIndex, {
          align: pending.align,
          behavior: "auto",
        });
        schedulePendingNavigationStabilization();
        return;
      }

      const isAligned = alignRowElementToViewport(
        scrollElement,
        rowElement,
        pending.align
      );
      if (isAligned) {
        // Finalize immediately on first aligned frame. Calling scrollToOffset
        // below clears TanStack's reconcileScroll scrollState, preventing
        // further corrective scrolls. The 1-s postNavSettling window then
        // blocks shouldAdjustScrollPositionOnItemSizeChange so late-arriving
        // measurements cannot shift the viewport away from the target.
        finalizePendingNavigation();
        return;
      }

      if (
        pending.attempts >= MAX_NAV_ALIGNMENT_ATTEMPTS ||
        now - pending.startedAt >= MAX_NAVIGATION_STABILIZATION_MS
      ) {
        finalizePendingNavigation();
        return;
      }

      pending.attempts += 1;
      rowVirtualizer.scrollToIndex(pending.rowIndex, {
        align: pending.align,
        behavior: "auto",
      });
      schedulePendingNavigationStabilization();
    });
  }, [clearNavigationFrame, finalizePendingNavigation, rowVirtualizer]);

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
    isProgrammaticScroll.current = true;
    rowVirtualizer.scrollToIndex(rows.length - 1, { align: "end" });
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
    rowVirtualizer,
  ]);

  useEffect(() => {
    if (activeOutputTab !== "output" || outputCollapsed) {
      return;
    }

    requestAnimationFrame(() => {
      rowVirtualizer.measure();
    });
  }, [activeOutputTab, outputCollapsed, rowVirtualizer, rows.length]);

  useEffect(() => {
    if (navigationPendingRowIndex == null) {
      return;
    }
    // Only schedule if no frame is already pending. The existing frame will
    // read the latest measurement state when it fires. Without this guard,
    // continuous measurements perpetually cancel + reschedule the rAF,
    // delaying the alignment check for as long as measurements arrive.
    if (navigationFrameRef.current === null) {
      schedulePendingNavigationStabilization();
    }
  }, [
    measurementVersion,
    navigationPendingRowIndex,
    schedulePendingNavigationStabilization,
  ]);

  // Export: open the options modal
  const handleExport = useCallback(() => {
    setExportModalOpen(true);
  }, []);

  // Count unique CLI steps for use in the export modal range hint
  const totalCliSteps = useMemo(() => {
    const seen = new Set<string>();
    for (const msg of allMessages) {
      if (msg.type === "cli")
        seen.add(`${msg.target.kind}:${msg.target.index}`);
    }
    return seen.size;
  }, [allMessages]);

  // Build the export messages array (shared between preview and confirm)
  const buildExportMessages = useCallback(
    () =>
      allMessages.map((msg) => ({
        type: msg.type,
        target: msg.target,
        timestamp: msg.timestamp,
        sequence: msg.sequence,
        data: msg.data,
        attemptIndex: msg.attemptIndex,
        runIndex: msg.runIndex,
        stepName:
          msg.type === "cli"
            ? msg.target.kind === FINAL_STEP_PHASES.FINAL_STEP
              ? finalStep?.name?.trim() || undefined
              : steps[msg.target.index]?.name?.trim() || undefined
            : undefined,
      })),
    [allMessages, finalStep?.name, steps]
  );

  // Export confirm: generate markdown with current options and trigger save/download
  const handleExportConfirm = useCallback(() => {
    let parsedRange: number[] | undefined;
    if (exportStepRange.trim()) {
      const parsed = parseRangeNotation(exportStepRange);
      if (!parsed) {
        setExportStepRangeError(true);
        return;
      }
      parsedRange = parsed;
    }

    const exportOptions: ExportOptions = {
      includeCommand: exportIncludeCommand,
      includeMetadata: exportIncludeMetadata,
      stepRange: parsedRange,
    };

    const markdownContent = generateMarkdownExport(
      buildExportMessages(),
      {
        fileName: fileName || "Unknown",
        executionState,
        currentStep,
        totalSteps,
      },
      {
        orderedEntries:
          isViewingHistory && historyOutputs?.orderedEntries?.length
            ? historyOutputs.orderedEntries
            : undefined,
        exportOptions,
      }
    );

    setExportModalOpen(false);

    if (isStandalone) {
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName ?? "output"}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const vscode = getVsCodeApi();
    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName,
    });
  }, [
    buildExportMessages,
    currentStep,
    executionState,
    exportIncludeCommand,
    exportIncludeMetadata,
    exportStepRange,
    fileName,
    historyOutputs,
    isViewingHistory,
    totalSteps,
  ]);

  const navigationController = useMemo(
    () => ({
      scrollToTarget: (
        target: OutputMessage["target"],
        options?: { behavior?: ScrollBehavior; align?: "start" | "end" }
      ) => {
        const rowIndex = firstRowIndexByTarget.get(
          `${target.kind}:${target.index}`
        );
        if (rowIndex === undefined || !outputRef.current) {
          return;
        }

        autoscrollEnabled.current = false;
        isProgrammaticScroll.current = true;
        const align = options?.align ?? "start";
        const requestedBehavior = options?.behavior ?? "auto";
        const behavior =
          requestedBehavior === "smooth" ? "auto" : requestedBehavior;
        const startedAt = performance.now();
        pendingNavigationRef.current = {
          rowIndex,
          align,
          targetKind: target.kind,
          targetIndex: target.index,
          requestedBehavior,
          effectiveBehavior: behavior,
          startedAt,
          lastMeasuredVersion: measurementVersionRef.current,
          lastMeasurementChangeAt: startedAt,
          attempts: 0,
        };
        setNavigationPendingRowIndex(rowIndex);

        // Do NOT call rowVirtualizer.measure() here. Clearing itemSizeCache
        // forces TanStack to re-estimate all rows from bucket estimates, which
        // destabilizes getOffsetForIndex and prolongs the reconcileScroll loop.
        rowVirtualizer.scrollToIndex(rowIndex, { align, behavior });
        schedulePendingNavigationStabilization();
      },
      getTargetScrollFraction: (target: OutputMessage["target"]) => {
        const rowIndex = firstRowIndexByTarget.get(
          `${target.kind}:${target.index}`
        );
        const totalSize = Math.max(1, rowLayout.totalSize);
        if (rowIndex === undefined || totalSize <= 0) {
          return null;
        }

        return rowLayout.rowStartsByIndex[rowIndex] / totalSize;
      },
    }),
    [
      firstRowIndexByTarget,
      rowLayout,
      rowVirtualizer,
      schedulePendingNavigationStabilization,
    ]
  );

  useEffect(() => {
    setActiveOutputNavigationController(navigationController);
    return () => {
      setActiveOutputNavigationController(null);
    };
  }, [navigationController]);

  useEffect(
    () => () => {
      clearNavigationFrame();
      pendingNavigationRef.current = null;
    },
    [clearNavigationFrame]
  );

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

  // Check if there's any output
  const hasOutput = rows.length > 0;
  const isOutputScrollSeeking =
    outputOverscan === OUTPUT_ACTIVE_SCROLL_OVERSCAN;
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!shouldLogOutputVirtualRange()) {
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
    navigationPendingRowIndex != null &&
    virtualRows.some((row) => row.index === navigationPendingRowIndex);
  // The overlay is a global navigation/empty-range affordance. Scroll-seek
  // placeholders are different: they replace expensive row DOM while the user
  // is actively scrolling, so avoid stacking the global overlay on top of them.
  const showVirtualizationOverlay =
    !isOutputScrollSeeking &&
    ((hasOutput &&
      rows.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
      virtualRows.length === 0) ||
      (navigationPendingRowIndex !== null && !isNavigationTargetVirtualized));

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
    if (fullOverscanRestoreTimerRef.current !== null) {
      clearTimeout(fullOverscanRestoreTimerRef.current);
    }
    if (outputOverscanRef.current === OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN) {
      fullOverscanRestoreTimerRef.current = setTimeout(() => {
        setOutputOverscanMode(OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN, "idle", {
          phase: "restore-buffer-overscan",
        });

        fullOverscanRestoreTimerRef.current = setTimeout(() => {
          fullOverscanRestoreTimerRef.current = null;
          setOutputOverscanMode(OUTPUT_VIRTUALIZER_OVERSCAN, "idle", {
            phase: "restore-full-overscan",
          });
        }, OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS);
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

  // ── Workflow-level undo/redo aggregation ───────────────────────────────────
  // Iterates all steps to collect entries for the workflow undo/redo dialog.
  const workflowUndoRedoData = useMemo(() => {
    if (!allowUndoActions)
      return { undoEntries: [], redoEntries: [], workspacePath: "" };

    const undoEntries: WorkflowStepEntry[] = [];
    const redoEntries: WorkflowStepEntry[] = [];
    let workspacePath = "";

    for (const msgTarget of uniqueStepTargets) {
      const key = `${msgTarget.kind}:${msgTarget.index}`;
      const lastCliIdx = lastCliIndexPerStep.get(key);
      if (lastCliIdx === undefined) continue;

      const lastMsg = allMessages[lastCliIdx];
      const lastOutput = lastMsg?.data as CliOutputType | undefined;
      if (!lastOutput || lastOutput.isStreaming) continue;

      if (lastOutput.workingDirectory)
        workspacePath = lastOutput.workingDirectory;

      const isFinalStep = msgTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
      const stepIndex = msgTarget.index;

      let effectiveSnapshot: WorkspaceSnapshot | undefined;
      let effectiveUndoRecord: UndoRecord | undefined;

      if (isViewingHistory && historyOutputs) {
        effectiveSnapshot = isFinalStep
          ? historyOutputs.finalStepOutputs?.[stepIndex]?.workspaceSnapshot
          : historyOutputs.promptOutputs[stepIndex]?.workspaceSnapshot;
        effectiveUndoRecord = isFinalStep
          ? historyOutputs.finalStepOutputs?.[stepIndex]?.undoRecord
          : historyOutputs.promptOutputs[stepIndex]?.undoRecord;
      } else {
        const targetKey = isFinalStep
          ? `finalStep-${stepIndex}`
          : `queue-${stepIndex}`;
        effectiveSnapshot = isFinalStep
          ? finalStepWorkspaceSnapshots[stepIndex]
          : workspaceSnapshots[stepIndex];
        effectiveUndoRecord = undoRecords[targetKey];
      }

      const stepOutputs = (stepOutputsMap.get(key) ?? []) as CliOutputType[];
      const undoTarget: UndoExecutionTarget = isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };
      const label = isFinalStep
        ? `Final Step Loop ${stepIndex + 1}`
        : `Prompt ${stepIndex + 1}`;

      const redoInstructions =
        effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
          ? (effectiveUndoRecord.redoInstructions ?? [])
          : [];

      // Redo entry: files previously undone that can be re-applied
      if (redoInstructions.length > 0) {
        redoEntries.push({ target: undoTarget, label, redoInstructions });
      }

      // Undo entry: undoable candidates excluding already-undone files
      const allCandidates = buildUndoCandidatesForOutputs(
        stepOutputs,
        effectiveSnapshot
      );
      const candidates =
        redoInstructions.length > 0
          ? allCandidates.filter(
              (c) =>
                !redoInstructions.some((ri) => sameFilePath(c.path, ri.path))
            )
          : allCandidates;
      const undoCandidates = candidates.filter((c) => c.instruction !== null);
      if (undoCandidates.length > 0) {
        undoEntries.push({ target: undoTarget, label, undoCandidates });
      }
    }

    return { undoEntries, redoEntries, workspacePath };
  }, [
    allowUndoActions,
    uniqueStepTargets,
    lastCliIndexPerStep,
    allMessages,
    stepOutputsMap,
    isViewingHistory,
    historyOutputs,
    workspaceSnapshots,
    finalStepWorkspaceSnapshots,
    undoRecords,
  ]);
  const showCompactWorkflowUndoRedoLabels =
    workflowUndoRedoData.undoEntries.length > 0 &&
    workflowUndoRedoData.redoEntries.length > 0;
  const useCompactOutputHeaderLabels =
    isHeaderNarrow || showCompactWorkflowUndoRedoLabels;

  // ── Minimap steps array ────────────────────────────────────────────────────
  const minimapSteps = useMemo((): MinimapStep[] => {
    return measureOutputPhase(
      "minimapSteps",
      {
        targets: uniqueStepTargets.length,
        rows: rows.length,
        totalSize: rowLayout.totalSize,
      },
      () => {
        const totalSize = Math.max(1, rowLayout.totalSize);

        return uniqueStepTargets.flatMap((msgTarget) => {
          const key = `${msgTarget.kind}:${msgTarget.index}`;
          const firstRowIndex = firstRowIndexByTarget.get(key);
          if (firstRowIndex === undefined) return [];

          const kind = msgTarget.kind;
          const stepIndex = msgTarget.index;
          const isFinalStep = kind === FINAL_STEP_PHASES.FINAL_STEP;
          const workflowStep = isFinalStep ? finalStep : steps[stepIndex];
          const label = isFinalStep
            ? getStepName(workflowStep, `Final Step Loop ${stepIndex + 1}`)
            : getStepName(
                workflowStep,
                getQueueStepFallbackName(workflowStep, stepIndex)
              );
          const scrollFraction =
            stepScrollFractions.get(key) ??
            rowLayout.rowStartsByIndex[firstRowIndex] / totalSize;
          const diffBlocks: MinimapDiffBlock[] = rows.flatMap((row) => {
            if (
              row.rowKind !== "structured-event" ||
              row.target?.kind !== msgTarget.kind ||
              row.target?.index !== msgTarget.index ||
              !row.diff
            ) {
              return [];
            }

            return [
              {
                key: row.diff.key,
                rowKey: row.key,
                scrollFraction:
                  (rowLayout.rowStartsByKey.get(row.key) ?? 0) / totalSize,
                heightFraction:
                  estimateOutputDiffBlockHeight(row, outputFontSize) /
                  totalSize,
                addedLines: row.diff.addedLines,
                removedLines: row.diff.removedLines,
                runs: row.diff.runs,
                isCollapsed: row.diff.isCollapsed,
              },
            ];
          });

          const noActions: MinimapStep["undoActions"] = {
            undo: null,
            redo: null,
          };
          const stepOutputs = stepOutputsMap.get(key) ?? [];

          if (!allowUndoActions) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const lastCliIdx = lastCliIndexPerStep.get(key);
          if (lastCliIdx === undefined) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const lastMsg = allMessages[lastCliIdx];
          const lastOutput = lastMsg?.data as CliOutputType | undefined;
          if (!lastOutput || lastOutput.isStreaming) {
            return [
              {
                key,
                kind,
                stepIndex,
                firstMessageIndex: firstRowIndex,
                scrollFraction,
                label,
                undoActions: noActions,
                diffBlocks,
              },
            ];
          }

          const undoTarget: UndoExecutionTarget = isFinalStep
            ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
            : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };

          let effectiveSnapshot: WorkspaceSnapshot | undefined;
          let effectiveUndoRecord: UndoRecord | undefined;

          if (isViewingHistory && historyOutputs) {
            effectiveSnapshot = isFinalStep
              ? historyOutputs.finalStepOutputs?.[stepIndex]?.workspaceSnapshot
              : historyOutputs.promptOutputs[stepIndex]?.workspaceSnapshot;
            effectiveUndoRecord = isFinalStep
              ? historyOutputs.finalStepOutputs?.[stepIndex]?.undoRecord
              : historyOutputs.promptOutputs[stepIndex]?.undoRecord;
          } else {
            effectiveSnapshot = isFinalStep
              ? finalStepWorkspaceSnapshots[stepIndex]
              : workspaceSnapshots[stepIndex];
            effectiveUndoRecord =
              undoRecords[
                isFinalStep ? `finalStep-${stepIndex}` : `queue-${stepIndex}`
              ];
          }

          const workspacePath = lastOutput.workingDirectory ?? "";
          const actions = computePromptUndoActions(
            stepOutputs,
            effectiveUndoRecord,
            effectiveSnapshot
          );

          const undoActions: MinimapStep["undoActions"] = {
            redo: actions.redo
              ? {
                  label: actions.redo.label,
                  onTrigger: () => {
                    setMinimapDialogState({
                      mode: "redo",
                      target: undoTarget,
                      workspacePath,
                      redoInstructions: effectiveUndoRecord?.redoInstructions,
                      requestId: generateId(),
                    });
                  },
                }
              : null,
            undo: actions.undo
              ? {
                  label: actions.undo.label,
                  onTrigger: () => {
                    const alreadyUndone =
                      effectiveUndoRecord != null &&
                      effectiveUndoRecord.isRedone !== true
                        ? effectiveUndoRecord.redoInstructions
                        : undefined;
                    const input = buildUndoDialogInputForPrompt(
                      undoTarget,
                      stepOutputs,
                      effectiveSnapshot,
                      workspacePath,
                      alreadyUndone
                    );
                    setMinimapDialogState({
                      mode: "undo",
                      target: undoTarget,
                      workspacePath,
                      input,
                      requestId: generateId(),
                    });
                  },
                }
              : null,
          };

          return [
            {
              key,
              kind,
              stepIndex,
              firstMessageIndex: firstRowIndex,
              scrollFraction,
              label,
              undoActions,
              diffBlocks,
            },
          ];
        });
      }
    );
  }, [
    allMessages,
    allowUndoActions,
    finalStep,
    finalStepWorkspaceSnapshots,
    firstRowIndexByTarget,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
    outputFontSize,
    rowLayout,
    rows,
    stepOutputsMap,
    stepScrollFractions,
    steps,
    undoRecords,
    uniqueStepTargets,
    workspaceSnapshots,
  ]);

  const handleBackToLive = useCallback(() => {
    useWorkflowStore.getState().clearHistoryOutputs();
    useUiStore.getState().clearHistoryView();
  }, []);

  const handlePromptUndo = useCallback((row: CliHeaderRow) => {
    if (!row.promptUndo) return;
    const target: UndoExecutionTarget = row.isFinalStep
      ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.stepIndex }
      : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.stepIndex };
    const alreadyUndone =
      row.promptUndo.undoRecord != null &&
      row.promptUndo.undoRecord.isRedone !== true
        ? row.promptUndo.undoRecord.redoInstructions
        : undefined;
    const input = buildUndoDialogInputForPrompt(
      target,
      row.promptUndo.allStepOutputs,
      row.promptUndo.workspaceSnapshot,
      row.promptUndo.workspacePath,
      alreadyUndone
    );
    setMinimapDialogState({
      mode: "undo",
      target,
      workspacePath: row.promptUndo.workspacePath,
      input,
      requestId: generateId(),
    });
  }, []);

  const handlePromptRedo = useCallback((row: CliHeaderRow) => {
    if (!row.promptUndo?.undoRecord?.redoInstructions?.length) return;
    const target: UndoExecutionTarget = row.isFinalStep
      ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.stepIndex }
      : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.stepIndex };
    setMinimapDialogState({
      mode: "redo",
      target,
      workspacePath: row.promptUndo.workspacePath,
      redoInstructions: row.promptUndo.undoRecord.redoInstructions,
      requestId: generateId(),
    });
  }, []);

  const handleFileUndo = useCallback(
    (row: StructuredEventRow, request: OutputRowFileUndoRequest) => {
      const target: UndoExecutionTarget =
        row.target.kind === FINAL_STEP_PHASES.FINAL_STEP
          ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: row.target.index }
          : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: row.target.index };
      const stepOutputs = stepOutputsMap.get(
        `${row.target.kind}:${row.target.index}`
      );
      const workspacePath =
        stepOutputs && stepOutputs.length > 0
          ? (stepOutputs[stepOutputs.length - 1]?.workingDirectory ?? "")
          : "";
      const showRedo =
        row.undoRecord != null && row.undoRecord.isRedone !== true;

      if (showRedo) {
        const fileRedoInstruction = row.undoRecord?.redoInstructions.find(
          (item) => sameFilePath(item.path, request.path)
        );
        if (fileRedoInstruction) {
          setMinimapDialogState({
            mode: "redo",
            target,
            workspacePath,
            redoInstructions: [fileRedoInstruction],
            requestId: generateId(),
          });
        }
        return;
      }

      const input = buildUndoDialogInputForSpecificEvent(
        target,
        request.eventIndex,
        request.path,
        request.event,
        row.workspaceSnapshot,
        workspacePath,
        {
          oldContent: request.oldContent,
          newContent: request.newContent,
          structuredPatch: request.structuredPatch,
        }
      );

      setMinimapDialogState({
        mode: "undo",
        target,
        workspacePath,
        input,
        requestId: generateId(),
      });
    },
    [stepOutputsMap]
  );

  const invalidateMeasuredRow = useCallback(
    (rowKey: string) => {
      measurementCacheRef.current.delete(rowKey);
      rowVirtualizer.measure();
      setMeasurementVersion((version) => version + 1);
    },
    [rowVirtualizer]
  );

  const invalidateMeasuredRowForUserResize = useCallback(
    (rowKey: string) => {
      const scrollElement = outputRef.current;
      const rowElement =
        scrollElement == null
          ? null
          : findRenderedRowElementByKey(scrollElement, rowKey);
      const previousTop =
        rowElement == null ? null : rowElement.getBoundingClientRect().top;

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
          if (previousTop == null) {
            return;
          }

          const finalScrollElement = outputRef.current;
          if (!finalScrollElement) {
            return;
          }

          const finalRowElement = findRenderedRowElementByKey(
            finalScrollElement,
            rowKey
          );
          if (!finalRowElement) {
            return;
          }

          const delta =
            finalRowElement.getBoundingClientRect().top - previousTop;
          if (Math.abs(delta) < 1) {
            return;
          }

          const maxScroll = Math.max(
            0,
            finalScrollElement.scrollHeight - finalScrollElement.clientHeight
          );
          finalScrollElement.scrollTop = Math.max(
            0,
            Math.min(maxScroll, finalScrollElement.scrollTop + delta)
          );
          lastScrollTopRef.current = finalScrollElement.scrollTop;
        });
      });
    },
    [rowVirtualizer]
  );

  const handleDiffCollapsedChange = useCallback(
    (rowKey: string, diffKey: string, collapsed: boolean) => {
      invalidateMeasuredRow(rowKey);
      if (collapsed) {
        setDiffExpansionState((previous) => {
          if (!previous.has(diffKey)) return previous;
          const next = new Map(previous);
          next.delete(diffKey);
          return next;
        });
      }
      setDiffCollapseState((previous) => {
        const next = new Map(previous);
        next.set(diffKey, collapsed);
        return next;
      });
    },
    [invalidateMeasuredRow]
  );

  const handleDiffGapExpand = useCallback(
    (
      rowKey: string,
      diffKey: string,
      gapIndex: number,
      nextExpandedToLine: number
    ) => {
      invalidateMeasuredRow(rowKey);
      setDiffExpansionState((previous) => {
        const currentDiffState = previous.get(diffKey);
        if (currentDiffState?.get(gapIndex) === nextExpandedToLine) {
          return previous;
        }

        const next = new Map(previous);
        const nextDiffState = new Map(currentDiffState ?? []);
        nextDiffState.set(gapIndex, nextExpandedToLine);
        next.set(diffKey, nextDiffState);
        return next;
      });
    },
    [invalidateMeasuredRow]
  );

  const handleToolCallExpansionChange = useCallback(
    (rowKey: string, section: ToolCallExpansionSection, expanded: boolean) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setToolCallExpansionState((previous) => {
        const currentState =
          previous.get(rowKey) ?? DEFAULT_TOOL_CALL_EXPANSION_STATE;
        const nextState: ToolCallExpansionState = {
          ...currentState,
          paramsExpanded:
            section === "params" ? expanded : currentState.paramsExpanded,
          outputExpanded:
            section === "output" ? expanded : currentState.outputExpanded,
          errorExpanded:
            section === "error" ? expanded : currentState.errorExpanded,
        };

        const isDefaultState =
          !nextState.paramsExpanded &&
          !nextState.outputExpanded &&
          !nextState.errorExpanded;

        if (
          currentState.paramsExpanded === nextState.paramsExpanded &&
          currentState.outputExpanded === nextState.outputExpanded &&
          currentState.errorExpanded === nextState.errorExpanded
        ) {
          return previous;
        }

        const next = new Map(previous);
        if (isDefaultState) {
          next.delete(rowKey);
        } else {
          next.set(rowKey, nextState);
        }
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  const handleBashExpansionChange = useCallback(
    (
      rowKey: string,
      section: BashOutputExpansionSection,
      expanded: boolean
    ) => {
      invalidateMeasuredRowForUserResize(rowKey);
      setBashExpansionState((previous) => {
        const currentState = previous.get(rowKey) ?? {
          outputExpanded: false,
          errorExpanded: false,
        };
        const nextState: BashOutputExpansionState = {
          ...currentState,
          outputExpanded:
            section === "output" ? expanded : currentState.outputExpanded,
          errorExpanded:
            section === "error" ? expanded : currentState.errorExpanded,
        };

        const isDefaultState =
          !nextState.outputExpanded && !nextState.errorExpanded;

        if (
          currentState.outputExpanded === nextState.outputExpanded &&
          currentState.errorExpanded === nextState.errorExpanded
        ) {
          return previous;
        }

        const next = new Map(previous);
        if (isDefaultState) {
          next.delete(rowKey);
        } else {
          next.set(rowKey, nextState);
        }
        return next;
      });
    },
    [invalidateMeasuredRowForUserResize]
  );

  const handleMinimapStepClick = useCallback(
    (step: MinimapStep) => {
      navigationController.scrollToTarget(
        { kind: step.kind, index: step.stepIndex },
        { behavior: "smooth", align: "start" }
      );
    },
    [navigationController]
  );

  const collapsedHeader = (
    <div
      ref={mergedHeaderRef}
      className="flex flex-row items-center w-full h-[30px] px-2 gap-1 border-b border-panel-border bg-sidebar-bg cursor-pointer select-none text-description-fg hover:text-foreground transition-colors flex-shrink-0"
      onClick={() => {
        triggerPanelAnimation();
        toggleOutputCollapse();
      }}
      role="button"
      aria-label="Expand output"
      tabIndex={0}
      onKeyDown={(e) =>
        e.key === "Enter" && (triggerPanelAnimation(), toggleOutputCollapse())
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
        <div
          ref={mergedHeaderRef}
          className="flex items-center justify-between gap-[var(--spacing-sm)] h-[30px] pl-2 pr-1 border-b border-panel-border flex-shrink-0 bg-sidebar-bg"
        >
          {/* Left: clickable collapse area + tab buttons + font size controls + execution mode */}
          <div className="flex items-center gap-1">
            {/* Collapse affordance — chevron + icon only (narrower click target) */}
            <div
              className="flex items-center gap-1 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
              onClick={() => {
                triggerPanelAnimation();
                toggleOutputCollapse();
              }}
              role="button"
              aria-label="Collapse output"
              tabIndex={0}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                (triggerPanelAnimation(), toggleOutputCollapse())
              }
            >
              <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
            </div>

            {/* Output / Terminal tab buttons */}
            {showTerminalTab ? (
              <div className="flex items-center ml-1">
                <button
                  className={`fp-tab ${activeOutputTab === "output" ? "fp-tab-active" : "fp-tab-inactive"}`}
                  onClick={() =>
                    setActiveOutputTab(terminalWorkflowId, "output")
                  }
                >
                  <i
                    className={`codicon codicon-output codicon-sm ${isHeaderNarrow ? "px-1" : ""}`}
                  />
                  {!isHeaderNarrow && <span>Output</span>}
                </button>
                <button
                  className={`fp-tab ${activeOutputTab === "terminal" ? "fp-tab-active" : "fp-tab-inactive"}`}
                  onClick={() => {
                    setActiveOutputTab(terminalWorkflowId, "terminal");
                    if (terminalSessions.length === 0) {
                      const vscode = getVsCodeApi();
                      vscode?.postMessage({
                        type: MESSAGE_TYPES.TERMINAL_SPAWN_SHELL,
                        workflowId: terminalWorkflowId,
                        cwd: workspaceRoot || "",
                      });
                    }
                  }}
                >
                  <i
                    className={`codicon codicon-terminal codicon-sm ${isHeaderNarrow ? "px-1" : ""}`}
                  />
                  {!isHeaderNarrow && <span>Terminal</span>}
                  {terminalSessionActive && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse" />
                  )}
                </button>
              </div>
            ) : (
              <span className="text-xs font-semibold uppercase tracking-wide text-description-fg ml-1 flex items-center gap-1">
                <i className="codicon codicon-output text-sm" />
                Output
              </span>
            )}

            {/* Font size stepper — switches between output and terminal font sizes */}
            {activeOutputTab === "output" ? (
              <div className="flex items-center ml-2">
                <button
                  className="icon-btn py-0 px-0.5"
                  title="Decrease font size"
                  aria-label="Decrease font size"
                  onClick={() => setOutputFontSize(outputFontSize - 1)}
                  disabled={outputFontSize <= 10}
                >
                  <i className="codicon codicon-sm codicon-remove" />
                </button>
                {!isHeaderNarrow && (
                  <span className="text-xxs text-description-fg tabular-nums w-[20px] text-center select-none">
                    {outputFontSize}
                  </span>
                )}
                <button
                  className="icon-btn py-0 px-0.5"
                  title="Increase font size"
                  aria-label="Increase font size"
                  onClick={() => setOutputFontSize(outputFontSize + 1)}
                  disabled={outputFontSize >= 24}
                >
                  <i className="codicon codicon-sm codicon-add" />
                </button>
              </div>
            ) : activeOutputTab === "terminal" ? (
              <div className="flex items-center ml-2">
                <button
                  className="icon-btn py-0 px-0.5"
                  title="Decrease terminal font size"
                  aria-label="Decrease terminal font size"
                  onClick={() => updateTerminalFontSize(terminalFontSize - 1)}
                  disabled={terminalFontSize <= 8}
                >
                  <i className="codicon codicon-sm codicon-remove" />
                </button>
                {!isHeaderNarrow && (
                  <span className="text-xxs text-description-fg tabular-nums w-[20px] text-center select-none">
                    {terminalFontSize}
                  </span>
                )}
                <button
                  className="icon-btn py-0 px-0.5"
                  title="Increase terminal font size"
                  aria-label="Increase terminal font size"
                  onClick={() => updateTerminalFontSize(terminalFontSize + 1)}
                  disabled={terminalFontSize >= 24}
                >
                  <i className="codicon codicon-sm codicon-add" />
                </button>
              </div>
            ) : null}
          </div>

          {/* Right: controls */}
          <div
            className={`ml-auto flex items-center ${isHeaderNarrow ? "gap-1" : "gap-2"}`}
          >
            {activeOutputTab === "terminal" && (
              <>
                {/* Active session icon + title — only shown when rail is collapsed */}
                {isTerminalCompact && activeTerminalSession && (
                  <div className="flex items-center gap-1.5 min-w-0 mr-1">
                    <TerminalSessionIcon session={activeTerminalSession} />
                    <span className="text-xs text-foreground truncate max-w-[120px]">
                      {activeTerminalSession.stepName}
                    </span>
                  </div>
                )}

                {/* New Terminal button */}
                <button
                  className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-description-fg hover:text-foreground transition-colors"
                  title="New Terminal"
                  onClick={() => {
                    const vscode = getVsCodeApi();
                    vscode?.postMessage({
                      type: MESSAGE_TYPES.TERMINAL_SPAWN_SHELL,
                      workflowId: terminalWorkflowId,
                      cwd: workspaceRoot || "",
                    });
                  }}
                >
                  <i className="codicon codicon-add text-xs" />
                  {!isTerminalCompact && <span>New Terminal</span>}
                </button>

                {/* Trash button — compact mode: shell sessions always, AI CLI sessions when workflow is not executing */}
                {isTerminalCompact &&
                  activeTerminalSession &&
                  (activeTerminalSession.kind === SESSION_KINDS.SHELL ||
                    (activeTerminalSession.kind === SESSION_KINDS.AI_CLI &&
                      !isExecutionActive)) && (
                    <button
                      className="icon-btn py-0 px-1"
                      title="Close terminal"
                      aria-label="Close terminal"
                      onClick={() => {
                        if (!activeTerminalSession) return;
                        const vscode = getVsCodeApi();
                        if (
                          activeTerminalSession.kind === SESSION_KINDS.SHELL
                        ) {
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
                        terminalRegistry.clearSession(
                          terminalWorkflowId,
                          activeTerminalSession.id
                        );
                        useTerminalStore
                          .getState()
                          .removeSession(
                            terminalWorkflowId,
                            activeTerminalSession.id
                          );
                        // If this was the last session, switch back to output tab
                        const remaining =
                          useTerminalStore.getState().sessions[
                            terminalWorkflowId
                          ] ?? [];
                        if (remaining.length === 0) {
                          setActiveOutputTab(terminalWorkflowId, "output");
                        }
                      }}
                    >
                      <i className="codicon codicon-trash text-xs" />
                    </button>
                  )}
              </>
            )}
            {activeOutputTab === "output" && (
              <>
                {/* Workflow-level undo button */}
                {workflowUndoRedoData.undoEntries.length > 0 &&
                  (() => {
                    const count = workflowUndoRedoData.undoEntries.reduce(
                      (n, e) => n + (e.undoCandidates?.length ?? 0),
                      0
                    );
                    return (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 px-1 py-0.5 text-xs text-link-fg hover:text-link-active-fg transition-colors min-w-0"
                        style={{ touchAction: "manipulation" }}
                        title={`Undo workflow changes (${count} file${count !== 1 ? "s" : ""})`}
                        onClick={() =>
                          setWorkflowDialogState({
                            mode: "undo",
                            workspacePath: workflowUndoRedoData.workspacePath,
                            entries: workflowUndoRedoData.undoEntries,
                            requestId: generateId(),
                          })
                        }
                      >
                        <i className="codicon codicon-discard text-xs flex-shrink-0" />
                        {!isHeaderVeryNarrow && (
                          <span className="text-nowrap">
                            {useCompactOutputHeaderLabels
                              ? "Undo"
                              : `Undo ${count} change${count !== 1 ? "s" : ""}`}
                          </span>
                        )}
                      </button>
                    );
                  })()}
                {/* Workflow-level redo button */}
                {workflowUndoRedoData.redoEntries.length > 0 &&
                  (() => {
                    const count = workflowUndoRedoData.redoEntries.reduce(
                      (n, e) => n + (e.redoInstructions?.length ?? 0),
                      0
                    );
                    return (
                      <button
                        type="button"
                        className="flex items-center gap-0.5 px-1 py-0.5 text-xs text-terminal-ansiGreen hover:opacity-80 transition-opacity min-w-0"
                        style={{ touchAction: "manipulation" }}
                        title={`Redo workflow changes (${count} file${count !== 1 ? "s" : ""})`}
                        onClick={() =>
                          setWorkflowDialogState({
                            mode: "redo",
                            workspacePath: workflowUndoRedoData.workspacePath,
                            entries: workflowUndoRedoData.redoEntries,
                            requestId: generateId(),
                          })
                        }
                      >
                        <i className="codicon codicon-redo text-xs flex-shrink-0" />
                        {!isHeaderVeryNarrow && (
                          <span>
                            {useCompactOutputHeaderLabels
                              ? "Redo"
                              : `Redo ${count} change${count !== 1 ? "s" : ""}`}
                          </span>
                        )}
                      </button>
                    );
                  })()}
                {availableRuns > 0 && (
                  <RunSelector
                    availableRuns={availableRuns}
                    currentRunIndex={viewingRunIndex}
                    isViewingHistory={isViewingHistory}
                    isLiveRunActive={
                      executionState === EXECUTION_STATES.RUNNING
                    }
                    narrow={useCompactOutputHeaderLabels}
                    veryNarrow={isHeaderVeryNarrow}
                    runTimestamps={runTimestamps}
                    runStates={runStates}
                    onSelectRun={(runIndex) => {
                      const vscode = getVsCodeApi();
                      if (vscode) {
                        vscode.postMessage({
                          type: MESSAGE_TYPES.LOAD_RUN_HISTORY,
                          runIndex,
                        });
                      }
                    }}
                    onBackToLive={() => {
                      useWorkflowStore.getState().clearHistoryOutputs();
                      useUiStore.getState().clearHistoryView();
                    }}
                    onClearHistory={() => {
                      const vscode = getVsCodeApi();
                      if (vscode) {
                        vscode.postMessage({
                          type: MESSAGE_TYPES.CLEAR_RUN_HISTORY,
                        });
                      }
                    }}
                  />
                )}
                {hasOutput && (
                  <ExpandCollapseAllDiffsButton
                    anyDiffCollapsed={anyDiffCollapsed}
                    onExpand={expandAllDiffs}
                    onCollapse={collapseAllDiffs}
                  />
                )}
                <button
                  className="icon-btn py-1 px-1"
                  id="export-btn"
                  title="Export output to markdown"
                  aria-label="Export output to markdown"
                  onClick={handleExport}
                  disabled={!hasOutput}
                >
                  <i className="codicon codicon-sm codicon-share" />
                </button>
              </>
            )}
            <IconToggleButton
              active={executionMode === EXECUTION_MODES.INTERACTIVE}
              onToggle={handleExecutionModeChange}
              activeIcon="debug-console"
              inactiveIcon="terminal"
              activeTooltip="Interactive mode: terminal visible, steer execution and interact with harness"
              inactiveTooltip="Headless mode: runs in background, output shown in Output panel"
              activeLabel="Interactive"
              inactiveLabel="Headless"
              narrow={isHeaderNarrow}
              labelPosition="left"
            />
          </div>
        </div>
      )}

      {/* Output Content: toggle between Output view and Terminal view */}
      {activeOutputTab === "terminal" ? (
        <div
          className={`${outputCollapsed ? "hidden" : "flex"} flex-row min-h-0 flex-1`}
        >
          <TerminalView workflowId={terminalWorkflowId} />
        </div>
      ) : (
        <div
          className={`${outputCollapsed ? "hidden" : "flex"} relative flex-row min-h-0 flex-1`}
        >
          {/* Scrollable output */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            ref={outputRef}
            id="output-content"
            className="font-mono text-[length:var(--fp-output-font-size-sm)] min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
            style={{ overflowAnchor: "none" }}
            onScroll={handleScroll}
            onWheel={() => {
              lastUserScrollInputAtRef.current = performance.now();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(e.clientX, e.clientY, e.currentTarget);
            }}
            {...outputLongPressHandlers}
          >
            {!hasOutput ? (
              <p className="text-center text-description-fg italic p-[var(--spacing-lg)]">
                Output will appear here during execution
              </p>
            ) : (
              <Profiler
                id="OutputVirtualRows"
                onRender={handleOutputProfilerRender}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualRows.map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    const renderScrollSeekPlaceholder =
                      isOutputScrollSeeking &&
                      !isNavigationTargetVirtualized &&
                      shouldRenderScrollSeekPlaceholder(row);

                    return (
                      <div
                        key={virtualRow.key}
                        ref={
                          renderScrollSeekPlaceholder
                            ? undefined
                            : measureRowElement
                        }
                        data-index={virtualRow.index}
                        data-row-key={row.key}
                        className="flow-root"
                        style={{
                          position: "absolute",
                          top: 0,
                          transform: `translateY(${virtualRow.start}px)`,
                          width: "100%",
                        }}
                      >
                        {renderScrollSeekPlaceholder ? (
                          <OutputScrollSeekPlaceholder
                            row={row}
                            height={virtualRow.size}
                          />
                        ) : (
                          <OutputRow
                            row={row}
                            isExecutionActive={isExecutionActive}
                            onBackToLive={handleBackToLive}
                            onPromptUndo={handlePromptUndo}
                            onPromptRedo={handlePromptRedo}
                            onFileUndo={handleFileUndo}
                            onDiffCollapsedChange={handleDiffCollapsedChange}
                            onDiffGapExpand={handleDiffGapExpand}
                            onToolCallExpansionChange={
                              handleToolCallExpansionChange
                            }
                            bashExpansion={
                              bashExpansionState.get(row.key) ??
                              DEFAULT_BASH_OUTPUT_EXPANSION_STATE
                            }
                            onBashExpansionChange={handleBashExpansionChange}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </Profiler>
            )}
          </div>

          {showVirtualizationOverlay && (
            <div className="pointer-events-none absolute inset-y-0 left-0 right-[14px] flex items-center justify-center">
              <div className="flex items-center gap-2 rounded border border-widget-border bg-editor-bg/90 px-3 py-1.5 text-xs text-description-fg shadow-sm backdrop-blur-[1px]">
                <i className="codicon codicon-loading codicon-modifier-spin" />
                <span>Rendering output…</span>
              </div>
            </div>
          )}

          {/* Minimap rail */}
          {hasOutput && (
            <Profiler id="OutputMinimap" onRender={handleOutputProfilerRender}>
              <OutputMinimap
                steps={minimapSteps}
                scrollContainerRef={outputRef}
                contentHeight={rowLayout.totalSize}
                onStepClick={handleMinimapStepClick}
              />
            </Profiler>
          )}
        </div>
      )}

      {/* Shared prompt-level undo/redo dialog — triggered from minimap */}
      {minimapDialogState && (
        <UndoChangesDialog
          mode={minimapDialogState.mode}
          target={minimapDialogState.target}
          workspacePath={minimapDialogState.workspacePath}
          input={minimapDialogState.input}
          redoInstructions={minimapDialogState.redoInstructions}
          requestId={minimapDialogState.requestId}
          onClose={() => setMinimapDialogState(null)}
        />
      )}

      {/* Workflow-level undo/redo dialog — triggered from header buttons */}
      {workflowDialogState && (
        <UndoChangesDialog
          mode={workflowDialogState.mode}
          target={workflowDialogState.entries[0].target}
          workspacePath={workflowDialogState.workspacePath}
          requestId={workflowDialogState.requestId}
          workflowEntries={workflowDialogState.entries}
          onClose={() => setWorkflowDialogState(null)}
        />
      )}

      {/* Output tab right-click context menu */}
      {outputContextMenuPortal}

      {/* Export options modal — used by both VS Code and hosted web server */}
      {exportModalOpen && (
        <Modal
          isOpen
          title="Export Output"
          onClose={() => setExportModalOpen(false)}
          size="sm"
          footer={
            <>
              <button
                type="button"
                className="px-4 py-2 text-sm text-description-fg hover:text-foreground transition-colors"
                onClick={() => setExportModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm bg-btn-bg text-btn-fg hover:bg-btn-hover rounded transition-colors"
                onClick={handleExportConfirm}
              >
                {isStandalone ? (
                  <>
                    <i className="codicon codicon-cloud-download mr-1" />
                    Download
                  </>
                ) : (
                  <>
                    <i className="codicon codicon-share mr-1" />
                    Export
                  </>
                )}
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-4 py-1">
            {/* Include command checkbox */}
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                aria-label="Include CLI command"
                checked={exportIncludeCommand}
                onChange={(e) => setExportIncludeCommand(e.target.checked)}
                className="mt-0.5 accent-btn-bg"
              />
              <span className="text-sm">
                <span className="text-foreground font-medium">
                  Include CLI command
                </span>
                <span className="block text-xs text-description-fg mt-0.5">
                  When unchecked, the command run for each prompt step is
                  omitted from the export.
                </span>
              </span>
            </label>

            {/* Include metadata checkbox */}
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                aria-label="Include metadata"
                checked={exportIncludeMetadata}
                onChange={(e) => setExportIncludeMetadata(e.target.checked)}
                className="mt-0.5 accent-btn-bg"
              />
              <span className="text-sm">
                <span className="text-foreground font-medium">
                  Include metadata
                </span>
                <span className="block text-xs text-description-fg mt-0.5">
                  When unchecked, step headings, token stats, session IDs, and
                  separators are omitted — giving a clean conversation history.
                </span>
              </span>
            </label>

            {/* Step range input */}
            <div>
              <label className="block text-sm text-foreground font-medium mb-1">
                Step range{" "}
                <span className="text-description-fg font-normal">
                  (optional)
                </span>
              </label>
              <input
                type="text"
                value={exportStepRange}
                onChange={(e) => {
                  setExportStepRange(e.target.value);
                  setExportStepRangeError(false);
                }}
                placeholder={
                  totalCliSteps > 1
                    ? `e.g. 1-${totalCliSteps}`
                    : "e.g. 1,2,4-10"
                }
                aria-label="Step range (e.g. 1,2,4-10)"
                className={`w-full px-2 text-xs bg-input-bg text-input-fg border rounded focus:outline-none focus:border-focus-border h-7 ${
                  exportStepRangeError
                    ? "border-input-error-border"
                    : "border-input-border"
                }`}
              />
              {exportStepRangeError && (
                <span className="text-xxs text-error-fg mt-0.5 block">
                  Use numbers, commas, and ranges (e.g. 1,3,5-10)
                </span>
              )}
              <p className="text-xxs text-description-fg mt-1">
                Leave blank to export all{" "}
                {totalCliSteps > 0 ? totalCliSteps : ""} step
                {totalCliSteps !== 1 ? "s" : ""}.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
};
