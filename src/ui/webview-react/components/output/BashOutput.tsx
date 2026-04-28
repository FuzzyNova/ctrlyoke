import { useState, useId, memo } from "react";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import {
  TOOL_CALL_TERMINAL,
  TOOL_CALL_LINE,
  TOOL_RESULT_LINE,
  TOOL_ERROR_LINE,
} from "./outputStyles";
import type { FileOperationStatus } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";

const STATUS_BADGE_STYLES: Record<string, string> = {
  success: "text-indicator-success",
  error: "text-indicator-error",
  running: "text-indicator-running",
};

interface BashOutputProps {
  command: string;
  output?: string;
  error?: string;
  exitCode?: number;
  status?: FileOperationStatus;
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
 *
 * Wrapped in React.memo so completed bash steps do not re-render when
 * other steps are streaming.
 */
export const BashOutput = memo<BashOutputProps>(
  ({
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
    const sanitizedCommand = sanitizeTerminalOutput(command).trim();
    const displayCommand = sanitizedCommand || "command unavailable";
    const hasCommandLabel = sanitizedCommand.length > 0;
    const sanitizedOutput = sanitizeTerminalOutput(output || "");
    const sanitizedError = sanitizeTerminalOutput(error || "");

    // Check if status is "initiated" (command still running)
    const isRunning = status === OPERATION_STATUS.INITIATED;
    const isCompleted =
      status === OPERATION_STATUS.COMPLETED ||
      status === OPERATION_STATUS.FAILED ||
      !status;

    // Render expandable content.
    // Only the visible slice is in the DOM — the full string is not kept in the
    // React tree when collapsed, preventing large bash outputs from accumulating
    // DOM nodes even when hidden.
    const renderExpandableContent = (
      content: string,
      type: "output" | "error",
      isExpanded: boolean,
      setExpanded: (v: boolean) => void
    ) => {
      if (!content) return null;

      const lines = content.split("\n");
      const isTruncated = lines.length > maxLines;
      const visibleContent =
        isTruncated && !isExpanded
          ? lines.slice(0, maxLines).join("\n")
          : content;
      const hiddenLines = lines.length - maxLines;

      const cssClass = type === "error" ? TOOL_ERROR_LINE : TOOL_RESULT_LINE;

      return (
        <div className={`${cssClass} flex items-start gap-1`}>
          <span className="shrink-0">⎿</span>
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
            id={`${containerId}-${type}`}
          >
            {visibleContent}
            {isTruncated && (
              <button
                type="button"
                className="text-bash-expand-link no-underline text-sm ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
                onClick={() => setExpanded(!isExpanded)}
              >
                {isExpanded
                  ? "[show less]"
                  : `[show ${hiddenLines} more line${hiddenLines !== 1 ? "s" : ""}]`}
              </button>
            )}
          </div>
        </div>
      );
    };

    // Determine status badge
    const renderStatusBadge = () => {
      if (isRunning) {
        return (
          <span
            className={`inline ml-2 text-[length:var(--fp-output-font-size-sm)] font-normal ${STATUS_BADGE_STYLES.running}`}
          >
            running
          </span>
        );
      }
      if (isCompleted && exitCode !== undefined) {
        const success = exitCode === 0;
        const variant = success ? "success" : "error";
        return (
          <span
            className={`inline ml-2 text-[length:var(--fp-output-font-size-sm)] font-normal ${STATUS_BADGE_STYLES[variant]}`}
          >
            (exit: {exitCode})
          </span>
        );
      }
      return null;
    };

    const dotColorClass =
      exitCode !== undefined
        ? exitCode === 0
          ? "text-indicator-success"
          : "text-indicator-error"
        : isRunning
          ? "text-indicator-running"
          : "text-editor-fg";

    return (
      <div className={`${TOOL_CALL_TERMINAL} ${className}`}>
        <div className={TOOL_CALL_LINE}>
          <span className="min-w-0 break-words">
            <span className={dotColorClass}>●</span>{" "}
            <span
              className={
                hasCommandLabel
                  ? "text-editor-fg"
                  : "text-description-fg italic"
              }
            >
              {displayCommand}
            </span>
            {renderStatusBadge()}
          </span>
        </div>

        {/* Only show output/error for completed commands */}
        {isCompleted && (
          <>
            {renderExpandableContent(
              sanitizedOutput,
              "output",
              outputExpanded,
              setOutputExpanded
            )}
            {renderExpandableContent(
              sanitizedError,
              "error",
              errorExpanded,
              setErrorExpanded
            )}
          </>
        )}
      </div>
    );
  }
);
BashOutput.displayName = "BashOutput";
