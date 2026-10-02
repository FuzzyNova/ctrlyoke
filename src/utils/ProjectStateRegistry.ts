import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "./FileLockUtils";
import { renameWithTransientRetry } from "./AtomicFileUtils";
import { pathsEqual } from "./PathCasing";
import {
  ctrlyokeStateHome,
  projectStateRoot,
  userProjectsRoot,
} from "./ProjectStatePaths";
import type { RunHistoryLocation } from "../types/CtrlYokeSettings";
import { RUN_HISTORY_LOCATIONS } from "../types/DashboardConstants";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "./PersistedSchemaGuard";
import { migrateToCurrent } from "./FormatMigrations";

export const PROJECT_METADATA_FILE_NAME = "project.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REGISTRY_LOCK_NAME = ".registry";

export interface ProjectStateMetadata {
  schemaVersion: (typeof CURRENT_SCHEMA_VERSIONS)[typeof PERSISTED_STORES.PROJECT_METADATA];
  statePath: string;
  gitToplevel?: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ProjectStateInitialization {
  projectRoot: string;
  metadataPath?: string;
  metadata?: ProjectStateMetadata;
}

/**
 * Owns the reverse-lookup metadata for user-scoped project state.
 *
 * This class deliberately does not calculate paths from configuration. The
 * caller supplies the startup-frozen location, while ProjectStatePaths stays
 * pure and synchronous for the path consumers used by the MCP server.
 */
export class ProjectStateRegistry {
  private readonly location: RunHistoryLocation;

  public constructor(location = getFrozenRunHistoryLocation()) {
    this.location = location;
  }

