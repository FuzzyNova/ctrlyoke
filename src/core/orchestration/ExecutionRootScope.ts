import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { absoluteGitDir, gitCommonDir } from "../../utils/GitUtils";
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
 */
export async function resolveExecutionRootScope(
  executionRoot: string
): Promise<ExecutionRootScope> {
  const canonicalExecutionRoot = await canonicalPath(executionRoot);
  const worktreeGitDir = await absoluteGitDir(canonicalExecutionRoot);
  const identity = foldPathForCompare(
    await canonicalPath(worktreeGitDir ?? canonicalExecutionRoot)
  );
  const commonDir = worktreeGitDir
    ? await gitCommonDir(canonicalExecutionRoot)
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
 * are kept in the common directory so managed worktree removal cannot remove
 * the coordination or lease state.
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
