import { useState, useId, memo } from "react";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import {
  DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  formatCollapsedOutputToggleLabel,
} from "@utils/outputTruncation";
import {
  highlightText,
  type RowFindDecoration,
} from "@utils/outputFind";
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
  commandFindMatches?: RowFindDecoration["matches"];
  outputFindMatches?: RowFindDecoration["matches"];
  errorFindMatches?: RowFindDecoration["matches"];
  exitCode?: number;
  status?: FileOperationStatus;
  maxLines?: number;
  maxCharacters?: number;
  maxCommandCharacters?: number;
  expansion?: BashOutputExpansionState;
  onExpansionChange?: (
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
  className?: string;
}

export type BashOutputExpansionSection = "command" | "output" | "error";

export interface BashOutputExpansionState {
  commandExpanded: boolean;
  outputExpanded: boolean;
  errorExpanded: boolean;
}

export const DEFAULT_BASH_OUTPUT_EXPANSION_STATE: Readonly<BashOutputExpansionState> =
  {
    commandExpanded: false,
    outputExpanded: false,
    errorExpanded: false,
  };

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
    commandFindMatches,
    outputFindMatches,
    errorFindMatches,
    exitCode,
    status,
    maxLines = DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
    maxCharacters = DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
    maxCommandCharacters = DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
    expansion,
    onExpansionChange,
    className = "",
  }) => {
    const [uncontrolledExpansion, setUncontrolledExpansion] =
      useState<BashOutputExpansionState>({
        commandExpanded: false,
        outputExpanded: false,
        errorExpanded: false,
      });
    const containerId = useId();
    const resolvedExpansion = expansion ?? uncontrolledExpansion;
    const updateExpansion = (
      section: BashOutputExpansionSection,
      expanded: boolean
    ) => {
      if (expansion === undefined) {
        setUncontrolledExpansion((previous) => ({
          ...previous,
          [section === "command"
            ? "commandExpanded"
            : section === "output"
              ? "outputExpanded"
              : "errorExpanded"]: expanded,
        }));
      }
      onExpansionChange?.(section, expanded);
    };
    const sanitizedCommand = sanitizeTerminalOutput(command)
      .trim()
      .replace(/\s*\n+\s*/g, " ");
    const displayCommand = sanitizedCommand || "command unavailable";
    const hasCommandLabel = sanitizedCommand.length > 0;
    const commandPreview = buildCollapsedSingleLinePreview(displayCommand, {
      expanded: resolvedExpansion.commandExpanded,
      maxChars: maxCommandCharacters,
    });
    const canToggleCommand =
      resolvedExpansion.commandExpanded || commandPreview.isTruncated;
    const sanitizedOutput = sanitizeTerminalOutput(output || "");
    const sanitizedError = sanitizeTerminalOutput(error || "");
    const hasDuplicateOutputAndError =
      sanitizedOutput.trim().length > 0 &&
      sanitizedOutput.trim() === sanitizedError.trim();
    const renderedOutput = hasDuplicateOutputAndError ? "" : sanitizedOutput;
    const renderedError = sanitizedError;

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
      findMatches?: RowFindDecoration["matches"]
    ) => {
      if (!content) return null;

      const preview = buildCollapsedOutputPreview(content, {
        expanded: isExpanded,
        maxLines,
        maxChars: maxCharacters,
      });
      const canToggle = isExpanded || preview.isTruncated;

      const cssClass = type === "error" ? TOOL_ERROR_LINE : TOOL_RESULT_LINE;

      // Highlight only the visible (possibly truncated) slice — find match
      // offsets are computed against the full text, but highlightText's
      // normalizeMatches clips/drops any matches outside [0, visibleText.length],
      // so matches hidden behind "[show more]" simply don't render a <mark>.
      return (
        <div className={`${cssClass} flex items-start gap-1`}>
          <span className="shrink-0">⎿</span>
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
            id={`${containerId}-${type}`}
          >
            {highlightText(preview.visibleText, findMatches ?? [])}
            {canToggle && (
              <button
                type="button"
                className="text-bash-expand-link no-underline text-[length:var(--fp-output-font-size-sm)] ml-1 cursor-pointer hover:underline bg-transparent border-0 p-0 font-inherit"
                onClick={(event) => {
                  event.preventDefault();
                  updateExpansion(type, !isExpanded);
                }}
              >
                {formatCollapsedOutputToggleLabel(preview, isExpanded)}
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
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className={dotColorClass}>●</span>{" "}
            <span
              className={
                hasCommandLabel
                  ? "text-editor-fg [overflow-wrap:anywhere]"
                  : "text-description-fg italic [overflow-wrap:anywhere]"
              }
            >
              {highlightText(
                commandPreview.visibleText,
                commandFindMatches ?? []
              )}
              {!resolvedExpansion.commandExpanded &&
                commandPreview.isTruncated &&
                "..."}
            </span>
            {renderStatusBadge()}
          </span>
          {canToggleCommand && (
            <button
              type="button"
              className="text-bash-expand-link text-[length:var(--fp-output-font-size-sm)] cursor-pointer bg-transparent border-0 p-0 font-inherit hover:underline shrink-0"
              onClick={(event) => {
                event.preventDefault();
                updateExpansion("command", !resolvedExpansion.commandExpanded);
              }}
              title={
                resolvedExpansion.commandExpanded
                  ? "Hide full command"
                  : "Show full command"
              }
            >
              {resolvedExpansion.commandExpanded ? "▲" : "▼"}
            </button>
          )}
        </div>

        {/* Only show output/error for completed commands */}
        {isCompleted && (
          <>
            {renderExpandableContent(
              renderedOutput,
              "output",
              resolvedExpansion.outputExpanded,
              outputFindMatches
            )}
            {renderExpandableContent(
              renderedError,
              "error",
              resolvedExpansion.errorExpanded,
              errorFindMatches
            )}
          </>
        )}
      </div>
    );
  }
);
BashOutput.displayName = "BashOutput";
