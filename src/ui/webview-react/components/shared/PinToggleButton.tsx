import React from "react";
import { IconToggleButton } from "./IconToggleButton";

/**
 * Pin/unpin toggle shared by the run summary banner and the step headers.
 * Colors follow `IconToggleButton` (highlight when pinned, no hover fill), and
 * the icon stays body-text size so it sits on a single header line.
 */
export const PinToggleButton: React.FC<{
  pinned: boolean;
  onToggle: () => void;
  pinTooltip: string;
  unpinTooltip: string;
  ariaLabel: string;
}> = ({ pinned, onToggle, pinTooltip, unpinTooltip, ariaLabel }) => (
  <IconToggleButton
    active={pinned}
    onToggle={onToggle}
    activeIcon="codicon-pinned"
    inactiveIcon="codicon-pin"
    activeTooltip={unpinTooltip}
    inactiveTooltip={pinTooltip}
    ariaLabel={ariaLabel}
    iconClassName=""
  />
);
