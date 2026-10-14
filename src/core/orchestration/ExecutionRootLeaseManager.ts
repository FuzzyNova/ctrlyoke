import * as fs from "fs/promises";
import * as path from "path";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import type { GitLocationLookup } from "../../utils/GitUtils";
import {
  generateOwnerToken,
  isOwnerStale,
  isProcessAlive,
} from "../../utils/LockSafetyPrimitives";
import { lockFilePath, withFileLock } from "../../utils/FileLockUtils";
import {
  resolveExecutionRootScope,
  SCOPE_STORAGE_CATEGORIES,
  scopeStorageRoot,
  verifyScopeRecord as verifyExecutionRootScopeRecord,
} from "./ExecutionRootScope";

export const EXECUTION_LEASE_MODES = {
  SHARED_NATIVE: "shared-native",
  EXCLUSIVE_WORKTREE: "exclusive-worktree",
} as const;
export type ExecutionLeaseMode =
  (typeof EXECUTION_LEASE_MODES)[keyof typeof EXECUTION_LEASE_MODES];

export interface ExecutionLease {
  ownerToken: string;
  mode: "shared-native" | "exclusive-worktree";
  pid: number;
  runner: "vscode" | "cli";
  instanceId: string;
  stateRoot: string;
  executionRoot: string;
  workflowKey: string;
  runRef: string;
  startedAt: number;
  lastHeartbeat: number;
}

export interface ExecutionLeaseRequest {
  mode: ExecutionLeaseMode;
  stateRoot: string;
  executionRoot: string;
  workflowKey: string;
  runRef: string;
  runner: ExecutionLease["runner"];
  instanceId: string;
  pid?: number;
}

export interface ExecutionLeaseHandle extends ExecutionLease {
  updateHeartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface ExecutionLeaseConflict {
  lease: ExecutionLease;
  ageMs: number;
  retryAction: "retry";
}

/** Read-only lease state used by worktree discovery and activation diagnostics. */
export interface ExecutionLeaseInspection {
  lease: ExecutionLease;
  ageMs: number;
  stale: boolean;
}

export class ExecutionLeaseConflictError extends Error {
  readonly conflict: ExecutionLeaseConflict;
  readonly retryable = true;
  readonly retryAction = "retry" as const;
  readonly retry: () => Promise<ExecutionLeaseHandle>;

