import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";

/** Return the parallel group whose inclusive step range contains this index. */
export function findParallelGroupForStep(
  parallelGroups: readonly ParallelGroupDefinition[] | undefined,
  stepIndex: number
): ParallelGroupDefinition | undefined {
  return parallelGroups?.find(
    (group) => stepIndex >= group.startIndex && stepIndex <= group.endIndex
  );
}

/**
 * Return the prior-context boundary for a queue step. Members of a parallel
 * group share its start boundary so sibling outputs are excluded.
 */
export function getPriorContextStepCount(
  parallelGroups: readonly ParallelGroupDefinition[] | undefined,
  stepIndex: number
): number {
  return (
    findParallelGroupForStep(parallelGroups, stepIndex)?.startIndex ?? stepIndex
  );
}
