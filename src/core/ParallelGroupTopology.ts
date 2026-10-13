import { randomUUID } from "crypto";
import type {
  ParallelGroupDefinition,
  PromptFile,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { isScriptStep } from "../types/CtrlYokeTypes";
import { assertStartedStepPositionsPreserved } from "./StepIdentity";
import { hasStarted } from "../utils/StepStatusDerivation";
import { scanInlinePriorContextRefs } from "../utils/FileReferenceParser";
import {
  PARALLEL_GROUP_INSERT_RELOCATION_KINDS,
  type ParallelGroupInsertRelocationKind,
  PROMPT_TERMINAL_STATUS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
} from "../types/DashboardConstants";

export interface ParallelGroupTopology {
  steps: WorkflowStep[];
  parallelGroups: ParallelGroupDefinition[];
}

type ParallelReferenceDefaults = Pick<PromptFile, "priorContext" | "sessionId">;

/**
 * Reports numeric session and prior-context references that point at another
 * member of the same parallel group. References inherited from workflow-level
 * properties are checked alongside step-level values.
 */
export function getParallelSiblingReferenceErrors(
  steps: WorkflowStep[],
  parallelGroups: ParallelGroupDefinition[],
  workflowDefaults?: ParallelReferenceDefaults
): string[] {
  const errors: string[] = [];

  for (const group of parallelGroups) {
    if (
      !group ||
      !Number.isInteger(group.startIndex) ||
      !Number.isInteger(group.endIndex) ||
      group.startIndex < 0 ||
      group.endIndex >= steps.length ||
      group.startIndex > group.endIndex
    ) {
      continue;
    }

    const memberNumbers = Array.from(
      { length: group.endIndex - group.startIndex + 1 },
      (_, offset) => group.startIndex + offset + 1
    );
    const memberNumberText = memberNumbers.join(", ");

    for (
      let stepIndex = group.startIndex;
      stepIndex <= group.endIndex;
      stepIndex++
    ) {
      const step = steps[stepIndex];
      if (isScriptStep(step)) {
        continue;
      }

      const priorContext =
        step.priorContext !== undefined
          ? step.priorContext
          : workflowDefaults?.priorContext;
      const sessionId =
        step.sessionId !== undefined
          ? step.sessionId
          : workflowDefaults?.sessionId;

      for (const reference of getNumericReferences(priorContext)) {
        if (memberNumbers.includes(reference) && reference !== stepIndex + 1) {
          errors.push(
            `Step ${stepIndex + 1}: Numeric priorContext reference ${reference} cannot target a sibling in parallel group (steps ${memberNumberText})`
          );
        }
      }

      for (const match of scanInlinePriorContextRefs(step.prompt)) {
        if (match.ref.kind !== PRIOR_CONTEXT_REFERENCE_KINDS.STEP) continue;
        for (const reference of match.ref.indices) {
          if (
            memberNumbers.includes(reference) &&
            reference !== stepIndex + 1
          ) {
            errors.push(
              `Step ${stepIndex + 1}: Inline priorContext reference ${reference} cannot target a sibling in parallel group (steps ${memberNumberText})`
            );
          }
        }
      }

      for (const reference of getNumericReferences(sessionId)) {
        if (memberNumbers.includes(reference) && reference !== stepIndex + 1) {
          errors.push(
            `Step ${stepIndex + 1}: Numeric sessionId reference ${reference} cannot target a sibling in parallel group (steps ${memberNumberText})`
          );
        }
      }
    }
  }

  return errors;
}

function getNumericReferences(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (reference): reference is number => typeof reference === "number"
    );
  }
  return [];
}

