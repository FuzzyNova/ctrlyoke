import type { WorkflowStep, CliOutput } from "@store/workflowStore";
import type {
  ContextMenuItem,
  ContextMenuSubmenu,
} from "../components/shared/ContextMenu";
import { selectionTargetKey, useEditorStore } from "@store/editorStore";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";
import {
  isScriptStep,
  isPromptStep,
  type ParallelGroupDefinition,
} from "@root/types/CtrlYokeTypes";
import type { ReorderPromptsMessage } from "@root/types/WebviewMessageTypes";
import {
  EDITOR_TARGET_KINDS,
  FINAL_STEP_PHASES,
  STEER_ORIGIN_KINDS,
  type ExecutionState,
  type FinalStepPhase,
} from "@root/types/DashboardConstants";
import { isScriptEditorStepType } from "@utils/stepDraftContent";
import { executionOwnsCurrentStep, getStepKindLabel } from "./status";
import { getStepAssistantTextForCopy } from "./outputUtils";
import {
  getTargetKey,
  toOutputMessageTarget,
  type OutputMessageTarget,
} from "./outputProjection";
import {
  getWorkflowStepRawText,
  serializeWorkflowStepText,
} from "./workflowStepSerialization";
import { writeClipboardText } from "./clipboard";
import {
  buildStepMetadataClipboardText,
  type StepRuntimeMetaSnapshot,
} from "./stepMetadataClipboard";
import { startReplyFromStep } from "./replyToStep";
import {
  OUTPUT_COPY_MENU_LABELS,
  getStepCopyLabels,
} from "./outputCopyMenuLabels";
import { generateSingleStepMarkdownExport } from "./markdownExport";
import {
  END_STEP_EARLY_UNSUPPORTED,
  NO_LIVE_HARNESS,
  STEER_EXTERNAL_RUN,
  STEER_NO_CONTENT,
  STEER_PROMPT_ONLY,
  formatEndStepEarlyTitle,
  formatNoLiveSessionReason,
  formatSteerTargetLabel,
  formatSteerTargetTitle,
  type SteerTarget,
} from "./steerTargets";
import { sendEditorDraftAsSteer, sendSteerText } from "./sendEditorSteer";
import { sendMessage } from "@messaging/sendMessage";
import { MESSAGE_TYPES } from "@/types/messages";

export interface StepCopyMenuItemsInput {
  step: WorkflowStep;
  /** 1-based display position for the Copy Metadata header line; ignored when `isFinalStep`. */
  slotNumber?: number;
  /** True for the workflow's final step, which has no queue position. */
  isFinalStep?: boolean;
  latestOutput?: CliOutput | null;
  latestPrompt?: string;
  runtimeMeta?: StepRuntimeMetaSnapshot;
  isCurrent?: boolean;
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
  latestOutput,
  latestPrompt,
  runtimeMeta,
  isCurrent,
  liveContextWindow,
}: StepCopyMenuItemsInput): ContextMenuItem[] {
  const outputText = latestOutput
    ? getStepAssistantTextForCopy(latestOutput)
    : undefined;
  const isScript = isScriptStep(step);
  const copyContentLabel = `Copy ${getStepKindLabel(step.type)}`;
  const copyLabels = getStepCopyLabels(isScript);

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
      label: copyLabels.menu,
      icon: "codicon-copy",
      disabled: !outputText,
      title: copyLabels.title,
      disabledTitle: "No output to copy",
      onClick: () => {
        if (!outputText) return;
        void writeClipboardText(outputText);
      },
    },
    {
      label: OUTPUT_COPY_MENU_LABELS.COPY_TRANSCRIPT,
      icon: "codicon-copy",
      disabled: !latestOutput,
      title: copyLabels.transcriptTitle,
      disabledTitle: "No output to copy",
      onClick: () => {
        if (!latestOutput) return;
        void writeClipboardText(
          generateSingleStepMarkdownExport(
            latestOutput,
            {
              kind: isFinalStep
                ? FINAL_STEP_PHASES.FINAL_STEP
                : FINAL_STEP_PHASES.QUEUE,
              index: Math.max(0, (slotNumber ?? 1) - 1),
            },
            latestPrompt
          )
        );
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
            isCurrent,
            liveContextWindow,
          })
        );
      },
    },
  ];
}

export interface ReplyToStepMenuItemInput {
  step: WorkflowStep;
  sessionId?: string;
  sessionHarness?: string;
  sessionModel?: string;
  /** Reply banner label for the step, e.g. `Step 3` or `Final step`. */
  sourceLabel: string;
}

/** Build the action that starts a new prompt using this step's session. */
export function buildReplyToStepMenuItem({
  step,
  sessionId,
  sessionHarness,
  sessionModel,
  sourceLabel,
}: ReplyToStepMenuItemInput): ContextMenuItem {
  const isScript = isScriptStep(step);
  const hasSession = typeof sessionId === "string" && sessionId.length > 0;

  return {
    label: "Reply to Step",
    icon: "codicon-reply",
    disabled: isScript || !hasSession,
    disabledTitle: isScript
      ? "Script steps have no AI session to reply to"
      : !hasSession
        ? "This step has no session to resume yet"
        : undefined,
    onClick: () => {
      if (isScriptStep(step) || !sessionId) return;
      startReplyFromStep(
        step,
        sessionId,
        sourceLabel,
        sessionHarness,
        sessionModel
      );
    },
  };
}