  /** Ensure the project's registry record exists and is owned by stateRoot. */
  public async initialize(
    stateRoot: string,
    gitToplevel?: string
  ): Promise<ProjectStateInitialization> {
    const resolvedStateRoot = path.resolve(stateRoot);
    const projectRoot = projectStateRoot(resolvedStateRoot, this.location);

    if (this.location === RUN_HISTORY_LOCATIONS.WORKSPACE) {
      return { projectRoot };
    }

    const projectsRoot = path.dirname(projectRoot);
    await ensurePrivateDirectory(ctrlyokeStateHome());
    await ensurePrivateDirectory(projectsRoot);
    await assertContainedByRealRoot(projectsRoot, projectRoot);

    // The lock is a sibling of the project directory so it can be acquired
    // before the directory exists. It is still inside the private projects
    // root and is removed by withFileLock after the transaction completes.
    return withUserProjectRegistryLock(async () => {
      return withFileLock(projectRoot, async () => {
        await assertContainedByRealRoot(projectsRoot, projectRoot);
        await rejectSymlinkProjectDirectory(projectRoot);

        const projectExists = await pathExists(projectRoot);
        if (!projectExists) {
          await fs.mkdir(projectRoot, {
            recursive: false,
            mode: PRIVATE_DIRECTORY_MODE,
          });
        } else {
          const stats = await fs.lstat(projectRoot);
          if (!stats.isDirectory()) {
            throw new Error(
              `Project state path is not a directory: ${projectRoot}`
            );
          }
        }
        await fs.chmod(projectRoot, PRIVATE_DIRECTORY_MODE);

        await assertContainedByRealRoot(projectsRoot, projectRoot);
        await rejectSymlinkProjectDirectory(projectRoot);

        const metadataPath = path.join(projectRoot, PROJECT_METADATA_FILE_NAME);
        const metadata = await readOrCreateMetadata(
          projectRoot,
          metadataPath,
          resolvedStateRoot,
          gitToplevel
        );
        await writeMetadataAtomically(
          projectsRoot,
          projectRoot,
          metadataPath,
          metadata
        );

        return { projectRoot, metadataPath, metadata };
      });
    });
  }
}

/** Resolve the private project-state directory used by user-scoped history. */
export function userProjectStatesRoot(): string {
  return userProjectsRoot();
}

/** Serialize mutations that enumerate, rename, or delete project directories. */
export async function withUserProjectRegistryLock<T>(
  action: (projectsRoot: string) => Promise<T>
): Promise<T> {
  const projectsRoot = userProjectStatesRoot();
  await ensurePrivateDirectory(ctrlyokeStateHome());
  await ensurePrivateDirectory(projectsRoot);

  return withFileLock(path.join(projectsRoot, REGISTRY_LOCK_NAME), async () => {
    await assertContainedByRealRoot(projectsRoot, projectsRoot);
    return action(projectsRoot);
  });
}

/** Re-check a project path against the real projects root immediately before mutation. */
export async function assertUserProjectContained(
  projectsRoot: string,
  projectRoot: string
): Promise<void> {
  await assertContainedByRealRoot(projectsRoot, projectRoot);
}

/** Reject a project root that could redirect a lifecycle operation elsewhere. */
export async function assertProjectDirectoryIsReal(
  projectRoot: string
): Promise<void> {
  await rejectSymlinkProjectDirectory(projectRoot);
}

/** Read and validate one project registry record without following a directory symlink. */
export async function readProjectStateMetadata(
  projectRoot: string
): Promise<ProjectStateMetadata | undefined> {
  const metadataPath = path.join(projectRoot, PROJECT_METADATA_FILE_NAME);
  const stats = await lstatIfExists(metadataPath);
  if (!stats) {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Project metadata must not be a symlink: ${metadataPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Project metadata is not a file: ${metadataPath}`);
  }
  return parseMetadata(await fs.readFile(metadataPath, "utf8"), metadataPath);
}

/** Write one project registry record atomically while preserving its directory boundary. */
export async function writeProjectStateMetadata(
  projectsRoot: string,
  projectRoot: string,
  metadata: ProjectStateMetadata
): Promise<void> {
  await writeMetadataAtomically(
    projectsRoot,
    projectRoot,
    path.join(projectRoot, PROJECT_METADATA_FILE_NAME),
    metadata
  );
}

/** Return a warning when the private state home is inside a repository/state root. */
export function getStateHomeWarning(
  stateHome: string,
  knownStateRoots: readonly string[],
  gitToplevels: readonly (string | undefined)[] = []
): string | undefined {
  const resolvedHome = path.resolve(stateHome);
  const roots = [...knownStateRoots, ...gitToplevels.filter(isDefined)];
  const containingRoot = roots.find((root) =>
    isPathWithinOrEqual(resolvedHome, path.resolve(root))
  );

  if (!containingRoot) {
    return undefined;
  }

  return `CTRLYOKE_HOME ("${resolvedHome}") is inside the known state/worktree root "${path.resolve(containingRoot)}". This isolation override also places private ctrlyoke credentials and quota cache inside the tree.`;
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

function isPathWithinOrEqual(candidate: string, directory: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDirectory = path.resolve(directory);
  if (pathsEqual(resolvedCandidate, resolvedDirectory)) {
    return true;
  }
  const relative = path.relative(resolvedDirectory, resolvedCandidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function readOrCreateMetadata(
  projectRoot: string,
  metadataPath: string,
  stateRoot: string,
  gitToplevel: string | undefined
): Promise<ProjectStateMetadata> {
  let existing: ProjectStateMetadata | undefined;
  try {
    const stats = await fs.lstat(metadataPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Project metadata must not be a symlink: ${metadataPath}`
      );
    }
    if (!stats.isFile()) {
      throw new Error(`Project metadata is not a file: ${metadataPath}`);
    }
    existing = parseMetadata(
      await fs.readFile(metadataPath, "utf8"),
      metadataPath
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const entries = await fs.readdir(projectRoot);
    if (entries.length > 0) {
      throw new Error(
        `Project state directory is non-empty but has no project metadata: ${projectRoot}`
      );
    }
  }

  if (existing && !pathsEqual(path.resolve(existing.statePath), stateRoot)) {
    throw new Error(
      `Project state collision: ${projectRoot} belongs to "${existing.statePath}", not "${stateRoot}".`
    );
  }

  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROJECT_METADATA],
    statePath: existing?.statePath ?? stateRoot,
    ...(gitToplevel !== undefined
      ? { gitToplevel: path.resolve(gitToplevel) }
      : existing?.gitToplevel !== undefined
        ? { gitToplevel: existing.gitToplevel }
        : {}),
    createdAt: existing?.createdAt ?? now,
    lastOpenedAt: now,
  };
}