export function assertNoParallelSiblingReferences(
  topology: ParallelGroupTopology,
  workflowDefaults?: ParallelReferenceDefaults
): void {
  const errors = getParallelSiblingReferenceErrors(
    topology.steps,
    topology.parallelGroups,
    workflowDefaults
  );
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

type ParallelGroupDefinitionInput = Omit<
  ParallelGroupDefinition,
  "id" | "failFast"
> &
  Partial<Pick<ParallelGroupDefinition, "id" | "failFast">>;

export const PARALLEL_GROUP_INSERT_POSITIONS = {
  AFTER: "after",
  BEFORE: "before",
} as const;

export type ParallelGroupInsertPosition =
  (typeof PARALLEL_GROUP_INSERT_POSITIONS)[keyof typeof PARALLEL_GROUP_INSERT_POSITIONS];

export interface ParallelGroupInsertRelocation {
  kind: ParallelGroupInsertRelocationKind;
  groupId: string;
}

export interface ParallelGroupInsertPlacement {
  requestedIndex: number;
  insertedIndex: number;
  relocation?: ParallelGroupInsertRelocation;
}

function cloneTopology(topology: ParallelGroupTopology): ParallelGroupTopology {
  return {
    steps: [...topology.steps],
    parallelGroups: topology.parallelGroups.map((group) => ({ ...group })),
  };
}

function assertIndex(index: number, name: string): void {
  if (!Number.isInteger(index)) {
    throw new Error(`${name} must be an integer`);
  }
}

function groupIndex(
  groups: ParallelGroupDefinition[],
  group: string | number
): number {
  const index =
    typeof group === "number"
      ? group
      : groups.findIndex((candidate) => candidate.id === group);
  if (index < 0 || index >= groups.length) {
    throw new Error(`Unknown parallel group: ${String(group)}`);
  }
  return index;
}

/**
 * Validates the flat-step topology. The ranges are inclusive and every
 * member of a group is represented by one contiguous range.
 */
export function validateParallelGroupTopology(
  topology: ParallelGroupTopology
): void {
  const { steps, parallelGroups } = topology;
  if (!Array.isArray(steps)) {
    throw new Error("Parallel topology steps must be an array");
  }
  if (!Array.isArray(parallelGroups)) {
    throw new Error("Parallel topology groups must be an array");
  }

  const ids = new Set<string>();
  let previousEnd = -1;
  parallelGroups.forEach((group, index) => {
    if (!group || typeof group !== "object") {
      throw new Error(`Parallel group ${index} must be an object`);
    }
    if (typeof group.id !== "string" || group.id.length === 0) {
      throw new Error(`Parallel group ${index} must have a non-empty id`);
    }
    if (ids.has(group.id)) {
      throw new Error(`Duplicate parallel group id: ${group.id}`);
    }
    ids.add(group.id);

    assertIndex(group.startIndex, `Parallel group ${group.id} startIndex`);
    assertIndex(group.endIndex, `Parallel group ${group.id} endIndex`);
    if (typeof group.failFast !== "boolean") {
      throw new Error(`Parallel group ${group.id} failFast must be a boolean`);
    }
    if (
      group.startIndex < 0 ||
      group.endIndex < 0 ||
      group.startIndex > group.endIndex ||
      group.endIndex >= steps.length
    ) {
      throw new Error(`Parallel group ${group.id} range is out of bounds`);
    }
    if (group.endIndex - group.startIndex + 1 < 2) {
      throw new Error(
        `Parallel group ${group.id} must contain at least two steps`
      );
    }
    if (group.startIndex <= previousEnd) {
      throw new Error(`Parallel group ${group.id} overlaps or is out of order`);
    }
    previousEnd = group.endIndex;
  });
}

/**
 * Returns an independent, validated topology. Undefined groups are the
 * canonical empty topology used by drafts and legacy workflows.
 */
export function normalizeParallelGroupTopology(topology: {
  steps: WorkflowStep[];
  parallelGroups?: ParallelGroupDefinitionInput[];
}): ParallelGroupTopology {
  if (!Array.isArray(topology.steps)) {
    throw new Error("Parallel topology steps must be an array");
  }
  if (
    topology.parallelGroups !== undefined &&
    !Array.isArray(topology.parallelGroups)
  ) {
    throw new Error("Parallel topology groups must be an array");
  }
  const normalized: ParallelGroupTopology = {
    steps: [...topology.steps],
    parallelGroups: (topology.parallelGroups ?? []).map((group) => ({
      ...group,
      id: group.id ?? randomUUID(),
      failFast: group.failFast ?? true,
    })),
  };
  validateParallelGroupTopology(normalized);
  return normalized;
}

export function resolveParallelGroupInsertIndex(
  topology: ParallelGroupTopology,
  index: number,
  position: ParallelGroupInsertPosition
): ParallelGroupInsertPlacement {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(index, "Insert index");
  if (index < 0 || index > normalized.steps.length) {
    throw new Error(`Insert index ${index} is out of bounds`);
  }
  if (
    position !== PARALLEL_GROUP_INSERT_POSITIONS.AFTER &&
    position !== PARALLEL_GROUP_INSERT_POSITIONS.BEFORE
  ) {
    throw new Error(`Unknown parallel group insert position: ${position}`);
  }

  const containing = normalized.parallelGroups.find(
    (group) => index > group.startIndex && index <= group.endIndex
  );
  if (!containing) {
    return { requestedIndex: index, insertedIndex: index };
  }
  const insertedIndex =
    position === PARALLEL_GROUP_INSERT_POSITIONS.BEFORE
      ? containing.startIndex
      : containing.endIndex + 1;
  return {
    requestedIndex: index,
    insertedIndex,
    relocation: {
      kind:
        position === PARALLEL_GROUP_INSERT_POSITIONS.BEFORE
          ? PARALLEL_GROUP_INSERT_RELOCATION_KINDS.BEFORE_PARALLEL_GROUP
          : PARALLEL_GROUP_INSERT_RELOCATION_KINDS.AFTER_PARALLEL_GROUP,
      groupId: containing.id,
    },
  };
}

/**
 * Shift group ranges that sit after an insertion point. `insertedCount` is the
 * number of steps spliced in, not 1: multi-step inserts (MCP queue appends,
 * clipboard topology pastes) would otherwise leave every later group pointing
 * at the wrong members.
 */
function shiftForInsert(
  groups: ParallelGroupDefinition[],
  insertIndex: number,
  insertedCount: number
): ParallelGroupDefinition[] {
  return groups.map((group) =>
    insertIndex <= group.startIndex
      ? {
          ...group,
          startIndex: group.startIndex + insertedCount,
          endIndex: group.endIndex + insertedCount,
        }
      : { ...group }
  );
}

export function insertParallelGroupStep(
  topology: ParallelGroupTopology,
  index: number,
  step: WorkflowStep,
  position: ParallelGroupInsertPosition = PARALLEL_GROUP_INSERT_POSITIONS.AFTER
): ParallelGroupTopology {
  return insertParallelGroupSteps(topology, index, [step], position);
}

export function insertParallelGroupSteps(
  topology: ParallelGroupTopology,
  index: number,
  steps: WorkflowStep[],
  position: ParallelGroupInsertPosition = PARALLEL_GROUP_INSERT_POSITIONS.AFTER
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const placement = resolveParallelGroupInsertIndex(
    normalized,
    index,
    position
  );
  const insertIndex = placement.insertedIndex;
  const result = {
    steps: [...normalized.steps],
    parallelGroups: shiftForInsert(
      normalized.parallelGroups,
      insertIndex,
      steps.length
    ),
  };
  result.steps.splice(insertIndex, 0, ...steps);
  validateParallelGroupTopology(result);
  return result;
}

function assertParallelGroupCanAcceptMembers(
  group: ParallelGroupDefinition,
  members: readonly WorkflowStep[]
): void {
  const groupHasSettled = members.every(
    (step) =>
      step._runtime?.completedAt !== undefined ||
      step._runtime?.terminalStatus !== undefined
  );
  if (groupHasSettled) {
    throw new Error(`Cannot append to settled parallel group ${group.id}`);
  }

  if (
    group.failFast &&
    members.some(
      (step) => step._runtime?.terminalStatus === PROMPT_TERMINAL_STATUS.FAILED
    )
  ) {
    throw new Error(
      `Cannot append to fail-fast parallel group ${group.id} after failure`
    );
  }

  if (
    members.some(
      (step) =>
        step._runtime?.terminalStatus === PROMPT_TERMINAL_STATUS.CANCELLED
    )
  ) {
    throw new Error(
      `Cannot append to cancelling or stopping parallel group ${group.id}`
    );
  }
}

/** Extend a group by one member at endIndex + 1. Shifts later steps/groups. */
export function appendParallelGroupMember(
  topology: ParallelGroupTopology,
  group: string | number,
  step: WorkflowStep
): ParallelGroupTopology {
  return appendParallelGroupMembers(topology, group, [step]);
}

/** Extend a group by appending several members at endIndex + 1. */
export function appendParallelGroupMembers(
  topology: ParallelGroupTopology,
  group: string | number,
  steps: WorkflowStep[]
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const selected =
    normalized.parallelGroups[groupIndex(normalized.parallelGroups, group)];
  const existingMembers = normalized.steps.slice(
    selected.startIndex,
    selected.endIndex + 1
  );
  assertParallelGroupCanAcceptMembers(selected, existingMembers);
  if (steps.length === 0) {
    return normalized;
  }

  const insertIndex = selected.endIndex + 1;
  const result: ParallelGroupTopology = {
    steps: [...normalized.steps],
    parallelGroups: shiftForInsert(
      normalized.parallelGroups,
      insertIndex,
      steps.length
    ),
  };
  result.steps.splice(insertIndex, 0, ...steps);
  const resultGroup = result.parallelGroups.find(
    (candidate) => candidate.id === selected.id
  );
  if (!resultGroup) {
    throw new Error(`Unknown parallel group: ${selected.id}`);
  }
  resultGroup.endIndex += steps.length;
  assertStartedStepPositionsPreserved(
    normalized.steps,
    result.steps,
    "append to parallel group"
  );
  validateParallelGroupTopology(result);
  return result;
}

export function insertParallelGroupTopology(
  topology: ParallelGroupTopology,
  index: number,
  incoming: ParallelGroupTopology,
  position: ParallelGroupInsertPosition = PARALLEL_GROUP_INSERT_POSITIONS.AFTER
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const incomingNormalized = normalizeParallelGroupTopology(incoming);
  const placement = resolveParallelGroupInsertIndex(
    normalized,
    index,
    position
  );
  const insertIndex = placement.insertedIndex;
  const result: ParallelGroupTopology = {
    steps: [...normalized.steps],
    parallelGroups: [
      ...shiftForInsert(
        normalized.parallelGroups,
        insertIndex,
        incomingNormalized.steps.length
      ),
      ...incomingNormalized.parallelGroups.map((group) => ({
        ...group,
        startIndex: group.startIndex + insertIndex,
        endIndex: group.endIndex + insertIndex,
      })),
    ],
  };
  result.steps.splice(insertIndex, 0, ...incomingNormalized.steps);
  result.parallelGroups.sort(
    (left, right) => left.startIndex - right.startIndex
  );
  validateParallelGroupTopology(result);
  return result;
}

/** Delete step positions against one final topology. */
export function deleteParallelGroupSteps(
  topology: ParallelGroupTopology,
  indices: number[]
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const removed = new Set(indices);
  if (removed.size !== indices.length) {
    throw new Error("Delete indices must be unique");
  }
  for (const index of removed) {
    assertIndex(index, "Delete index");
    if (index < 0 || index >= normalized.steps.length) {
      throw new Error(`Delete index ${index} is out of bounds`);
    }
  }
  const groups: ParallelGroupDefinition[] = [];
  for (const group of normalized.parallelGroups) {
    const groupIndices = Array.from(
      { length: group.endIndex - group.startIndex + 1 },
      (_, offset) => group.startIndex + offset
    );
    const remaining = groupIndices.filter((index) => !removed.has(index));
    if (
      remaining.length === 1 &&
      groupIndices.some((index) => hasStarted(normalized.steps[index]))
    ) {
      throw new Error(
        `Cannot shrink active parallel group ${group.id} from two members to one`
      );
    }
    if (remaining.length >= 2) {
      const startIndex =
        remaining[0] -
        [...removed].filter((index) => index < remaining[0]).length;
      groups.push({
        ...group,
        startIndex,
        endIndex: startIndex + remaining.length - 1,
      });
    }
  }
  const result = {
    steps: normalized.steps.filter((_, index) => !removed.has(index)),
    parallelGroups: groups,
  };
  validateParallelGroupTopology(result);
  return result;
}

interface TopologyStep {
  step: WorkflowStep;
  groupId?: string;
}

export type PendingParallelGroupRange = {
  id?: string;
  start: number;
  end: number;
  failFast: boolean;
};

function moveItems(
  items: TopologyStep[],
  fromIndex: number,
  toIndex: number,
  count: number
): TopologyStep[] {
  const moving = items.splice(fromIndex, count);
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, ...moving);
  return items;
}

