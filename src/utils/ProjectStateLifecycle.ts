import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renameWithTransientRetry } from "./AtomicFileUtils";
import {
  assertProjectDirectoryIsReal,
  assertUserProjectContained,
  findProjectHistory,
  isEmptyProjectScaffold,
  readProjectStateMetadata,
  statePathBelongsTo,
  type ProjectStateMetadata,
  withUserProjectRegistryLock,
  writeProjectStateMetadata,
} from "./ProjectStateRegistry";
import { canonicalStatePath, projectStateRoot } from "./ProjectStatePaths";
import { pathsEqual } from "./PathCasing";
import {
  inspectProjectRunner,
  lstatIfExists,
  ProjectStateLifecycleError,
} from "./ProjectStateInspection";
import {
  PROJECT_RUNNER_STATUSES,
  PROJECT_STATE_PATH_STATUSES,
  RUN_HISTORY_LOCATIONS,
  NODE_ERROR_CODES,
  type ProjectRunnerStatus,
} from "../types/DashboardConstants";
import { getErrorMessage, hasErrnoCode, getErrnoCode } from "./ErrorUtils";

export { ProjectStateLifecycleError, type ProjectRunnerStatus };

export type ProjectStatePathStatus =
  (typeof PROJECT_STATE_PATH_STATUSES)[keyof typeof PROJECT_STATE_PATH_STATUSES];

export interface UserProjectInspection {
  projectRoot: string;
  metadata?: ProjectStateMetadata;
  statePathStatus: ProjectStatePathStatus;
  runnerStatus: ProjectRunnerStatus;
  reason?: string;
}

export interface PruneUserProjectsResult {
  inspections: UserProjectInspection[];
  deleted: string[];
}

export interface RelinkUserProjectOptions {
  dryRun: boolean;
  /** `null` explicitly removes a previously recorded Git toplevel. */
  gitToplevel?: string | null;
}

export interface RelinkUserProjectResult {
  oldProjectRoot: string;
  newProjectRoot: string;
  replacedEmptyScaffold: boolean;
  metadata: ProjectStateMetadata;
}

/** Inspect every user-scoped project without requiring a workspace or frozen policy. */
export async function inspectUserProjects(): Promise<UserProjectInspection[]> {
  return withUserProjectRegistryLock((projectsRoot) =>
    inspectUserProjectsUnderLock(projectsRoot)
  );
}

/** Delete orphaned user projects after a complete, lock-protected safety scan. */
export async function pruneUserProjects(
  dryRun: boolean
): Promise<PruneUserProjectsResult> {
  return withUserProjectRegistryLock(async (projectsRoot) => {
    const inspections = await inspectUserProjectsUnderLock(projectsRoot);
    const deleted: string[] = [];

    if (!dryRun) {
      for (const inspection of inspections) {
        if (
          inspection.statePathStatus !== PROJECT_STATE_PATH_STATUSES.MISSING ||
          inspection.runnerStatus !== PROJECT_RUNNER_STATUSES.NONE
        ) {
          continue;
        }

        // Re-run all path and ownership checks immediately before deletion.
        await assertUserProjectContained(projectsRoot, inspection.projectRoot);
        await assertProjectDirectoryIsReal(inspection.projectRoot);
        const metadata = await readProjectStateMetadata(inspection.projectRoot);
        if (
          !metadata ||
          (await classifyStatePath(metadata.statePath)) !==
            PROJECT_STATE_PATH_STATUSES.MISSING
        ) {
          continue;
        }
        const runner = await inspectProjectRunner(inspection.projectRoot);
        if (runner.status === PROJECT_RUNNER_STATUSES.LIVE) {
          continue;
        }
        if (runner.status === PROJECT_RUNNER_STATUSES.UNKNOWN) {
          continue;
        }

        try {
          await fs.rm(inspection.projectRoot, {
            recursive: true,
            force: false,
          });
          deleted.push(inspection.projectRoot);
        } catch (error) {
          if (!hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
            throw error;
          }
        }
      }
    }

    return { inspections, deleted };
  });
}

/**
 * Move one user-scoped project directory to the key for a renamed repository.
 * Both paths are canonicalized, so either may be typed through a symlink. The
 * source is whichever directory holds the old path's history, including one
 * that ctrlyoke 0.2.0 filed under a symlinked spelling's key.
 */
