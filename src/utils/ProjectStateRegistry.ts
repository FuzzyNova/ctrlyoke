import { isRecord } from "./JsonTypeGuards";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FileLockOptions, withFileLock } from "./FileLockUtils";
import { renameWithTransientRetry } from "./AtomicFileUtils";
import { pathsEqual } from "./PathCasing";
import { relativePathEscapes } from "./PathSecurity";
import {
  canonicalStatePath,
  ctrlyokeStateHome,
  legacyProjectKey,
  projectKey,
  projectKeySlug,
  projectStateRoot,
  userProjectsRoot,
} from "./ProjectStatePaths";
import {
  inspectProjectRunner,
  latestProjectRunTimestamp,
  lstatIfExists,
} from "./ProjectStateInspection";
import { getErrorMessage } from "./ErrorUtils";
import type { RunHistoryLocation } from "../types/CtrlYokeSettings";
import {
  PROJECT_RUNNER_STATUSES,
  RUN_HISTORY_LOCATIONS,
  NODE_ERROR_CODES,
} from "../types/DashboardConstants";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "./PersistedSchemaGuard";
import { migrateToCurrent } from "./FormatMigrations";
import { hasErrnoCode } from "./ErrorUtils";

const PROJECT_METADATA_FILE_NAME = "project.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REGISTRY_LOCK_NAME = ".registry";
/** `<slug>-<hash12>`, the shape `projectKey` produces; group 1 is the slug. */
const PROJECT_KEY_PATTERN = /^(.+)-[0-9a-f]{12}$/;

/**
 * Every window, CLI and MCP server registers its project on startup, and a
 * failed registration aborts that startup. A holder whose event loop is
 * blocked (a busy extension host can stall for many seconds while activating)
 * keeps the lock well past the default 5 s timeout without being dead, so wait
 * while its heartbeat is fresh: a dead holder's lock still goes stale and is
 * reclaimed after 30 s. The ceiling only bounds a live holder stuck in its
 * action, such as a `history prune` deleting a large backlog.
 */
const REGISTRY_LOCK_OPTIONS: FileLockOptions = {
  waitWhileHolderAlive: true,
  maxWaitMs: 5 * 60_000,
};

export interface ProjectStateMetadata {
  schemaVersion: (typeof CURRENT_SCHEMA_VERSIONS)[typeof PERSISTED_STORES.PROJECT_METADATA];
  statePath: string;
  gitToplevel?: string;
  createdAt: string;
  lastOpenedAt: string;
  /** Whether the one-time full project-key recovery scan has completed. */
  legacyProjectScanComplete?: boolean;
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
    // Workspace-mode history still keeps its run definition anchors in the
    // user project directory, so that directory is registered in both modes:
    // the record is what lets `history prune` and `history relink` handle it.
    const registration = await registerUserProject(
      resolvedStateRoot,
      gitToplevel
    );
    if (this.location === RUN_HISTORY_LOCATIONS.WORKSPACE) {
      return {
        projectRoot: projectStateRoot(resolvedStateRoot, this.location),
      };
    }
    return registration;
  }
}

async function registerUserProject(
  resolvedStateRoot: string,
  gitToplevel: string | undefined
): Promise<ProjectStateInitialization> {
  const canonicalRoot = canonicalStatePath(resolvedStateRoot);
  const projectRoot = projectStateRoot(
    resolvedStateRoot,
    RUN_HISTORY_LOCATIONS.USER
  );
  const projectsRoot = path.dirname(projectRoot);
  await ensurePrivateDirectory(ctrlyokeStateHome());
  await ensurePrivateDirectory(projectsRoot);
  await assertContainedByRealRoot(projectsRoot, projectRoot);

  // The lock is a sibling of the project directory so it can be acquired
  // before the directory exists. It is still inside the private projects
  // root and is removed by withFileLock after the transaction completes.
  return withUserProjectRegistryLock(async () => {
    return withFileLock(
      projectRoot,
      async () => {
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
          canonicalRoot,
          gitToplevel
        );
        await writeMetadataAtomically(
          projectsRoot,
          projectRoot,
          metadataPath,
          metadata
        );

        await adoptSplitProjectHistory(projectsRoot, resolvedStateRoot);

        return { projectRoot, metadataPath, metadata };
      },
      REGISTRY_LOCK_OPTIONS
    );
  });
}

