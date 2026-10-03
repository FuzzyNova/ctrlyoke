import {
  FINAL_STEP_PHASES,
  KEYBOARD_KEYS,
} from "@root/types/DashboardConstants";
import React, { memo, useState } from "react";
import { type OutputMinimapMarkerGroup } from "@utils/outputMinimapMarkers";
import { getPromptChangeLabelParts } from "@utils/promptUndo";
import { Icon } from "../shared/Icon";
import type { MinimapStep } from "./OutputMinimap";

interface MarkerTone {
  rank: number;
  className: string;
}

/**
 * A step's pill color, ranked so a grouped marker can show its most important
 * member: selection, then mixed undo/redo, then redo-only, then any change.
 */
function getStepMarkerTone(step: MinimapStep): MarkerTone {
  const summary = step.changeSummary;
  const hasUndoable = (summary?.undoable ?? 0) > 0;
  const hasUndone = (summary?.undone ?? 0) > 0;
  if (step.selected) return { rank: 4, className: "text-focus-border" };
  if (hasUndoable && hasUndone)
    return { rank: 3, className: "text-warning-fg" };
  if (hasUndone) return { rank: 2, className: "text-terminal-ansiGreen" };
  if ((summary?.total ?? 0) > 0) return { rank: 1, className: "text-link-fg" };
  return { rank: 0, className: "text-description-fg" };
}

function getGroupMarkerTone(members: readonly MinimapStep[]): MarkerTone {
  return members.reduce<MarkerTone>(
    (best, step) => {
      const tone = getStepMarkerTone(step);
      return tone.rank > best.rank ? tone : best;
    },
    { rank: -1, className: "" }
  );
}

function getStepNoun(step: MinimapStep): string {
  return step.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? `final step loop ${step.stepIndex + 1}`
    : `step ${step.stepIndex + 1}`;
}

/** Tail triangle height; offsets keep its tip on the marker's center. */
const POPUP_TAIL_PX = 10;

interface MinimapStepPopupRowProps {
  step: MinimapStep;
  /** Grouped rows get their own jump button and tone dot; the marker covers a lone step. */
  inGroup: boolean;
  onStepClick: (step: MinimapStep) => void;
  onStepToggle?: (step: MinimapStep) => void;
  onStepSolo?: (step: MinimapStep) => void;
  onDismissPin: () => void;
}

