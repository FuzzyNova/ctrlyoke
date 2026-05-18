import React, {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
} from "react";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { CliOutput, StatusMessage } from "../output";
import { Modal } from "../shared";
import {
  RunSelector,
  IconToggleButton,
  ExpandCollapseAllDiffsButton,
} from "../shared";
import { TerminalSessionIcon } from "../output/TerminalSessionIcon";
import { normalizeCliEvents } from "@root/utils/CliEventNormalizer";
import { generateId } from "@utils/string";
import { generateMarkdownExport } from "@utils/markdownExport";
import {
  getRenderedDiffStats,
  toRdvFromContent,
  toRdvHunks,
} from "@utils/rdvAdapter";
import {
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import type {
  CliOutput as CliOutputType,
  CliEvent,
  FileEditData,
  FileWriteData,
  OutputStatusMessage,
} from "../../types/cliEvents";
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
import { CLI_EVENT_TYPES } from "../../types/cliEvents";
import {
  OutputMinimap,
  type MinimapStep,
  type MinimapDiffBlock,
  type DiffRun,
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
  computePromptUndoActions,
  sameFilePath,
  type UndoDialogInput,
} from "../../utils/promptUndo";
import type { UndoFileInstruction } from "../../types/messages";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { buildDiffAnchorPrefix } from "@utils/outputUtils";
import { useOutputContextMenu } from "@hooks/useOutputContextMenu";

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

interface DiffMeasurement {
  startFraction: number;
  heightFraction: number;
  isCollapsed: boolean;
  addedLines: number;
  removedLines: number;
  runs: DiffRun[];
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

function diffRunsEqual(a: DiffRun[], b: DiffRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].count !== b[i].count ||
      a[i].addedLines !== b[i].addedLines ||
      a[i].removedLines !== b[i].removedLines
    ) {
      return false;
    }
  }
  return true;
}

function stepFractionMapsEqual(
  a: Map<string, number>,
  b: Map<string, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const nextValue = b.get(key);
    if (nextValue === undefined || !nearlyEqual(value, nextValue)) {
      return false;
    }
  }
  return true;
}

function diffMeasurementMapsEqual(
  a: Map<string, DiffMeasurement>,
  b: Map<string, DiffMeasurement>
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const nextValue = b.get(key);
    if (!nextValue) return false;
    if (
      !nearlyEqual(value.startFraction, nextValue.startFraction) ||
      !nearlyEqual(value.heightFraction, nextValue.heightFraction) ||
      value.isCollapsed !== nextValue.isCollapsed ||
      value.addedLines !== nextValue.addedLines ||
      value.removedLines !== nextValue.removedLines ||
      !diffRunsEqual(value.runs, nextValue.runs)
    ) {
      return false;
    }
  }
  return true;
}