/** Resolve the private project-state directory used by user-scoped history. */
function userProjectStatesRoot(): string {
  return userProjectsRoot();
}

/** Serialize mutations that enumerate, rename, or delete project directories. */
export async function withUserProjectRegistryLock<T>(
  action: (projectsRoot: string) => Promise<T>
): Promise<T> {
  const projectsRoot = userProjectStatesRoot();
  await ensurePrivateDirectory(ctrlyokeStateHome());
  await ensurePrivateDirectory(projectsRoot);

  return withFileLock(
    path.join(projectsRoot, REGISTRY_LOCK_NAME),
    async () => {
      await assertContainedByRealRoot(projectsRoot, projectsRoot);
      return action(projectsRoot);
    },
    REGISTRY_LOCK_OPTIONS
  );
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

/** Whether a recorded `statePath` names the given canonical state root. */
export function statePathBelongsTo(
  statePath: string,
  canonicalRoot: string
): boolean {
  return pathsEqual(canonicalStatePath(statePath), canonicalRoot);
}

/** Whether a project directory holds nothing but its `project.json`. */
export async function isEmptyProjectScaffold(
  projectRoot: string
): Promise<boolean> {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  return entries.every((entry) => entry.name === PROJECT_METADATA_FILE_NAME);
}

export interface ProjectHistoryCandidate {
  projectRoot: string;
  metadata: ProjectStateMetadata;
  /** Start time of the newest run, or `undefined` when there are no runs. */
  latestRunAt?: number;
  /** False for a directory holding only `project.json`. */
  hasContent: boolean;
}

export interface ProjectHistoryLookup {
  /** The canonical state root the lookup was made for. */
  canonicalRoot: string;
  /** The directory the canonical project key names. */
  canonicalProjectRoot: string;
  /** The canonical directory, when it exists with metadata for this root. */
  canonical?: ProjectHistoryCandidate;
  /**
   * Directories left under a key that older releases derived from a
   * symlinked spelling of the same root.
   */
  splits: ProjectHistoryCandidate[];
  /**
   * The candidate to keep: the one whose newest run is most recent, the
   * canonical directory on a tie, and an existing directory over a bare
   * scaffold. `undefined` when no candidate exists.
   */
  keep?: ProjectHistoryCandidate;
}

/**
 * Find every directory holding history for one state root: the canonical key
 * and any key older releases derived from a symlinked spelling. Split directories are
 * found by the spelling passed in and by scanning keys that share a slug with
 * either spelling. On the first lookup it scans all project keys and matches
 * them on `statePath`. Call it under {@link withUserProjectRegistryLock}.
 */
export async function findProjectHistory(
  projectsRoot: string,
  stateRoot: string
): Promise<ProjectHistoryLookup> {
  const canonicalRoot = canonicalStatePath(stateRoot);
  const canonicalKey = projectKey(canonicalRoot);
  const canonicalProjectRoot = path.join(projectsRoot, canonicalKey);

  const slugs = new Set([
    projectKeySlug(stateRoot),
    projectKeySlug(canonicalRoot),
  ]);
  const splitKeys = new Set<string>([legacyProjectKey(stateRoot)]);
  for (const entry of await fs.readdir(projectsRoot, { withFileTypes: true })) {
    const match = PROJECT_KEY_PATTERN.exec(entry.name);
    if (match && slugs.has(match[1])) {
      splitKeys.add(entry.name);
    }
  }
  splitKeys.delete(canonicalKey);

  const canonicalMetadata =
    await readProjectStateMetadata(canonicalProjectRoot);
  if (!canonicalMetadata?.legacyProjectScanComplete) {
    for (const entry of await fs.readdir(projectsRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !PROJECT_KEY_PATTERN.test(entry.name))
        continue;
      splitKeys.add(entry.name);
    }
  }

  const canonical = await readHistoryCandidate(
    projectsRoot,
    canonicalProjectRoot,
    canonicalRoot
  );
  const splits: ProjectHistoryCandidate[] = [];
  for (const key of splitKeys) {
    const candidate = await readHistoryCandidate(
      projectsRoot,
      path.join(projectsRoot, key),
      canonicalRoot
    );
    if (candidate) {
      splits.push(candidate);
    }
  }
  splits.sort(
    (a, b) =>
      compareRecency(b, a) ||
      b.metadata.lastOpenedAt.localeCompare(a.metadata.lastOpenedAt)
  );

  let keep = canonical;
  for (const split of splits) {
    if (!keep || compareRecency(split, keep) > 0) {
      keep = split;
    }
  }

  return {
    canonicalRoot,
    canonicalProjectRoot,
    ...(canonical ? { canonical } : {}),
    splits,
    ...(keep ? { keep } : {}),
  };
}

/** Positive when `a` should be kept over `b`. */
function compareRecency(
  a: ProjectHistoryCandidate,
  b: ProjectHistoryCandidate
): number {
  if (a.hasContent !== b.hasContent) {
    return a.hasContent ? 1 : -1;
  }
  if (a.latestRunAt === undefined && b.latestRunAt === undefined) return 0;
  if (a.latestRunAt === undefined) return -1;
  if (b.latestRunAt === undefined) return 1;
  return a.latestRunAt - b.latestRunAt;
}

async function readHistoryCandidate(
  projectsRoot: string,
  projectRoot: string,
  canonicalRoot: string
): Promise<ProjectHistoryCandidate | undefined> {
  try {
    await assertContainedByRealRoot(projectsRoot, projectRoot);
    const stats = await lstatIfExists(projectRoot);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      return undefined;
    }
    const metadata = await readProjectStateMetadata(projectRoot);
    if (!metadata || !statePathBelongsTo(metadata.statePath, canonicalRoot)) {
      return undefined;
    }
    const latestRunAt = await latestProjectRunTimestamp(projectRoot);
    return {
      projectRoot,
      metadata,
      ...(latestRunAt !== undefined ? { latestRunAt } : {}),
      hasContent: !(await isEmptyProjectScaffold(projectRoot)),
    };
  } catch {
    // An unreadable or newer-version directory is not adopted or replaced.
    return undefined;
  }
}

