import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";

interface UseFinalStepContextMenuOptions {
  hasFinalStep: boolean;
  isReadOnly: boolean;
  isDisabled: boolean;
  onToggleEnabled: () => void;
}

export function useFinalStepContextMenu({
  hasFinalStep,
  isReadOnly,
  isDisabled,
  onToggleEnabled,
}: UseFinalStepContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openFinalStepContextMenu = useCallback(
    (x: number, y: number) => {
      setContextMenu({
        x,
        y,
        items: [
          {
            label: isDisabled ? "Enable final step" : "Disable final step",
            icon: isDisabled ? "codicon-check" : "codicon-circle-slash",
            disabled: !hasFinalStep || isReadOnly,
            disabledTitle: !hasFinalStep
              ? "No final step configured"
              : "Cannot change while final step is running",
            onClick: onToggleEnabled,
          },
        ],
      });
    },
    [hasFinalStep, isDisabled, isReadOnly, onToggleEnabled]
  );

  const finalStepContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openFinalStepContextMenu, finalStepContextMenuPortal };
}
