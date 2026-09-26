import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  absoluteGitDir,
  liveGitLocations,
  type GitLocationLookup,
} from "../../utils/GitUtils";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import { foldPathForCompare } from "../../utils/PathCasing";

/** The canonical identity used by all execution-root-scoped storage. */
export interface ExecutionRootScope {
  /** Canonical, case-folded identity of the execution root or its worktree Git directory. */
  identity: string;
  /** SHA-256 of {@link identity}, used for Git-backed storage directories. */
  scopeHash: string;
  /** Canonical execution root, retained for the non-Git fallback path. */
  executionRoot: string;
  /** Canonical Git common directory when the execution root is Git-backed. */
  gitCommonDir?: string;
}

export interface ScopeRecord {
  scopeIdentity: string;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return path.normalize(await fs.realpath(resolved));
  } catch {
    return path.normalize(resolved);
  }
}

/**
 * Resolve the one canonical identity shared by execution leases and coordination
 * storage. A linked worktree is identified by its worktree-specific Git
 * directory, while the storage for that identity lives in Git's common dir.
 * The worktree Git directory is always asked afresh (see `GitLocationMemo`);
 * only the common directory comes from `git`.
 */
export async function resolveExecutionRootScope(
  executionRoot: string,
  git: GitLocationLookup = liveGitLocations
): Promise<ExecutionRootScope> {
  const canonicalExecutionRoot = await canonicalPath(executionRoot);
  const worktreeGitDir = await absoluteGitDir(canonicalExecutionRoot);
  const identity = foldPathForCompare(
    await canonicalPath(worktreeGitDir ?? canonicalExecutionRoot)
  );
  const commonDir = worktreeGitDir
    ? await git.gitCommonDir(canonicalExecutionRoot)
    : undefined;
  if (worktreeGitDir && !commonDir) {
    throw new Error(
      `Cannot resolve Git common directory for execution root: ${canonicalExecutionRoot}`
    );
  }

  return {
    identity,
    scopeHash: crypto
      .createHash("sha256")
      .update(identity, "utf8")
      .digest("hex"),
    executionRoot: canonicalExecutionRoot,
    ...(commonDir ? { gitCommonDir: await canonicalPath(commonDir) } : {}),
  };
}

/**
 * Return a storage directory for a scope-owned category. Git-backed categories
 * live in the Git common directory — never inside the execution root's working
 * tree — for three reasons, in order of weight:
 *
 * 1. **Nothing we write can become an untracked or committed file in the
 *    user's repository.** `.ctrlyoke/` is not wholesale-ignored; only the
 *    entries `WorkspaceInitializer` generates are, and that file is written
 *    solely by `initializeIfNeeded` — which the MCP server never calls. A
 *    board under the working tree would therefore appear untracked in any
 *    checkout ctrlyoke had not initialized (including an external agent's,
 *    where the first note would also create `.ctrlyoke/` and flip
 *    `WorkspaceInitializer.isInitialized` to true), and inside a managed
 *    worktree `hasUncommittedChanges` + `commitAll` would land it in the
 *    user's branch.
 * 2. **The common directory is guaranteed to be on the same filesystem as the
 *    execution root.** Both leases and coordination claims are reaped by PID
 *    liveness, which is only meaningful among processes sharing that
 *    filesystem — so a synced location (the user-mode state home under
 *    OneDrive/Dropbox) would be wrong here even though run history tolerates it.
 * 3. Records outlive a managed worktree's directory. Load-bearing for the
 *    worktree ownership records next door, incidental for the board.
 *
 * The non-Git fallback accepts (1) and (2) being unavailable because there is
 * no repository to dirty and nowhere else scoped to put it.
 */
export function scopeStorageRoot(
  scope: ExecutionRootScope,
  category: string
): string {
  return scope.gitCommonDir
    ? path.join(scope.gitCommonDir, "ctrlyoke", category, scope.scopeHash)
    : path.join(scope.executionRoot, ".ctrlyoke", category);
}

export interface ScopeRecordVerification {
  storageRoot: string;
  scopeIdentity: string;
  /** Return true when data exists that must not be adopted without metadata. */
  hasExistingData: () => Promise<boolean>;
  mismatchMessage: string;
  missingMessage: string;
}

/**
 * Verify or create the identity marker for a scope-owned storage directory.
 * Callers serialize this operation with their storage-specific lock.
 */
export async function verifyScopeRecord({
  storageRoot,
  scopeIdentity,
  hasExistingData,
  mismatchMessage,
  missingMessage,
}: ScopeRecordVerification): Promise<void> {
  const scopePath = path.join(storageRoot, "scope.json");
  const existing = await readJson<ScopeRecord>(scopePath);
  if (existing) {
    if (existing.scopeIdentity !== scopeIdentity) {
      throw new Error(`${mismatchMessage} at ${scopePath}; refusing to use it`);
    }
    return;
  }

  if (await hasExistingData()) {
    throw new Error(`${missingMessage} at ${scopePath}; refusing to use it`);
  }

  await writeFileAtomic(
    scopePath,
    JSON.stringify({ scopeIdentity } satisfies ScopeRecord, null, 2)
  );
}

/** Backward-friendly name for callers that previously owned the lease resolver. */
export const resolveLeaseScope = resolveExecutionRootScope;
