import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { CliOutput, StatusMessage } from "../output";
import { PanelBar, RunSelector } from "../shared";
import { generateMarkdownExport, formatTime } from "@utils/outputUtils";
import type {
  CliOutput as CliOutputType,
  OutputStatusMessage,
} from "../../types/cliEvents";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to consider "at bottom"

/**
 * Combined message type for chronological sorting
 */
interface OutputMessage {
  type: "status" | "cli";
  stepIndex: number;
  timestamp: number;
  data: OutputStatusMessage | CliOutputType;
  attemptIndex?: number;
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
 */
export const OutputSection: React.FC = () => {
  const {
    fileName,
    executionState,
    currentStep,
    totalSteps,
    cliOutputs,
    statusMessages,
    streamingChunks,
    historyOutputs,
  } = useWorkflowStore();
  const {
    outputCollapsed,
    toggleOutputCollapse,
    isViewingHistory,
    viewingRunIndex,
    availableRuns,
    runTimestamps,
    runStates,
  } = useUiStore();
  const outputRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const autoscrollEnabled = useRef(true);
  const isProgrammaticScroll = useRef(false);

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
      // History mode: render all steps from the historical run, independent of current workflow
      return Array.from({ length: historyOutputs.stepCount }, (_, i) => ({
        stepIndex: i,
        cliOutputs: historyOutputs.steps[i]?.cliOutputs ?? [],
        statusMessages: historyOutputs.steps[i]?.statusMessages ?? [],
      }));
    }
    // Live mode: render steps from current workflow
    return Array.from({ length: totalSteps }, (_, i) => ({
      stepIndex: i,
      cliOutputs: cliOutputs[i] ?? [],
      statusMessages: statusMessages[i] ?? [],
    }));
  }, [
    isViewingHistory,
    historyOutputs,
    totalSteps,
    cliOutputs,
    statusMessages,
  ]);

  // Build chronologically sorted list of all messages
  const allMessages = useMemo((): OutputMessage[] => {
    const messages: OutputMessage[] = [];

    for (const step of stepsToRender) {
      const { stepIndex } = step;

      // Add status messages
      const stepStatusMessages = step.statusMessages || [];
      stepStatusMessages.forEach((statusMsg, index) => {
        messages.push({
          type: "status",
          stepIndex,
          timestamp: statusMsg.timestamp || stepIndex * 10000 + index,
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
          stepIndex,
          timestamp:
            cliOutput.timestampMs ||
            stepIndex * 10000 +
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
  }, []);

  // Auto-scroll effect
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

  // Export handler
  const handleExport = useCallback(() => {
    const vscode = getVsCodeApi();
    if (!vscode) return;

    const markdownContent = generateMarkdownExport(
      allMessages.map((msg) => ({
        type: msg.type,
        stepIndex: msg.stepIndex,
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
    const map = new Map<number, number>();
    allMessages.forEach((msg, idx) => {
      if (!map.has(msg.stepIndex)) {
        map.set(msg.stepIndex, idx);
      }
    });
    return map;
  }, [allMessages]);

  // Check if there's any output
  const hasOutput = allMessages.length > 0;

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
        {/* Left: clickable collapse area */}
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
            />
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

      {/* Output Content */}
      <div
        ref={outputRef}
        id="output-content"
        className="font-mono text-[11px] min-h-0 p-0 flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {/* History banner: shown when viewing a historical run */}
        {isViewingHistory && historyOutputs && (
          <div className="px-3 py-2 text-[11px] text-description-fg bg-editor-bg border-b border-widget-border flex items-center justify-between flex-shrink-0">
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
            const isFirstForStep = firstIndexByStep.get(item.stepIndex) === index;
            if (item.type === "status") {
              const statusData = item.data as OutputStatusMessage;
              return (
                <React.Fragment key={`status-${index}`}>
                  {isFirstForStep && (
                    <div id={`output-step-${item.stepIndex}`} />
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
              const streamingChunk = streamingChunks[item.stepIndex] || "";
              return (
                <React.Fragment key={`cli-${index}`}>
                  {isFirstForStep && (
                    <div id={`output-step-${item.stepIndex}`} />
                  )}
                  <CliOutput
                    output={cliData}
                    stepIndex={item.stepIndex}
                    attemptIndex={item.attemptIndex || 0}
                    streamingChunk={streamingChunk}
                  />
                </React.Fragment>
              );
            }
          })
        )}
      </div>
    </section>
  );
};
