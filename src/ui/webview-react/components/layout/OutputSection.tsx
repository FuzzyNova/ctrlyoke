import React, {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
} from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { CliOutput, StatusMessage } from "../output";
import { PanelBar, RunSelector, IconToggleButton } from "../shared";
import { generateDiffLines } from "@utils/outputUtils";
import { generateId } from "@utils/string";
import { generateMarkdownExport } from "@utils/markdownExport";
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

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to consider "at bottom"

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

  // Execution mode toggle
  const executionMode = useSettingsStore((s) => s.globalSettings.executionMode);
  const handleExecutionModeChange = useCallback((active: boolean) => {
    const vscode = getVsCodeApi();
    vscode?.postMessage({
      type: MESSAGE_TYPES.CHANGE_EXECUTION_MODE,
      executionMode: active
        ? EXECUTION_MODES.INTERACTIVE
        : EXECUTION_MODES.HEADLESS,
    });
  }, []);

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
  const showTerminalTab = true;
  const terminalSessionActive = terminalActiveWorkflows.has(terminalWorkflowId);

  const [headerRef, isHeaderNarrow] = useElementNarrow(600);

  const outputRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const autoscrollEnabled = useRef(true);
  const isProgrammaticScroll = useRef(false);

  // Scroll position tracked for the minimap viewport indicator
  const [minimapScrollTop, setMinimapScrollTop] = useState(0);

  // Real pixel fractions for each step anchor (key → offsetTop / scrollHeight)
  const [stepScrollFractions, setStepScrollFractions] = useState<
    Map<string, number>
  >(new Map());

  // DOM measurements for diff anchor elements (anchorId → position + collapse state)
  const [diffMeasurements, setDiffMeasurements] = useState<
    Map<
      string,
      { startFraction: number; heightFraction: number; isCollapsed: boolean }
    >
  >(new Map());

  // Shared prompt-level undo/redo dialog (owned here, triggered from minimap)
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);

  // Workflow-level undo/redo dialog (aggregates all prompt-level changes)
  const [workflowDialogState, setWorkflowDialogState] =
    useState<WorkflowDialogState | null>(null);

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

  // Smart scroll: detect user scrolling away from bottom
  const handleScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const el = outputRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD;
    autoscrollEnabled.current = atBottom;
    setMinimapScrollTop(el.scrollTop);
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
      setStepScrollFractions(fractions);

      // Measure diff anchor elements so the minimap can render colored overlays.
      // data-diff-anchor divs wrap file-operation events in StructuredOutput and
      // reflect the actual rendered height (collapsed or expanded).
      const diffAnchors =
        container.querySelectorAll<HTMLElement>("[data-diff-anchor]");
      const newDiffMeasurements = new Map<
        string,
        { startFraction: number; heightFraction: number; isCollapsed: boolean }
      >();
      diffAnchors.forEach((el) => {
        const pixelTop =
          el.getBoundingClientRect().top - containerTop + container.scrollTop;
        // Read actual collapse state set by DiffView's useEffect on the anchor.
        // Fall back to the global diffsCollapsed default when the attribute isn't
        // stamped yet (e.g. before DiffView's first effect flush).
        const attrVal = el.getAttribute("data-diff-collapsed");
        const isCollapsed =
          attrVal !== null ? attrVal === "true" : diffsCollapsed;
        newDiffMeasurements.set(el.id, {
          startFraction: pixelTop / scrollHeight,
          heightFraction: el.offsetHeight / scrollHeight,
          isCollapsed,
        });
      });
      setDiffMeasurements(newDiffMeasurements);
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    // Watch for individual diff expand/collapse — DiffView stamps data-diff-collapsed
    // on [data-diff-anchor] elements, but the container's clientHeight doesn't change
    // (it's overflow-y-auto with fixed visual height), so ResizeObserver won't fire.
    // MutationObserver catches the attribute change and triggers a re-measure.
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(container, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-diff-collapsed"],
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    // activeOutputTab is included so a re-measure fires when switching back from
    // the terminal tab — the output div is unmounted while terminal is active, so
    // its DOM measurements become stale and must be refreshed on re-mount.
  }, [allMessages, uniqueStepTargets, diffsCollapsed, activeOutputTab]);

  // Export handler
  const handleExport = useCallback(() => {
    const vscode = getVsCodeApi();
    if (!vscode) return;

    const markdownContent = generateMarkdownExport(
      allMessages.map((msg) => ({
        type: msg.type,
        target: msg.target,
        timestamp: msg.timestamp,
        sequence: msg.sequence,
        data: msg.data,
        attemptIndex: msg.attemptIndex,
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
    historyOutputs,
    isViewingHistory,
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

  // Check if there's any output
  const hasOutput = allMessages.length > 0;

  // Derive whether any diff is currently collapsed from DOM measurements.
  // Falls back to the store value before the DOM has been measured.
  // Used to show the correct "Expand all" vs "Collapse all" button label.
  const anyDiffCollapsed =
    diffMeasurements.size === 0
      ? diffsCollapsed
      : Array.from(diffMeasurements.values()).some((m) => m.isCollapsed);

  const isExecutionActive =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

  // Only show undo actions when execution is not active
  const allowUndoActions = !isExecutionActive;

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

  // ── Diff line count helper ─────────────────────────────────────────────────

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
        let added = 0;
        let removed = 0;
        const runs: DiffRun[] = [];
        let currentType: DiffRun["type"] | null = null;
        let currentCount = 0;

        const flushRun = () => {
          if (currentType !== null && currentCount > 0) {
            runs.push({ type: currentType, count: currentCount });
          }
        };

        for (const hunk of data.structuredPatch) {
          for (const line of hunk.lines) {
            const lineType: DiffRun["type"] =
              line[0] === "+"
                ? "added"
                : line[0] === "-"
                  ? "removed"
                  : "context";
            if (lineType === "added") added++;
            else if (lineType === "removed") removed++;
            if (lineType === currentType) {
              currentCount++;
            } else {
              flushRun();
              currentType = lineType;
              currentCount = 1;
            }
          }
        }
        flushRun();
        return { added, removed, runs };
      }
      if (data.oldContent && data.newContent) {
        // No structuredPatch — compute runs from the same diff algorithm used
        // by DiffView so the minimap gradient matches the DOM rendering exactly.
        let added = 0;
        let removed = 0;
        const runs: DiffRun[] = [];
        let currentType: DiffRun["type"] | null = null;
        let currentCount = 0;

        const flushRun = () => {
          if (currentType !== null && currentCount > 0) {
            runs.push({ type: currentType, count: currentCount });
          }
        };

        for (const line of generateDiffLines(
          data.oldContent,
          data.newContent
        )) {
          if (line.type === "added") added++;
          else if (line.type === "removed") removed++;
          if (line.type === currentType) {
            currentCount++;
          } else {
            flushRun();
            currentType = line.type;
            currentCount = 1;
          }
        }
        flushRun();
        return { added, removed, runs };
      }
      return { added: 0, removed: 0, runs: [] };
    }
    if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
      const data = event.data as FileWriteData;
      const lines = data.content ? data.content.split("\n").length : 1;
      return {
        added: lines,
        removed: 0,
        runs: [{ type: "added", count: lines }],
      };
    }
    if (event.type === CLI_EVENT_TYPES.FILE_DELETE) {
      return { added: 0, removed: 1, runs: [{ type: "removed", count: 1 }] };
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
      const label = isFinalStep
        ? `Final Step Loop ${stepIndex + 1}`
        : `Prompt ${stepIndex + 1}`;

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
        const typedOutput = output as CliOutputType & { attemptIndex?: number };
        const attemptIdx = typedOutput.attemptIndex ?? 0;
        const anchorPrefix = `fp-diff-${kindSlug}-${stepIndex}-a${attemptIdx}`;
        const events = typedOutput.structured?.events ?? [];
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
          const stats = computeDiffStats(event);
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
  ]);

  if (outputCollapsed) {
    return (
      <PanelBar
        orientation="horizontal"
        icon="terminal"
        title="Output"
        onClick={() => {
          triggerPanelAnimation();
          toggleOutputCollapse();
        }}
      />
    );
  }

  return (
    <section
      ref={sectionRef}
      id="output-section"
      className="min-h-0 flex-1 bg-editor-bg flex flex-col h-full"
    >
      {/* Section Header */}
      <div
        ref={headerRef}
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
            <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
            <i className="codicon codicon-terminal text-[14px]" />
          </div>

          {/* Output / Terminal tab buttons */}
          {showTerminalTab ? (
            <div className="flex items-center ml-1">
              <button
                className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 transition-colors
                  ${
                    activeOutputTab === "output"
                      ? "text-foreground border-b border-foreground"
                      : "text-description-fg hover:text-foreground"
                  }`}
                onClick={() => setActiveOutputTab(terminalWorkflowId, "output")}
              >
                Output
              </button>
              <button
                className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 flex items-center gap-1 transition-colors
                  ${
                    activeOutputTab === "terminal"
                      ? "text-foreground border-b border-foreground"
                      : "text-description-fg hover:text-foreground"
                  }`}
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
                Terminal
                {terminalSessionActive && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                )}
              </button>
            </div>
          ) : (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-description-fg ml-1">
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
              <span className="text-[10px] text-description-fg tabular-nums w-[20px] text-center select-none">
                {outputFontSize}
              </span>
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
                onClick={() => setTerminalFontSize(terminalFontSize - 1)}
                disabled={terminalFontSize <= 10}
              >
                <i className="codicon codicon-sm codicon-remove" />
              </button>
              <span className="text-[10px] text-description-fg tabular-nums w-[20px] text-center select-none">
                {terminalFontSize}
              </span>
              <button
                className="icon-btn py-0 px-0.5"
                title="Increase terminal font size"
                aria-label="Increase terminal font size"
                onClick={() => setTerminalFontSize(terminalFontSize + 1)}
                disabled={terminalFontSize >= 24}
              >
                <i className="codicon codicon-sm codicon-add" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Right: controls */}
        <div className="ml-auto flex items-center gap-2">
          {activeOutputTab === "terminal" && (
            <>
              <button
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-description-fg hover:text-foreground transition-colors"
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
                <i className="codicon codicon-add text-[12px]" />
                <span>New Terminal</span>
              </button>
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
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-link-fg hover:text-link-active-fg transition-colors"
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
                      <i className="codicon codicon-discard text-[12px]" />
                      <span>
                        {isHeaderNarrow ? "Undo" : `Undo ${count} changes`}
                      </span>
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
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-terminal-ansiGreen hover:opacity-80 transition-opacity"
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
                      <i className="codicon codicon-redo text-[12px]" />
                      <span>
                        {isHeaderNarrow ? "Redo" : `Redo ${count} changes`}
                      </span>
                    </button>
                  );
                })()}
              {availableRuns > 0 && (
                <RunSelector
                  availableRuns={availableRuns}
                  currentRunIndex={viewingRunIndex}
                  isViewingHistory={isViewingHistory}
                  isLiveRunActive={executionState === EXECUTION_STATES.RUNNING}
                  narrow={isHeaderNarrow}
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
                <button
                  className="icon-btn py-1 px-1"
                  title={
                    anyDiffCollapsed ? "Expand all diffs" : "Collapse all diffs"
                  }
                  aria-label={
                    anyDiffCollapsed ? "Expand all diffs" : "Collapse all diffs"
                  }
                  onClick={() =>
                    anyDiffCollapsed ? expandAllDiffs() : collapseAllDiffs()
                  }
                >
                  <i
                    className={`codicon codicon-sm ${anyDiffCollapsed ? "codicon-diff" : "codicon-diff-ignored"}`}
                  />
                </button>
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

      {/* Output Content: toggle between Output view and Terminal view */}
      {activeOutputTab === "terminal" ? (
        <div className="flex flex-row min-h-0 flex-1">
          <TerminalView workflowId={terminalWorkflowId} />
        </div>
      ) : (
        <div className="flex flex-row min-h-0 flex-1">
          {/* Scrollable output */}
          <div
            ref={outputRef}
            id="output-content"
            className="font-mono text-[length:var(--fp-output-font-size-sm)] min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
            onScroll={handleScroll}
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
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-bash-status-success animate-pulse align-middle" />
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
                        stepLabel={
                          item.target.kind === FINAL_STEP_PHASES.QUEUE
                            ? undefined
                            : `Final Step Loop ${item.target.index + 1}`
                        }
                        attemptIndex={item.attemptIndex || 0}
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
              scrollTop={minimapScrollTop}
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
    </section>
  );
};
