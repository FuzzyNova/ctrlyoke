import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";

interface UseFinalStepContextMenuOptions {
  hasFinalStep: boolean;
  isReadOnly: boolean;
  onDisable: () => void;
}

export function useFinalStepContextMenu({
  hasFinalStep,
  isReadOnly,
  onDisable,
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
            label: "Disable final step",
            icon: "codicon-trash",
            disabled: !hasFinalStep || isReadOnly,
            disabledTitle: !hasFinalStep
              ? "No final step configured"
              : "Cannot disable while final step is running",
            onClick: onDisable,
          },
        ],
      });
    },
    [hasFinalStep, isReadOnly, onDisable]
  );

  const finalStepContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openFinalStepContextMenu, finalStepContextMenuPortal };
}
