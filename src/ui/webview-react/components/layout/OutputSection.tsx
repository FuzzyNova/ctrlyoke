import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { CliOutput, StatusMessage } from "../output";
import { generateMarkdownExport, formatTime } from "@utils/outputUtils";
import type { CliOutputItem, OutputStatusMessage } from "../../types/cliEvents";
import { MESSAGE_TYPES } from "../../types/messages";

// VS Code API type
declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

// Get vscode API (singleton pattern)
let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;
const getVsCodeApi = () => {
  if (!vscodeApi && typeof acquireVsCodeApi !== "undefined") {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
};

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
  } = useWorkflowStore();
  const {
    outputCollapsed,
    toggleOutputCollapse,
    autoscrollEnabled,
    setAutoscroll,
  } = useUiStore();
  const outputRef = useRef<HTMLDivElement>(null);

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

      // Add CLI outputs
      const stepOutputs = cliOutputs[stepIndex] || [];
      stepOutputs.forEach((output, attemptIndex) => {
        messages.push({
          type: "cli",
          stepIndex,
          timestamp:
            (output as CliOutputItem & { timestampMs?: number }).timestampMs ||
            stepIndex * 10000 + stepStatusMessages.length + attemptIndex,
          data: output as unknown as CliOutputItem,
          attemptIndex,
        });
      });
    }

    // Sort by timestamp
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }, [cliOutputs, statusMessages, totalSteps]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoscrollEnabled && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [allMessages, autoscrollEnabled]);

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

  return (
    <section
      id="output-section"
      className={`output-section ${outputCollapsed ? "collapsed" : ""}`}
    >
      {/* Section Header */}
      <div className="section-header output-controls">
        <div className="section-title-group">
          <button
            className="collapse-btn"
            onClick={toggleOutputCollapse}
            title={outputCollapsed ? "Expand output" : "Collapse output"}
            aria-label={outputCollapsed ? "Expand output" : "Collapse output"}
            aria-expanded={!outputCollapsed}
          >
            <i
              className={`codicon ${
                outputCollapsed
                  ? "codicon-chevron-right"
                  : "codicon-chevron-down"
              }`}
            />
          </button>
          <h2 className="section-title">
            <i className="codicon codicon-terminal" /> Output
          </h2>
        </div>

        <div className="output-controls-right">
          {/* Auto-scroll checkbox */}
          <label
            className="autoscroll-label"
            title="Auto-scroll to latest output"
          >
            <input
              type="checkbox"
              id="autoscroll-checkbox"
              checked={autoscrollEnabled}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            <span>Auto-scroll</span>
          </label>

          {/* Export button */}
          <button
            className="icon-btn"
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
      {!outputCollapsed && (
        <div ref={outputRef} id="output-content" className="output-content">
          {!hasOutput ? (
            <p className="empty-state">
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
                return (
                  <CliOutput
                    key={`cli-${index}`}
                    output={cliData}
                    stepIndex={item.stepIndex}
                    attemptIndex={item.attemptIndex || 0}
                  />
                );
              }
            })
          )}
        </div>
      )}
    </section>
  );
};
