import type { WorkingFile } from "../types/CtrlYokeTypes";

/** Removes lineage-owned fields left in pre-release run files. */
export function stripLegacyWorkingFileLineageMetadata<T extends object>(
  workingFile: T
): T {
  const record = workingFile as Record<string, unknown>;
  delete record.workflowName;
  delete record.originalFile;
  delete record.isFavorite;
  delete record.lastModifiedAt;
  return workingFile;
}

/**
 * Latest execution activity recorded in a run/draft working file: the run's
 * own start/end plus every step's (and the final step's) dispatch/completion.
 */
export function getWorkingFileLastActivityAt(workingFile: WorkingFile): number {
  const runtime = workingFile._runtime;
  return resolveLineageLastModifiedAt(
    workingFile.startedAt,
    runtime?.startTime,
    runtime?.executionEndTime,
    runtime?.finalStep?.startedAt,
    runtime?.finalStep?.completedAt,
    ...(workingFile.steps ?? []).flatMap((step) => [
      step._runtime?.startedAt,
      step._runtime?.completedAt,
    ])
  );
}

/**
 * A lineage's display recency: the descriptor's `lastModifiedAt` or its runs'
 * activity, whichever is newer. The descriptor alone is not enough — appending
 * to and continuing an existing run write only that run's working file, never
 * the descriptor (`RunContinuationService.appendStepsToRun`), so a lineage
 * whose latest run keeps being extended would otherwise keep its original
 * timestamp forever. Every recency sort and "last modified" label must use this.
 */
export function resolveLineageLastModifiedAt(
  descriptorLastModifiedAt: number | undefined,
  ...runActivityTimestamps: ReadonlyArray<number | undefined>
): number {
  return Math.max(
    descriptorLastModifiedAt || 0,
    ...runActivityTimestamps.map((timestamp) => timestamp || 0)
  );
}