export interface LiveStepControlMenuItemsInput {
  workflowId: string | null;
  /** Queue index, or the signed final-step index `-(loopIndex + 1)`. */
  stepIndex: number;
  /** True while this step is executing. */
  isRunning: boolean;
  /** This step's live steer destination, from `useSteerTargets`. */
  target: SteerTarget | undefined;
  /** Why the editor draft can't be sent (`getSteerDraftDisabledReason`). */
  draftDisabledReason: string | undefined;
  isExternallyManaged: boolean;
}

/**
 * Send Steer to Step and End Step Early. The pressed step is the target, so
 * neither needs a picker. Send Steer to Step also appears on a finished step
 * whose interactive terminal is still open; End Step Early only on a running
 * step. Returns no items for a step with neither.
 */
export function buildLiveStepControlMenuItems({
  workflowId,
  stepIndex,
  isRunning,
  target,
  draftDisabledReason,
  isExternallyManaged,
}: LiveStepControlMenuItemsInput): ContextMenuItem[] {
  if (!isRunning && !target) return [];
  const steerDisabledReason = !target
    ? formatNoLiveSessionReason(stepIndex)
    : draftDisabledReason;
  const items: ContextMenuItem[] = [
    {
      label: "Send Steer to Step",
      icon: "codicon-arrow-up",
      disabled: steerDisabledReason !== undefined || !workflowId,
      title: target ? formatSteerTargetTitle(target) : undefined,
      disabledTitle: steerDisabledReason,
      onClick: () => {
        if (steerDisabledReason !== undefined || !workflowId || !target) {
          return;
        }
        sendEditorDraftAsSteer(workflowId, target.sessionId);
      },
    },
  ];
  if (isRunning) {
    const endDisabledReason = isExternallyManaged
      ? STEER_EXTERNAL_RUN
      : !target?.canInterruptTurn
        ? END_STEP_EARLY_UNSUPPORTED
        : undefined;
    items.push({
      label: "End Step Early",
      icon: "codicon-debug-stop",
      disabled: endDisabledReason !== undefined || !workflowId,
      title: formatEndStepEarlyTitle(stepIndex),
      disabledTitle: endDisabledReason,
      onClick: () => {
        if (endDisabledReason !== undefined || !workflowId || !target) return;
        sendMessage(MESSAGE_TYPES.INTERRUPT_HEADLESS_TURN, {
          workflowId,
          sessionId: target.sessionId,
        });
      },
    });
  }
  return items;
}

export interface QueuedStepHandoffMenuItemsInput {
  step: WorkflowStep;
  /** Absolute queue index of the step. */
  stepIndex: number;
  workflowId: string | null;
  /**
   * Why the step cannot leave the queue (it is running or settled, or the
   * workflow is read-only), or undefined when it can.
   */
  removeDisabledReason: string | undefined;
  /** Every live steer destination for the workflow, from `useSteerTargets`. */
  steerTargets: readonly SteerTarget[];
}

/**
 * Move to Editor and Send as Steer: take a queued step back out of the queue,
 * into the prompt editor or into a live session. Both remove the step without
 * the delete confirmation, because its text is not lost: it is in the editor,
 * or delivered and kept in Recent Prompts (a failed steer is restored as a
 * new-step draft). Send as Steer opens a submenu when several sessions are live.
 */
export function buildQueuedStepHandoffMenuItems({
  step,
  stepIndex,
  workflowId,
  removeDisabledReason,
  steerTargets,
}: QueuedStepHandoffMenuItemsInput): Array<
  ContextMenuItem | ContextMenuSubmenu