function parseMetadata(
  contents: string,
  metadataPath: string
): ProjectStateMetadata {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid project metadata JSON at ${metadataPath}: ${String(error)}`
    );
  }

  if (!isRecord(value) || typeof value.schemaVersion !== "number") {
    throw new Error(`Invalid project metadata at ${metadataPath}.`);
  }
  assertWritableSchema(PERSISTED_STORES.PROJECT_METADATA, value, metadataPath);
  value = migrateToCurrent(PERSISTED_STORES.PROJECT_METADATA, value).doc;
  if (!isRecord(value)) {
    throw new Error(`Invalid project metadata at ${metadataPath}.`);
  }
  if (
    value.schemaVersion !==
    CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROJECT_METADATA]
  ) {
    throw new Error(
      `Unsupported project metadata schema ${value.schemaVersion}: ${metadataPath}`
    );
  }
  if (
    typeof value.statePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastOpenedAt !== "string" ||
    (value.gitToplevel !== undefined && typeof value.gitToplevel !== "string")
  ) {
    throw new Error(`Invalid project metadata fields at ${metadataPath}.`);
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROJECT_METADATA],
    statePath: value.statePath,
    ...(value.gitToplevel !== undefined
      ? { gitToplevel: value.gitToplevel }
      : {}),
    createdAt: value.createdAt,
    lastOpenedAt: value.lastOpenedAt,
  };
}

async function writeMetadataAtomically(
  projectsRoot: string,
  projectRoot: string,
  metadataPath: string,
  metadata: ProjectStateMetadata
): Promise<void> {
  await assertContainedByRealRoot(projectsRoot, projectRoot);
  await rejectSymlinkProjectDirectory(projectRoot);
  const existingMetadata = await lstatIfExists(metadataPath);
  if (existingMetadata?.isSymbolicLink()) {
    throw new Error(`Project metadata must not be a symlink: ${metadataPath}`);
  }

  const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      }
    );
    await fs.chmod(temporaryPath, PRIVATE_FILE_MODE);
    await assertContainedByRealRoot(projectsRoot, projectRoot);
    await rejectSymlinkProjectDirectory(projectRoot);
    await renameWithTransientRetry(temporaryPath, metadataPath);
    await fs.chmod(metadataPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function rejectSymlinkProjectDirectory(
  projectRoot: string
): Promise<void> {
  const stats = await lstatIfExists(projectRoot);
  if (stats?.isSymbolicLink()) {
    throw new Error(
      `Project state directory must not be a symlink: ${projectRoot}`
    );
  }
}

async function assertContainedByRealRoot(
  projectsRoot: string,
  candidate: string
): Promise<void> {
  const realRoot = await fs.realpath(projectsRoot);
  const resolvedCandidate = path.resolve(candidate);
  // Resolve the candidate's parent so a state home that reaches the projects
  // root through a symlink/junction is compared using the same real path form.
  // Keep the final component lexical: rejectSymlinkProjectDirectory owns the
  // explicit check for a project directory that is itself a link.
  const realCandidate = path.join(
    await fs.realpath(path.dirname(resolvedCandidate)),
    path.basename(resolvedCandidate)
  );
  const relative = path.relative(realRoot, realCandidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Project state path escapes the projects root: ${resolvedCandidate}`
    );
  }
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

async function pathExists(filePath: string): Promise<boolean> {
  return (await lstatIfExists(filePath)) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
