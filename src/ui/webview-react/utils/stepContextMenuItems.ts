import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import type { StepContextMenuItem } from "../components/shared/StepContextMenu";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { ReorderPromptsMessage } from "@root/types/WebviewMessageTypes";
import {
  EXECUTION_STATES,
  type ExecutionState,
} from "@root/types/DashboardConstants";
import { isExecutionBusy } from "./status";
import { getTargetKey, toOutputMessageTarget } from "./outputProjection";
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

export interface StepOutputFilterMenuItemsInput {
  hidden: boolean;
  allPresentTargetKeys: readonly string[];
  onToggle: () => void;
  onSolo: (allPresentTargetKeys: readonly string[]) => void;
}

/** Output visibility actions shared by queue-step and final-step menus. */
export function buildStepOutputFilterMenuItems({
  hidden,
  allPresentTargetKeys,
  onToggle,
  onSolo,
}: StepOutputFilterMenuItemsInput): StepContextMenuItem[] {
  return [
    {
      label: hidden ? "Show output" : "Hide output",
      icon: hidden ? "codicon-eye" : "codicon-eye-closed",
      disabled: false,
      onClick: onToggle,
    },
    {
      label: "Show only this step's output",
      icon: "codicon-target",
      disabled: false,
      onClick: () => onSolo(allPresentTargetKeys),
    },
  ];
}

/** Collect the logical output targets present in a displayed entry list. */
export function getPresentOutputTargetKeys(
  entries: readonly OrderedHistoryEntry[]
): string[] {
  const keys = new Set<string>();
  for (const entry of entries) {
    if ("target" in entry) {
      keys.add(getTargetKey(toOutputMessageTarget(entry.target)));
    }
  }
  return [...keys];
}

type PendingGroupRange = ReorderPromptsMessage["pendingGroups"][number];

export interface StepGroupingMenuItemsInput {
  stepIndex: number;
  currentStep: number;
  steps: readonly WorkflowStep[];
  parallelGroups: readonly ParallelGroupDefinition[];
  executionState: ExecutionState;
  disabled: boolean;
  disabledTitle?: string;
  onReorder: (
    newPendingOrder: number[],
    pendingGroups: PendingGroupRange[]
  ) => void;
}

export function isParallelGroupTopologyLocked(
  group: ParallelGroupDefinition,
  steps: readonly WorkflowStep[],
  currentStep: number,
  executionState: ExecutionState
): boolean {
  return (
    group.startIndex < currentStep ||
    steps
      .slice(group.startIndex, group.endIndex + 1)
      .some((step) => step._runtime?.completedAt !== undefined) ||
    ((executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING) &&
      currentStep >= group.startIndex &&
      currentStep <= group.endIndex)
  );
}

function pendingGroupRanges(
  currentStep: number,
  parallelGroups: readonly ParallelGroupDefinition[]
): PendingGroupRange[] {
  return parallelGroups
    .filter((group) => group.startIndex >= currentStep)
    .map((group) => ({
      id: group.id,
      start: group.startIndex - currentStep,
      end: group.endIndex - currentStep,
      failFast: group.failFast,
    }));
}

function rangeForPendingPosition(
  pendingPosition: number,
  groups: PendingGroupRange[]
): PendingGroupRange | undefined {
  return groups.find(
    (group) => pendingPosition >= group.start && pendingPosition <= group.end
  );
}