function topologyFromItems(
  items: TopologyStep[],
  groupPolicies?: ReadonlyMap<string, boolean>
): ParallelGroupTopology {
  const steps = items.map((item) => item.step);
  const groups: ParallelGroupDefinition[] = [];
  let start = 0;
  while (start < items.length) {
    const groupId = items[start].groupId;
    if (!groupId) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < items.length && items[end + 1].groupId === groupId) {
      end += 1;
    }
    groups.push({
      id: groupId,
      startIndex: start,
      endIndex: end,
      failFast: groupPolicies?.get(groupId) ?? true,
    });
    start = end + 1;
  }
  return { steps, parallelGroups: groups };
}

export function reorderParallelGroupSteps(
  topology: ParallelGroupTopology,
  fromIndex: number,
  toIndex: number
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(fromIndex, "Source index");
  assertIndex(toIndex, "Destination index");
  if (
    fromIndex < 0 ||
    fromIndex >= normalized.steps.length ||
    toIndex < 0 ||
    toIndex >= normalized.steps.length
  ) {
    throw new Error("Reorder index is out of bounds");
  }
  if (fromIndex === toIndex) {
    return cloneTopology(normalized);
  }

  const items: TopologyStep[] = normalized.steps.map((step, index) => ({
    step,
    groupId: normalized.parallelGroups.find(
      (group) => index >= group.startIndex && index <= group.endIndex
    )?.id,
  }));
  const sourceGroup = normalized.parallelGroups.find(
    (group) => fromIndex >= group.startIndex && fromIndex <= group.endIndex
  );

  if (
    sourceGroup &&
    (toIndex < sourceGroup.startIndex || toIndex > sourceGroup.endIndex)
  ) {
    moveItems(
      items,
      sourceGroup.startIndex,
      toIndex > sourceGroup.endIndex
        ? toIndex - (sourceGroup.endIndex - sourceGroup.startIndex)
        : toIndex,
      sourceGroup.endIndex - sourceGroup.startIndex + 1
    );
  } else {
    const destinationGroup = normalized.parallelGroups.find(
      (group) =>
        !sourceGroup && toIndex > group.startIndex && toIndex <= group.endIndex
    );
    if (destinationGroup) {
      toIndex = destinationGroup.endIndex + 1;
      if (fromIndex < toIndex) {
        toIndex -= 1;
      }
    }
    moveItems(items, fromIndex, toIndex, 1);
  }

  const result = topologyFromItems(items);
  for (const group of result.parallelGroups) {
    const original = normalized.parallelGroups.find(
      (candidate) => candidate.id === group.id
    );
    group.failFast = original?.failFast ?? true;
  }
  assertStartedStepPositionsPreserved(
    normalized.steps,
    result.steps,
    "reorder"
  );
  validateParallelGroupTopology(result);
  return result;
}

