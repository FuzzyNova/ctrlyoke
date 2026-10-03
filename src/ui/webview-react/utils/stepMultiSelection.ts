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
