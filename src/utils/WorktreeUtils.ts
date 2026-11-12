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
  currentBranch,
  hasGitOperationInProgress,
  hasUncommittedChanges,
  type GitWorktreeEntry,
  validateBranchName,
} from "./GitUtils";
import { withFileLock } from "./FileLockUtils";
import { discoverRepos } from "./WorkspaceRepoDiscovery";
import { isPathWithinDirectory } from "./PathSecurity";
import { pathsEqual } from "./PathCasing";
import { ConfigurationUtils } from "./ConfigurationUtils";
import {
  WORKTREE_IDENTITY_KINDS,
  WORKTREE_MODES,
  NODE_ERROR_CODES,
} from "../types/DashboardConstants";
import { hasErrnoCode, getErrnoCode } from "./ErrorUtils";

export interface WorkspaceEligibility {
  eligible: boolean;
  repositories: WorkspaceRepo[];
  repository?: WorkspaceRepo;
  reason?: string;
}

/**
 * Resolve symlinks in the existing part of a path while retaining its tail.
 * When nothing exists, not even the filesystem root (an unmounted drive such
 * as a cloud drive that has not mounted yet), there is no link to resolve, so
 * the lexical path is returned rather than failing on `realpath('Z:\')`.
 */
export async function resolveThroughNearestExistingAncestor(
  candidate: string
): Promise<string> {
  const absolute = path.resolve(candidate);
  let current = absolute;
  const missing: string[] = [];

  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.normalize(path.join(existing, ...missing.reverse()));
    } catch (error) {
      if (!hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.normalize(absolute);
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
  | {
      kind: typeof WORKTREE_IDENTITY_KINDS.MANAGED;
      workflowKey: string;
      runRef: string;
    }
  | { kind: typeof WORKTREE_IDENTITY_KINDS.NAMED; branchRef: string }
  | { kind: typeof WORKTREE_IDENTITY_KINDS.CHECKOUT; name: string };

export type CheckoutSlotResolution =
  | { kind: "existing"; entry: GitWorktreeEntry }
  | { kind: "planned"; path: string };

function expandCheckoutPath(value: string): string {
  const home = os.homedir();
  if (value === "~") return path.resolve(home);
  if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) {
    return path.resolve(home, value.slice(2));
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      "Checkout must be an absolute path, a ~-prefixed path, or a bare name."
    );
  }
  return path.resolve(value);
}