/** Canonical roots whose leftover split directories were already reported. */
const reportedSplitRoots = new Set<string>();

/**
 * Move history filed under a symlinked spelling's key to
 * the canonical key, so every spelling of the project sees it. When both keys
 * hold history, the one with the most recent run is kept at the canonical key
 * and the other stays under the old key, untouched. Best effort: a live runner
 * in either directory, or any filesystem failure, leaves everything in place
 * to be retried on the next startup.
 */
async function adoptSplitProjectHistory(
  projectsRoot: string,
  stateRoot: string
): Promise<void> {
  try {
    const lookup = await findProjectHistory(projectsRoot, stateRoot);
    const { keep, canonical, canonicalProjectRoot, canonicalRoot } = lookup;
    if (
      lookup.splits.length &&
      lookup.canonical?.latestRunAt === undefined &&
      lookup.splits.every((split) => split.latestRunAt === undefined)
    ) {
      const anchorMergeProjects = [
        canonicalProjectRoot,
        ...lookup.splits.map((split) => split.projectRoot),
      ];
      const runners = await Promise.all(
        anchorMergeProjects.map((projectRoot) =>
          inspectProjectRunner(projectRoot).catch(() => ({
            status: PROJECT_RUNNER_STATUSES.UNKNOWN,
          }))
        )
      );
      if (
        runners.every(
          (runner) => runner.status === PROJECT_RUNNER_STATUSES.NONE
        )
      ) {
        await mergeDefinitionAnchors(
          projectsRoot,
          canonicalProjectRoot,
          lookup.splits
        );
      }
    }
    if (!keep || keep === canonical) {
      if (
        canonical?.hasContent &&
        lookup.splits.some((split) => split.hasContent) &&
        canonical.latestRunAt !== undefined &&
        !reportedSplitRoots.has(canonicalRoot)
      ) {
        reportedSplitRoots.add(canonicalRoot);
        console.warn(
          `[ProjectStateRegistry] Older history for "${canonicalRoot}" stays under ${lookup.splits
            .filter((split) => split.hasContent)
            .map((split) => split.projectRoot)
            .join(", ")}; ${canonicalProjectRoot} has the more recent run.`
        );
      }
      await markLegacyProjectScanComplete(
        projectsRoot,
        canonicalProjectRoot,
        canonical
      );
      return;
    }

    if (!canonical && (await lstatIfExists(canonicalProjectRoot))) {
      // Not this project's directory (or unreadable): never displace it.
      return;
    }

    for (const projectRoot of [keep.projectRoot, canonicalProjectRoot]) {
      const runner = await inspectProjectRunner(projectRoot).catch(() => ({
        status: PROJECT_RUNNER_STATUSES.UNKNOWN,
      }));
      if (runner.status !== PROJECT_RUNNER_STATUSES.NONE) {
        console.warn(
          `[ProjectStateRegistry] Not moving history for "${canonicalRoot}" from ${keep.projectRoot}: runner state in ${projectRoot} is ${runner.status}.`
        );
        return;
      }
    }

    await moveProjectHistory(projectsRoot, keep, canonicalProjectRoot);
    await writeProjectStateMetadata(projectsRoot, canonicalProjectRoot, {
      ...keep.metadata,
      statePath: canonicalRoot,
      legacyProjectScanComplete: true,
    });
    console.warn(
      `[ProjectStateRegistry] Moved history for "${canonicalRoot}" from ${keep.projectRoot} to ${canonicalProjectRoot}.`
    );
  } catch (error) {
    console.warn(
      `[ProjectStateRegistry] Could not move split history for "${stateRoot}": ${getErrorMessage(error)}`
    );
  }
}

