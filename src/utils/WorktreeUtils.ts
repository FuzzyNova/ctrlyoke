import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { WorkspaceRepo } from "../types/HostedWorkspaceViewerTypes";
import {
  gitCommonDir,
  listWorktrees,
  repoToplevel,
  type GitWorktreeEntry,
  validateBranchName,
} from "./GitUtils";
import { withFileLock } from "./FileLockUtils";
import { discoverRepos } from "./WorkspaceRepoDiscovery";
import { isPathWithinDirectory } from "./PathSecurity";
import { ConfigurationUtils } from "./ConfigurationUtils";
import { WORKTREE_MODES } from "../types/DashboardConstants";

export interface WorkspaceEligibility {
  eligible: boolean;
  repositories: WorkspaceRepo[];
  repository?: WorkspaceRepo;
  reason?: string;
}

/** Resolve symlinks in the existing part of a path while retaining its tail. */
export async function resolveThroughNearestExistingAncestor(
  candidate: string
): Promise<string> {
  let current = path.resolve(candidate);
  const missing: string[] = [];

  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.normalize(path.join(existing, ...missing.reverse()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function slugifyWorktreeName(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase();
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "workflow").slice(0, 40).replace(/-+$/g, "") || "workflow";
}

export type WorktreeNameIdentity =
  | { kind: typeof WORKTREE_MODES.MANAGED; workflowKey: string; runRef: string }
  | { kind: typeof WORKTREE_MODES.NAMED; branchRef: string };

/**
 * Generate the only physical-name format used by worktree support. The hash
 * includes the canonical shared Git directory and the exact logical identity,
 * so a readable slug can never authorize reuse of another checkout.
 */
export function createWorktreeDirectoryName(
  readableName: string,
  canonicalCommonDirectory: string,
  identity: WorktreeNameIdentity
): string {
  const logicalIdentity =
    identity.kind === WORKTREE_MODES.MANAGED
      ? `${identity.workflowKey}/${identity.runRef}`
      : identity.branchRef;
  const hash = crypto
    .createHash("sha256")
    .update(`${canonicalCommonDirectory}\0${logicalIdentity}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${slugifyWorktreeName(readableName)}-${hash}`;
}

export const buildWorktreeDirectoryName = createWorktreeDirectoryName;

export function createRepositoryIdentity(
  repositoryName: string,
  canonicalCommonDirectory: string
): string {
  const hash = crypto
    .createHash("sha256")
    .update(canonicalCommonDirectory, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${slugifyWorktreeName(repositoryName)}-${hash}`;
}

export function createManagedBranchName(
  workflowName: string,
  runRef: string
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runRef)) {
    throw new Error(`Invalid branch name: ${runRef}`);
  }
  return `ctrlyoke/${slugifyWorktreeName(workflowName)}/${runRef}`;
}

export async function validateWorktreeBranchName(
  branchName: string
): Promise<void> {
  await validateBranchName(branchName);
}

export interface WorktreeRootResolutionOptions {
  sourceCheckoutRoot: string;
  /** Explicit user-scope root. It must be absolute or begin with `~`. */
  explicitRoot?: string;
  repositoryName?: string;
  commonDirectory?: string;
  homeDirectory?: string;
  /** Test seam for verifying the root-creation fallback policy. */
  createDirectory?: (root: string) => Promise<void>;
  discoveredWorktrees?: readonly GitWorktreeEntry[];
}

export interface WorktreeRootResolution {
  root: string;
  tier: "explicit" | "sibling" | "fallback";
}

export function expandExplicitRoot(
  value: string,
  homeDirectory: string
): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homeDirectory;
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
    return path.join(homeDirectory, trimmed.slice(2));
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      "The configured worktree root must be an absolute path or begin with ~."
    );
  }
  return path.resolve(trimmed);
}

function isFilesystemFailure(error: unknown): boolean {
  return new Set([
    "EACCES",
    "EBUSY",
    "EEXIST",
    "EIO",
    "ELOOP",
    "ENAMETOOLONG",
    "ENOSPC",
    "ENOTDIR",
    "EPERM",
    "EROFS",
  ]).has((error as NodeJS.ErrnoException).code ?? "");
}

async function createRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

/**
 * Resolve and create a worktree root. Explicit configuration is never allowed
 * to silently fall through; only a real sibling-root filesystem failure uses
 * the central fallback location.
 */
export async function resolveWorktreeRoot(
  options: WorktreeRootResolutionOptions
): Promise<WorktreeRootResolution> {
  const source = await resolveThroughNearestExistingAncestor(
    options.sourceCheckoutRoot
  );
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const createDirectory = options.createDirectory ?? createRoot;
  const explicit = options.explicitRoot?.trim();

  if (explicit) {
    const root = expandExplicitRoot(explicit, home);
    try {
      await createDirectory(root);
    } catch (error) {
      throw new Error(
        `Configured worktree root is invalid or unavailable: ${root}`,
        { cause: error }
      );
    }
    await assertWorktreePlacement({
      sourceCheckoutRoot: source,
      worktreeRoot: root,
      discoveredWorktrees: options.discoveredWorktrees,
    });
    return { root: path.resolve(root), tier: "explicit" };
  }

  const repositoryName =
    options.repositoryName || path.basename(source) || "repository";
  const sibling = path.join(
    path.dirname(source),
    `${path.basename(source)}.worktrees`
  );
  try {
    await createDirectory(sibling);
    await assertWorktreePlacement({
      sourceCheckoutRoot: source,
      worktreeRoot: sibling,
      discoveredWorktrees: options.discoveredWorktrees,
    });
    return { root: path.resolve(sibling), tier: "sibling" };
  } catch (error) {
    if (!isFilesystemFailure(error)) throw error;
  }

  const common =
    options.commonDirectory ?? (await gitCommonDir(options.sourceCheckoutRoot));
  if (!common) {
    throw new Error("Cannot resolve the repository Git common directory.");
  }
  const identity = createRepositoryIdentity(repositoryName, common);
  const fallback = path.join(home, ".ctrlyoke", "worktrees", identity);
  await createDirectory(fallback);
  await assertWorktreePlacement({
    sourceCheckoutRoot: source,
    worktreeRoot: fallback,
    discoveredWorktrees: options.discoveredWorktrees,
  });
  return { root: path.resolve(fallback), tier: "fallback" };
}

/** Resolve a worktree root using the user-scope settings value. */
export async function resolveConfiguredWorktreeRoot(
  sourceCheckoutRoot: string,
  options: Omit<
    WorktreeRootResolutionOptions,
    "sourceCheckoutRoot" | "explicitRoot"
  > = {}
): Promise<WorktreeRootResolution> {
  return resolveWorktreeRoot({
    ...options,
    sourceCheckoutRoot,
    explicitRoot: ConfigurationUtils.getWorktreeRoot(),
  });
}

export interface WorktreePlacementPreview {
  /** Directory the run is expected to execute in, when it can be determined
   *  without creating anything. Absent when nothing can be inferred without
   *  a real run identity (managed mode) or a resolvable Git repository. */
  directory?: string;
  /** True only when `directory` was confirmed against an existing Git
   *  worktree entry; false for a computed-but-unconfirmed best guess. */
  isExact: boolean;
  /** Explains why `directory` is absent, or why it is only a best guess. */
  notice?: string;
}

/**
 * Best-effort, read-only preview of where a worktree run would execute.
 * Never creates a directory, branch, or Git worktree state — safe to call
 * from dry-run/preview. Named-branch placement is exact once Git already has
 * a matching worktree entry, and otherwise a deterministic best guess (the
 * same hash inputs `WorktreeManager.resolveNamedWorktree` would use).
 * Managed placement can't be previewed exactly because its branch name is
 * derived from a `RunRef` that a dry run never allocates.
 */
export async function previewWorktreePlacement(
  options:
    | {
        sourceCheckoutRoot: string;
        mode: typeof WORKTREE_MODES.MANAGED;
      }
    | {
        sourceCheckoutRoot: string;
        mode: typeof WORKTREE_MODES.NAMED;
        branch: string;
      }
): Promise<WorktreePlacementPreview> {
  const repositoryRoot = await repoToplevel(options.sourceCheckoutRoot);
  if (!repositoryRoot) {
    return {
      isExact: false,
      notice:
        "Cannot resolve a Git repository to preview the worktree location.",
    };
  }

  if (options.mode === WORKTREE_MODES.NAMED) {
    const entries = await listWorktrees(repositoryRoot).catch(
      () => [] as GitWorktreeEntry[]
    );
    const existing = entries.find(
      (entry) => entry.branchName === options.branch
    );
    if (existing) {
      return { directory: existing.worktreePath, isExact: true };
    }
  }

  if (options.mode === WORKTREE_MODES.MANAGED) {
    return {
      isExact: false,
      notice:
        "The managed worktree path includes a run ID assigned when this workflow runs.",
    };
  }

  const commonDirectory = await gitCommonDir(repositoryRoot);
  if (!commonDirectory) {
    return {
      isExact: false,
      notice:
        "Cannot resolve the repository's Git common directory to preview the worktree location.",
    };
  }

  const explicitRoot = ConfigurationUtils.getWorktreeRoot()?.trim();
  const root = explicitRoot
    ? expandExplicitRoot(explicitRoot, os.homedir())
    : path.join(
        path.dirname(repositoryRoot),
        `${path.basename(repositoryRoot)}.worktrees`
      );
  const directoryName = createWorktreeDirectoryName(
    options.branch,
    commonDirectory,
    { kind: "named", branchRef: options.branch }
  );
  return {
    directory: path.join(root, directoryName),
    isExact: false,
    notice: explicitRoot
      ? undefined
      : "Assumes the default worktree location; the actual run may use a fallback location if this one can't be created.",
  };
}

export interface WorktreePlacementOptions {
  sourceCheckoutRoot: string;
  worktreeRoot: string;
  worktreePath?: string;
  discoveredWorktrees?: readonly GitWorktreeEntry[];
}

/** Apply all worktree placement guards after symlink-aware resolution. */
export async function assertWorktreePlacement(
  options: WorktreePlacementOptions
): Promise<void> {
  const source = await resolveThroughNearestExistingAncestor(
    options.sourceCheckoutRoot
  );
  const root = await resolveThroughNearestExistingAncestor(
    options.worktreeRoot
  );

  if (isPathWithinDirectory(root, source)) {
    throw new Error(
      `Worktree root cannot be inside the source checkout: ${root}`
    );
  }

  const discovered = options.discoveredWorktrees ?? [];
  for (const worktree of discovered) {
    const existing = await resolveThroughNearestExistingAncestor(
      worktree.worktreePath
    );
    if (isPathWithinDirectory(root, existing)) {
      throw new Error(
        `Worktree root cannot be inside an existing worktree: ${existing}`
      );
    }
  }

  if (options.worktreePath) {
    const worktreePath = await resolveThroughNearestExistingAncestor(
      options.worktreePath
    );
    if (!isPathWithinDirectory(worktreePath, root)) {
      throw new Error(
        `Worktree path must remain inside its resolved root: ${worktreePath}`
      );
    }
  }
}

/** Evaluate the structural first-release workspace eligibility rule. */
export async function evaluateWorkspaceEligibility(
  namedRoots: readonly ResolverWorkspaceFolder[],
  _stateRoot?: string
): Promise<WorkspaceEligibility> {
  const repositories = await discoverRepos(namedRoots);
  if (repositories.length === 0) {
    return {
      eligible: false,
      repositories,
      reason: "Worktree mode requires a Git repository in the workspace.",
    };
  }
  if (repositories.length > 1) {
    return {
      eligible: false,
      repositories,
      reason: "Worktree mode requires exactly one Git repository.",
    };
  }

  const repository = repositories[0];
  const outsideRoot = namedRoots.find(
    (root) =>
      !isPathWithinDirectory(
        path.resolve(root.fsPath),
        path.resolve(repository.rootPath)
      )
  );
  if (outsideRoot) {
    return {
      eligible: false,
      repositories,
      repository,
      reason: `Workspace root is outside the sole Git repository: ${outsideRoot.fsPath}`,
    };
  }
  return { eligible: true, repositories, repository };
}

export async function assertWorkspaceEligibility(
  namedRoots: readonly ResolverWorkspaceFolder[],
  stateRoot?: string
): Promise<WorkspaceEligibility> {
  const result = await evaluateWorkspaceEligibility(namedRoots, stateRoot);
  if (!result.eligible) throw new Error(result.reason);
  return result;
}

/** Run one short Git-admin mutation under the repository's common-directory lock. */
export async function withWorktreeMutationLock<T>(
  commonDirectory: string,
  action: () => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T> {
  const resolvedCommonDirectory =
    await resolveThroughNearestExistingAncestor(commonDirectory);
  return withFileLock(
    path.join(resolvedCommonDirectory, "ctrlyoke-worktree-mutation"),
    action,
    options
  );
}

/** Convenience form for callers that have a checkout rather than its common dir. */
export async function withRepositoryWorktreeMutationLock<T>(
  repositoryRoot: string,
  action: () => Promise<T>
): Promise<T> {
  const common = await gitCommonDir(repositoryRoot);
  if (!common)
    throw new Error("Cannot resolve the repository Git common directory.");
  return withWorktreeMutationLock(common, action);
}

export const withGitWorktreeMutationLock = withRepositoryWorktreeMutationLock;