function outputHasFileOperation(output: CliOutputType): boolean {
  return (
    output.structured?.events?.some(
      (event) =>
        event.type === CLI_EVENT_TYPES.FILE_EDIT ||
        event.type === CLI_EVENT_TYPES.FILE_WRITE ||
        event.type === CLI_EVENT_TYPES.FILE_DELETE
    ) ?? false
  );
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
  const measureFrameRef = useRef<number | null>(null);

  // Real pixel fractions for each step anchor (key → offsetTop / scrollHeight)
  const [stepScrollFractions, setStepScrollFractions] = useState<
    Map<string, number>
  >(new Map());

  // DOM measurements for diff anchor elements (anchorId → position + collapse state)
  const [diffMeasurements, setDiffMeasurements] = useState<
    Map<string, DiffMeasurement>
  >(new Map());

  // Shared prompt-level undo/redo dialog (owned here, triggered from minimap)
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);

  // Workflow-level undo/redo dialog (aggregates all prompt-level changes)
  const [workflowDialogState, setWorkflowDialogState] =
    useState<WorkflowDialogState | null>(null);

  // Standalone-mode export modal (browser clients that can't use VS Code save dialog)
  const [exportModalContent, setExportModalContent] = useState<string | null>(
    null
  );

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

  // Unique step targets in first-appearance order (for DOM measurement and undo/redo iteration).
  const uniqueStepTargets = useMemo(() => {
    const seen = new Map<string, OutputMessage["target"]>();
    for (const msg of allMessages) {
      const key = `${msg.target.kind}:${msg.target.index}`;
      if (!seen.has(key)) {
        seen.set(key, msg.target);
      }
    }
    return [...seen.values()];
  }, [allMessages]);

  const hasFileOperationOutput = useMemo(
    () =>
      allMessages.some(
        (msg) =>
          msg.type === "cli" &&
          outputHasFileOperation(msg.data as CliOutputType)
      ),
    [allMessages]
  );

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
  // We watch both allMessages (new output records) and streamingChunks
  // (tokens arriving for the current streaming item) so the view follows
  // the growing content in real time without rebuilding allMessages each tick.
  useEffect(() => {
    if (autoscrollEnabled.current && outputRef.current) {
      isProgrammaticScroll.current = true;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
      // Reset flag after the scroll event fires
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    }
  }, [allMessages, streamingChunks, finalStepStreamingChunks]);

  // Measure real pixel positions of step anchor divs so the minimap can
  // place markers at their true scroll fractions (not an index fraction).
  // Re-runs whenever allMessages changes (content height changes) and uses a
  // ResizeObserver to catch in-progress content growth.
  useEffect(() => {
    const container = outputRef.current;
    if (!container) return;

    const measure = () => {
      const { scrollHeight } = container;
      if (scrollHeight === 0) return;
      const containerTop = container.getBoundingClientRect().top;

      // Measure step anchor positions
      const fractions = new Map<string, number>();
      for (const target of uniqueStepTargets) {
        const kindSlug =
          target.kind === FINAL_STEP_PHASES.QUEUE ? "queue" : "final";
        const anchor = document.getElementById(
          `output-step-${kindSlug}-${target.index}`
        );
        if (anchor) {
          const pixelPos =
            anchor.getBoundingClientRect().top -
            containerTop +
            container.scrollTop;
          fractions.set(
            `${target.kind}:${target.index}`,
            pixelPos / scrollHeight
          );
        }
      }
      setStepScrollFractions((prev) =>
        stepFractionMapsEqual(prev, fractions) ? prev : fractions
      );

      if (!hasFileOperationOutput) {
        setDiffMeasurements((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }

      // Measure diff anchor elements so the minimap can render colored overlays.
      // data-diff-anchor divs wrap file-operation events in StructuredOutput and
      // reflect the actual rendered height (collapsed or expanded).
      const diffAnchors =
        container.querySelectorAll<HTMLElement>("[data-diff-anchor]");
      const newDiffMeasurements = new Map<string, DiffMeasurement>();
      diffAnchors.forEach((el) => {
        const pixelTop =
          el.getBoundingClientRect().top - containerTop + container.scrollTop;
        // Read actual collapse state set by DiffView's useEffect on the anchor.
        // Fall back to the global diffsCollapsed default when the attribute isn't
        // stamped yet (e.g. before DiffView's first effect flush).
        const attrVal = el.getAttribute("data-diff-collapsed");
        const isCollapsed =
          attrVal !== null ? attrVal === "true" : diffsCollapsed;
        const addedLines = Number(
          el.getAttribute("data-diff-added-lines") ?? 0
        );
        const removedLines = Number(
          el.getAttribute("data-diff-removed-lines") ?? 0
        );
        newDiffMeasurements.set(el.id, {
          startFraction: pixelTop / scrollHeight,
          heightFraction: el.offsetHeight / scrollHeight,
          isCollapsed,
          addedLines: Number.isFinite(addedLines) ? addedLines : 0,
          removedLines: Number.isFinite(removedLines) ? removedLines : 0,
          runs: parseDiffRuns(el.getAttribute("data-diff-runs")),
        });
      });
      setDiffMeasurements((prev) =>
        diffMeasurementMapsEqual(prev, newDiffMeasurements)
          ? prev
          : newDiffMeasurements
      );
    };

    const scheduleMeasure = () => {
      if (measureFrameRef.current !== null) return;
      measureFrameRef.current = requestAnimationFrame(() => {
        measureFrameRef.current = null;
        measure();
      });
    };

    measure();
    // Re-measure on the next frame so remounted DiffView children have time to
    // reinsert anchors and stamp their minimap metadata before we read the DOM.
    scheduleMeasure();

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(container);
    // Watch for individual diff expand/collapse — DiffView stamps data-diff-collapsed
    // on [data-diff-anchor] elements, but the container's clientHeight doesn't change
    // (it's overflow-y-auto with fixed visual height), so ResizeObserver won't fire.
    // MutationObserver also watches childList so remounted output content can
    // repopulate diff anchors even when the scroll container size stays fixed.
    const mutationObserver = hasFileOperationOutput
      ? new MutationObserver(scheduleMeasure)
      : null;
    mutationObserver?.observe(container, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: [
        "data-diff-collapsed",
        "data-diff-added-lines",
        "data-diff-removed-lines",
        "data-diff-runs",
      ],
    });
    return () => {
      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
    };
    // activeOutputTab is included so a re-measure fires when switching back from
    // the terminal tab — the output div is unmounted while terminal is active, so
    // its DOM measurements become stale and must be refreshed on re-mount.
    // outputCollapsed is included for the same reason when the OutputSection stays
    // mounted as a collapsed bar and later expands in-place.
  }, [
    allMessages,
    uniqueStepTargets,
    hasFileOperationOutput,
    diffsCollapsed,
    activeOutputTab,
    outputCollapsed,
  ]);

  // Export handler
  const handleExport = useCallback(() => {
    const markdownContent = generateMarkdownExport(
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
      }
    );

    if (isStandalone) {
      setExportModalContent(markdownContent);
      return;
    }

    const vscode = getVsCodeApi();
    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName,
    });
  }, [
    allMessages,
    currentStep,
    executionState,
    fileName,
    finalStep?.name,
    historyOutputs,
    isViewingHistory,
    steps,
    totalSteps,
  ]);

  // Map of array index → stepIndex for the first message of each step.
  // Used to insert step anchor divs so clicking a prompt can scroll to its output.
  const firstIndexByStep = useMemo(() => {
    const map = new Map<string, number>();
    allMessages.forEach((msg, idx) => {
      const key = `${msg.target.kind}:${msg.target.index}`;
      if (!map.has(key)) {
        map.set(key, idx);
      }
    });
    return map;
  }, [allMessages]);

  // Map step key → all CLI outputs for that step (used for minimap undo actions)
  const stepOutputsMap = useMemo(() => {
    const map = new Map<string, CliOutputType[]>();
    for (const msg of allMessages) {
      if (msg.type === "cli") {
        const key = `${msg.target.kind}:${msg.target.index}`;
        const existing = map.get(key) ?? [];
        existing.push(msg.data as CliOutputType);
        map.set(key, existing);
      }
    }
    return map;
  }, [allMessages]);

  // Track last CLI message index per step (prompt-level undo button shown only on last attempt)
  const lastCliIndexPerStep = useMemo(() => {
    const map = new Map<string, number>();
    allMessages.forEach((msg, idx) => {
      if (msg.type === "cli") {
        map.set(`${msg.target.kind}:${msg.target.index}`, idx);
      }
    });
    return map;
  }, [allMessages]);

  const { openContextMenu, outputContextMenuPortal } = useOutputContextMenu({
    allMessages,
    stepScrollFractions,
    lastCliIndexPerStep,
  });

  // Check if there's any output
  const hasOutput = allMessages.length > 0;

  // Derive whether any diff is currently collapsed from DOM measurements.
  // Falls back to the store value before the DOM has been measured.
  // Used to show the correct "Expand all" vs "Collapse all" button label.
  const anyDiffCollapsed = !hasFileOperationOutput
    ? false
    : diffMeasurements.size === 0
      ? diffsCollapsed
      : Array.from(diffMeasurements.values()).some((m) => m.isCollapsed);

  const isExecutionActive =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

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

  // ── Diff line count helper ─────────────────────────────────────────────────

  function parseDiffRuns(value: string | null): DiffRun[] {
    if (!value) return [];

    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];

      return parsed.flatMap((run) => {
        if (
          typeof run?.count !== "number" ||
          typeof run?.addedLines !== "number" ||
          typeof run?.removedLines !== "number"
        ) {
          return [];
        }

        return [
          {
            count: run.count,
            addedLines: run.addedLines,
            removedLines: run.removedLines,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  /**
   * Extract diff statistics and run sequence for a single CLI event.
   * Returns added/removed totals (for collapsed display) plus an ordered
   * runs array (for expanded VS Code-style minimap strips).
   * Runs are only populated when structuredPatch hunk data is available.
   */
  function computeDiffStats(event: CliEvent): {
    added: number;
    removed: number;
    runs: DiffRun[];
  } {
    if (event.type === CLI_EVENT_TYPES.FILE_EDIT) {
      const data = event.data as FileEditData;
      if (data.structuredPatch && data.structuredPatch.length > 0) {
        return getRenderedDiffStats(
          toRdvHunks(data.structuredPatch),
          "unified"
        );
      }
      if (data.oldContent && data.newContent) {
        const { hunks } = toRdvFromContent(data.oldContent, data.newContent);
        return getRenderedDiffStats(hunks, "unified");
      }
      return { added: 0, removed: 0, runs: [] };
    }
    if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
      const data = event.data as FileWriteData;
      const lines = data.content ? data.content.split("\n").length : 1;
      return {
        added: lines,
        removed: 0,
        runs: [{ count: lines, addedLines: 1, removedLines: 0 }],
      };
    }
    if (event.type === CLI_EVENT_TYPES.FILE_DELETE) {
      return {
        added: 0,
        removed: 1,
        runs: [{ count: 1, addedLines: 0, removedLines: 1 }],
      };
    }
    return { added: 0, removed: 0, runs: [] };
  }

  // ── Minimap steps array ────────────────────────────────────────────────────
  // Built from stepsToRender + firstIndexByStep; includes prompt-level
  // undo/redo actions so the minimap can show them without needing CliOutput.
  const minimapSteps = useMemo((): MinimapStep[] => {
    return uniqueStepTargets.flatMap((msgTarget) => {
      const key = `${msgTarget.kind}:${msgTarget.index}`;
      const firstIdx = firstIndexByStep.get(key);
      if (firstIdx === undefined) return [];

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

      // Real pixel fraction — falls back to index fraction until DOM is measured
      const scrollFraction =
        stepScrollFractions.get(key) ??
        firstIdx / Math.max(1, allMessages.length);

      const noActions: MinimapStep["undoActions"] = { undo: null, redo: null };
      const stepOutputs = stepOutputsMap.get(key) ?? [];

      // Always build diff blocks so overlays update in real time during execution.
      const kindSlug = isFinalStep ? "fp" : "q";
      const diffBlocks: MinimapDiffBlock[] = [];
      for (const output of stepOutputs) {
        const attemptIdx = output.attemptIndex ?? 0;
        const runIdx = output.runIndex ?? 0;
        const anchorPrefix = buildDiffAnchorPrefix(
          kindSlug,
          stepIndex,
          runIdx,
          attemptIdx
        );
        // Normalize to match the indices StructuredOutput uses for DOM anchor IDs.
        // normalizeCliEvents can merge/remove events (e.g. collapsing duplicate
        // fileRead completions), so iterating the original array produces anchor IDs
        // that don't exist in the DOM.
        const events = normalizeCliEvents(output.structured?.events ?? []);
        events.forEach((event, eventIndex) => {
          if (
            event.type !== CLI_EVENT_TYPES.FILE_EDIT &&
            event.type !== CLI_EVENT_TYPES.FILE_WRITE &&
            event.type !== CLI_EVENT_TYPES.FILE_DELETE
          )
            return;
          const anchorId = `${anchorPrefix}-e${eventIndex}`;
          const measurement = diffMeasurements.get(anchorId);
          if (!measurement || measurement.heightFraction < 0.0005) return;
          const stats =
            measurement.addedLines > 0 ||
            measurement.removedLines > 0 ||
            measurement.runs.length > 0
              ? {
                  added: measurement.addedLines,
                  removed: measurement.removedLines,
                  runs: measurement.runs,
                }
              : computeDiffStats(event);
          if (stats.added + stats.removed === 0) return;
          diffBlocks.push({
            scrollFraction: measurement.startFraction,
            heightFraction: measurement.heightFraction,
            addedLines: stats.added,
            removedLines: stats.removed,
            runs: stats.runs,
            isCollapsed: measurement.isCollapsed,
          });
        });
      }

      // Skip undo actions while execution is active — scrollbar and diff overlays
      // are still rendered so the rail is usable during a running prompt.
      if (!allowUndoActions) {
        return [
          {
            key,
            kind,
            stepIndex,
            firstMessageIndex: firstIdx,
            scrollFraction,
            label,
            undoActions: noActions,
            diffBlocks,
          },
        ];
      }

      // Only the last CLI attempt gets undo/redo actions
      const lastCliIdx = lastCliIndexPerStep.get(key);
      if (lastCliIdx === undefined) {
        return [
          {
            key,
            kind,
            stepIndex,
            firstMessageIndex: firstIdx,
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
            firstMessageIndex: firstIdx,
            scrollFraction,
            label,
            undoActions: noActions,
            diffBlocks,
          },
        ];
      }

      const targetKey = isFinalStep
        ? `finalStep-${stepIndex}`
        : `queue-${stepIndex}`;
      const undoTarget: UndoExecutionTarget = isFinalStep
        ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: stepIndex }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex };

      let effectiveSnapshot: WorkspaceSnapshot | undefined;
      let effectiveUndoRecord: UndoRecord | undefined;

      if (isViewingHistory && historyOutputs) {
        effectiveSnapshot =
          kind === FINAL_STEP_PHASES.QUEUE
            ? historyOutputs.promptOutputs[stepIndex]?.workspaceSnapshot
            : historyOutputs.finalStepOutputs?.[stepIndex]?.workspaceSnapshot;
        effectiveUndoRecord =
          kind === FINAL_STEP_PHASES.QUEUE
            ? historyOutputs.promptOutputs[stepIndex]?.undoRecord
            : historyOutputs.finalStepOutputs?.[stepIndex]?.undoRecord;
      } else {
        effectiveSnapshot = isFinalStep
          ? finalStepWorkspaceSnapshots[stepIndex]
          : workspaceSnapshots[stepIndex];
        effectiveUndoRecord = undoRecords[targetKey];
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
                  redoInstructions: effectiveUndoRecord!.redoInstructions,
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
          firstMessageIndex: firstIdx,
          scrollFraction,
          label,
          undoActions,
          diffBlocks,
        },
      ];
    });
  }, [
    allowUndoActions,
    uniqueStepTargets,
    firstIndexByStep,
    lastCliIndexPerStep,
    allMessages,
    stepOutputsMap,
    stepScrollFractions,
    diffMeasurements,
    isViewingHistory,
    historyOutputs,
    workspaceSnapshots,
    finalStepWorkspaceSnapshots,
    undoRecords,
    steps,
    finalStep,
  ]);

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
          <div
            ref={outputRef}
            id="output-content"
            className="font-mono text-[length:var(--fp-output-font-size-sm)] min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
            onScroll={handleScroll}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(e.clientX, e.clientY, e.currentTarget);
            }}
          >
            {/* History banner: shown when viewing a historical run */}
            {isViewingHistory && historyOutputs && (
              <div className="px-3 py-2 text-[length:var(--fp-output-font-size-sm)] text-description-fg bg-editor-bg border-b border-widget-border flex items-center justify-between flex-shrink-0">
                <span>
                  Run {historyOutputs.runMetadata.runId} &middot;{" "}
                  {new Date(
                    historyOutputs.runMetadata.startedAt
                  ).toLocaleString()}
                  {historyOutputs.runMetadata.completedAt
                    ? " \u2713"
                    : " (incomplete)"}
                </span>
                {executionState === EXECUTION_STATES.RUNNING && (
                  <button
                    type="button"
                    onClick={() => {
                      useWorkflowStore.getState().clearHistoryOutputs();
                      useUiStore.getState().clearHistoryView();
                    }}
                    className="text-link-fg hover:underline focus:outline-none"
                  >
                    Back to Live{" "}
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse align-middle" />
                  </button>
                )}
              </div>
            )}
            {!hasOutput ? (
              <p className="text-center text-description-fg italic p-[var(--spacing-lg)]">
                Output will appear here during execution
              </p>
            ) : (
              allMessages.map((item, index) => {
                const isFirstForStep =
                  firstIndexByStep.get(
                    `${item.target.kind}:${item.target.index}`
                  ) === index;
                if (item.type === "status") {
                  const statusData = item.data as OutputStatusMessage;
                  return (
                    <React.Fragment key={`status-${index}`}>
                      {isFirstForStep && (
                        <div
                          id={`output-step-${item.target.kind === FINAL_STEP_PHASES.QUEUE ? "queue" : "final"}-${item.target.index}`}
                        />
                      )}
                      {isFirstForStep &&
                        item.target.kind === FINAL_STEP_PHASES.FINAL_STEP && (
                          <div className="px-3 pt-2 text-[length:var(--fp-output-font-size-xs)] uppercase tracking-wide text-description-fg">
                            Final Step Loop {item.target.index + 1}
                          </div>
                        )}
                      <StatusMessage
                        message={statusData.message}
                        severity={statusData.severity}
                        timestamp={statusData.timestamp}
                        timestampMs={statusData.timestampMs}
                      />
                    </React.Fragment>
                  );
                } else {
                  const cliData = item.data as CliOutputType;
                  // Pass the streaming chunk for the active streaming step.
                  // This prop changes on every token, but React.memo on CliOutput
                  // ensures only the row with a non-empty chunk re-renders.
                  const streamingChunk =
                    item.target.kind === FINAL_STEP_PHASES.QUEUE
                      ? streamingChunks[item.target.index] || ""
                      : finalStepStreamingChunks[item.target.index] || "";
                  const stepSnapshot: WorkspaceSnapshot | undefined =
                    isViewingHistory && historyOutputs
                      ? item.target.kind === FINAL_STEP_PHASES.QUEUE
                        ? historyOutputs.promptOutputs[item.target.index]
                            ?.workspaceSnapshot
                        : historyOutputs.finalStepOutputs?.[item.target.index]
                            ?.workspaceSnapshot
                      : undefined;
                  const stepUndoRecord: UndoRecord | undefined =
                    isViewingHistory && historyOutputs
                      ? item.target.kind === FINAL_STEP_PHASES.QUEUE
                        ? historyOutputs.promptOutputs[item.target.index]
                            ?.undoRecord
                        : historyOutputs.finalStepOutputs?.[item.target.index]
                            ?.undoRecord
                      : undefined;
                  const stepKey = `${item.target.kind}:${item.target.index}`;
                  const isFinalStepOutput =
                    item.target.kind === FINAL_STEP_PHASES.FINAL_STEP;
                  const workflowStep = isFinalStepOutput
                    ? finalStep
                    : steps[item.target.index];
                  return (
                    <React.Fragment key={`cli-${index}`}>
                      {isFirstForStep && (
                        <div
                          id={`output-step-${item.target.kind === FINAL_STEP_PHASES.QUEUE ? "queue" : "final"}-${item.target.index}`}
                        />
                      )}
                      {isFirstForStep &&
                        item.target.kind === FINAL_STEP_PHASES.FINAL_STEP && (
                          <div className="px-3 pt-2 text-[length:var(--fp-output-font-size-xs)] uppercase tracking-wide text-description-fg">
                            Final Step Loop {item.target.index + 1}
                          </div>
                        )}
                      <CliOutput
                        output={cliData}
                        stepIndex={item.target.index}
                        isFinalStep={isFinalStepOutput}
                        stepLabel={
                          isFinalStepOutput
                            ? `Final Step Loop ${item.target.index + 1}`
                            : `Step ${item.target.index + 1}`
                        }
                        stepName={
                          isFinalStepOutput
                            ? getStepName(
                                workflowStep,
                                `Final Step Loop ${item.target.index + 1}`
                              )
                            : workflowStep?.name?.trim() || undefined
                        }
                        attemptIndex={item.attemptIndex || 0}
                        runIndex={item.runIndex ?? cliData.runIndex ?? 0}
                        streamingChunk={streamingChunk}
                        isExecutionActive={isExecutionActive}
                        allowUndoActions={allowUndoActions}
                        workspaceSnapshot={stepSnapshot}
                        undoRecord={stepUndoRecord}
                        allStepOutputs={
                          lastCliIndexPerStep.get(stepKey) === index &&
                          allowUndoActions
                            ? stepOutputsMap.get(stepKey)
                            : undefined
                        }
                      />
                    </React.Fragment>
                  );
                }
              })
            )}
          </div>

          {/* Minimap rail */}
          {hasOutput && (
            <OutputMinimap
              steps={minimapSteps}
              scrollContainerRef={outputRef}
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

      {/* Standalone export modal — browser clients that can't use VS Code save dialog */}
      {exportModalContent !== null && (
        <Modal
          isOpen
          title="Export Output"
          onClose={() => setExportModalContent(null)}
          size="lg"
          footer={
            <>
              <button
                type="button"
                className="px-4 py-2 text-sm text-description-fg hover:text-foreground transition-colors"
                onClick={() => setExportModalContent(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm bg-btn-bg text-btn-fg hover:bg-btn-hover rounded transition-colors"
                onClick={() => {
                  const blob = new Blob([exportModalContent], {
                    type: "text/markdown",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${fileName ?? "output"}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <i className="codicon codicon-cloud-download mr-1" />
                Download
              </button>
            </>
          }
        >
          <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
            {exportModalContent}
          </pre>
        </Modal>
      )}
    </section>
  );
};
