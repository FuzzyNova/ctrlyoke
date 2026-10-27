import React from "react";
import { useUiStore } from "@store/uiStore";
import { Icon } from "../shared/Icon";

/**
 * Global toggle for the sticky step header (`OutputPane`). It sits on every
 * step and parallel-group header rather than in a menu so the control that
 * turns the sticky copy off is the one drawn on it, and the one that turns it
 * back on is on the header that would have stuck.
 */
export const StepHeaderPinButton: React.FC = () => {
  const isPinned = useUiStore((state) => state.stepHeaderPinned);
  const togglePinned = useUiStore((state) => state.toggleStepHeaderPinned);
  return (
    <button
      type="button"
      onClick={togglePinned}
      style={{ touchAction: "manipulation" }}
      title={
        isPinned
          ? "Unpin step headers (scroll with output)"
          : "Pin step headers to the top of the output while scrolling"
      }
      aria-label={isPinned ? "Unpin step headers" : "Pin step headers"}
      aria-pressed={isPinned}
      className="inline-flex shrink-0 items-center text-description-fg hover:text-foreground transition-colors"
    >
      <Icon name={isPinned ? "codicon-pinned" : "codicon-pin"} />
    </button>
  );
};
