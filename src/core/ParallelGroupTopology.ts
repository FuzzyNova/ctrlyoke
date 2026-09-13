import { randomUUID } from "crypto";
import type {
  ParallelGroupDefinition,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import {
  assertStartedStepPositionsPreserved,
  hasStarted,
} from "./StepIdentity";

export interface ParallelGroupTopology {
  steps: WorkflowStep[];
  parallelGroups: ParallelGroupDefinition[];
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
): number {
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
    return index;
  }
  return position === PARALLEL_GROUP_INSERT_POSITIONS.BEFORE
    ? containing.startIndex
    : containing.endIndex + 1;
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
  const insertIndex = resolveParallelGroupInsertIndex(
    normalized,
    index,
    position
  );
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

export function insertParallelGroupTopology(
  topology: ParallelGroupTopology,
  index: number,
  incoming: ParallelGroupTopology,
  position: ParallelGroupInsertPosition = PARALLEL_GROUP_INSERT_POSITIONS.AFTER
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  const incomingNormalized = normalizeParallelGroupTopology(incoming);
  const insertIndex = resolveParallelGroupInsertIndex(
    normalized,
    index,
    position
  );
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

export function deleteParallelGroupStep(
  topology: ParallelGroupTopology,
  index: number
): ParallelGroupTopology {
  const normalized = normalizeParallelGroupTopology(topology);
  assertIndex(index, "Delete index");
  if (index < 0 || index >= normalized.steps.length) {
    throw new Error(`Delete index ${index} is out of bounds`);
  }

  const containing = normalized.parallelGroups.find(
    (group) => index >= group.startIndex && index <= group.endIndex
  );
  const result: ParallelGroupTopology = {
    steps: normalized.steps.filter((_, stepIndex) => stepIndex !== index),
    parallelGroups: normalized.parallelGroups
      .filter(
        (group) =>
          group !== containing || group.endIndex - group.startIndex + 1 > 2
      )
      .map((group) => {
        if (group === containing) {
          return { ...group, endIndex: group.endIndex - 1 };
        }
        if (group.startIndex > index) {
          return {
            ...group,
            startIndex: group.startIndex - 1,
            endIndex: group.endIndex - 1,
          };
        }
        return { ...group };
      }),
  };
  if (
    containing &&
    containing.endIndex - containing.startIndex + 1 === 2 &&
    normalized.steps
      .slice(containing.startIndex, containing.endIndex + 1)
      .some(hasStarted)
  ) {
    throw new Error(
      `Cannot shrink active parallel group ${containing.id} from two members to one`
    );
  }
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
  id?: string
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
  if (
    normalized.steps
      .slice(startIndex, endIndex + 1)
      .some(hasStarted)
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
    throw new Error(
      `Cannot remove active parallel group ${selected.id}`
    );
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
    throw new Error(
      `Cannot remove active parallel group ${selected.id}`
    );
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