  constructor(
    conflict: ExecutionLeaseConflict,
    retry: () => Promise<ExecutionLeaseHandle>
  ) {
    const owner = conflict.lease;
    const ageSeconds = Math.max(0, Math.floor(conflict.ageMs / 1000));
    super(
      `Execution root is in use: workflow ${owner.workflowKey}, run ${owner.runRef}; ` +
        `${owner.runner} instance ${owner.instanceId}, PID ${owner.pid}; ` +
        `state root ${owner.stateRoot}; lease age ${ageSeconds}s. ` +
        `Retry after the owning run releases it.`
    );
    this.name = "ExecutionLeaseConflictError";
    this.conflict = conflict;
    this.retry = retry;
  }
}

/** Where one execution root's leases and arbitration lock live. */
export interface LeaseScope {
  identity: string;
  storageRoot: string;
  leasesRoot: string;
  /** `withFileLock` target; the lock file itself is `arbitrationPath`. */
  arbitrationTarget: string;
  arbitrationPath: string;
}

/**
 * Serialize lease mutations for one execution root. Uses the shared
 * `withFileLock` primitive so arbitration gets the same delete-pending retry and
 * rename-away release as every other ctrlyoke lock; a private copy of that loop
 * missed both and wedged a lease until reboot.
 */
async function withArbitrationLock<T>(
  scope: LeaseScope,
  action: () => Promise<T>
): Promise<T> {
  await fs.mkdir(scope.storageRoot, { recursive: true });
  return withFileLock(scope.arbitrationTarget, action);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resolveLeaseScope(
  executionRoot: string,
  git?: GitLocationLookup
): Promise<LeaseScope> {
  const scope = await resolveExecutionRootScope(executionRoot, git);
  const storageRoot = scopeStorageRoot(
    scope,
    SCOPE_STORAGE_CATEGORIES.EXECUTION_LEASES
  );
  const arbitrationTarget = path.join(storageRoot, "arbitration");
  return {
    identity: scope.identity,
    storageRoot,
    leasesRoot: path.join(storageRoot, "leases"),
    arbitrationTarget,
    arbitrationPath: lockFilePath(arbitrationTarget),
  };
}

function isCompatible(
  requestedMode: ExecutionLeaseMode,
  existingMode: ExecutionLeaseMode
): boolean {
  return (
    requestedMode === EXECUTION_LEASE_MODES.SHARED_NATIVE &&
    existingMode === EXECUTION_LEASE_MODES.SHARED_NATIVE
  );
}

async function readLiveLeases(scope: LeaseScope): Promise<ExecutionLease[]> {
  const entries = await fs.readdir(scope.leasesRoot, { withFileTypes: true });
  const leases: ExecutionLease[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const leasePath = path.join(scope.leasesRoot, entry.name);
    const lease = await readJson<ExecutionLease>(leasePath);
    if (!lease) continue;
    if (isOwnerStale(lease.pid, lease.lastHeartbeat)) {
      await fs.unlink(leasePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      continue;
    }
    leases.push(lease);
  }
  return leases;
}

function createHandle(
  lease: ExecutionLease,
  scope: LeaseScope
): ExecutionLeaseHandle {
  let released = false;
  return {
    ...lease,
    updateHeartbeat: () =>
      ExecutionRootLeaseManager.updateHeartbeat(scope, lease.ownerToken),
    release: async () => {
      if (released) return;
      released = true;
      await ExecutionRootLeaseManager.release(scope, lease.ownerToken);
    },
  };
}

export class ExecutionRootLeaseManager {
  constructor(private readonly defaultRequest?: ExecutionLeaseRequest) {}

  /** `git` is the caller's per-operation lookup, if it has one. */
  async acquire(
    request = this.defaultRequest,
    git?: GitLocationLookup
  ): Promise<ExecutionLeaseHandle> {
    if (!request) throw new Error("An execution lease request is required");
    return ExecutionRootLeaseManager.acquireLease(request, git);
  }

  static async acquire(
    request: ExecutionLeaseRequest,
    git?: GitLocationLookup
  ): Promise<ExecutionLeaseHandle> {
    return this.acquireLease(request, git);
  }

  static async acquireLease(
    request: ExecutionLeaseRequest,
    git?: GitLocationLookup
  ): Promise<ExecutionLeaseHandle> {
    const scope = await resolveLeaseScope(request.executionRoot, git);
    const ownerToken = generateOwnerToken();
    const now = Date.now();
    const lease: ExecutionLease = {
      ownerToken,
      mode: request.mode,
      pid: request.pid ?? process.pid,
      runner: request.runner,
      instanceId: request.instanceId,
      stateRoot: request.stateRoot,
      executionRoot: request.executionRoot,
      workflowKey: request.workflowKey,
      runRef: request.runRef,
      startedAt: now,
      lastHeartbeat: now,
    };

    await fs.mkdir(scope.leasesRoot, { recursive: true });
    await withArbitrationLock(scope, async () => {
      await verifyExecutionRootScopeRecord({
        storageRoot: scope.storageRoot,
        scopeIdentity: scope.identity,
        hasExistingData: async () => {
          const entries = await fs
            .readdir(scope.leasesRoot)
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            });
          return entries.some((entry) => entry.endsWith(".json"));
        },
        mismatchMessage: "Execution lease scope mismatch",
        missingMessage: "Execution lease scope metadata is missing",
      });
      const liveLeases = await readLiveLeases(scope);
      const conflict = liveLeases.find(
        (existing) => !isCompatible(request.mode, existing.mode)
      );
      if (conflict) {
        throw new ExecutionLeaseConflictError(
          {
            lease: conflict,
            ageMs: Date.now() - conflict.startedAt,
            retryAction: "retry",
          },
          // A retry is a later operation, so it asks Git afresh.
          () => ExecutionRootLeaseManager.acquireLease(request)
        );
      }

      const leasePath = path.join(scope.leasesRoot, `${ownerToken}.json`);
      const handle = await fs.open(leasePath, "wx");
      try {
        await handle.writeFile(JSON.stringify(lease, null, 2), "utf8");
      } finally {
        await handle.close();
      }
    });

    return createHandle(lease, scope);
  }

  static async updateHeartbeat(
    scope: LeaseScope,
    ownerToken: string
  ): Promise<void> {
    await withArbitrationLock(scope, async () => {
      const leasePath = path.join(scope.leasesRoot, `${ownerToken}.json`);
      const existing = await readJson<ExecutionLease>(leasePath);
      if (!existing) return;
      if (existing.ownerToken !== ownerToken) return;
      await writeFileAtomic(
        leasePath,
        JSON.stringify({ ...existing, lastHeartbeat: Date.now() }, null, 2)
      );
    });
  }

  static async release(scope: LeaseScope, ownerToken: string): Promise<void> {
    await withArbitrationLock(scope, async () => {
      const leasePath = path.join(scope.leasesRoot, `${ownerToken}.json`);
      const existing = await readJson<ExecutionLease>(leasePath);
      if (!existing || existing.ownerToken !== ownerToken) return;
      await fs.unlink(leasePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    });
  }

  /** Exposed for focused tests and diagnostics; acquisition uses the same resolver. */
  static async getScopeInfo(executionRoot: string): Promise<LeaseScope> {
    return resolveLeaseScope(executionRoot);
  }

  /** Inspect persisted leases without pruning stale owners or changing Git state. */
  static async inspectLeases(
    executionRoot: string,
    now = Date.now(),
    git?: GitLocationLookup
  ): Promise<ExecutionLeaseInspection[]> {
    const scope = await resolveLeaseScope(executionRoot, git);
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(scope.leasesRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const inspections: ExecutionLeaseInspection[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let lease: ExecutionLease | null;
      try {
        lease = await readJson<ExecutionLease>(
          path.join(scope.leasesRoot, entry.name)
        );
      } catch {
        // A malformed or disappearing lease cannot prove a live owner.
        continue;
      }
      if (!lease) continue;
      inspections.push({
        lease,
        ageMs: Math.max(0, now - lease.startedAt),
        stale: ExecutionRootLeaseManager.isLeaseStale(lease),
      });
    }
    return inspections;
  }

  /** Shared stale-owner predicate for callers inspecting persisted leases. */
  static isLeaseStale(
    lease: Pick<ExecutionLease, "pid" | "lastHeartbeat">
  ): boolean {
    return isOwnerStale(
      lease.pid,
      lease.lastHeartbeat,
      Date.now(),
      isProcessAlive
    );
  }
}