> {
  const removeStep = () =>
    sendMessage(MESSAGE_TYPES.DELETE_PROMPT, { indices: [stepIndex] });

  const editorState = useEditorStore.getState();
  const replacedDraft =
    editorState.selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT
      ? editorState
      : editorState.savedNewPromptState;
  const scriptDraftWouldBeReplaced =
    replacedDraft !== null &&
    replacedDraft !== undefined &&
    isScriptEditorStepType(replacedDraft.stepType) &&
    replacedDraft.scriptCommand.trim().length > 0;
  const moveDisabledReason =
    removeDisabledReason ??
    (scriptDraftWouldBeReplaced
      ? "Save or clear the script draft before moving a step into the editor"
      : undefined);
  const moveToEditor: ContextMenuItem = {
    label: "Move to Editor",
    icon: "codicon-edit",
    disabled: moveDisabledReason !== undefined,
    title: "Load this step into the prompt editor and remove it from the queue",
    disabledTitle: moveDisabledReason,
    onClick: () => {
      if (moveDisabledReason !== undefined) return;
      useEditorStore.getState().moveStepToNewStepDraft(stepIndex, step);
      removeStep();
    },
  };

  const queuedEdit =
    editorState.pendingEdits[
      selectionTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, index: stepIndex })
    ];
  const isSelectedStep =
    editorState.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
    editorState.selectionTarget.index === stepIndex;
  const savedPrompt = "prompt" in step ? step.prompt : "";
  const queuedPrompt = isSelectedStep
    ? editorState.promptText
    : (queuedEdit?.promptText ?? savedPrompt);
  const steerText = isPromptStep(step) ? queuedPrompt.trim() : "";
  // A step's own session never steers it: it has not started yet.
  const destinations = steerTargets.filter(
    (target) => target.stepIndex !== stepIndex
  );
  const steerDisabledReason = !isPromptStep(step)
    ? STEER_PROMPT_ONLY
    : (removeDisabledReason ??
      (steerText.length === 0
        ? STEER_NO_CONTENT
        : !workflowId || destinations.length === 0
          ? NO_LIVE_HARNESS
          : undefined));
  const steerTo = (target: SteerTarget) => () => {
    if (steerDisabledReason !== undefined || !workflowId) return;
    sendSteerText(workflowId, target.sessionId, steerText, {
      kind: STEER_ORIGIN_KINDS.QUEUED_STEP,
      stepIndex,
      step: isPromptStep(step) ? { ...step, prompt: steerText } : step,
    });
    removeStep();
  };

  const steerLabel = "Send as Steer";
  const steerIcon = "codicon-arrow-up";
  const sendAsSteer: ContextMenuItem | ContextMenuSubmenu =
    steerDisabledReason !== undefined || destinations.length === 1
      ? {
          label: steerLabel,
          icon: steerIcon,
          disabled: steerDisabledReason !== undefined,
          title: destinations[0]
            ? `${formatSteerTargetTitle(destinations[0])} Removes this step from the queue.`
            : undefined,
          disabledTitle: steerDisabledReason,
          onClick: destinations[0] ? steerTo(destinations[0]) : () => {},
        }
      : {
          label: steerLabel,
          icon: steerIcon,
          disabled: false,
          title:
            "Send this step's prompt to a live session and remove it from the queue",
          submenu: destinations.map((target) => ({
            label: formatSteerTargetLabel(target),
            icon: steerIcon,
            disabled: false,
            title: formatSteerTargetTitle(target),
            onClick: steerTo(target),
          })),
        };

  return [moveToEditor, sendAsSteer];
}

export interface StepOutputFilterMenuItemsInput {
  hidden: boolean;
  onToggle: () => void;
  onSolo: () => void;
  /** Defaults to "Show only this step's output". */
  soloLabel?: string;
}

/** Output visibility actions shared by queue-step and final-step menus. */
export function buildStepOutputFilterMenuItems({
  hidden,
  onToggle,
  onSolo,
  soloLabel = "Show only this step's output",
}: StepOutputFilterMenuItemsInput): ContextMenuItem[] {
  return [
    {
      label: hidden ? "Show output" : "Hide output",
      icon: hidden ? "codicon-eye" : "codicon-eye-closed",
      disabled: false,
      onClick: onToggle,
    },
    {
      label: soloLabel,
      icon: "codicon-target",
      disabled: false,
      onClick: onSolo,
    },
  ];
}

/** Collect the logical output targets present in a displayed entry list. */
export function getPresentOutputTargetKeys(
  entries: readonly OrderedHistoryEntry[]
): string[] {
  return collectOutputTargetKeys(entries, () => true);
}

/** Collect the target key of every final-step loop present in an entry list. */
export function getPresentFinalStepTargetKeys(
  entries: readonly OrderedHistoryEntry[]
): string[] {
  return collectOutputTargetKeys(
    entries,
    (target) => target.kind === FINAL_STEP_PHASES.FINAL_STEP
  );
}

function collectOutputTargetKeys(
  entries: readonly OrderedHistoryEntry[],
  include: (target: OutputMessageTarget) => boolean
): string[] {
  const keys = new Set<string>();
  for (const entry of entries) {
    if ("target" in entry) {
      const target = toOutputMessageTarget(entry.target);
      if (include(target)) keys.add(getTargetKey(target));
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
  finalStepPhase: FinalStepPhase | null;
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
  executionState: ExecutionState,
  finalStepPhase: FinalStepPhase | null
): boolean {
  return (
    group.startIndex < currentStep ||
    steps
      .slice(group.startIndex, group.endIndex + 1)
      .some((step) => step._runtime?.completedAt !== undefined) ||
    (executionOwnsCurrentStep(executionState, finalStepPhase) &&
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
  finalStepPhase,
  disabled,
  disabledTitle,
  onReorder,
}: StepGroupingMenuItemsInput): ContextMenuItem[] {
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
    index === currentStep &&
    executionOwnsCurrentStep(executionState, finalStepPhase);
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
          executionState,
          finalStepPhase
        )
      : false;
  };

  const items: ContextMenuItem[] = [];
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
