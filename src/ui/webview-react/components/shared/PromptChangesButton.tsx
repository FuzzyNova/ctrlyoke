import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import {
  getPromptChangeLabelSteps,
  type PromptChangeSummary,
} from "@utils/promptUndo";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";

/** Below this much spare width a label counts as not fitting (sub-pixel noise). */
const FIT_TOLERANCE_PX = 0.5;

interface PromptChangesButtonProps {
  summary: PromptChangeSummary;
  /** Start the steps at `View N` instead of the full label. */
  compact?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  /**
   * Colour, padding and the icon-to-label `gap-*`; the button supplies its own
   * layout and sizing.
   */
  className: string;
  iconClassName?: string;
}

function horizontalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
  );
}

/**
 * Picks the widest of a set of stacked labels that fits the button.
 *
 * Every step stays laid out (the unpicked ones `invisible`) in one grid cell,
 * and the button's preferred width is pinned to the widest of them, so the
 * width the flex layout hands it never depends on which step is showing;
 * picking a step can therefore never feed back into the measurement.
 *
 * The button carries `contain: inline-size`. Without it, Chromium counts the
 * label text in the button's min-content width, so the button either refuses
 * to shrink at all or, with `min-width: 0`, shrinks right through its own icon.
 * Containment zeroes its intrinsic width, which is why its width and minimum
 * (the icon-only step) are set here from the measured steps.
 */
function useWidestFittingStep(stepCount: number, resetKey: unknown) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const stepRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  const fit = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const widths = stepRefs.current
      .slice(0, stepCount)
      .map((step) => step?.getBoundingClientRect().width ?? 0);
    const padding = horizontalPadding(button);
    // Set straight on the node (React manages neither property), so the
    // measurement below already sees the button at its flexed size.
    button.style.width = `${Math.ceil((widths[0] ?? 0) + padding)}px`;
    button.style.minWidth = `${Math.ceil((widths[stepCount - 1] ?? 0) + padding)}px`;
    const available =
      button.getBoundingClientRect().width - padding + FIT_TOLERANCE_PX;
    const fitting = widths.findIndex((width) => width <= available);
    setStepIndex(fitting < 0 ? stepCount - 1 : fitting);
  }, [stepCount]);

  // Before paint, so a narrow pane never flashes the wider label first.
  useLayoutEffect(fit, [fit, resetKey]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const { observer, disconnect } = createAnimationFrameResizeObserver(fit);
    observer.observe(button);
    // A font-size change resizes the labels before it resizes the button.
    const widest = stepRefs.current[0];
    if (widest) observer.observe(widest);
    return disconnect;
  }, [fit]);

  return { buttonRef, stepRefs, stepIndex };
}

/**
 * The "View N changes" button. As its room shrinks it steps down from the full
 * label to `View N`, to `N`, to the diff icon alone; no label is ever cut off
 * with an ellipsis. It shrinks only when its flex container squeezes it, so
 * callers decide what gives way before it.
 *
 * A step narrower than the button's slot sits at its right edge, so the spare
 * room shows up beside the button rather than between the icon and the count.
 * Only the visible step takes clicks, so that spare room is not a hidden hit
 * target. The single column is `minmax(0, 1fr)` rather than `auto`: an auto
 * track widens to the widest (hidden) step, and right-aligning within it would
 * push the visible step past the button's clipped edge.
 */
export const PromptChangesButton: React.FC<PromptChangesButtonProps> = ({
  summary,
  compact = false,
  onClick,
  disabled,
  title,
  ariaLabel,
  className,
  iconClassName = "",
}) => {
  const steps = useMemo(
    () => getPromptChangeLabelSteps(summary, compact),
    [summary, compact]
  );
  const { buttonRef, stepRefs, stepIndex } = useWidestFittingStep(
    steps.length,
    steps
  );
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{ touchAction: "manipulation" }}
      title={title}
      aria-label={ariaLabel}
      className={`pointer-events-none grid grid-cols-[minmax(0,1fr)] overflow-hidden whitespace-nowrap contain-inline-size ${className}`}
    >
      {steps.map((step, index) => (
        <span
          key={index}
          ref={(node) => {
            stepRefs.current[index] = node;
          }}
          // `gap-[inherit]` takes the caller's `gap-*`, which on the
          // single-cell grid itself would do nothing.
          className={`col-start-1 row-start-1 flex items-center justify-self-end gap-[inherit] ${
            index === stepIndex ? "pointer-events-auto" : "invisible"
          }`}
          data-change-label-step={index === stepIndex ? "active" : undefined}
        >
          <Icon name="diff" className={`shrink-0 ${iconClassName}`} />
          {step.main && (
            <span>
              {step.main}
              {step.undone && (
                <span className="text-terminal-ansiGreen">{step.undone}</span>
              )}
            </span>
          )}
        </span>
      ))}
    </button>
  );
};
