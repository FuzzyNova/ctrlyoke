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
