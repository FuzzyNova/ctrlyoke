import React, { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { CliOutput, StatusMessage } from "../output";
import { PanelBar, RunSelector } from "../shared";
import { generateMarkdownExport, formatTime } from "@utils/outputUtils";
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
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";
import { CLI_EVENT_TYPES } from "../../types/cliEvents";
import { OutputMinimap, type MinimapStep, type MinimapDiffBlock, type DiffRun } from "../output/OutputMinimap";
import { UndoChangesDialog } from "../output/UndoChangesDialog";
import {
  buildUndoDialogInputForPrompt,
  computePromptUndoActions,
  type UndoDialogInput,
} from "../../utils/promptUndo";
import type { UndoFileInstruction } from "../../types/messages";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to consider "at bottom"

/**
 * Combined message type for chronological sorting
 */
interface OutputMessage {
  type: "status" | "cli";
  target:
    | { kind: "queue"; index: number }
    | { kind: "finalPrompt"; index: number };
  timestamp: number;
  data: OutputStatusMessage | CliOutputType;
  attemptIndex?: number;
}

interface MinimapDialogState {
  mode: "undo" | "redo";
  target: UndoExecutionTarget;
  workspacePath: string;
  input?: UndoDialogInput;
  redoInstructions?: UndoFileInstruction[];
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
  const cliOutputs = useWorkflowStore((s) => s.cliOutputs);
  const finalPromptOutputs = useWorkflowStore((s) => s.finalPromptOutputs);
  const statusMessages = useWorkflowStore((s) => s.statusMessages);
  const finalPromptStatusMessages = useWorkflowStore(
    (s) => s.finalPromptStatusMessages
  );
  // streamingChunks changes on every token — keep it isolated so the
  // auto-scroll effect doesn't require rebuilding allMessages.
  const streamingChunks = useWorkflowStore((s) => s.streamingChunks);
  const historyOutputs = useWorkflowStore((s) => s.historyOutputs);
  const workspaceSnapshots = useWorkflowStore((s) => s.workspaceSnapshots);
  const finalPromptWorkspaceSnapshots = useWorkflowStore(
    (s) => s.finalPromptWorkspaceSnapshots
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
  const toggleDiffsCollapsed = useUiStore((s) => s.toggleDiffsCollapsed);
  const outputFontSize = useUiStore((s) => s.outputFontSize);
  const setOutputFontSize = useUiStore((s) => s.setOutputFontSize);

  const outputRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const autoscrollEnabled = useRef(true);
  const isProgrammaticScroll = useRef(false);

  // Scroll position tracked for the minimap viewport indicator
  const [minimapScrollTop, setMinimapScrollTop] = useState(0);

  // Real pixel fractions for each step anchor (key → offsetTop / scrollHeight)
  const [stepScrollFractions, setStepScrollFractions] = useState<Map<string, number>>(
    new Map()
  );

  // DOM measurements for diff anchor elements (anchorId → position + collapse state)
  const [diffMeasurements, setDiffMeasurements] = useState<
    Map<string, { startFraction: number; heightFraction: number; isCollapsed: boolean }>
  >(new Map());

  // Shared prompt-level undo/redo dialog (owned here, triggered from minimap)
  const [minimapDialogState, setMinimapDialogState] =
    useState<MinimapDialogState | null>(null);

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

  // Determine which steps data source to use: history snapshot or live outputs
  const stepsToRender = useMemo(() => {
    if (isViewingHistory && historyOutputs) {
      const queueSteps = Array.from(
        { length: historyOutputs.stepCount },
        (_, i) => ({
          target: { kind: "queue" as const, index: i },
          cliOutputs: historyOutputs.steps[i]?.cliOutputs ?? [],
          statusMessages: historyOutputs.steps[i]?.statusMessages ?? [],
        })
      );

      const finalOutputs = historyOutputs.finalPromptOutputs ?? {};
      const finalSteps = Object.keys(finalOutputs)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
        .map((loopIndex) => ({
          target: { kind: "finalPrompt" as const, index: loopIndex },
          cliOutputs: finalOutputs[loopIndex]?.cliOutputs ?? [],
          statusMessages: finalOutputs[loopIndex]?.statusMessages ?? [],
        }));

      return [...queueSteps, ...finalSteps];
    }

    const queueSteps = Array.from({ length: totalSteps }, (_, i) => ({
      target: { kind: "queue" as const, index: i },
      cliOutputs: cliOutputs[i] ?? [],
      statusMessages: statusMessages[i] ?? [],
    }));

    const finalSteps = Object.keys(finalPromptOutputs)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
      .map((loopIndex) => ({
        target: { kind: "finalPrompt" as const, index: loopIndex },
        cliOutputs: finalPromptOutputs[loopIndex] ?? [],
        statusMessages: finalPromptStatusMessages[loopIndex] ?? [],
      }));

    return [...queueSteps, ...finalSteps];
  }, [
    isViewingHistory,
    historyOutputs,
    totalSteps,
    cliOutputs,
    statusMessages,
    finalPromptOutputs,
    finalPromptStatusMessages,
  ]);

  // Build chronologically sorted list of all messages.
  // This memo depends on stepsToRender (not streamingChunks), so it only
  // rebuilds when actual output records change — not on every streaming token.
  const allMessages = useMemo((): OutputMessage[] => {
    const messages: OutputMessage[] = [];

    for (const step of stepsToRender) {
      const { target } = step;
      const executionIndex = target.index;

      // Add status messages
      const stepStatusMessages = step.statusMessages || [];
      stepStatusMessages.forEach((statusMsg, index) => {
        messages.push({
          type: "status",
          target,
          timestamp: statusMsg.timestamp || executionIndex * 10000 + index,
          data: {
            message: statusMsg.message,
            severity: statusMsg.severity,
            timestamp: formatTime(statusMsg.timestamp),
            timestampMs: statusMsg.timestamp,
          },
        });
      });

      // Add CLI outputs - use explicit attemptIndex from data, not array position
      const stepOutputs = step.cliOutputs || [];
      stepOutputs.forEach((output) => {
        const cliOutput = output as CliOutputType & {
          timestampMs?: number;
          attemptIndex?: number;
        };
        const explicitAttemptIndex = cliOutput.attemptIndex ?? 0;
        messages.push({
          type: "cli",
          target,
          timestamp:
            cliOutput.timestampMs ||
            executionIndex * 10000 +
              stepStatusMessages.length +
              explicitAttemptIndex,
          data: output as unknown as CliOutputType,
          attemptIndex: explicitAttemptIndex,
        });
      });
    }

    // Sort by timestamp
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }, [stepsToRender]);

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
  }, [allMessages, streamingChunks]);

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
      for (const step of stepsToRender) {
        const kindSlug = step.target.kind === "queue" ? "queue" : "final";
        const anchor = document.getElementById(
          `output-step-${kindSlug}-${step.target.index}`
        );
        if (anchor) {
          const pixelPos =
            anchor.getBoundingClientRect().top - containerTop + container.scrollTop;
          fractions.set(`${step.target.kind}:${step.target.index}`, pixelPos / scrollHeight);
        }
      }
      setStepScrollFractions(fractions);

      // Measure diff anchor elements so the minimap can render colored overlays.
      // data-diff-anchor divs wrap file-operation events in StructuredOutput and
      // reflect the actual rendered height (collapsed or expanded).
      const diffAnchors = container.querySelectorAll<HTMLElement>("[data-diff-anchor]");
      const newDiffMeasurements = new Map<string, { startFraction: number; heightFraction: number; isCollapsed: boolean }>();
      diffAnchors.forEach((el) => {
        const pixelTop =
          el.getBoundingClientRect().top - containerTop + container.scrollTop;
        // Read actual collapse state set by DiffView's useEffect on the anchor.
        // Fall back to the global diffsCollapsed default when the attribute isn't
        // stamped yet (e.g. before DiffView's first effect flush).
        const attrVal = el.getAttribute("data-diff-collapsed");
        const isCollapsed = attrVal !== null ? attrVal === "true" : diffsCollapsed;
        newDiffMeasurements.set(el.id, {
          startFraction: pixelTop / scrollHeight,
          heightFraction: el.offsetHeight / scrollHeight,
          isCollapsed,
        });
      });
      setDiffMeasurements(newDiffMeasurements);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [allMessages, stepsToRender, diffsCollapsed]);

  // Export handler
  const handleExport = useCallback(() => {
    const vscode = getVsCodeApi();
    if (!vscode) return;

    const markdownContent = generateMarkdownExport(
      allMessages.map((msg) => ({
        type: msg.type,
        stepIndex: msg.target.index,
        timestamp: msg.timestamp,
        data: msg.data,
        attemptIndex: msg.attemptIndex,
      })),
      {
        fileName: fileName || "Unknown",
        executionState,
        currentStep,
        totalSteps,
      }
    );

    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName,
    });
  }, [allMessages, fileName, executionState, currentStep, totalSteps]);

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
    for (const step of stepsToRender) {
      const key = `${step.target.kind}:${step.target.index}`;
      map.set(key, step.cliOutputs as CliOutputType[]);
    }
    return map;
  }, [stepsToRender]);

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

  const isExecutionActive =
    executionState === EXECUTION_STATES.RUNNING ||
    executionState === EXECUTION_STATES.CANCELLING;

  // Only show undo actions when execution is not active
  const allowUndoActions = !isExecutionActive;

  // ── Diff line count helper ─────────────────────────────────────────────────

  /**
   * Extract diff statistics and run sequence for a single CLI event.
   * Returns added/removed totals (for collapsed display) plus an ordered
   * runs array (for expanded VS Code-style minimap strips).
   * Runs are only populated when structuredPatch hunk data is available.
   */
  function computeDiffStats(
    event: CliEvent
  ): { added: number; removed: number; runs: DiffRun[] } {
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
              line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context";
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
        // No hunk data — rough estimate, no run sequence available
        return {
          added: data.newContent.split("\n").length,
          removed: data.oldContent.split("\n").length,
          runs: [],
        };
      }
      return { added: 0, removed: 0, runs: [] };
    }
    if (event.type === CLI_EVENT_TYPES.FILE_WRITE) {
      const data = event.data as FileWriteData;
      const lines = data.content ? data.content.split("\n").length : 1;
      return { added: lines, removed: 0, runs: [{ type: "added", count: lines }] };
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
    if (!allowUndoActions) return [];

    return stepsToRender.flatMap((step) => {
      const key = `${step.target.kind}:${step.target.index}`;
      const firstIdx = firstIndexByStep.get(key);
      if (firstIdx === undefined) return [];

      const kind = step.target.kind;
      const stepIndex = step.target.index;
      const isFinalPrompt = kind === "finalPrompt";
      const label = isFinalPrompt
        ? `Final Prompt Loop ${stepIndex + 1}`
        : `Prompt ${stepIndex + 1}`;

      // Real pixel fraction — falls back to index fraction until DOM is measured
      const scrollFraction =
        stepScrollFractions.get(key) ??
        firstIdx / Math.max(1, allMessages.length);

      // Only the last CLI attempt gets undo/redo actions
      const lastCliIdx = lastCliIndexPerStep.get(key);
      const noActions: MinimapStep["undoActions"] = { undo: null, redo: null };
      if (lastCliIdx === undefined) {
        return [{ key, kind, stepIndex, firstMessageIndex: firstIdx, scrollFraction, label, undoActions: noActions, diffBlocks: [] }];
      }

      const lastMsg = allMessages[lastCliIdx];
      const lastOutput = lastMsg?.data as CliOutputType | undefined;
      if (!lastOutput || lastOutput.isStreaming) {
        return [{ key, kind, stepIndex, firstMessageIndex: firstIdx, scrollFraction, label, undoActions: noActions, diffBlocks: [] }];
      }

      const stepOutputs = stepOutputsMap.get(key) ?? [];
      const targetKey = isFinalPrompt
        ? `finalPrompt-${stepIndex}`
        : `queue-${stepIndex}`;
      const target: UndoExecutionTarget = isFinalPrompt
        ? { kind: "finalPrompt", loopIndex: stepIndex }
        : { kind: "queue", stepIndex };

      let effectiveSnapshot: WorkspaceSnapshot | undefined;
      let effectiveUndoRecord: UndoRecord | undefined;

      if (isViewingHistory && historyOutputs) {
        effectiveSnapshot =
          kind === "queue"
            ? historyOutputs.steps[stepIndex]?.workspaceSnapshot
            : historyOutputs.finalPromptOutputs?.[stepIndex]?.workspaceSnapshot;
        effectiveUndoRecord =
          kind === "queue"
            ? historyOutputs.steps[stepIndex]?.undoRecord
            : historyOutputs.finalPromptOutputs?.[stepIndex]?.undoRecord;
      } else {
        effectiveSnapshot = isFinalPrompt
          ? finalPromptWorkspaceSnapshots[stepIndex]
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
                  target,
                  workspacePath,
                  redoInstructions: effectiveUndoRecord!.redoInstructions,
                  requestId: crypto.randomUUID(),
                });
              },
            }
          : null,
        undo: actions.undo
          ? {
              label: actions.undo.label,
              onTrigger: () => {
                const alreadyUndone =
                  effectiveUndoRecord != null && effectiveUndoRecord.isRedone !== true
                    ? effectiveUndoRecord.redoInstructions
                    : undefined;
                const input = buildUndoDialogInputForPrompt(
                  target,
                  stepOutputs,
                  effectiveSnapshot,
                  workspacePath,
                  alreadyUndone
                );
                setMinimapDialogState({
                  mode: "undo",
                  target,
                  workspacePath,
                  input,
                  requestId: crypto.randomUUID(),
                });
              },
            }
          : null,
      };

      // Build diff blocks for this step: one entry per file-operation event that
      // has a DOM measurement anchor (set by StructuredOutput when not hideDiff).
      const kindSlug = isFinalPrompt ? "fp" : "q";
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
          ) return;
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

      return [{ key, kind, stepIndex, firstMessageIndex: firstIdx, scrollFraction, label, undoActions, diffBlocks }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allowUndoActions,
    stepsToRender,
    firstIndexByStep,
    lastCliIndexPerStep,
    allMessages,
    stepOutputsMap,
    stepScrollFractions,
    diffMeasurements,
    isViewingHistory,
    historyOutputs,
    workspaceSnapshots,
    finalPromptWorkspaceSnapshots,
    undoRecords,
  ]);

  if (outputCollapsed) {
    return (
      <PanelBar
        orientation="horizontal"
        icon="terminal"
        title="Output"
        onClick={toggleOutputCollapse}
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
      <div className="flex items-center justify-between gap-[var(--spacing-sm)] h-[30px] px-2 border-b border-panel-border flex-shrink-0 bg-sidebar-bg">
        {/* Left: clickable collapse area + font size controls */}
        <div className="flex items-center gap-1">
          <div
            className="flex items-center gap-1 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
            onClick={toggleOutputCollapse}
            role="button"
            aria-label="Collapse output"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && toggleOutputCollapse()}
          >
            <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
            <i className="codicon codicon-terminal text-[14px]" />
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              Output
            </span>
          </div>
          {/* Font size stepper — grouped tightly, separated from title by ml-2 */}
          <div className="flex items-center ml-3">
            <button
              className="icon-btn py-0 px-0.5"
              title="Decrease font size"
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
              onClick={() => setOutputFontSize(outputFontSize + 1)}
              disabled={outputFontSize >= 24}
            >
              <i className="codicon codicon-sm codicon-add" />
            </button>
          </div>
        </div>

        {/* Right: controls */}
        <div className="ml-auto flex items-center gap-2">
          {availableRuns > 0 && (
            <RunSelector
              availableRuns={availableRuns}
              currentRunIndex={viewingRunIndex}
              isViewingHistory={isViewingHistory}
              isLiveRunActive={executionState === EXECUTION_STATES.RUNNING}
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
              className="icon-btn py-0 px-2"
              title={diffsCollapsed ? "Expand all diffs" : "Collapse all diffs"}
              onClick={toggleDiffsCollapsed}
            >
              <i
                className={`codicon codicon-sm ${diffsCollapsed ? "codicon-diff" : "codicon-diff-ignored"}`}
              />
            </button>
          )}
          <button
            className="icon-btn py-0 px-2"
            id="export-btn"
            title="Export output to markdown"
            onClick={handleExport}
            disabled={!hasOutput}
          >
            <i className="codicon codicon-sm codicon-export" />
          </button>
        </div>
      </div>

      {/* Output Content row: scrollable output + minimap rail */}
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
                {new Date(historyOutputs.runMetadata.startedAt).toLocaleString()}
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
                        id={`output-step-${item.target.kind === "queue" ? "queue" : "final"}-${item.target.index}`}
                      />
                    )}
                    {isFirstForStep && item.target.kind === "finalPrompt" && (
                      <div className="px-3 pt-2 text-[length:var(--fp-output-font-size-xs)] uppercase tracking-wide text-description-fg">
                        Final Prompt Loop {item.target.index + 1}
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
                // Only pass the streaming chunk for queue-type steps.
                // This prop changes on every token, but React.memo on CliOutput
                // ensures only the row with a non-empty chunk re-renders.
                const streamingChunk =
                  item.target.kind === "queue"
                    ? streamingChunks[item.target.index] || ""
                    : "";
                const stepSnapshot: WorkspaceSnapshot | undefined =
                  isViewingHistory && historyOutputs
                    ? item.target.kind === "queue"
                      ? historyOutputs.steps[item.target.index]?.workspaceSnapshot
                      : historyOutputs.finalPromptOutputs?.[item.target.index]
                          ?.workspaceSnapshot
                    : undefined;
                const stepUndoRecord: UndoRecord | undefined =
                  isViewingHistory && historyOutputs
                    ? item.target.kind === "queue"
                      ? historyOutputs.steps[item.target.index]?.undoRecord
                      : historyOutputs.finalPromptOutputs?.[item.target.index]
                          ?.undoRecord
                    : undefined;
                const stepKey = `${item.target.kind}:${item.target.index}`;
                return (
                  <React.Fragment key={`cli-${index}`}>
                    {isFirstForStep && (
                      <div
                        id={`output-step-${item.target.kind === "queue" ? "queue" : "final"}-${item.target.index}`}
                      />
                    )}
                    {isFirstForStep && item.target.kind === "finalPrompt" && (
                      <div className="px-3 pt-2 text-[length:var(--fp-output-font-size-xs)] uppercase tracking-wide text-description-fg">
                        Final Prompt Loop {item.target.index + 1}
                      </div>
                    )}
                    <CliOutput
                      output={cliData}
                      stepIndex={item.target.index}
                      stepLabel={
                        item.target.kind === "queue"
                          ? undefined
                          : `Final Prompt Loop ${item.target.index + 1}`
                      }
                      attemptIndex={item.attemptIndex || 0}
                      streamingChunk={streamingChunk}
                      isExecutionActive={isExecutionActive}
                      allowUndoActions={allowUndoActions}
                      workspaceSnapshot={stepSnapshot}
                      undoRecord={stepUndoRecord}
                      allStepOutputs={
                        lastCliIndexPerStep.get(stepKey) === index && allowUndoActions
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
    </section>
  );
};