function assertPendingOrder(
  pendingCount: number,
  newPendingOrder: number[]
): void {
  if (newPendingOrder.length !== pendingCount) {
    throw new Error(
      `Pending reorder must contain exactly ${pendingCount} indices`
    );
  }
  const seen = new Set<number>();
  for (const index of newPendingOrder) {
    assertIndex(index, "Pending reorder index");
    if (index < 0 || index >= pendingCount || seen.has(index)) {
      throw new Error("Pending reorder must be a permutation of its indices");
    }
    seen.add(index);
  }
}

/**
 * Rejects reorder requests that place unrelated steps between members of an
 * existing parallel group. The requested order is relative to the pending
 * suffix, while group ranges use absolute workflow indices.
 */
export function assertParallelGroupsRemainContiguousAfterReorder(
  topology: ParallelGroupTopology,
  currentIndex: number,
  newPendingOrder: number[]
): void {
  const requestedAbsoluteOrder = [
    ...Array.from({ length: currentIndex }, (_, index) => index),
    ...newPendingOrder.map((index) => currentIndex + index),
  ];
  const requestedPositions = new Map(
    requestedAbsoluteOrder.map((sourceIndex, position) => [
      sourceIndex,
      position,
    ])
  );

  for (const group of topology.parallelGroups) {
    const memberIndices = Array.from(
      { length: group.endIndex - group.startIndex + 1 },
      (_, offset) => group.startIndex + offset
    );
    const memberPositions = memberIndices.map((index) =>
      requestedPositions.get(index)
    );
    const presentPositions = memberPositions.filter(
      (position): position is number => position !== undefined
    );
    if (
      presentPositions.length !== memberIndices.length ||
      Math.max(...presentPositions) - Math.min(...presentPositions) + 1 !==
        memberIndices.length
    ) {
      throw new Error(
        `Cannot split parallel group ${group.id} (members at indices ${memberIndices.join(", ")}) when reordering`
      );
    }
  }
}

