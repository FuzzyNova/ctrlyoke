import * as fs from "fs";
import type { RunRef, WorkflowKey, WorkingFile } from "../types/CtrlYokeTypes";
import * as WorkflowPaths from "./WorkflowPaths";

const LINEAGE_ACTIVITY_READ_BATCH_SIZE = 32;

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
 * activity stamp/start/end plus every step's (and final step's) dispatch/completion.
 */
export function getWorkingFileLastActivityAt(workingFile: WorkingFile): number {
  const runtime = workingFile._runtime;
  return resolveLineageLastModifiedAt(
    workingFile.startedAt,
    runtime?.lastActivityAt,
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

/**
 * Resolves lineage recency from the descriptor and every persisted run file.
 * Keeping this scan here gives every recency surface the same inputs and keeps
 * summary-cache freshness aligned with the lineage list.
 */
export async function getLineageLastModifiedAt(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  descriptorLastModifiedAt: number | undefined
): Promise<number> {
  const lineageDirectory = WorkflowPaths.lineageDir(workspaceRoot, workflowKey);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(lineageDirectory, {
      withFileTypes: true,
    });
  } catch {
    return resolveLineageLastModifiedAt(descriptorLastModifiedAt);
  }

  const directories = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      (WorkflowPaths.isRunDirEntry(entry) ||
        WorkflowPaths.isDraftDirEntry(entry))
  );
  const activityTimestamps: Array<number | undefined> = [];
  for (
    let startIndex = 0;
    startIndex < directories.length;
    startIndex += LINEAGE_ACTIVITY_READ_BATCH_SIZE
  ) {
    const batch = directories.slice(
      startIndex,
      startIndex + LINEAGE_ACTIVITY_READ_BATCH_SIZE
    );
    activityTimestamps.push(
      ...(await Promise.all(
        batch.map(async (entry) => {
          const workingFilePath = WorkflowPaths.isDraftDirEntry(entry)
            ? WorkflowPaths.draftFilePath(workspaceRoot, workflowKey)
            : WorkflowPaths.runFilePath(
                workspaceRoot,
                workflowKey,
                entry.name as RunRef
              );
          try {
            const content = await fs.promises.readFile(workingFilePath, "utf8");
            return getWorkingFileLastActivityAt(
              JSON.parse(content) as WorkingFile
            );
          } catch {
            return undefined;
          }
        })
      ))
    );
  }
  return resolveLineageLastModifiedAt(
    descriptorLastModifiedAt,
    ...activityTimestamps
  );
}