/** Read-only resolution of an authored checkout path or named slot. */
export async function resolveCheckoutSlot(
  sourceCheckoutRoot: string,
  checkout: string,
  entries: readonly GitWorktreeEntry[],
  commonDirectory: string,
  root: string
): Promise<CheckoutSlotResolution> {
  const value = checkout.trim();
  if (!value) throw new Error("Checkout must not be empty.");
  const pathForm =
    path.isAbsolute(value) ||
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith(`~${path.sep}`) ||
    value.includes("/") ||
    value.includes("\\");
  if (pathForm) {
    const target = expandCheckoutPath(value);
    if (pathsEqual(target, sourceCheckoutRoot))
      throw new Error("The source checkout cannot be used as a checkout slot.");
    const entry = entries.find((candidate) =>
      pathsEqual(candidate.worktreePath, target)
    );
    if (entry?.prunable || entry?.prunableReason !== undefined)
      throw new Error(
        `Checkout "${target}" is prunable. Use Repair or Prune in Settings → Worktrees.`
      );
    if (entry) return { kind: "existing", entry };
    try {
      await fs.access(target);
      throw new Error(
        `Checkout path already exists but is not a registered worktree: ${target}`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { kind: "planned", path: target };
  }
  const identities = [
    value,
    createWorktreeDirectoryName(value, commonDirectory, {
      kind: WORKTREE_IDENTITY_KINDS.CHECKOUT,
      name: value,
    }),
    createWorktreeDirectoryName(value, commonDirectory, {
      kind: WORKTREE_IDENTITY_KINDS.NAMED,
      branchRef: value,
    }),
  ];
  const matches = entries.filter(
    (entry) =>
      !entry.bare &&
      !pathsEqual(entry.worktreePath, sourceCheckoutRoot) &&
      identities.includes(path.basename(entry.worktreePath))
  );
  if (matches.length > 1) {
    throw new Error(
      `Checkout "${value}" matches multiple registered worktrees: ${matches.map((entry) => entry.worktreePath).join(", ")}. Specify a path instead.`
    );
  }
  if (matches.length === 1) {
    if (matches[0].prunable || matches[0].prunableReason !== undefined)
      throw new Error(
        `Checkout "${matches[0].worktreePath}" is prunable. Use Repair or Prune in Settings → Worktrees.`
      );
    return { kind: "existing", entry: matches[0] };
  }
  return {
    kind: "planned",
    path: path.join(
      root,
      createWorktreeDirectoryName(value, commonDirectory, {
        kind: WORKTREE_IDENTITY_KINDS.CHECKOUT,
        name: value,
      })
    ),
  };
}

export const checkoutSwitchBlockers = {
  operation: (checkout: string, operation: string) =>
    `Checkout "${checkout}" has a Git ${operation} in progress. Finish or abort it, then run again.`,
  dirty: (checkout: string, branch: string) =>
    `Checkout "${checkout}" has uncommitted changes on branch "${branch}". Commit or stash them, then run again.`,
  branchElsewhere: (branch: string, checkout: string, path: string) =>
    `Branch "${branch}" is checked out in "${path}", not in checkout "${checkout}".`,
  pathCollision: (worktreePath: string, otherBranch: string, branch: string) =>
    `"${worktreePath}" now holds branch "${otherBranch}". Add checkout: ${path.basename(worktreePath)} to run "${branch}" in it.`,
};

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
    identity.kind === WORKTREE_IDENTITY_KINDS.MANAGED
      ? `${identity.workflowKey}/${identity.runRef}`
      : identity.kind === WORKTREE_IDENTITY_KINDS.CHECKOUT
        ? `checkout:${identity.name}`
        : identity.branchRef;
  const hash = crypto
    .createHash("sha256")
    .update(`${canonicalCommonDirectory}\0${logicalIdentity}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${slugifyWorktreeName(readableName)}-${hash}`;
}

function createRepositoryIdentity(
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
  return new Set<string>([
    NODE_ERROR_CODES.EACCES,
    NODE_ERROR_CODES.EBUSY,
    NODE_ERROR_CODES.EEXIST,
    NODE_ERROR_CODES.EIO,
    NODE_ERROR_CODES.ELOOP,
    NODE_ERROR_CODES.ENAMETOOLONG,
    NODE_ERROR_CODES.ENOSPC,
    NODE_ERROR_CODES.ENOTDIR,
    NODE_ERROR_CODES.EPERM,
    NODE_ERROR_CODES.EROFS,
  ]).has(getErrnoCode(error) ?? "");
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
  checkout?: string;
  checkoutCurrentBranch?: string;
  switchBlocker?: string;
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
        checkout?: string;
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
    if (existing && !options.checkout) {
      return { directory: existing.worktreePath, isExact: true };
    }
    if (options.checkout) {
      const common = await gitCommonDir(repositoryRoot);
      if (!common)
        return {
          isExact: false,
          notice:
            "Cannot resolve the repository's Git common directory to preview the checkout slot.",
        };
      const explicitRoot = ConfigurationUtils.getWorktreeRoot()?.trim();
      const root = explicitRoot
        ? expandExplicitRoot(explicitRoot, os.homedir())
        : path.join(
            path.dirname(repositoryRoot),
            `${path.basename(repositoryRoot)}.worktrees`
          );
      try {
        const slot = await resolveCheckoutSlot(
          repositoryRoot,
          options.checkout,
          entries,
          common,
          root
        );
        if (slot.kind === "planned") {
          const elsewhere = entries.find(
            (entry) => entry.branchName === options.branch
          );
          return {
            directory: slot.path,
            isExact: false,
            checkout: options.checkout,
            switchBlocker: elsewhere
              ? checkoutSwitchBlockers.branchElsewhere(
                  options.branch,
                  options.checkout,
                  elsewhere.worktreePath
                )
              : undefined,
          };
        }
        const slotBranch = await currentBranch(slot.entry.worktreePath);
        const elsewhere = entries.find(
          (entry) => entry.branchName === options.branch
        );
        let switchBlocker: string | undefined;
        if (
          elsewhere &&
          !pathsEqual(elsewhere.worktreePath, slot.entry.worktreePath)
        ) {
          switchBlocker = checkoutSwitchBlockers.branchElsewhere(
            options.branch,
            options.checkout,
            elsewhere.worktreePath
          );
        } else if (slotBranch !== options.branch) {
          if (await hasGitOperationInProgress(slot.entry.worktreePath))
            switchBlocker = checkoutSwitchBlockers.operation(
              options.checkout,
              "operation"
            );
          else if (await hasUncommittedChanges(slot.entry.worktreePath))
            switchBlocker = checkoutSwitchBlockers.dirty(
              options.checkout,
              slotBranch ?? "detached HEAD"
            );
        }
        return {
          directory: slot.entry.worktreePath,
          isExact: true,
          checkout: options.checkout,
          checkoutCurrentBranch: slotBranch ?? undefined,
          switchBlocker,
        };
      } catch (error) {
        return {
          isExact: false,
          notice: error instanceof Error ? error.message : String(error),
          checkout: options.checkout,
        };
      }
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
    { kind: WORKTREE_IDENTITY_KINDS.NAMED, branchRef: options.branch }
  );
  const directory = path.join(root, directoryName);
  const collision = await listWorktrees(repositoryRoot)
    .then((entries) =>
      entries.find(
        (entry) =>
          pathsEqual(entry.worktreePath, directory) &&
          entry.branchName !== options.branch
      )
    )
    .catch(() => undefined);
  return {
    directory,
    isExact: false,
    switchBlocker: collision
      ? checkoutSwitchBlockers.pathCollision(
          directory,
          collision.branchName ?? "detached HEAD",
          options.branch
        )
      : undefined,
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
