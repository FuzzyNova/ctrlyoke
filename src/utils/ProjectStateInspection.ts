import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowLockInspectionAtPath } from "./WorkflowLockInspector";
import {
  PROJECT_RUNNER_STATUSES,
  WORKFLOW_LOCK_LIVENESS,
  NODE_ERROR_CODES,
  type ProjectRunnerStatus,
} from "../types/DashboardConstants";
import type { WorkflowKey } from "../types/CtrlYokeTypes";
import * as WorkflowPaths from "./WorkflowPaths";
import { hasErrnoCode } from "./ErrorUtils";

/**
 * Read-only inspection of one user-scoped project directory, shared by the
 * registry (which migrates split history on startup) and the lifecycle
 * commands (`history prune`/`relink`). It reads only run storage, never
 * `project.json`, so it sits below both without importing either.
 */

export class ProjectStateLifecycleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectStateLifecycleError";
  }
}

/** Whether any lineage of the project has a live runner, failing closed on anything unexpected. */
export async function inspectProjectRunner(
  projectRoot: string
): Promise<{ status: ProjectRunnerStatus; path?: string }> {
  const runsRoot = WorkflowPaths.runsRootForProjectState(projectRoot);
  const runsStats = await lstatIfExists(runsRoot);
  if (!runsStats) {
    return { status: PROJECT_RUNNER_STATUSES.NONE };
  }
  if (runsStats.isSymbolicLink()) {
    throw new ProjectStateLifecycleError(
      `Run storage must not be a symlink: ${runsRoot}`
    );
  }
  if (!runsStats.isDirectory()) {
    return { status: PROJECT_RUNNER_STATUSES.UNKNOWN };
  }

  const lineages = await fs.readdir(runsRoot, { withFileTypes: true });
  for (const lineage of lineages) {
    if (lineage.isSymbolicLink()) {
      throw new ProjectStateLifecycleError(
        `Run lineage must not be a symlink: ${path.join(runsRoot, lineage.name)}`
      );
    }
    if (!lineage.isDirectory()) {
      continue;
    }
    const workflowKey = lineage.name as WorkflowKey;
    const runnerPath = WorkflowPaths.runnerLockPathForProjectState(
      projectRoot,
      workflowKey
    );
    const runnerStats = await lstatIfExists(runnerPath);
    if (!runnerStats) {
      continue;
    }
    if (runnerStats.isSymbolicLink() || !runnerStats.isFile()) {
      throw new ProjectStateLifecycleError(
        `Runner lock is not a regular file: ${runnerPath}`
      );
    }

    const lockInspection = await readWorkflowLockInspectionAtPath(runnerPath);
    if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ABSENT) {
      throw new ProjectStateLifecycleError(
        `Runner lock is invalid: ${runnerPath}`
      );
    }
    if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
      return { status: PROJECT_RUNNER_STATUSES.LIVE, path: runnerPath };
    }
  }

  return { status: PROJECT_RUNNER_STATUSES.NONE };
}

/**
 * Start time of the project's most recent run across every lineage, from the
 * run directory names, or `undefined` when the project has no runs.
 */
export async function latestProjectRunTimestamp(
  projectRoot: string
): Promise<number | undefined> {
  const runsRoot = WorkflowPaths.runsRootForProjectState(projectRoot);
  let latest: number | undefined;
  for (const lineage of await readDirIfExists(runsRoot)) {
    if (!WorkflowPaths.isLineageDirEntry(lineage)) {
      continue;
    }
    const lineageRoot = path.join(runsRoot, lineage.name);
    for (const run of await readDirIfExists(lineageRoot)) {
      if (!WorkflowPaths.isRunDirEntry(run)) {
        continue;
      }
      const timestamp = WorkflowPaths.parseRunRefTimestamp(run.name);
      if (
        timestamp !== undefined &&
        (latest === undefined || timestamp > latest)
      ) {
        latest = timestamp;
      }
    }
  }
  return latest;
}

export async function lstatIfExists(
  filePath: string
): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
      return undefined;
    }
    throw error;
  }
}

async function readDirIfExists(
  directory: string
): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      hasErrnoCode(error, NODE_ERROR_CODES.ENOENT) ||
      hasErrnoCode(error, NODE_ERROR_CODES.ENOTDIR)
    ) {
      return [];
    }
    throw error;
  }
}
