import React from "react";
import { StatusIcon } from "./StatusIcon";
import { PromptItemDetails } from "./PromptItemDetails";
import type { PromptOverride } from "./PromptItemDetails";
import type {
  PromptItem,
  StepStatus,
  FinalPromptPhase,
} from "../../types/messages";
import type { CliOutput } from "../../store/workflowStore";

interface FinalPromptFooterProps {
  finalPrompt: PromptItem | null;
  status: StepStatus | null;
  loopCount: number;
  phase: FinalPromptPhase | null;
  isExpanded: boolean;
  isSelected: boolean;
  isReadOnly: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onDisable: () => void;
  /** Resolved harness display name (accounting for workflow/global defaults) */
  harnessLabel?: string;
  /** True when harness is inherited (not set at prompt level) */
  harnessIsDefault?: boolean;
  /** Resolved model display name (accounting for workflow/global defaults) */
  modelLabel?: string;
  /** True when model is inherited (not set at prompt level) */
  modelIsDefault?: boolean;
  /** Latest CLI output for the current final prompt loop */
  latestOutput?: CliOutput | null;
  /** Prompt-level property overrides to display as compact chips */
  overrides?: PromptOverride[];
}

const truncate = (text: string, maxLength: number = 72): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
};

export const FinalPromptFooter: React.FC<FinalPromptFooterProps> = ({
  finalPrompt,
  status,
  loopCount,
  phase,
  isExpanded,
  isSelected,
  isReadOnly,
  onSelect,
  onToggleExpanded,
  onDisable,
  harnessLabel,
  harnessIsDefault,
  modelLabel,
  modelIsDefault,
  latestOutput,
  overrides,
}) => {
  const hasFinalPrompt = !!finalPrompt;
  const effectiveStatus: StepStatus = hasFinalPrompt
    ? (status ?? "pending")
    : "pending";

  return (
    <div className="border-t border-panel-border bg-sidebar-bg flex-shrink-0">
      {hasFinalPrompt && isExpanded && finalPrompt && (
        <div
          className={`px-3 py-2 border-b border-panel-border ${
            isSelected
              ? "bg-list-active-bg text-list-active-fg"
              : "hover:bg-list-hover-bg text-foreground"
          } ${isReadOnly ? "" : "cursor-pointer"}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isReadOnly) {
              onSelect();
            }
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !isReadOnly) {
              e.preventDefault();
              onSelect();
            }
          }}
        >
          {/* Prompt name / text — pl-5 matches PromptItemDetails indent */}
          <div className="text-[11px] leading-relaxed">
            {finalPrompt.name ? finalPrompt.name : truncate(finalPrompt.prompt)}
          </div>

          {/* Phase badge */}
          {phase && (
            <div className="mt-0.5text-[10px] opacity-75">
              {phase === "finalPrompt" ? "Final Prompt" : "Queue"}
            </div>
          )}

          {/* Shared metadata rows: harness/model, stats, end condition, overrides, etc. */}
          <PromptItemDetails
            status={effectiveStatus}
            harnessLabel={harnessLabel}
            harnessIsDefault={harnessIsDefault}
            modelLabel={modelLabel}
            modelIsDefault={modelIsDefault}
            latestOutput={latestOutput}
            isSelected={isSelected}
            overrides={overrides}
          />
        </div>
      )}

      <div
        className={`h-9 px-2 flex items-center gap-2 ${
          isSelected
            ? "bg-list-active-bg text-list-active-fg"
            : "hover:bg-list-hover-bg text-foreground"
        } ${isReadOnly ? "opacity-75" : "cursor-pointer"}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!isReadOnly) {
            onSelect();
          }
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !isReadOnly) {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <StatusIcon status={effectiveStatus} disabled={!hasFinalPrompt} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          Final Prompt
        </span>
        {hasFinalPrompt && finalPrompt ? (
          <span className="text-[12px] font-bold flex-1 opacity-90 text-terminal-ansiGreen">
            enabled
          </span>
        ) : (
          <span className="text-[12px] flex-1 italic opacity-80 text-foreground">
            disabled
          </span>
        )}
        {loopCount > 0 && (
          <span className="ml-1 px-1.5 py-[1px] rounded bg-badge-bg text-badge-fg text-[10px]">
            Loop {loopCount + 1}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasFinalPrompt && !isReadOnly && (
            <button
              type="button"
              className="icon-btn py-0 px-1"
              onClick={(e) => {
                e.stopPropagation();
                onDisable();
              }}
              title="Disable final prompt"
              aria-label="Disable final prompt"
            >
              <i className="codicon codicon-trash text-[12px]" />
            </button>
          )}
          {hasFinalPrompt && (
            <button
              type="button"
              className="icon-btn py-0 px-1"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded();
              }}
              title={
                isExpanded
                  ? "Collapse final prompt details"
                  : "Expand final prompt details"
              }
              aria-label={
                isExpanded
                  ? "Collapse final prompt details"
                  : "Expand final prompt details"
              }
            >
              <i
                className={`codicon ${isExpanded ? "codicon-chevron-down" : "codicon-chevron-up"} text-[12px]`}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
