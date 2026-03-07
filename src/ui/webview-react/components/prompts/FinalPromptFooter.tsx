import React from "react";
import { StatusIcon } from "./StatusIcon";
import type {
  PromptItem,
  StepStatus,
  FinalPromptPhase,
} from "../../types/messages";

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
}) => {
  const effectiveStatus: StepStatus = status ?? "pending";
  const hasFinalPrompt = !!finalPrompt;

  return (
    <div className="border-t border-panel-border bg-sidebar-bg flex-shrink-0">
      {hasFinalPrompt && isExpanded && finalPrompt && (
        <div
          className={`px-3 py-2 border-b border-panel-border ${
            isSelected
              ? "bg-list-active-bg text-list-active-fg"
              : "text-foreground"
          }`}
        >
          <div className="text-[11px] leading-relaxed">
            {finalPrompt.name ? finalPrompt.name : truncate(finalPrompt.prompt)}
          </div>
          <div className="mt-1 text-[10px] opacity-75 flex items-center gap-1">
            {finalPrompt.harness && <span>{finalPrompt.harness}</span>}
            {finalPrompt.harness && finalPrompt.model && (
              <span className="opacity-40">|</span>
            )}
            {finalPrompt.model && <span>{finalPrompt.model}</span>}
            {phase && (
              <>
                <span className="opacity-40">|</span>
                <span>
                  {phase === "finalPrompt" ? "Orchestrator" : "Queue"}
                </span>
              </>
            )}
          </div>
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
        <StatusIcon status={effectiveStatus} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          Orchestrator
        </span>
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
              title="Disable orchestrator prompt"
              aria-label="Disable orchestrator prompt"
            >
              <i className="codicon codicon-trash text-[12px]" />
            </button>
          )}
          <button
            type="button"
            className="icon-btn py-0 px-1"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded();
            }}
            title={
              isExpanded
                ? "Collapse orchestrator details"
                : "Expand orchestrator details"
            }
            aria-label={
              isExpanded
                ? "Collapse orchestrator details"
                : "Expand orchestrator details"
            }
          >
            <i
              className={`codicon ${isExpanded ? "codicon-chevron-down" : "codicon-chevron-up"} text-[12px]`}
            />
          </button>
        </div>
      </div>
    </div>
  );
};
