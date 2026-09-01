import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import type { StepContextMenuItem } from "../components/shared/StepContextMenu";
import {
  getWorkflowStepRawText,
  isScriptWorkflowStep,
  serializeWorkflowStepText,
  writeClipboardText,
} from "./stepClipboard";
import {
  buildStepMetadataClipboardText,
  type StepRuntimeMetaSnapshot,
} from "./stepMetadataClipboard";

export interface StepCopyMenuItemsInput {
  step: WorkflowStep;
  /** 1-based display position for the Copy Metadata header line; ignored when `isFinalStep`. */
  slotNumber?: number;
  /** True for the workflow's final step, which has no queue position. */
  isFinalStep?: boolean;
  /** Response/output text to copy; undefined disables the Copy Output item. */
  outputText?: string;
  latestOutput?: CliOutput | null;
  runtimeMeta?: StepRuntimeMetaSnapshot;
  liveContextWindow?: { used: number; size: number };
}

/**
 * The four "Copy ..." items shared by the queue-step and final-step context
 * menus (useStepContextMenu / useFinalStepContextMenu).
 */
export function buildStepCopyMenuItems({
  step,
  slotNumber,
  isFinalStep = false,
  outputText,
  latestOutput,
  runtimeMeta,
  liveContextWindow,
}: StepCopyMenuItemsInput): StepContextMenuItem[] {
  const copyContentLabel = isScriptWorkflowStep(step)
    ? "Copy Script"
    : "Copy Prompt";

  return [
    {
      label: "Copy Step",
      icon: "codicon-copy",
      disabled: false,
      onClick: () => {
        void writeClipboardText(serializeWorkflowStepText(step));
      },
    },
    {
      label: copyContentLabel,
      icon: "codicon-copy",
      disabled: false,
      onClick: () => {
        void writeClipboardText(getWorkflowStepRawText(step));
      },
    },
    {
      label: "Copy Output",
      icon: "codicon-copy",
      disabled: !outputText,
      disabledTitle: "No output to copy",
      onClick: () => {
        if (!outputText) return;
        void writeClipboardText(outputText);
      },
    },
    {
      label: "Copy Metadata",
      icon: "codicon-copy",
      disabled: false,
      onClick: () => {
        void writeClipboardText(
          buildStepMetadataClipboardText({
            step,
            slotNumber,
            isFinalStep,
            latestOutput,
            runtimeMeta,
            liveContextWindow,
          })
        );
      },
    },
  ];
}
