import React from "react";
import { useLongPress } from "../../hooks/useLongPress";
import { StatusIcon } from "./StatusIcon";
import { PromptStepDetails } from "./PromptStepDetails";
import type { PromptOverride } from "./PromptStepDetails";
import {
  FINAL_STEP_PHASES,
  type StepStatus,
  type FinalStepPhase,
} from "../../types/messages";
import type { CliOutput, WorkflowStep } from "../../store/workflowStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";

function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

function getStepDisplayText(step: WorkflowStep): string {
  return isScriptStep(step) ? step.script : (step.name ?? step.prompt);
}

interface FinalStepFooterProps {
  finalStep: WorkflowStep | null;
  status: StepStatus | null;
  loopCount: number;
  phase: FinalStepPhase | null;
  isExpanded: boolean;
  isSelected: boolean;
  /** Whether selecting this final step in the editor is unavailable. */
  isSelectionReadOnly?: boolean;
  isReadOnly: boolean;
  isDisabled: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
  /** Resolved harness display name (accounting for workflow/global defaults) */
  harnessLabel?: string;
  /** True when harness is inherited (not set at prompt level) */
  harnessIsDefault?: boolean;
  /** Resolved model display name (accounting for workflow/global defaults) */
  modelLabel?: string;
  /** True when model is inherited (not set at prompt level) */
  modelIsDefault?: boolean;
  /** Latest CLI output for the current final step loop */
  latestOutput?: CliOutput | null;
  /** Prompt-level property overrides to display as compact chips */
  overrides?: PromptOverride[];
  /** Right-click context menu handler */
  onContextMenu?: (x: number, y: number) => void;
}

const truncate = (text: string, maxLength: number = 72): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
};

export const FinalStepFooter: React.FC<FinalStepFooterProps> = ({
  finalStep,
  status,
  loopCount,
  phase,
  isExpanded,
  isSelected,
  isReadOnly,
  isSelectionReadOnly = isReadOnly,
  isDisabled,
  onSelect,
  onToggleExpanded,
  onToggleEnabled,
  harnessLabel,
  harnessIsDefault,
  modelLabel,
  modelIsDefault,
  latestOutput,
  overrides,
  onContextMenu,
}) => {
  const hasFinalStep = !!finalStep;
  const effectiveStatus: StepStatus = hasFinalStep
    ? (status ?? "pending")
    : "pending";
  const longPressHandlers = useLongPress(onContextMenu);
  const showDisabledState = !hasFinalStep || isDisabled;

  return (
    <div className="border-t border-panel-border bg-sidebar-bg flex-shrink-0">
      {hasFinalStep && isExpanded && finalStep && (
        <div
          className={`px-3 py-2 border-b border-panel-border ${
            isSelected
              ? "bg-list-active-bg text-list-active-fg"
              : "hover:bg-list-hover-bg text-foreground"
          } ${isSelectionReadOnly ? "" : "cursor-pointer"} ${isDisabled && !isSelected ? "opacity-85" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isSelectionReadOnly) {
              onSelect();
            }
          }}
          onKeyDown={(e) => {
            if (
              (e.key === "Enter" || e.key === " ") &&
              !isSelectionReadOnly
            ) {
              e.preventDefault();
              onSelect();
            }
          }}
          onContextMenu={
            onContextMenu
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(e.clientX, e.clientY);
                }
              : undefined
          }
          {...longPressHandlers}
        >
          {/* Prompt name / text — pl-5 matches PromptStepDetails indent */}
          <div className="text-xs leading-relaxed">
            {truncate(getStepDisplayText(finalStep))}
          </div>

          {isDisabled && (
            <div className="mt-1">
              <span className="inline-flex rounded bg-badge-bg px-1 py-px text-xxs text-badge-fg">
                Disabled
              </span>
            </div>
          )}

          {/* Phase badge */}
          {phase && (
            <div className="mt-0.5 text-xxs opacity-75">
              {phase === FINAL_STEP_PHASES.FINAL_STEP ? "Final Step" : "Queue"}
            </div>
          )}

          {/* Shared metadata rows: harness/model (prompt only), stats, end condition, overrides */}
          <PromptStepDetails
            status={effectiveStatus}
            harnessLabel={isScriptStep(finalStep) ? undefined : harnessLabel}
            harnessIsDefault={
              isScriptStep(finalStep) ? undefined : harnessIsDefault
            }
            modelLabel={isScriptStep(finalStep) ? undefined : modelLabel}
            modelIsDefault={
              isScriptStep(finalStep) ? undefined : modelIsDefault
            }
            latestOutput={latestOutput}
            isSelected={isSelected}
            overrides={isScriptStep(finalStep) ? undefined : overrides}
          />
        </div>
      )}

      <div
        className={`h-[39px] px-2 flex items-center gap-2 ${
          isSelected
            ? "bg-list-active-bg text-list-active-fg"
            : "hover:bg-list-hover-bg text-foreground"
        } ${isSelectionReadOnly ? "opacity-75" : "cursor-pointer"}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!isSelectionReadOnly) {
            onSelect();
          }
        }}
        onKeyDown={(e) => {
          if (
            (e.key === "Enter" || e.key === " ") &&
            !isSelectionReadOnly
          ) {
            e.preventDefault();
            onSelect();
          }
        }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e.clientX, e.clientY);
              }
            : undefined
        }
        {...longPressHandlers}
      >
        <StatusIcon status={effectiveStatus} disabled={showDisabledState} />
        <span className="text-xs font-semibold uppercase tracking-wide">
          {"Final Step"}
        </span>
        {hasFinalStep && finalStep && isScriptStep(finalStep) && (
          <span
            className="ml-1 px-1 py-px rounded text-xxs bg-badge-bg text-badge-fg opacity-75 flex-shrink-0"
            title="Script step — runs a shell command"
          >
            script
          </span>
        )}
        {hasFinalStep && finalStep ? (
          <span
            className={`text-xs font-bold flex-1 opacity-90 ${isDisabled ? "text-description-fg" : "text-terminal-ansiGreen"}`}
          >
            {isDisabled ? "disabled" : "enabled"}
          </span>
        ) : (
          <span className="text-xs flex-1 italic opacity-80 text-foreground">
            disabled
          </span>
        )}
        {loopCount > 0 && (
          <span className="ml-1 px-1.5 py-px rounded bg-badge-bg text-badge-fg text-xxs">
            Loop {loopCount + 1}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasFinalStep && !isReadOnly && (
            <button
              type="button"
              className="icon-btn py-0 px-1"
              onClick={(e) => {
                e.stopPropagation();
                onToggleEnabled();
              }}
              title={isDisabled ? "Enable final step" : "Disable final step"}
              aria-label={
                isDisabled ? "Enable final step" : "Disable final step"
              }
            >
              <i
                className={`codicon ${isDisabled ? "codicon-check" : "codicon-circle-slash"} text-xs`}
              />
            </button>
          )}
          {hasFinalStep && (
            <button
              type="button"
              className="icon-btn py-0 px-1"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded();
              }}
              title={
                isExpanded
                  ? "Collapse final step details"
                  : "Expand final step details"
              }
              aria-label={
                isExpanded
                  ? "Collapse final step details"
                  : "Expand final step details"
              }
            >
              <i
                className={`codicon ${isExpanded ? "codicon-chevron-down" : "codicon-chevron-up"} text-xs`}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
