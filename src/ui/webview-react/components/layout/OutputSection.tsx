import React, {
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
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";
import { useLongPress } from "@hooks/useLongPress";
import {
  buildOutputRows,
  estimateOutputRowHeight,
  type CliHeaderRow,
  type StructuredEventRow,
} from "@utils/outputRows";
import { setActiveOutputNavigationController } from "@utils/outputNavigation";
import type { OutputRowFileUndoRequest } from "../output/OutputRow";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to consider "at bottom"

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
  const previousDiffResetVersion = useRef(diffResetVersion);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [diffCollapseState, setDiffCollapseState] = useState<Map<string, boolean>>(
    new Map()
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
        defaultDiffCollapsed: diffsCollapsed,
      }),
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
      diffsCollapsed,
      executionState,
    ]
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => outputRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 48;
      return measurementCacheRef.current.get(row.key) ?? estimateOutputRowHeight(row);
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
  });

  const measureRowElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      rowVirtualizer.measureElement(element);

      const index = Number(element.dataset.index ?? -1);
      const row = rows[index];
      if (!row) return;

      const nextHeight = element.getBoundingClientRect().height;
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;

      const previousHeight = measurementCacheRef.current.get(row.key);
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - nextHeight) < 0.5
      ) {
        return;
      }

      measurementCacheRef.current.set(row.key, nextHeight);
      setMeasurementVersion((version) => version + 1);
    },
    [rowVirtualizer, rows]
  );

  const rowLayout = useMemo(() => {
    let offset = 0;
    const rowStartsByIndex: number[] = [];
    const rowStartsByKey = new Map<string, number>();
    const rowSizesByKey = new Map<string, number>();

    for (const [index, row] of rows.entries()) {
      rowStartsByIndex[index] = offset;
      rowStartsByKey.set(row.key, offset);
      const size = measurementCacheRef.current.get(row.key) ?? estimateOutputRowHeight(row);
      rowSizesByKey.set(row.key, size);
      offset += size;
    }

    return {
      totalSize: offset,
      rowStartsByIndex,
      rowStartsByKey,
      rowSizesByKey,
    };
  }, [rows, measurementVersion]);

  const stepScrollFractions = useMemo(() => {
    const fractions = new Map<string, number>();
    const totalSize = Math.max(1, rowLayout.totalSize);

    for (const target of uniqueStepTargets) {
      const targetKey = `${target.kind}:${target.index}`;
      const rowIndex = firstRowIndexByTarget.get(targetKey);
      if (rowIndex === undefined) continue;
      fractions.set(targetKey, rowLayout.rowStartsByIndex[rowIndex] / totalSize);
    }

    return fractions;
  }, [firstRowIndexByTarget, rowLayout, uniqueStepTargets]);

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
  }, [rows, diffsCollapsed]);

  useEffect(() => {
    if (previousDiffResetVersion.current === diffResetVersion) {
      return;
    }
    previousDiffResetVersion.current = diffResetVersion;

    setDiffCollapseState((previous) => {
      if (previous.size === 0) return previous;
      const next = new Map(previous);
      for (const key of next.keys()) {
        next.set(key, diffsCollapsed);
      }
      return next;
    });
  }, [diffResetVersion, diffsCollapsed]);

  // Smart scroll: detect user scrolling away from bottom
  const handleScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const el = outputRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD;
    autoscrollEnabled.current = atBottom;
  }, []);

  // Auto-scroll effect.
  useEffect(() => {
    if (autoscrollEnabled.current && outputRef.current && rows.length > 0) {
      isProgrammaticScroll.current = true;
      rowVirtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    }
  }, [
    rows,
    streamingChunks,
    finalStepStreamingChunks,
    measurementVersion,
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

  // Export: open the options modal
  const handleExport = useCallback(() => {
    setExportModalOpen(true);
  }, []);

  // Count unique CLI steps for use in the export modal range hint
  const totalCliSteps = useMemo(() => {
    const seen = new Set<string>();
    for (const msg of allMessages) {
      if (msg.type === "cli") seen.add(`${msg.target.kind}:${msg.target.index}`);
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
        rowVirtualizer.scrollToIndex(rowIndex, {
          align: options?.align ?? "start",
          behavior: options?.behavior ?? "auto",
        });
        requestAnimationFrame(() => {
          isProgrammaticScroll.current = false;
        });
      },
      getTargetScrollFraction: (target: OutputMessage["target"]) => {
        const rowIndex = firstRowIndexByTarget.get(
          `${target.kind}:${target.index}`
        );
        if (rowIndex === undefined || rowLayout.totalSize <= 0) {
          return null;
        }

        return rowLayout.rowStartsByIndex[rowIndex] / rowLayout.totalSize;
      },
    }),
    [firstRowIndexByTarget, rowLayout, rowVirtualizer]
  );

  useEffect(() => {
    setActiveOutputNavigationController(navigationController);
    return () => {
      setActiveOutputNavigationController(null);
    };
  }, [navigationController]);

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
            scrollFraction:
              (rowLayout.rowStartsByKey.get(row.key) ?? 0) / totalSize,
            heightFraction:
              (rowLayout.rowSizesByKey.get(row.key) ?? row.estimateSize) /
              totalSize,
            addedLines: row.diff.addedLines,
            removedLines: row.diff.removedLines,
            runs: row.diff.runs,
            isCollapsed: row.diff.isCollapsed,
          },
        ];
      });

      const noActions: MinimapStep["undoActions"] = { undo: null, redo: null };
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
        effectiveUndoRecord = undoRecords[
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
  }, [
    allMessages,
    allowUndoActions,
    finalStep,
    finalStepWorkspaceSnapshots,
    firstRowIndexByTarget,
    historyOutputs,
    isViewingHistory,
    lastCliIndexPerStep,
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
        const fileRedoInstruction = row.undoRecord?.redoInstructions.find((item) =>
          sameFilePath(item.path, request.path)
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

  const handleDiffCollapsedChange = useCallback(
    (diffKey: string, collapsed: boolean) => {
      setDiffCollapseState((previous) => {
        const next = new Map(previous);
        next.set(diffKey, collapsed);
        return next;
      });
    },
    []
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
          className={`${outputCollapsed ? "hidden" : "flex"} flex-row min-h-0 flex-1`}
        >
          {/* Scrollable output */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            ref={outputRef}
            id="output-content"
            className="font-mono text-[length:var(--fp-output-font-size-sm)] min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
            onScroll={handleScroll}
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
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  position: "relative",
                  width: "100%",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;

                  return (
                    <div
                      key={virtualRow.key}
                      ref={measureRowElement}
                      data-index={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: "100%",
                      }}
                    >
                      <OutputRow
                        row={row}
                        isExecutionActive={isExecutionActive}
                        onBackToLive={handleBackToLive}
                        onPromptUndo={handlePromptUndo}
                        onPromptRedo={handlePromptRedo}
                        onFileUndo={handleFileUndo}
                        onDiffCollapsedChange={handleDiffCollapsedChange}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Minimap rail */}
          {hasOutput && (
            <OutputMinimap
              steps={minimapSteps}
              scrollContainerRef={outputRef}
              onStepClick={handleMinimapStepClick}
            />
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
                Leave blank to export all {totalCliSteps > 0 ? totalCliSteps : ""}{" "}
                step{totalCliSteps !== 1 ? "s" : ""}.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
};