async function markLegacyProjectScanComplete(
  projectsRoot: string,
  projectRoot: string,
  candidate: ProjectHistoryCandidate | undefined
): Promise<void> {
  if (!candidate) return;
  await writeProjectStateMetadata(projectsRoot, projectRoot, {
    ...candidate.metadata,
    legacyProjectScanComplete: true,
  });
}

/**
 * Put `keep` at `destination`. A bare scaffold there is replaced; a directory
 * with content swaps places with `keep`, so it survives under keep's old key.
 */
async function moveProjectHistory(
  projectsRoot: string,
  keep: ProjectHistoryCandidate,
  destination: string
): Promise<void> {
  for (const projectRoot of [keep.projectRoot, destination]) {
    await assertContainedByRealRoot(projectsRoot, projectRoot);
    await rejectSymlinkProjectDirectory(projectRoot);
  }

  const destinationStats = await lstatIfExists(destination);
  if (!destinationStats) {
    await renameWithTransientRetry(keep.projectRoot, destination);
    return;
  }
  if (!destinationStats.isDirectory()) {
    throw new Error(`Project state path is not a directory: ${destination}`);
  }

  const parked = `${destination}.adopt-${process.pid}-${Date.now()}`;
  await assertContainedByRealRoot(projectsRoot, parked);
  const replaceScaffold = await isEmptyProjectScaffold(destination);
  await renameWithTransientRetry(destination, parked);
  try {
    await renameWithTransientRetry(keep.projectRoot, destination);
  } catch (error) {
    await renameWithTransientRetry(parked, destination).catch(() => undefined);
    throw error;
  }
  if (replaceScaffold) {
    await fs.rm(parked, { recursive: true, force: true });
  } else {
    await renameWithTransientRetry(parked, keep.projectRoot);
  }
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
  return relative !== "" && !relativePathEscapes(relative);
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
    if (!hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
      throw error;
    }

    const entries = await fs.readdir(projectRoot);
    if (entries.length > 0) {
      throw new Error(
        `Project state directory is non-empty but has no project metadata: ${projectRoot}`
      );
    }
  }

  if (existing && !statePathBelongsTo(existing.statePath, stateRoot)) {
    throw new Error(
      `Project state collision: ${projectRoot} belongs to "${existing.statePath}", not "${stateRoot}".`
    );
  }

  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROJECT_METADATA],
    // Always the canonical spelling: an older record may hold the
    // symlinked spelling the project was first opened under.
    statePath: stateRoot,
    ...(gitToplevel !== undefined
      ? { gitToplevel: path.resolve(gitToplevel) }
      : existing?.gitToplevel !== undefined
        ? { gitToplevel: existing.gitToplevel }
        : {}),
    createdAt: existing?.createdAt ?? now,
    lastOpenedAt: now,
    ...(existing?.legacyProjectScanComplete
      ? { legacyProjectScanComplete: true }
      : {}),
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
    (value.gitToplevel !== undefined &&
      typeof value.gitToplevel !== "string") ||
    (value.legacyProjectScanComplete !== undefined &&
      typeof value.legacyProjectScanComplete !== "boolean")
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
    ...(value.legacyProjectScanComplete === true
      ? { legacyProjectScanComplete: true }
      : {}),
  };
}