export async function relinkUserProject(
  oldPath: string,
  newPath: string,
  options: RelinkUserProjectOptions
): Promise<RelinkUserProjectResult> {
  const resolvedOldPath = canonicalStatePath(oldPath);
  const resolvedNewPath = canonicalStatePath(newPath);
  const newProjectRoot = projectStateRoot(
    resolvedNewPath,
    RUN_HISTORY_LOCATIONS.USER
  );

  return withUserProjectRegistryLock(async (projectsRoot) => {
    await assertProjectDirectoriesSafe(projectsRoot);
    const source = await findProjectHistory(projectsRoot, oldPath);
    const oldProjectRoot =
      source.keep?.projectRoot ?? source.canonicalProjectRoot;
    await assertUserProjectContained(projectsRoot, oldProjectRoot);
    await assertUserProjectContained(projectsRoot, newProjectRoot);
    await assertProjectDirectoryIsReal(oldProjectRoot);

    const oldMetadata = await readProjectStateMetadata(oldProjectRoot);
    if (!oldMetadata) {
      throw new ProjectStateLifecycleError(
        `Source project state is missing project.json: ${oldProjectRoot}`
      );
    }
    if (!statePathBelongsTo(oldMetadata.statePath, resolvedOldPath)) {
      throw new ProjectStateLifecycleError(
        `Source project metadata does not belong to "${resolvedOldPath}".`
      );
    }
    await refuseLiveOrUnknownRunner(oldProjectRoot, "source");

    const destinationStats = await lstatIfExists(newProjectRoot);
    let replacedEmptyScaffold = false;
    if (destinationStats) {
      if (destinationStats.isSymbolicLink()) {
        throw new ProjectStateLifecycleError(
          `Refusing symlinked destination project directory: ${newProjectRoot}`
        );
      }
      if (!destinationStats.isDirectory()) {
        throw new ProjectStateLifecycleError(
          `Destination project state is not a directory: ${newProjectRoot}`
        );
      }
      if (!pathsEqual(oldProjectRoot, newProjectRoot)) {
        const destinationMetadata =
          await readProjectStateMetadata(newProjectRoot);
        if (
          !destinationMetadata ||
          !statePathBelongsTo(destinationMetadata.statePath, resolvedNewPath)
        ) {
          throw new ProjectStateLifecycleError(
            `Destination project state is a collision: ${newProjectRoot}`
          );
        }
        await refuseLiveOrUnknownRunner(newProjectRoot, "destination");
        if (!(await isEmptyProjectScaffold(newProjectRoot))) {
          throw new ProjectStateLifecycleError(
            `Destination project state contains history or other data: ${newProjectRoot}`
          );
        }
        replacedEmptyScaffold = true;
      }
    }

    const metadata: ProjectStateMetadata = {
      schemaVersion: oldMetadata.schemaVersion,
      statePath: resolvedNewPath,
      createdAt: oldMetadata.createdAt,
      ...(options.gitToplevel === null
        ? {}
        : options.gitToplevel !== undefined
          ? { gitToplevel: path.resolve(options.gitToplevel) }
          : oldMetadata.gitToplevel !== undefined
            ? { gitToplevel: oldMetadata.gitToplevel }
            : {}),
      lastOpenedAt: new Date().toISOString(),
    };

    if (options.dryRun) {
      return {
        oldProjectRoot,
        newProjectRoot,
        replacedEmptyScaffold,
        metadata,
      };
    }

    await assertUserProjectContained(projectsRoot, oldProjectRoot);
    await assertUserProjectContained(projectsRoot, newProjectRoot);
    await assertProjectDirectoryIsReal(oldProjectRoot);

    if (pathsEqual(oldProjectRoot, newProjectRoot)) {
      await writeProjectStateMetadata(projectsRoot, oldProjectRoot, metadata);
      return {
        oldProjectRoot,
        newProjectRoot,
        replacedEmptyScaffold: false,
        metadata,
      };
    }

    const backupRoot = `${newProjectRoot}.relink-${process.pid}-${Date.now()}`;
    await assertUserProjectContained(projectsRoot, backupRoot);
    if (await lstatIfExists(backupRoot)) {
      throw new ProjectStateLifecycleError(
        `Temporary relink path already exists: ${backupRoot}`
      );
    }

    let destinationBackedUp = false;
    try {
      if (destinationStats) {
        await renameWithTransientRetry(newProjectRoot, backupRoot);
        destinationBackedUp = true;
      }

      await writeProjectStateMetadata(projectsRoot, oldProjectRoot, metadata);
      await renameWithTransientRetry(oldProjectRoot, newProjectRoot);
      if (destinationBackedUp) {
        await fs.rm(backupRoot, { recursive: true, force: false });
      }
    } catch (error) {
      if (await lstatIfExists(oldProjectRoot)) {
        await writeProjectStateMetadata(
          projectsRoot,
          oldProjectRoot,
          oldMetadata
        ).catch(() => undefined);
      }
      if (destinationBackedUp && !(await lstatIfExists(newProjectRoot))) {
        await renameWithTransientRetry(backupRoot, newProjectRoot).catch(
          () => undefined
        );
      }
      throw error;
    }

    return {
      oldProjectRoot,
      newProjectRoot,
      replacedEmptyScaffold,
      metadata,
    };
  });
}

