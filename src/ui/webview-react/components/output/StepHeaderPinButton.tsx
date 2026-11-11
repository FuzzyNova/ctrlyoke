import React from "react";
import { useUiStore } from "@store/uiStore";
import { PinToggleButton } from "../shared/PinToggleButton";

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
    <PinToggleButton
      pinned={isPinned}
      onToggle={togglePinned}
      pinTooltip="Pin step headers to the top of the output while scrolling"
      unpinTooltip="Unpin step headers (scroll with output)"
      ariaLabel="Pin step headers"
    />
  );
};