function buildGroupingMutation(
  stepIndex: number,
  neighborIndex: number,
  currentStep: number,
  parallelGroups: readonly ParallelGroupDefinition[]
): PendingGroupRange[] | undefined {
  const pendingStart = Math.min(stepIndex, neighborIndex) - currentStep;
  const pendingEnd = Math.max(stepIndex, neighborIndex) - currentStep;
  if (pendingStart < 0) return undefined;

  const groups = pendingGroupRanges(currentStep, parallelGroups);
  const first = rangeForPendingPosition(pendingStart, groups);
  const second = rangeForPendingPosition(pendingEnd, groups);
  const merged = new Map<string, PendingGroupRange>();
  const additions: PendingGroupRange[] = [];
  for (const group of groups) {
    if (group !== first && group !== second) {
      merged.set(group.id!, { ...group });
    }
  }

  if (first && second && first.id === second.id) {
    return undefined;
  }
  if (first) {
    merged.set(first.id!, {
      ...first,
      start: Math.min(first.start, pendingStart),
      end: Math.max(first.end, pendingEnd),
    });
  } else if (second) {
    merged.set(second.id!, {
      ...second,
      start: Math.min(second.start, pendingStart),
      end: Math.max(second.end, pendingEnd),
    });
  } else {
    additions.push({
      start: pendingStart,
      end: pendingEnd,
      failFast: true,
    });
  }

  return [...merged.values(), ...additions].sort(
    (left, right) => left.start - right.start
  );
}

/** Build context-menu actions that mutate the pending-tail group topology. */
export function buildStepGroupingMenuItems({
  stepIndex,
  currentStep,
  steps,
  parallelGroups,
  executionState,
  disabled,
  disabledTitle,
  onReorder,
}: StepGroupingMenuItemsInput): StepContextMenuItem[] {
  const pendingPosition = stepIndex - currentStep;
  if (pendingPosition < 0 || stepIndex >= steps.length) return [];

  const groups = pendingGroupRanges(currentStep, parallelGroups);
  const containing = rangeForPendingPosition(pendingPosition, groups);
  if (containing) {
    return [
      {
        label: "Ungroup parallel steps",
        icon: "codicon-ungroup-by-ref-type",
        disabled,
        disabledTitle,
        onClick: () => {
          onReorder(
            Array.from(
              { length: steps.length - currentStep },
              (_, index) => index
            ),
            groups.filter((group) => group.id !== containing.id)
          );
        },
      },
    ];
  }

  // A neighbor being merged into is never the step the caller checked when it
  // computed `disabled` (that check only ever covers stepIndex's own group,
  // and stepIndex is guaranteed ungrouped here) — so an adjacent step that
  // belongs to a settled/in-flight group, or the currently executing step
  // itself, needs its own lock check or the server rejects a merge the menu
  // never disabled.
  const isBoundaryBusy = (index: number) =>
    index === currentStep && isExecutionBusy(executionState);
  const isNeighborLocked = (neighborIndex: number): boolean => {
    const neighborGroup = parallelGroups.find(
      (group) =>
        neighborIndex >= group.startIndex && neighborIndex <= group.endIndex
    );
    return neighborGroup
      ? isParallelGroupTopologyLocked(
          neighborGroup,
          steps,
          currentStep,
          executionState
        )
      : false;
  };

  const items: StepContextMenuItem[] = [];
  const makeGroupItem = (neighborIndex: number, label: string) => {
    const nextGroups = buildGroupingMutation(
      stepIndex,
      neighborIndex,
      currentStep,
      parallelGroups
    );
    if (!nextGroups) return;
    const itemLocked =
      isNeighborLocked(neighborIndex) ||
      isBoundaryBusy(stepIndex) ||
      isBoundaryBusy(neighborIndex);
    items.push({
      label,
      icon: "codicon-group-by-ref-type",
      disabled: disabled || itemLocked,
      disabledTitle: disabled
        ? disabledTitle
        : itemLocked
          ? "Cannot change a settled or executing parallel group"
          : undefined,
      onClick: () => {
        onReorder(
          Array.from(
            { length: steps.length - currentStep },
            (_, index) => index
          ),
          nextGroups
        );
      },
    });
  };

  if (stepIndex > currentStep) {
    makeGroupItem(stepIndex - 1, "Group with previous step");
  }
  if (stepIndex < steps.length - 1) {
    makeGroupItem(stepIndex + 1, "Group with next step");
  }
  return items;
}