async function inspectUserProjectsUnderLock(
  projectsRoot: string
): Promise<UserProjectInspection[]> {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const inspections: UserProjectInspection[] = [];

  for (const entry of entries) {
    const projectRoot = path.join(projectsRoot, entry.name);
    await assertUserProjectContained(projectsRoot, projectRoot);
    if (entry.isSymbolicLink()) {
      throw new ProjectStateLifecycleError(
        `Refusing symlinked project directory: ${projectRoot}`
      );
    }
    if (!entry.isDirectory()) {
      continue;
    }
    await assertProjectDirectoryIsReal(projectRoot);

    let metadata: ProjectStateMetadata | undefined;
    let reason: string | undefined;
    try {
      metadata = await readProjectStateMetadata(projectRoot);
      if (!metadata) {
        reason = "project.json is missing";
      }
    } catch (error) {
      reason = getErrorMessage(error);
    }

    if (!metadata) {
      inspections.push({
        projectRoot,
        statePathStatus: PROJECT_STATE_PATH_STATUSES.UNKNOWN,
        runnerStatus: PROJECT_RUNNER_STATUSES.UNKNOWN,
        ...(reason ? { reason } : {}),
      });
      continue;
    }

    let statePathStatus: ProjectStatePathStatus =
      PROJECT_STATE_PATH_STATUSES.UNKNOWN;
    try {
      statePathStatus = await classifyStatePath(metadata.statePath);
    } catch (error) {
      reason = getErrorMessage(error);
    }

    let runnerStatus: ProjectRunnerStatus = PROJECT_RUNNER_STATUSES.UNKNOWN;
    try {
      runnerStatus = (await inspectProjectRunner(projectRoot)).status;
    } catch (error) {
      reason = getErrorMessage(error);
    }

    inspections.push({
      projectRoot,
      metadata,
      statePathStatus,
      runnerStatus,
      ...(reason ? { reason } : {}),
    });
  }

  return inspections;
}

/** Enumerate the registry before every lifecycle operation and fail closed on symlinks. */
async function assertProjectDirectoriesSafe(
  projectsRoot: string
): Promise<void> {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  for (const entry of entries) {
    const projectRoot = path.join(projectsRoot, entry.name);
    await assertUserProjectContained(projectsRoot, projectRoot);
    if (entry.isSymbolicLink()) {
      throw new ProjectStateLifecycleError(
        `Refusing symlinked project directory: ${projectRoot}`
      );
    }
    if (entry.isDirectory()) {
      await assertProjectDirectoryIsReal(projectRoot);
    }
  }
}

async function classifyStatePath(
  statePath: string
): Promise<ProjectStatePathStatus> {
  try {
    await fs.stat(path.resolve(statePath));
    return PROJECT_STATE_PATH_STATUSES.PRESENT;
  } catch (error) {
    const code = getErrnoCode(error);
    if (code === NODE_ERROR_CODES.ENOENT) {
      const resolvedStatePath = path.resolve(statePath);
      if (
        resolvedStatePath.startsWith("\\\\") ||
        resolvedStatePath.startsWith("//")
      ) {
        return PROJECT_STATE_PATH_STATUSES.UNKNOWN;
      }
      let parent = path.dirname(resolvedStatePath);
      while (parent !== path.dirname(parent)) {
        try {
          const parentStats = await fs.stat(parent);
          return parentStats.isDirectory()
            ? PROJECT_STATE_PATH_STATUSES.MISSING
            : PROJECT_STATE_PATH_STATUSES.UNKNOWN;
        } catch (parentError) {
          const parentCode = getErrnoCode(parentError);
          if (parentCode !== NODE_ERROR_CODES.ENOENT) {
            return PROJECT_STATE_PATH_STATUSES.UNKNOWN;
          }
          parent = path.dirname(parent);
        }
      }
      return PROJECT_STATE_PATH_STATUSES.UNKNOWN;
    }
    return PROJECT_STATE_PATH_STATUSES.UNKNOWN;
  }
}

async function refuseLiveOrUnknownRunner(
  projectRoot: string,
  label: string
): Promise<void> {
  const runner = await inspectProjectRunner(projectRoot);
  if (runner.status === PROJECT_RUNNER_STATUSES.LIVE) {
    throw new ProjectStateLifecycleError(
      `Refusing to relink ${label} project with a live runner: ${runner.path}`
    );
  }
  if (runner.status === PROJECT_RUNNER_STATUSES.UNKNOWN) {
    throw new ProjectStateLifecycleError(
      `Refusing to relink ${label} project because runner state is unknown: ${projectRoot}`
    );
  }
}
