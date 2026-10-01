import { useState, useId, memo } from "react";
import { sanitizeTerminalOutput } from "@root/utils/TerminalOutputSanitizer";
import {
  DEFAULT_COLLAPSED_COMMAND_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedSingleLinePreview,
  buildCollapsedOutputPreview,
  canToggleCollapsedOutput,
} from "@utils/outputTruncation";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import { CollapsibleOutputSection } from "./CollapsibleOutputSection";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolCallExpandToggle } from "./ToolCallExpandToggle";
import type { FileOperationStatus } from "../../types/cliEvents";
import { OPERATION_STATUS } from "../../types/cliEvents";
import {
  BASH_OUTPUT_EXPANSION_SECTIONS,
  TOOL_RESULT_STATUSES,
  type BashOutputExpansionSection as SharedBashOutputExpansionSection,
} from "@root/types/DashboardConstants";

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
  showLabel?: boolean;
  expansion?: BashOutputExpansionState;
  onExpansionChange?: (
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
  className?: string;
}

export type BashOutputExpansionSection = SharedBashOutputExpansionSection;

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
 * - Long output collapsed behind a "Show full output" toggle above it
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
    showLabel = false,
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
          [section === BASH_OUTPUT_EXPANSION_SECTIONS.COMMAND
            ? "commandExpanded"
            : section === BASH_OUTPUT_EXPANSION_SECTIONS.OUTPUT
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

    // Only the visible slice is in the DOM — the full string is not kept in the
    // React tree when collapsed, preventing large bash outputs from accumulating
    // DOM nodes even when hidden.
    const renderExpandableContent = (
      content: string,
      type: Exclude<
        BashOutputExpansionSection,
        typeof BASH_OUTPUT_EXPANSION_SECTIONS.COMMAND
      >,
      isExpanded: boolean,
      findMatches?: RowFindDecoration["matches"]
    ) => {
      if (!content) return null;

      const preview = buildCollapsedOutputPreview(content, {
        expanded: isExpanded,
        maxLines,
        maxChars: maxCharacters,
      });
      const isError = type === BASH_OUTPUT_EXPANSION_SECTIONS.ERROR;

      return (
        <CollapsibleOutputSection
          section={type}
          contentId={`${containerId}-${type}`}
          isError={isError}
          noun={isError ? "error" : "output"}
          visibleText={preview.visibleText}
          findMatches={findMatches}
          canToggle={canToggleCollapsedOutput(preview, isExpanded)}
          isExpanded={isExpanded}
          isTruncated={preview.isTruncated}
          hiddenLineCount={preview.hiddenLineCount}
          onToggle={(expanded) => updateExpansion(type, expanded)}
        />
      );
    };

    // Determine status badge
    const renderStatusBadge = () => {
      if (isRunning) {
        return (
          <span
            className={`inline ml-2 text-[length:var(--cy-output-font-size-sm)] font-normal ${STATUS_BADGE_STYLES.running}`}
          >
            running
          </span>
        );
      }
      if (isCompleted && exitCode !== undefined) {
        const success = exitCode === 0;
        const variant = success
          ? TOOL_RESULT_STATUSES.SUCCESS
          : TOOL_RESULT_STATUSES.ERROR;
        return (
          <span
            className={`inline ml-2 text-[length:var(--cy-output-font-size-sm)] font-normal ${STATUS_BADGE_STYLES[variant]}`}
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
      <ToolCallBlock
        className={className}
        dot={<span className={dotColorClass}>●</span>}
        header={
          <>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
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
              <ToolCallExpandToggle
                expanded={resolvedExpansion.commandExpanded}
                onToggle={() =>
                  updateExpansion(
                    BASH_OUTPUT_EXPANSION_SECTIONS.COMMAND,
                    !resolvedExpansion.commandExpanded
                  )
                }
                label="Show full command"
                showLabel={showLabel}
                aria-label={`${resolvedExpansion.commandExpanded ? "Hide" : "Show"} full command for: ${commandPreview.visibleText}`}
                title={
                  resolvedExpansion.commandExpanded
                    ? "Hide full command"
                    : "Show full command"
                }
              />
            )}
          </>
        }
      >
        {/* Only show output/error for completed commands */}
        {isCompleted && (
          <>
            {renderExpandableContent(
              renderedOutput,
              BASH_OUTPUT_EXPANSION_SECTIONS.OUTPUT,
              resolvedExpansion.outputExpanded,
              outputFindMatches
            )}
            {renderExpandableContent(
              renderedError,
              BASH_OUTPUT_EXPANSION_SECTIONS.ERROR,
              resolvedExpansion.errorExpanded,
              errorFindMatches
            )}
          </>
        )}
      </ToolCallBlock>
    );
  }
);
BashOutput.displayName = "BashOutput";
