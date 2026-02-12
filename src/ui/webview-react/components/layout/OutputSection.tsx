import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { CliOutput, StatusMessage } from "../output";
import { PanelBar } from "../shared";
import { generateMarkdownExport, formatTime } from "@utils/outputUtils";
import type { CliOutputItem, OutputStatusMessage } from "../../types/cliEvents";
import { MESSAGE_TYPES } from "../../types/messages";

const SCROLL_BOTTOM_THRESHOLD = 40; // px from bottom to consider "at bottom"

/**
 * Combined message type for chronological sorting
 */
interface OutputMessage {
  type: "status" | "cli";
  stepIndex: number;
  timestamp: number;
  data: OutputStatusMessage | CliOutputItem;
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
  } = useWorkflowStore();
  const { outputCollapsed, toggleOutputCollapse } = useUiStore();
  const outputRef = useRef<HTMLDivElement>(null);
  const autoscrollEnabled = useRef(true);
  const isProgrammaticScroll = useRef(false);

  // Build chronologically sorted list of all messages
  const allMessages = useMemo((): OutputMessage[] => {
    const messages: OutputMessage[] = [];

    // Iterate through all steps
    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex++) {
      // Add status messages
      const stepStatusMessages = statusMessages[stepIndex] || [];
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
      const stepOutputs = cliOutputs[stepIndex] || [];
      stepOutputs.forEach((output) => {
        const cliOutput = output as CliOutputItem & {
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
          data: output as unknown as CliOutputItem,
          attemptIndex: explicitAttemptIndex,
        });
      });
    }

    // Sort by timestamp
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }, [cliOutputs, statusMessages, totalSteps]);

  // Smart scroll: detect user scrolling away from bottom
  const handleScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const el = outputRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
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
      id="output-section"
      className="min-h-0 flex-1 bg-[var(--bg-primary)] flex flex-col h-full"
    >
      {/* Section Header */}
      <div className="flex items-center justify-between gap-[var(--spacing-sm)] h-[30px] px-2 border-b border-[var(--vscode-panel-border)] flex-shrink-0 bg-[var(--vscode-sideBar-background)]">
        {/* Left: clickable collapse area */}
        <div
          className="flex items-center gap-1 cursor-pointer select-none text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] transition-colors"
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
          <button
            className="icon-btn py-0.5 px-2"
            id="export-btn"
            title="Export output to markdown"
            onClick={handleExport}
            disabled={!hasOutput}
          >
            <i className="codicon codicon-export" />
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
        {!hasOutput ? (
          <p className="text-center text-[var(--fg-secondary)] italic p-[var(--spacing-lg)]">
            Output will appear here during execution
          </p>
        ) : (
          allMessages.map((item, index) => {
            if (item.type === "status") {
              const statusData = item.data as OutputStatusMessage;
              return (
                <StatusMessage
                  key={`status-${index}`}
                  message={statusData.message}
                  severity={statusData.severity}
                  timestamp={statusData.timestamp}
                  timestampMs={statusData.timestampMs}
                />
              );
            } else {
              const cliData = item.data as CliOutputItem;
              const streamingChunk = streamingChunks[item.stepIndex] || "";
              return (
                <CliOutput
                  key={`cli-${index}`}
                  output={cliData}
                  stepIndex={item.stepIndex}
                  attemptIndex={item.attemptIndex || 0}
                  streamingChunk={streamingChunk}
                />
              );
            }
          })
        )}
      </div>
    </section>
  );
};
