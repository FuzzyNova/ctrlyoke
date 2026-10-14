import { useState, useCallback, useMemo } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../components/shared/StepContextMenu";
import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import {
  getStepSessionDetails,
  type StepRuntimeMetaSnapshot,
} from "@utils/stepMetadataClipboard";
import {
  buildReplyToStepMenuItem,
  buildStepCopyMenuItems,
  buildStepOutputFilterMenuItems,
  getPresentFinalStepTargetKeys,
  getPresentOutputTargetKeys,
} from "@utils/stepContextMenuItems";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { getTargetKey } from "@utils/outputProjection";
import { FINAL_STEP_PHASES } from "@/types/messages";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import { useFinalStepLatestPrompt } from "@hooks/useLatestStepOutput";

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
  latestPrompt?: string;
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
  latestPrompt,
  runtimeMeta,
}: UseFinalStepContextMenuOptions) {
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const hiddenOutputTargets = useUiStore((s) => s.hiddenOutputTargets);
  const setOutputTargetsHidden = useUiStore((s) => s.setOutputTargetsHidden);
  const soloOutputTargets = useUiStore((s) => s.soloOutputTargets);
  const isViewingHistory = useUiStore((s) => s.isViewingHistory);
  const finalStepLoopCount = useWorkflowStore((s) => s.finalStepLoopCount);
  const currentLatestPrompt = useFinalStepLatestPrompt();
  const liveContextWindow = useWorkflowStore(
    (s) => s.liveFinalStepContextWindow[s.finalStepLoopCount]
  );
  const liveOrderedEntries = useWorkflowStore((s) => s.liveOrderedEntries);
  const historyOutputs = useWorkflowStore((s) => s.historyOutputs);
  const outputEntries = isViewingHistory
    ? (historyOutputs?.orderedEntries ?? EMPTY_ORDERED_ENTRIES)
    : liveOrderedEntries;
  const presentOutputTargetKeys = useMemo(
    () => getPresentOutputTargetKeys(outputEntries),
    [outputEntries]
  );
  const presentFinalStepTargetKeys = useMemo(
    () => getPresentFinalStepTargetKeys(outputEntries),
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
            latestPrompt: latestPrompt ?? currentLatestPrompt,
            runtimeMeta,
            liveContextWindow,
          })
        : [];
      // The final step card stands for the final step as a whole, so its
      // filter actions cover every loop it has run. Per-loop control lives on
      // the minimap, where each loop is its own marker. `finalStepLoopCount`
      // is only a fallback for a final step with no output yet: once a loop
      // appends queue work it names the *next* loop, which has no output.
      const finalStepTargetKeys =
        presentFinalStepTargetKeys.length > 0
          ? presentFinalStepTargetKeys
          : [
              getTargetKey({
                kind: FINAL_STEP_PHASES.FINAL_STEP,
                index: finalStepLoopCount,
              }),
            ];
      const allPresentTargetKeys = [
        ...new Set([...presentOutputTargetKeys, ...finalStepTargetKeys]),
      ];
      const hidden = finalStepTargetKeys.every((key) =>
        hiddenOutputKeys.includes(key)
      );
      const filterItems = finalStep
        ? buildStepOutputFilterMenuItems({
            hidden,
            soloLabel: "Show only final step output",
            onToggle: () =>
              setOutputTargetsHidden(
                outputFilterWorkflowKey,
                finalStepTargetKeys,
                !hidden
              ),
            onSolo: () =>
              soloOutputTargets(
                outputFilterWorkflowKey,
                finalStepTargetKeys,
                allPresentTargetKeys
              ),
          })
        : [];

      setContextMenu({
        x,
        y,
        items: [
          ...copyItems,
          ...(copyItems.length > 0 ? [{ type: "divider" as const }] : []),
          ...(finalStep
            ? [
                buildReplyToStepMenuItem({
                  step: finalStep,
                  ...getStepSessionDetails(
                    finalStep,
                    latestOutput,
                    runtimeMeta
                  ),
                  sourceLabel: "Final step",
                }),
                { type: "divider" as const },
              ]
            : []),
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
      latestPrompt,
      currentLatestPrompt,
      runtimeMeta,
      liveContextWindow,
      finalStepLoopCount,
      hiddenOutputKeys,
      outputFilterWorkflowKey,
      presentFinalStepTargetKeys,
      presentOutputTargetKeys,
      setOutputTargetsHidden,
      soloOutputTargets,
    ]
  );

  const finalStepContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openFinalStepContextMenu, finalStepContextMenuPortal };
}
