import { useState, useCallback } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { type StepRuntimeMetaSnapshot } from "@utils/stepMetadataClipboard";
import { buildStepCopyMenuItems } from "@utils/stepContextMenuItems";

interface UseFinalStepContextMenuOptions {
  finalStep: WorkflowStep | null | undefined;
  isReadOnly: boolean;
  isDisabled: boolean;
  onToggleEnabled: () => void;
  /** Response/output text to copy; undefined disables the Copy Output item. */
  outputText?: string;
  /** Latest CLI output for the final step, used to build the Copy Metadata text. */
  latestOutput?: CliOutput | null;
  /** Cached runtime metadata (session ID, elapsed, context window). */
  runtimeMeta?: StepRuntimeMetaSnapshot;
}

export function useFinalStepContextMenu({
  finalStep,
  isReadOnly,
  isDisabled,
  onToggleEnabled,
  outputText,
  latestOutput,
  runtimeMeta,
}: UseFinalStepContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openFinalStepContextMenu = useCallback(
    (x: number, y: number) => {
      const hasFinalStep = !!finalStep;
      const copyItems = finalStep
        ? buildStepCopyMenuItems({
            step: finalStep,
            isFinalStep: true,
            outputText,
            latestOutput,
            runtimeMeta,
          })
        : [];

      setContextMenu({
        x,
        y,
        items: [
          ...copyItems,
          ...(copyItems.length > 0 ? [{ type: "divider" as const }] : []),
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
    [finalStep, isDisabled, isReadOnly, onToggleEnabled, outputText, latestOutput, runtimeMeta]
  );

  const finalStepContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openFinalStepContextMenu, finalStepContextMenuPortal };
}