/**
 * Reorders the pending tail while keeping every complete parallel group
 * contiguous. Members of a group may be reordered within that group; a group
 * move is represented by the first member encountered in the requested order.
 */
export function reorderParallelGroupPendingSteps(
  topology: ParallelGroupTopology,
  currentIndex: number,
  newPendingOrder: number[],
  pendingGroups?: PendingParallelGroupRange[],
  hasInFlightStep = false
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(currentIndex, "Current index");
  if (currentIndex < 0 || currentIndex > normalized.steps.length) {
    throw new Error(`Current index ${currentIndex} is out of bounds`);
  }
  assertPendingOrder(normalized.steps.length - currentIndex, newPendingOrder);
  // Explicit pendingGroups describe the intended new grouping (dashboard drag
  // into/out of a group), so only an order-only reorder must keep groups whole.
  if (pendingGroups === undefined) {
    assertParallelGroupsRemainContiguousAfterReorder(
      normalized,
      currentIndex,
      newPendingOrder
    );
  }

  const crossingGroup = normalized.parallelGroups.find(
    (group) => group.startIndex < currentIndex && group.endIndex >= currentIndex
  );
  if (crossingGroup) {
    const requestedPending = newPendingOrder.filter((index) => {
      const absoluteIndex = currentIndex + index;
      return (
        absoluteIndex >= currentIndex && absoluteIndex <= crossingGroup.endIndex
      );
    });
    if (
      requestedPending.length !== crossingGroup.endIndex - currentIndex + 1 ||
      requestedPending.some((index, position) => index !== position)
    ) {
      throw new Error(
        "Cannot reorder a parallel group across the current execution boundary"
      );
    }
  }

  if (pendingGroups !== undefined) {
    validatePendingParallelGroupRanges(
      pendingGroups,
      normalized.steps.length - currentIndex
    );
    return reorderPendingTopologyWithRanges(
      normalized,
      currentIndex,
      newPendingOrder,
      pendingGroups,
      hasInFlightStep
    );
  }

  interface PendingBlock {
    firstRequestedPosition: number;
    sourceIndices: number[];
    groupId?: string;
  }

  const requestedAbsolute = newPendingOrder.map(
    (index) => currentIndex + index
  );
  const blocks: PendingBlock[] = [];
  const seenGroups = new Set<string>();
  for (const [
    requestedPosition,
    absoluteIndex,
  ] of requestedAbsolute.entries()) {
    const group = normalized.parallelGroups.find(
      (candidate) =>
        absoluteIndex >= candidate.startIndex &&
        absoluteIndex <= candidate.endIndex
    );
    if (!group || group.startIndex < currentIndex) {
      blocks.push({
        firstRequestedPosition: requestedPosition,
        sourceIndices: [absoluteIndex],
      });
      continue;
    }
    if (seenGroups.has(group.id)) {
      continue;
    }
    seenGroups.add(group.id);
    blocks.push({
      firstRequestedPosition: requestedPosition,
      sourceIndices: requestedAbsolute.filter(
        (candidate) =>
          candidate >= group.startIndex && candidate <= group.endIndex
      ),
      groupId: group.id,
    });
  }

  blocks.sort(
    (left, right) => left.firstRequestedPosition - right.firstRequestedPosition
  );
  const pendingSourceIndices = blocks.flatMap((block) => block.sourceIndices);
  const prefixIndices = Array.from(
    { length: currentIndex },
    (_, index) => index
  );
  const orderedIndices = [...prefixIndices, ...pendingSourceIndices];
  const items: TopologyStep[] = orderedIndices.map((sourceIndex) => ({
    step: normalized.steps[sourceIndex],
    groupId: normalized.parallelGroups.find(
      (group) =>
        sourceIndex >= group.startIndex && sourceIndex <= group.endIndex
    )?.id,
  }));
  const result = topologyFromItems(items);
  for (const group of result.parallelGroups) {
    const original = normalized.parallelGroups.find(
      (candidate) => candidate.id === group.id
    );
    group.failFast = original?.failFast ?? true;
  }
  assertStartedStepPositionsPreserved(
    normalized.steps,
    result.steps,
    "reorder"
  );
  validateParallelGroupTopology(result);
  return result;
}