async function mergeDefinitionAnchors(
  projectsRoot: string,
  canonicalProjectRoot: string,
  splits: ProjectHistoryCandidate[]
): Promise<void> {
  await fs.mkdir(canonicalProjectRoot, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const sourceRoots = splits.map((split) =>
    path.join(split.projectRoot, ".definition-anchors")
  );
  const destinationRoot = path.join(
    canonicalProjectRoot,
    ".definition-anchors"
  );
  for (const sourceRoot of sourceRoots) {
    await copyNewerAnchorFiles(projectsRoot, sourceRoot, destinationRoot);
  }
}

async function copyNewerAnchorFiles(
  projectsRoot: string,
  source: string,
  destination: string
): Promise<void> {
  const sourceStats = await lstatIfExists(source);
  if (!sourceStats) return;
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) return;
  await assertContainedByRealRoot(projectsRoot, source);
  const destinationStats = await lstatIfExists(destination);
  if (
    destinationStats?.isSymbolicLink() ||
    (destinationStats && !destinationStats.isDirectory())
  ) {
    throw new Error(
      `Definition anchor directory is not a real directory: ${destination}`
    );
  }
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await fs.mkdir(destinationPath, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      await copyNewerAnchorFiles(projectsRoot, sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const incoming = await fs.readFile(sourcePath, "utf8");
    let shouldCopy = false;
    try {
      const existing = JSON.parse(
        await fs.readFile(destinationPath, "utf8")
      ) as { recordedAt?: number };
      const next = JSON.parse(incoming) as { recordedAt?: number };
      shouldCopy =
        typeof next.recordedAt === "number" &&
        (typeof existing.recordedAt !== "number" ||
          next.recordedAt > existing.recordedAt);
    } catch (error) {
      shouldCopy = hasErrnoCode(error, NODE_ERROR_CODES.ENOENT);
    }
    if (shouldCopy) {
      await fs.mkdir(path.dirname(destinationPath), {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      await fs.writeFile(destinationPath, incoming, {
        mode: PRIVATE_FILE_MODE,
      });
    }
  }
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
  if (relativePathEscapes(relative)) {
    throw new Error(
      `Project state path escapes the projects root: ${resolvedCandidate}`
    );
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return (await lstatIfExists(filePath)) !== undefined;
}
