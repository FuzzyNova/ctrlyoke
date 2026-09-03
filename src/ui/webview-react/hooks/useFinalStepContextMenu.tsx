import { useState, useCallback, useMemo } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import { type StepRuntimeMetaSnapshot } from "@utils/stepMetadataClipboard";
import {
  buildStepCopyMenuItems,
  buildStepOutputFilterMenuItems,
  getPresentOutputTargetKeys,
} from "@utils/stepContextMenuItems";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { getTargetKey } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";

const SHELL_WORKFLOW_ID = "_shell";
const EMPTY_TARGET_KEYS: readonly string[] = [];
const EMPTY_ORDERED_ENTRIES: readonly OrderedHistoryEntry[] = [];

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
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const hiddenOutputTargets = useUiStore((s) => s.hiddenOutputTargets);
  const toggleHiddenOutputTarget = useUiStore(
    (s) => s.toggleHiddenOutputTarget
  );
  const soloOutputTarget = useUiStore((s) => s.soloOutputTarget);
  const isViewingHistory = useUiStore((s) => s.isViewingHistory);
  const finalStepLoopCount = useWorkflowStore((s) => s.finalStepLoopCount);
  const liveOrderedEntries = useWorkflowStore((s) => s.liveOrderedEntries);
  const historyOutputs = useWorkflowStore((s) => s.historyOutputs);
  const outputEntries = isViewingHistory
    ? (historyOutputs?.orderedEntries ?? EMPTY_ORDERED_ENTRIES)
    : liveOrderedEntries;
  const presentOutputTargetKeys = useMemo(
    () => getPresentOutputTargetKeys(outputEntries),
    [outputEntries]
  );
  const outputFilterWorkflowKey = displayedViewAddress
    ? workflowViewAddressKey(displayedViewAddress)
    : SHELL_WORKFLOW_ID;
  const hiddenOutputKeys =
    hiddenOutputTargets[outputFilterWorkflowKey]?.keys ?? EMPTY_TARGET_KEYS;
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
      const targetKey = getTargetKey({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        index: finalStepLoopCount,
      });
      const allPresentTargetKeys = presentOutputTargetKeys.includes(targetKey)
        ? presentOutputTargetKeys
        : [...presentOutputTargetKeys, targetKey];
      const filterItems = finalStep
        ? buildStepOutputFilterMenuItems({
            hidden: hiddenOutputKeys.includes(targetKey),
            allPresentTargetKeys,
            onToggle: () =>
              toggleHiddenOutputTarget(outputFilterWorkflowKey, targetKey),
            onSolo: (keys) =>
              soloOutputTarget(outputFilterWorkflowKey, targetKey, keys),
          })
        : [];

      setContextMenu({
        x,
        y,
        items: [
          ...copyItems,
          ...(copyItems.length > 0 ? [{ type: "divider" as const }] : []),
          ...filterItems,
          ...(filterItems.length > 0 ? [{ type: "divider" as const }] : []),
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
    [
      finalStep,
      isDisabled,
      isReadOnly,
      onToggleEnabled,
      outputText,
      latestOutput,
      runtimeMeta,
      finalStepLoopCount,
      hiddenOutputKeys,
      outputFilterWorkflowKey,
      presentOutputTargetKeys,
      soloOutputTarget,
      toggleHiddenOutputTarget,
    ]
  );

  const finalStepContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openFinalStepContextMenu, finalStepContextMenuPortal };
}
