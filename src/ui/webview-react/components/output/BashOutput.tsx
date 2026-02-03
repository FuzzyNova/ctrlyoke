import React, { useState, useId } from "react";
import { escapeHtml } from "@utils/outputUtils";
import type { OperationStatus } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";

interface BashOutputProps {
  command: string;
  output?: string;
  error?: string;
  exitCode?: number;
  status?: OperationStatus;
  maxLines?: number;
  className?: string;
}

/**
 * BashOutput Component
 *
 * Renders terminal-style output for shell commands.
 * Features:
 * - Command shown with bullet prefix
 * - Output/error with ⎿ prefix
 * - Exit code with color-coded status badge
 * - Expandable long content with "show more" link
 */
export const BashOutput: React.FC<BashOutputProps> = ({
  command,
  output,
  error,
  exitCode,
  status,
  maxLines = 10,
  className = "",
}) => {
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const containerId = useId();

  // Check if status is "initiated" (command still running)
  const isRunning = status === OPERATION_STATUS.INITIATED;
  const isCompleted =
    status === OPERATION_STATUS.COMPLETED ||
    status === OPERATION_STATUS.FAILED ||
    !status;

  // Render expandable content
  const renderExpandableContent = (
    content: string,
    type: "output" | "error",
    isExpanded: boolean,
    setExpanded: (v: boolean) => void
  ) => {
    if (!content) return null;

    const lines = content.split("\n");
    const isTruncated = lines.length > maxLines;
    const truncatedContent = isTruncated
      ? lines.slice(0, maxLines).join("\n")
      : content;
    const hiddenLines = lines.length - maxLines;

    const cssClass = type === "error" ? "tool-error-line" : "tool-result-line";

    return (
      <div className={cssClass}>
        <span className="bash-prefix">{"  ⎿  "}</span>
        <div className="bash-content-container" id={`${containerId}-${type}`}>
          <span className={isExpanded ? "hidden" : ""}>
            {escapeHtml(truncatedContent)}
          </span>
          <span className={isExpanded ? "" : "hidden"}>
            {escapeHtml(content)}
          </span>
          {isTruncated && (
            <a
              href="#"
              className="bash-expand-link"
              onClick={(e) => {
                e.preventDefault();
                setExpanded(!isExpanded);
              }}
            >
              {isExpanded
                ? "[show less]"
                : `[show ${hiddenLines} more line${hiddenLines !== 1 ? "s" : ""}]`}
            </a>
          )}
        </div>
      </div>
    );
  };

  // Determine status badge
  const renderStatusBadge = () => {
    if (isRunning) {
      return <span className="status-badge running">running</span>;
    }
    if (isCompleted && exitCode !== undefined) {
      const success = exitCode === 0;
      return (
        <span className={`status-badge ${success ? "success" : "error"}`}>
          (exit: {exitCode})
        </span>
      );
    }
    return null;
  };

  return (
    <div className={`output-tool-call-terminal ${className}`}>
      <div className="tool-call-line">
        <span className="bash-bullet">● </span>
        <span className="bash-command">{escapeHtml(command)}</span>
        {renderStatusBadge()}
      </div>

      {/* Only show output/error for completed commands */}
      {isCompleted && (
        <>
          {renderExpandableContent(
            output || "",
            "output",
            outputExpanded,
            setOutputExpanded
          )}
          {renderExpandableContent(
            error || "",
            "error",
            errorExpanded,
            setErrorExpanded
          )}
        </>
      )}
    </div>
  );
};