const MinimapStepPopupRow: React.FC<MinimapStepPopupRowProps> = ({
  step,
  inGroup,
  onStepClick,
  onStepToggle,
  onStepSolo,
  onDismissPin,
}) => {
  const changeAction = step.changeAction;
  const changeLabel = step.changeSummary
    ? getPromptChangeLabelParts(step.changeSummary)
    : null;
  const hideShowLabel = `${step.hidden ? "Show" : "Hide"} ${getStepNoun(step)} output`;

  return (
    <div
      className={`flex flex-col gap-1 ${inGroup && step.hidden ? "opacity-60" : ""}`}
    >
      {/* Title row: step label + hide/show toggle */}
      <div className="flex items-center gap-2">
        {inGroup ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (e.altKey && onStepSolo) {
                onStepSolo(step);
                return;
              }
              onStepClick(step);
            }}
            style={{ touchAction: "manipulation" }}
            aria-label={`Go to ${step.label}`}
            title={step.label}
            className="flex items-center gap-1.5 text-xxs font-semibold text-foreground hover:text-link-fg transition-colors leading-tight focus:outline-none focus-visible:underline"
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current ${getStepMarkerTone(step).className}`}
            />
            {step.label}
          </button>
        ) : (
          <span className="text-xxs font-semibold text-foreground leading-tight">
            {step.label}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStepToggle?.(step);
          }}
          style={{ touchAction: "manipulation" }}
          aria-pressed={step.hidden}
          aria-label={hideShowLabel}
          title={hideShowLabel}
          className="ml-auto flex items-center gap-1 text-xxs text-description-fg hover:text-foreground transition-colors leading-tight focus:outline-none"
        >
          <Icon
            name={step.hidden ? "eye-closed" : "eye"}
            className="codicon-sm"
          />
          {step.hidden ? "Show" : "Hide"}
        </button>
      </div>

      {changeAction && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismissPin();
            changeAction.onTrigger();
          }}
          style={{ touchAction: "manipulation" }}
          title={changeAction.title}
          aria-label={changeAction.label}
          className="flex items-center gap-1 text-xxs text-link-fg hover:text-link-active-fg transition-colors leading-tight focus:outline-none"
        >
          <Icon name="diff" className="text-xxs" />
          {changeLabel && (
            <>
              {changeLabel.main}
              {changeLabel.undone && (
                <span className="text-terminal-ansiGreen">
                  {changeLabel.undone}
                </span>
              )}
            </>
          )}
        </button>
      )}
    </div>
  );
};

interface OutputMinimapMarkerProps {
  group: OutputMinimapMarkerGroup<MinimapStep>;
  /**
   * Measured rail height. While 0 the group is always a lone step and is
   * placed by percentage instead of by `topPx`/`bottomPx`.
   */
  railHeightPx: number;
  isPinned: boolean;
  onTogglePin: (groupKey: string) => void;
  onDismissPin: () => void;
  onStepClick: (step: MinimapStep) => void;
  onStepToggle?: (step: MinimapStep) => void;
  onStepSolo?: (step: MinimapStep) => void;
}

/**
 * One rail marker — a single step's pill, or a fatter, squarer bar standing
 * for every step whose true position falls within it. Hovering, focusing, or
 * pinning it opens a speech-bubble popup with one row per member step.
 *
 * The popup is only mounted while open, so a run with thousands of steps
 * doesn't keep thousands of hidden buttons in the DOM. Popup and pill are
 * siblings inside the one container that owns the hover/focus handlers, so
 * moving the mouse from the pill onto the popup never leaves the container.
 */
const OutputMinimapMarkerComponent: React.FC<OutputMinimapMarkerProps> = ({
  group,
  railHeightPx,
  isPinned,
  onTogglePin,
  onDismissPin,
  onStepClick,
  onStepToggle,
  onStepSolo,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);

  const { members } = group;
  const lead = members[0];
  const last = members[members.length - 1];
  const isGroup = members.length > 1;
  const isOpen = isPinned || isHovered || hasFocus;
  const allHidden = members.every((step) => step.hidden);
  const hasHiddenActivity = members.some((step) => step.hasHiddenActivity);
  const toneClass = getGroupMarkerTone(members).className;
  const markerLabel = isGroup
    ? `${members.length} steps: ${lead.label} – ${last.label}`
    : lead.label;

  const isMeasured = railHeightPx > 0;
  const heightPx = group.bottomPx - group.topPx;
  // A grouped popup can be tall, so it grows away from the nearer rail edge
  // instead of centering on the marker and spilling over the output header.
  const opensUpward =
    isGroup && isMeasured && group.topPx + heightPx / 2 > railHeightPx / 2;
  const tailOffsetPx = heightPx / 2 - POPUP_TAIL_PX / 2;
  const containerStyle: React.CSSProperties = isMeasured
    ? { top: `${group.topPx}px`, height: `${heightPx}px` }
    : {
        top: `clamp(3px, ${lead.scrollFraction * 100}%, calc(100% - 3px))`,
        height: "4px",
        transform: "translateY(-50%)",
      };
  const alignClass = !isGroup
    ? "items-center"
    : opensUpward
      ? "items-end"
      : "items-start";
  const tailStyle: React.CSSProperties = !isGroup
    ? {}
    : opensUpward
      ? { alignSelf: "flex-end", marginBottom: `${tailOffsetPx}px` }
      : { alignSelf: "flex-start", marginTop: `${tailOffsetPx}px` };

  return (
    // Outer row: anchored to the boundary between the pills and diff tracks
    // (not the rail's outer edge), so the marker lands inside the pills track
    // while the popup grows further left, overflowing past the rail's left
    // edge on purpose. Its mouse/focus listeners only decide whether the
    // popup is mounted; keyboard users reach the same popup by focusing the
    // marker button, which is a real interactive element.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={isGroup ? markerLabel : `Step ${lead.label}`}
      className={`group absolute right-[var(--cy-output-minimap-diff-width)] flex flex-row ${alignClass} z-header ${allHidden ? "opacity-60" : ""}`}
      style={containerStyle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHasFocus(false);
        }
      }}
    >
      {isOpen && (
        <div className="flex items-stretch mr-[3px]">
          {/* Bubble body */}
          <div
            className="flex flex-col justify-center gap-1 px-2 py-1.5 rounded-l rounded-r-none bg-dropdown-bg border border-panel-border shadow-lg"
            style={{ whiteSpace: "nowrap" }}
          >
            {isGroup && (
              <div className="text-xxs text-description-fg leading-tight">
                {members.length} steps
              </div>
            )}
            <div
              className={
                isGroup
                  ? "flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1"
                  : "contents"
              }
            >
              {members.map((step) => (
                <MinimapStepPopupRow
                  key={step.key}
                  step={step}
                  inGroup={isGroup}
                  onStepClick={onStepClick}
                  onStepToggle={onStepToggle}
                  onStepSolo={onStepSolo}
                  onDismissPin={onDismissPin}
                />
              ))}
            </div>
          </div>

          {/* Tail triangle pointing right toward the marker */}
          <div
            className="self-center flex-shrink-0 text-dropdown-bg"
            style={{
              width: 0,
              height: 0,
              borderTop: `${POPUP_TAIL_PX / 2}px solid transparent`,
              borderBottom: `${POPUP_TAIL_PX / 2}px solid transparent`,
              borderLeft: "5px solid currentColor",
              filter:
                "drop-shadow(1px 0 0 var(--vscode-panel-border, rgba(128,128,128,0.35)))",
              ...tailStyle,
            }}
          />
        </div>
      )}

      {/* Marker — click scrolls to the (first) step and pins the popup */}
      <button
        type="button"
        onClick={(e) => {
          if (e.altKey && onStepSolo && !isGroup) {
            e.preventDefault();
            e.stopPropagation();
            onStepSolo(lead);
            return;
          }
          // Keep the popup pinned for mouse, keyboard, and touch activation;
          // stopping propagation protects it from the document-level dismiss
          // listener.
          e.stopPropagation();
          onStepClick(lead);
          onTogglePin(group.key);
        }}
        onKeyDown={(e) => {
          if (e.key === KEYBOARD_KEYS.ESCAPE) {
            onDismissPin();
          }
        }}
        title={markerLabel}
        aria-label={markerLabel}
        aria-expanded={isOpen}
        tabIndex={0}
        className={`h-full w-[var(--cy-output-minimap-pills-width)] flex-shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border transition-transform duration-100 bg-current ${
          isGroup
            ? "rounded-sm"
            : "rounded-full group-hover:scale-y-150 group-focus-within:scale-y-150"
        } ${toneClass}`}
      />
      {hasHiddenActivity && (
        <span
          data-minimap-hidden-activity
          className="ml-0.5 h-1 w-1 self-center rounded-full bg-output-streaming animate-pulse-streaming"
          aria-hidden="true"
        />
      )}
    </div>
  );
};

export const OutputMinimapMarker = memo(OutputMinimapMarkerComponent);
OutputMinimapMarker.displayName = "OutputMinimapMarker";
