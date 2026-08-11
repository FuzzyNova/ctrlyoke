import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { WorkspaceRepo } from "../types/HostedWorkspaceViewerTypes";
import {
  gitCommonDir,
  type GitWorktreeEntry,
  validateBranchName,
} from "./GitUtils";
import { withFileLock } from "./FileLockUtils";
import { discoverRepos } from "./WorkspaceRepoDiscovery";
import { isPathWithinDirectory } from "./PathSecurity";
import { ConfigurationUtils } from "./ConfigurationUtils";

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
  | { kind: "managed"; workflowKey: string; runRef: string }
  | { kind: "named"; branchRef: string };

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
    identity.kind === "managed"
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

function expandExplicitRoot(value: string, homeDirectory: string): string {
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
  options: Omit<WorktreeRootResolutionOptions, "sourceCheckoutRoot" | "explicitRoot"> = {}
): Promise<WorktreeRootResolution> {
  return resolveWorktreeRoot({
    ...options,
    sourceCheckoutRoot,
    explicitRoot: ConfigurationUtils.getWorktreeRoot(),
  });
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
  action: () => Promise<T>
): Promise<T> {
  const resolvedCommonDirectory =
    await resolveThroughNearestExistingAncestor(commonDirectory);
  return withFileLock(
    path.join(resolvedCommonDirectory, "ctrlyoke-worktree-mutation"),
    action
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
