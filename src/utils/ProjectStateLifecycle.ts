import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renameWithTransientRetry } from "./AtomicFileUtils";
import {
  assertProjectDirectoryIsReal,
  assertUserProjectContained,
  PROJECT_METADATA_FILE_NAME,
  readProjectStateMetadata,
  type ProjectStateMetadata,
  withUserProjectRegistryLock,
  writeProjectStateMetadata,
} from "./ProjectStateRegistry";
import { projectStateRoot } from "./ProjectStatePaths";
import { pathsEqual } from "./PathCasing";
import { isOwnerStale } from "./LockSafetyPrimitives";
import {
  PROJECT_RUNNER_STATUSES,
  PROJECT_STATE_PATH_STATUSES,
  RUN_HISTORY_LOCATIONS,
} from "../types/DashboardConstants";
import type { WorkflowRunnerLock } from "../types/CtrlYokeTypes";
import * as WorkflowPaths from "./WorkflowPaths";

export type ProjectStatePathStatus =
  (typeof PROJECT_STATE_PATH_STATUSES)[keyof typeof PROJECT_STATE_PATH_STATUSES];
export type ProjectRunnerStatus =
  (typeof PROJECT_RUNNER_STATUSES)[keyof typeof PROJECT_RUNNER_STATUSES];

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

export class ProjectStateLifecycleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProjectStateLifecycleError";
  }
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
        const runner = await inspectRunner(inspection.projectRoot);
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
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    }

    return { inspections, deleted };
  });
}

/** Move one user-scoped project directory to the key for a renamed repository. */
export async function relinkUserProject(
  oldPath: string,
  newPath: string,
  options: RelinkUserProjectOptions
): Promise<RelinkUserProjectResult> {
  const resolvedOldPath = path.resolve(oldPath);
  const resolvedNewPath = path.resolve(newPath);
  const oldProjectRoot = projectStateRoot(
    resolvedOldPath,
    RUN_HISTORY_LOCATIONS.USER
  );
  const newProjectRoot = projectStateRoot(
    resolvedNewPath,
    RUN_HISTORY_LOCATIONS.USER
  );

  return withUserProjectRegistryLock(async (projectsRoot) => {
    await assertProjectDirectoriesSafe(projectsRoot);
    await assertUserProjectContained(projectsRoot, oldProjectRoot);
    await assertUserProjectContained(projectsRoot, newProjectRoot);
    await assertProjectDirectoryIsReal(oldProjectRoot);

    const oldMetadata = await readProjectStateMetadata(oldProjectRoot);
    if (!oldMetadata) {
      throw new ProjectStateLifecycleError(
        `Source project state is missing project.json: ${oldProjectRoot}`
      );
    }
    if (!pathsEqual(path.resolve(oldMetadata.statePath), resolvedOldPath)) {
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
          !pathsEqual(
            path.resolve(destinationMetadata.statePath),
            resolvedNewPath
          )
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
      reason = error instanceof Error ? error.message : String(error);
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
      reason = error instanceof Error ? error.message : String(error);
    }

    let runnerStatus: ProjectRunnerStatus = PROJECT_RUNNER_STATUSES.UNKNOWN;
    try {
      runnerStatus = (await inspectRunner(projectRoot)).status;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
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
          const parentCode = (parentError as NodeJS.ErrnoException).code;
          if (parentCode !== "ENOENT") {
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

async function inspectRunner(
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
    const runnerPath = path.join(runsRoot, lineage.name, "runner.json");
    const runnerStats = await lstatIfExists(runnerPath);
    if (!runnerStats) {
      continue;
    }
    if (runnerStats.isSymbolicLink() || !runnerStats.isFile()) {
      throw new ProjectStateLifecycleError(
        `Runner lock is not a regular file: ${runnerPath}`
      );
    }

    let lock: WorkflowRunnerLock;
    try {
      lock = JSON.parse(
        await fs.readFile(runnerPath, "utf8")
      ) as WorkflowRunnerLock;
    } catch (error) {
      throw new ProjectStateLifecycleError(
        `Runner lock cannot be read: ${runnerPath}: ${String(error)}`
      );
    }
    if (
      typeof lock.pid !== "number" ||
      typeof lock.lastHeartbeat !== "number"
    ) {
      throw new ProjectStateLifecycleError(
        `Runner lock is invalid: ${runnerPath}`
      );
    }
    if (!isOwnerStale(lock.pid, lock.lastHeartbeat)) {
      return { status: PROJECT_RUNNER_STATUSES.LIVE, path: runnerPath };
    }
  }

  return { status: PROJECT_RUNNER_STATUSES.NONE };
}

async function refuseLiveOrUnknownRunner(
  projectRoot: string,
  label: string
): Promise<void> {
  const runner = await inspectRunner(projectRoot);
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

async function isEmptyProjectScaffold(projectRoot: string): Promise<boolean> {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  return entries.every((entry) => entry.name === PROJECT_METADATA_FILE_NAME);
}

async function lstatIfExists(
  filePath: string
): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
