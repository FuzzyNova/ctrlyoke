import React from "react";
import { useLongPress } from "../../hooks/useLongPress";
import { StatusIcon } from "./StatusIcon";
import { PromptStepDetails } from "./PromptStepDetails";
import { ContextWindowBar } from "./ContextWindowBar";
import { resolveEffectiveContextWindow } from "@utils/tokenUtils";
import type { PromptOverride } from "./PromptStepDetails";
import {
  FINAL_STEP_PHASES,
  type HarnessId,
  type StepStatus,
  type FinalStepPhase,
} from "../../types/messages";
import type { CliOutput, WorkflowStep } from "../../store/workflowStore";
import { KEYBOARD_KEYS, STEP_TYPES } from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import { Icon } from "../shared/Icon";
import { formatFinalPassBadge } from "@root/utils/FinalStepLabels";

function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

function getStepDisplayText(step: WorkflowStep): string {
  return isScriptStep(step) ? step.script : (step.name ?? step.prompt);
}

interface FinalStepFooterProps {
  finalStep: WorkflowStep | null;
  /** Resolved identity color for the final step, when identity colors are on. */
  stepColor?: string;
  status: StepStatus | null;
  loopCount: number;
  phase: FinalStepPhase | null;
  isExpanded: boolean;
  isSelected: boolean;
  /** Whether selecting this final step in the editor is unavailable. */
  isSelectionReadOnly?: boolean;
  /** Whether the footer is narrow enough for compact status labels. */
  isNarrow?: boolean;
  isReadOnly: boolean;
  isDisabled: boolean;
  onSelect: () => void;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
  /** Harness ID for the icon shown before the harness label */
  harnessId?: HarnessId;
  /** Resolved harness display name (accounting for workflow/global defaults) */
  harnessLabel?: string;
  /** True when harness is inherited (not set at prompt level) */
  harnessIsDefault?: boolean;
  /** Resolved model display name (accounting for workflow/global defaults) */
  modelLabel?: string;
  /** True when model is inherited (not set at prompt level) */
  modelIsDefault?: boolean;
  /** Latest CLI output for the current final step pass */
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
  stepColor,
  status,
  loopCount,
  phase,
  isExpanded,
  isSelected,
  isReadOnly,
  isSelectionReadOnly = isReadOnly,
  isNarrow = false,
  isDisabled,
  onSelect,
  onToggleExpanded,
  onToggleEnabled,
  harnessId,
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
  // Live context telemetry is keyed by queue step index only, so the final
  // step's bar comes from its latest CLI output, falling back to the
  // persisted runtime metadata.
  const contextWindow = resolveEffectiveContextWindow({
    isCurrent: false,
    latestOutputTokens: latestOutput?.tokens,
    runtimeContextWindow: finalStep?._runtime,
  });
  // The details panel and the bar are one selectable unit, so hovering either
  // highlights both (matching how selection already highlights both).
  const rowStateClass = isSelected
    ? "bg-list-active-bg text-list-active-fg"
    : "group-hover/final-step:bg-list-hover-bg text-foreground";
  const finalStepTooltip = hasFinalStep
    ? `Final Step — ${isDisabled ? "Disabled" : "Enabled"}${
        loopCount > 0 ? ` — ${formatFinalPassBadge(loopCount + 1)}` : ""
      }`
    : "Final Step — Not set";

  return (
    <div className="group/final-step relative border-t border-panel-border bg-sidebar-bg shrink-0 cy-no-select">
      <div
        data-final-step-identity-bar
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${stepColor ? "" : "bg-transparent"}`}
        style={stepColor ? { backgroundColor: stepColor } : undefined}
        aria-hidden="true"
      />
      {hasFinalStep && isExpanded && finalStep && (
        <div
          className={`px-3 py-2 border-b border-panel-border ${rowStateClass} ${isSelectionReadOnly ? "" : "cursor-pointer"} ${isDisabled && !isSelected ? "opacity-85" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Final step"
          onClick={() => {
            if (!isSelectionReadOnly) {
              onSelect();
            }
          }}
          onKeyDown={(e) => {
            if (
              (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") &&
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
          {/* Layout: content column | (context bar) — matches WorkflowStep */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {/* Prompt name / text — pl-5 matches PromptStepDetails indent */}
              <div className="text-xs leading-relaxed">
                {truncate(getStepDisplayText(finalStep))}
              </div>

              {/* Phase badge */}
              {phase && (
                <div className="mt-0.5 text-xxs opacity-75">
                  {phase === FINAL_STEP_PHASES.FINAL_STEP
                    ? "Final Step"
                    : "Queue"}
                </div>
              )}

              {/* Shared metadata rows: harness/model (prompt only), stats, end condition, overrides */}
              <PromptStepDetails
                status={effectiveStatus}
                harnessId={isScriptStep(finalStep) ? undefined : harnessId}
                harnessLabel={
                  isScriptStep(finalStep) ? undefined : harnessLabel
                }
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
            <ContextWindowBar
              contextWindow={contextWindow}
              attemptTokens={latestOutput?.tokens}
              harnessId={harnessId}
            />
          </div>
        </div>
      )}

      <div
        className={`h-[39px] px-2 flex items-center gap-2 ${rowStateClass} ${isSelectionReadOnly ? "opacity-75" : "cursor-pointer"}`}
        role="button"
        tabIndex={0}
        title={finalStepTooltip}
        aria-label="Final step"
        onClick={() => {
          if (!isSelectionReadOnly) {
            onSelect();
          }
        }}
        onKeyDown={(e) => {
          if (
            (e.key === KEYBOARD_KEYS.ENTER || e.key === " ") &&
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
        {hasFinalStep ? (
          <StatusIcon status={effectiveStatus} disabled={isDisabled} />
        ) : (
          // Nothing configured is not the same as configured-but-off, so the
          // empty state shows no status icon (the spacer keeps label alignment).
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="text-xs font-semibold uppercase tracking-wide">
          {"Final Step"}
        </span>
        {hasFinalStep && finalStep && isScriptStep(finalStep) && (
          <span
            className="ml-1 px-1 py-px rounded-sm text-xxs bg-badge-bg text-badge-fg opacity-75 shrink-0"
            title="Script step — runs a shell command"
          >
            script
          </span>
        )}
        {/* Enabled is the default and goes unlabeled, matching queue rows and
            the editor header, which only call out the disabled state. */}
        {!hasFinalStep ? (
          <span className="text-xs italic text-description-fg">not set</span>
        ) : isDisabled ? (
          <span className="text-xs italic text-warning-fg">disabled</span>
        ) : null}
        {loopCount > 0 && (
          <span className="ml-1 shrink-0 whitespace-nowrap rounded-sm bg-badge-bg px-1.5 py-px text-xxs text-badge-fg">
            {isNarrow ? loopCount + 1 : formatFinalPassBadge(loopCount + 1)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasFinalStep && !isReadOnly && (
            <button
              type="button"
              className={`icon-btn py-0 px-1 ${isDisabled ? "text-warning-fg hover:text-warning-fg" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleEnabled();
              }}
              // Shows the current state, like the editor header's toggle.
              title={
                isDisabled
                  ? "Final step is disabled — click to enable"
                  : "Final step is enabled — click to disable"
              }
              aria-label={
                isDisabled ? "Enable final step" : "Disable final step"
              }
              aria-pressed={isDisabled}
            >
              <Icon
                name={isDisabled ? "codicon-circle-slash" : "codicon-check"}
                className="text-xs"
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
              <Icon
                name={
                  isExpanded ? "codicon-chevron-down" : "codicon-chevron-up"
                }
                className="text-xs"
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
