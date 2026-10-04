/** Keep queue indices valid, unique, and ordered for stable selection state. */
export function normalizeStepIndices(
  indices: readonly number[],
  queueLength: number
): number[] {
  return [...new Set(indices)]
    .filter(
      (index) => Number.isInteger(index) && index >= 0 && index < queueLength
    )
    .sort((a, b) => a - b);
}

export function selectStepRange(
  anchorIndex: number,
  clickedIndex: number,
  queueLength: number
): number[] {
  if (
    !Number.isInteger(anchorIndex) ||
    !Number.isInteger(clickedIndex) ||
    queueLength <= 0
  ) {
    return [];
  }
  const start = Math.max(0, Math.min(anchorIndex, clickedIndex));
  const end = Math.min(queueLength - 1, Math.max(anchorIndex, clickedIndex));
  return Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, i) => start + i
  );
}

export function toggleStepIndex(
  indices: readonly number[],
  clickedIndex: number,
  queueLength: number
): number[] {
  const current = normalizeStepIndices(indices, queueLength);
  return normalizeStepIndices(
    current.includes(clickedIndex)
      ? current.filter((index) => index !== clickedIndex)
      : [...current, clickedIndex],
    queueLength
  );
}

export function addStepRange(
  indices: readonly number[],
  anchorIndex: number,
  clickedIndex: number,
  queueLength: number
): number[] {
  return normalizeStepIndices(
    [...indices, ...selectStepRange(anchorIndex, clickedIndex, queueLength)],
    queueLength
  );
}

export function selectAllSteps(queueLength: number): number[] {
  return Array.from(
    { length: Math.max(0, Math.floor(queueLength)) },
    (_, i) => i
  );
}

/** A selection is multi only while at least two valid indices remain. */
export function collapseStepSelection<T extends { indices: number[] }>(
  selection: T | null
): T | null {
  return selection && new Set(selection.indices).size >= 2 ? selection : null;
}

/** Move selected values as one ordered block in a permutation. `dropSlot` is
 * measured in the original order, before selected values are pulled out. */
export function moveSelectedBlock<T>(
  order: readonly T[],
  selected: readonly T[],
  dropSlot: number
): T[] {
  const selectedSet = new Set(selected);
  const selectedPositions = order
    .map((value, index) => (selectedSet.has(value) ? index : -1))
    .filter((index) => index >= 0);
  if (selectedPositions.length < 2) return [...order];

  const block = order.filter((value) => selectedSet.has(value));
  const remaining = order.filter((value) => !selectedSet.has(value));
  const originalSlot = Math.max(
    0,
    Math.min(order.length, Math.floor(dropSlot))
  );
  const removedBeforeSlot = selectedPositions.filter(
    (index) => index < originalSlot
  ).length;
  const insertAt = Math.max(
    0,
    Math.min(remaining.length, originalSlot - removedBeforeSlot)
  );
  return [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ];
}

/** Shift a selected block by one slot while preserving its member order. */
export function shiftSelectedBlock<T>(
  order: readonly T[],
  selected: readonly T[],
  direction: "up" | "down"
): T[] {
  const selectedSet = new Set(selected);
  const positions = order
    .map((value, index) => (selectedSet.has(value) ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length < 2) return [...order];
  const first = positions[0];
  const block = order.filter((value) => selectedSet.has(value));
  const remaining = order.filter((value) => !selectedSet.has(value));
  const insertAt = Math.max(
    0,
    Math.min(remaining.length, first + (direction === "up" ? -1 : 1))
  );
  return [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ];
}

/** Remap old identities to their new positions after a full permutation. */
export function remapIndicesThroughPermutation(
  indices: readonly number[],
  permutation: readonly number[],
  baseIndex = 0
): number[] {
  const newPositionByOldIndex = new Map(
    permutation.map((oldIndex, offset) => [oldIndex, baseIndex + offset])
  );
  return indices
    .map((index) => newPositionByOldIndex.get(index))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
}