function validatePendingParallelGroupRanges(
  pendingGroups: PendingParallelGroupRange[],
  pendingCount: number
): void {
  if (!Array.isArray(pendingGroups)) {
    throw new Error("Pending parallel groups must be an array");
  }

  const ids = new Set<string>();
  let previousEnd = -1;
  for (const [index, group] of pendingGroups.entries()) {
    if (!group || typeof group !== "object") {
      throw new Error(`Pending parallel group ${index} must be an object`);
    }
    if (
      group.id !== undefined &&
      (typeof group.id !== "string" || group.id.length === 0)
    ) {
      throw new Error(`Pending parallel group ${index} has an invalid id`);
    }
    if (group.id !== undefined) {
      if (ids.has(group.id)) {
        throw new Error(`Duplicate pending parallel group id: ${group.id}`);
      }
      ids.add(group.id);
    }
    assertIndex(group.start, `Pending parallel group ${index} start`);
    assertIndex(group.end, `Pending parallel group ${index} end`);
    if (typeof group.failFast !== "boolean") {
      throw new Error(
        `Pending parallel group ${index} failFast must be a boolean`
      );
    }
    if (
      group.start < 0 ||
      group.end < group.start ||
      group.end >= pendingCount
    ) {
      throw new Error(`Pending parallel group ${index} range is out of bounds`);
    }
    if (group.start <= previousEnd) {
      throw new Error("Pending parallel groups overlap or are out of order");
    }
    previousEnd = group.end;
  }
}

function sameNumberSet(left: number[], right: number[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function reorderPendingTopologyWithRanges(
  normalized: ParallelGroupTopology,
  currentIndex: number,
  newPendingOrder: number[],
  pendingGroups: PendingParallelGroupRange[],
  hasInFlightStep: boolean
): ParallelGroupTopology {
  const pendingSourceIndices = newPendingOrder.map(
    (index) => currentIndex + index
  );
  const oldGroupById = new Map(
    normalized.parallelGroups.map((group) => [group.id, group])
  );
  const pendingGroupAtPosition = new Map<number, PendingParallelGroupRange>();
  const groupPolicies = new Map<string, boolean>();

  for (const group of pendingGroups) {
    if (group.id !== undefined && !oldGroupById.has(group.id)) {
      throw new Error(`Unknown parallel group: ${group.id}`);
    }
    const groupId = group.id ?? randomUUID();
    groupPolicies.set(groupId, group.failFast);
    for (let position = group.start; position <= group.end; position++) {
      pendingGroupAtPosition.set(position, { ...group, id: groupId });
    }
  }

  const groupIdBySourceIndex = new Map<number, string>();
  for (const [position, sourceIndex] of pendingSourceIndices.entries()) {
    const requestedGroup = pendingGroupAtPosition.get(position);
    const oldGroup = normalized.parallelGroups.find(
      (group) =>
        sourceIndex >= group.startIndex && sourceIndex <= group.endIndex
    );
    const oldGroupIsActive =
      oldGroup !== undefined &&
      (normalized.steps
        .slice(oldGroup.startIndex, oldGroup.endIndex + 1)
        .some(hasStarted) ||
        (hasInFlightStep &&
          currentIndex >= oldGroup.startIndex &&
          currentIndex <= oldGroup.endIndex));
    if (oldGroup && oldGroupIsActive) {
      if (requestedGroup?.id !== oldGroup.id) {
        throw new Error(
          `Cannot change membership of active parallel group ${oldGroup.id} (settled or in-flight parallel group)`
        );
      }
      groupIdBySourceIndex.set(sourceIndex, oldGroup.id);
    } else if (requestedGroup) {
      groupIdBySourceIndex.set(sourceIndex, requestedGroup.id!);
    }
  }

  for (const group of normalized.parallelGroups) {
    const active =
      normalized.steps
        .slice(group.startIndex, group.endIndex + 1)
        .some(hasStarted) ||
      (hasInFlightStep &&
        currentIndex >= group.startIndex &&
        currentIndex <= group.endIndex);
    if (!active) continue;
    const oldPendingMembers = Array.from(
      { length: group.endIndex - group.startIndex + 1 },
      (_, offset) => group.startIndex + offset
    ).filter((index) => index >= currentIndex);
    const newMembers = [...groupIdBySourceIndex.entries()]
      .filter(([, candidateGroupId]) => candidateGroupId === group.id)
      .map(([sourceIndex]) => sourceIndex);
    if (!sameNumberSet(oldPendingMembers, newMembers)) {
      throw new Error(
        `Cannot move members into or out of active parallel group ${group.id}`
      );
    }
  }

  const items: TopologyStep[] = [];
  for (let sourceIndex = 0; sourceIndex < currentIndex; sourceIndex++) {
    const oldGroup = normalized.parallelGroups.find(
      (group) =>
        sourceIndex >= group.startIndex && sourceIndex <= group.endIndex
    );
    items.push({
      step: normalized.steps[sourceIndex],
      groupId: oldGroup?.id,
    });
  }
  for (const [position, sourceIndex] of pendingSourceIndices.entries()) {
    items.push({
      step: normalized.steps[sourceIndex],
      groupId: groupIdBySourceIndex.get(sourceIndex),
    });
    const requestedGroup = pendingGroupAtPosition.get(position);
    if (requestedGroup) {
      groupPolicies.set(requestedGroup.id!, requestedGroup.failFast);
    }
  }

  const result = topologyFromItems(items, groupPolicies);
  for (const group of result.parallelGroups) {
    const original = normalized.parallelGroups.find(
      (candidate) => candidate.id === group.id
    );
    if (original) {
      const originalIsActive =
        normalized.steps
          .slice(original.startIndex, original.endIndex + 1)
          .some(hasStarted) ||
        (hasInFlightStep &&
          currentIndex >= original.startIndex &&
          currentIndex <= original.endIndex);
      group.failFast = originalIsActive
        ? original.failFast
        : (groupPolicies.get(group.id) ?? original.failFast);
    }
  }
  assertStartedStepPositionsPreserved(
    normalized.steps,
    result.steps,
    "reorder"
  );
  validateParallelGroupTopology(result);
  return result;
}

export function replaceParallelGroupStep(
  topology: ParallelGroupTopology,
  index: number,
  step: WorkflowStep
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(index, "Replace index");
  if (index < 0 || index >= normalized.steps.length) {
    throw new Error(`Replace index ${index} is out of bounds`);
  }
  normalized.steps[index] = step;
  validateParallelGroupTopology(normalized);
  return normalized;
}

export function groupParallelGroupSteps(
  topology: ParallelGroupTopology,
  startIndex: number,
  endIndex: number,
  failFast = true,
  id?: string,
  startedAnchorIndex?: number
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(startIndex, "Group start index");
  assertIndex(endIndex, "Group end index");
  if (endIndex - startIndex + 1 < 2) {
    throw new Error("A parallel group must contain at least two steps");
  }
  if (
    startIndex < 0 ||
    endIndex >= normalized.steps.length ||
    startIndex > endIndex
  ) {
    throw new Error("Parallel group range is out of bounds");
  }
  if (
    normalized.parallelGroups.some(
      (group) => startIndex <= group.endIndex && endIndex >= group.startIndex
    )
  ) {
    throw new Error("Parallel group range overlaps an existing group");
  }

  if (startedAnchorIndex !== undefined) {
    assertIndex(startedAnchorIndex, "Started anchor index");
    if (
      startedAnchorIndex < startIndex ||
      startedAnchorIndex > endIndex ||
      !hasStarted(normalized.steps[startedAnchorIndex])
    ) {
      throw new Error(
        "Started anchor index must identify a started step in the group range"
      );
    }
    if (
      normalized.steps[startedAnchorIndex]._runtime?.completedAt !==
        undefined ||
      normalized.steps[startedAnchorIndex]._runtime?.terminalStatus !==
        undefined
    ) {
      throw new Error(
        "Cannot create a parallel group around a settled started step"
      );
    }
  }

  if (
    normalized.steps
      .slice(startIndex, endIndex + 1)
      .some(
        (step, offset) =>
          hasStarted(step) && startIndex + offset !== startedAnchorIndex
      )
  ) {
    throw new Error(
      "Cannot change membership of a started step while creating a parallel group"
    );
  }
  const groupId = id ?? randomUUID();
  const result = {
    steps: [...normalized.steps],
    parallelGroups: [
      ...normalized.parallelGroups,
      { id: groupId, startIndex, endIndex, failFast },
    ].sort((left, right) => left.startIndex - right.startIndex),
  };
  validateParallelGroupTopology(result);
  return result;
}

/** Wrap an ungrouped step and a new sibling into a fresh two-member group. */
export function promoteStepToParallelGroup(
  topology: ParallelGroupTopology,
  stepIndex: number,
  step: WorkflowStep,
  options?: { failFast?: boolean }
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(stepIndex, "Promotion step index");
  if (stepIndex < 0 || stepIndex >= normalized.steps.length) {
    throw new Error(`Promotion step index ${stepIndex} is out of bounds`);
  }
  if (
    normalized.parallelGroups.some(
      (group) => stepIndex >= group.startIndex && stepIndex <= group.endIndex
    )
  ) {
    throw new Error(
      "Cannot promote a step that is already in a parallel group"
    );
  }

  const inserted = insertParallelGroupSteps(
    normalized,
    stepIndex + 1,
    [step],
    PARALLEL_GROUP_INSERT_POSITIONS.AFTER
  );
  assertStartedStepPositionsPreserved(
    normalized.steps,
    inserted.steps,
    "promote to parallel group"
  );
  return groupParallelGroupSteps(
    inserted,
    stepIndex,
    stepIndex + 1,
    options?.failFast ?? false,
    undefined,
    hasStarted(normalized.steps[stepIndex]) ? stepIndex : undefined
  );
}

export function ungroupParallelGroup(
  topology: ParallelGroupTopology,
  group: string | number
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const index = groupIndex(normalized.parallelGroups, group);
  const selected = normalized.parallelGroups[index];
  if (
    normalized.steps
      .slice(selected.startIndex, selected.endIndex + 1)
      .some(hasStarted)
  ) {
    throw new Error(`Cannot remove active parallel group ${selected.id}`);
  }
  const result = cloneTopology(normalized);
  result.parallelGroups.splice(index, 1);
  return result;
}

/** Removes a group's topology wrapper while leaving all of its steps in place. */
export function unwrapParallelGroup(
  topology: ParallelGroupTopology,
  group: string | number
): ParallelGroupTopology {
  const result = cloneTopology(topology);
  const index = groupIndex(result.parallelGroups, group);
  const selected = result.parallelGroups[index];
  if (
    result.steps
      .slice(selected.startIndex, selected.endIndex + 1)
      .some(hasStarted)
  ) {
    throw new Error(`Cannot remove active parallel group ${selected.id}`);
  }
  result.parallelGroups.splice(index, 1);
  validateParallelGroupTopology(result);
  return result;
}

export function snapParallelGroupIndex(
  topology: ParallelGroupTopology,
  index: number
): number {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(index, "Step index");
  if (index < 0 || index > normalized.steps.length) {
    throw new Error(`Step index ${index} is out of bounds`);
  }
  return (
    normalized.parallelGroups.find(
      (group) => index >= group.startIndex && index <= group.endIndex
    )?.startIndex ?? index
  );
}

export const snapParallelGroupStartPosition = snapParallelGroupIndex;
export const validateParallelGroups = validateParallelGroupTopology;
export const normalizeParallelGroups = normalizeParallelGroupTopology;

export interface FlattenedParallelItems {
  topology: ParallelGroupTopology;
  itemCount: number;
  stepCount: number;
}

/**
 * An authored-style parallel container whose members are already resolved.
 * Named rather than inlined so every caller that builds one — the parser today,
 * the MCP append path in Phase 3B — refers to the same contract.
 */
export interface ResolvedParallelContainer {
  parallel: WorkflowStep[];
  failFast?: boolean;
}

/** One queue item: an executable step or a container of them. */
export type ResolvedParallelItem = WorkflowStep | ResolvedParallelContainer;

/**
 * Flattens resolved queue items into a relative, normalized topology.
 *
 * The input contains either one executable step or an authored-style parallel
 * container whose members have already been resolved by its caller.
 */
export function flattenParallelItems(
  items: readonly ResolvedParallelItem[]
): FlattenedParallelItems {
  const steps: WorkflowStep[] = [];
  const parallelGroups: Array<{
    startIndex: number;
    endIndex: number;
    failFast?: boolean;
  }> = [];

  for (const item of items) {
    if (typeof item === "object" && item !== null && "parallel" in item) {
      if (item.parallel.length < 2) {
        throw new Error("A parallel group must contain at least two steps");
      }

      const startIndex = steps.length;
      for (const member of item.parallel) {
        if (
          typeof member === "object" &&
          member !== null &&
          "parallel" in member
        ) {
          throw new Error(
            "A parallel group cannot contain a nested parallel container"
          );
        }
        steps.push(member);
      }
      parallelGroups.push({
        startIndex,
        endIndex: steps.length - 1,
        failFast: item.failFast,
      });
      continue;
    }

    steps.push(item);
  }

  const topology = normalizeParallelGroupTopology({
    steps,
    parallelGroups,
  });
  return { topology, itemCount: items.length, stepCount: steps.length };
}
