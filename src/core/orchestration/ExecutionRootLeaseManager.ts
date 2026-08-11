import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { absoluteGitDir, gitCommonDir } from "../../utils/GitUtils";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import {
  generateOwnerToken,
  isOwnerStale,
  isProcessAlive,
  STALE_HEARTBEAT_MS,
} from "../../utils/LockSafetyPrimitives";
import { foldPathForCompare } from "../../utils/PathCasing";

export type ExecutionLeaseMode = "shared-native" | "exclusive-worktree";

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

interface LeaseScope {
  identity: string;
  storageRoot: string;
  leasesRoot: string;
  arbitrationPath: string;
}

interface LeaseScopeRecord {
  scopeIdentity: string;
}

const ARBITRATION_TIMEOUT_MS = 5_000;
const ARBITRATION_RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return path.normalize(await fs.realpath(resolved));
  } catch {
    return path.normalize(resolved);
  }
}

async function withArbitrationLock<T>(
  lockPath: string,
  action: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - start < ARBITRATION_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}`, "utf8");
      } finally {
        await handle.close();
      }
      try {
        return await action();
      } finally {
        await fs.unlink(lockPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > STALE_HEARTBEAT_MS) {
          await fs.unlink(lockPath).catch((unlinkError: unknown) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw unlinkError;
            }
          });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
      }
      await sleep(ARBITRATION_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Timed out waiting for execution lease arbitration: ${lockPath}`
  );
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function resolveLeaseScope(executionRoot: string): Promise<LeaseScope> {
  const canonicalExecutionRoot = await canonicalPath(executionRoot);
  const worktreeGitDir = await absoluteGitDir(canonicalExecutionRoot);
  if (worktreeGitDir) {
    const identity = foldPathForCompare(await canonicalPath(worktreeGitDir));
    const commonDir = await gitCommonDir(canonicalExecutionRoot);
    if (!commonDir) {
      throw new Error(
        `Cannot resolve Git common directory for execution root: ${canonicalExecutionRoot}`
      );
    }
    const scopeHash = crypto
      .createHash("sha256")
      .update(identity, "utf8")
      .digest("hex");
    const storageRoot = path.join(
      await canonicalPath(commonDir),
      "ctrlyoke",
      "execution-leases",
      scopeHash
    );
    return {
      identity,
      storageRoot,
      leasesRoot: path.join(storageRoot, "leases"),
      arbitrationPath: path.join(storageRoot, "arbitration.lock"),
    };
  }

  const storageRoot = path.join(
    canonicalExecutionRoot,
    ".ctrlyoke",
    "execution-leases"
  );
  return {
    identity: foldPathForCompare(canonicalExecutionRoot),
    storageRoot,
    leasesRoot: path.join(storageRoot, "leases"),
    arbitrationPath: path.join(storageRoot, "arbitration.lock"),
  };
}

function isCompatible(
  requestedMode: ExecutionLeaseMode,
  existingMode: ExecutionLeaseMode
): boolean {
  return requestedMode === "shared-native" && existingMode === "shared-native";
}

async function verifyScopeRecord(scope: LeaseScope): Promise<void> {
  const scopePath = path.join(scope.storageRoot, "scope.json");
  const existing = await readJson<LeaseScopeRecord>(scopePath);
  if (existing) {
    if (existing.scopeIdentity !== scope.identity) {
      throw new Error(
        `Execution lease scope mismatch at ${scopePath}; refusing to use it`
      );
    }
    return;
  }

  const entries = await fs.readdir(scope.leasesRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  if (entries.some((entry) => entry.endsWith(".json"))) {
    throw new Error(
      `Execution lease scope metadata is missing at ${scopePath}; refusing to use it`
    );
  }
  await writeFileAtomic(
    scopePath,
    JSON.stringify(
      { scopeIdentity: scope.identity } satisfies LeaseScopeRecord,
      null,
      2
    )
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

  async acquire(request = this.defaultRequest): Promise<ExecutionLeaseHandle> {
    if (!request) throw new Error("An execution lease request is required");
    return ExecutionRootLeaseManager.acquireLease(request);
  }

  async acquireLease(
    request = this.defaultRequest
  ): Promise<ExecutionLeaseHandle> {
    if (!request) throw new Error("An execution lease request is required");
    return ExecutionRootLeaseManager.acquireLease(request);
  }

  static async acquire(
    request: ExecutionLeaseRequest
  ): Promise<ExecutionLeaseHandle> {
    return this.acquireLease(request);
  }

  static async acquireLease(
    request: ExecutionLeaseRequest
  ): Promise<ExecutionLeaseHandle> {
    const scope = await resolveLeaseScope(request.executionRoot);
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
    await withArbitrationLock(scope.arbitrationPath, async () => {
      await verifyScopeRecord(scope);
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
    await withArbitrationLock(scope.arbitrationPath, async () => {
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
    await withArbitrationLock(scope.arbitrationPath, async () => {
      const leasePath = path.join(scope.leasesRoot, `${ownerToken}.json`);
      const existing = await readJson<ExecutionLease>(leasePath);
      if (!existing || existing.ownerToken !== ownerToken) return;
      await fs.unlink(leasePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    });
  }

  /** Exposed for focused tests and diagnostics; acquisition uses the same resolver. */
  static async getScopeInfo(executionRoot: string): Promise<{
    identity: string;
    storageRoot: string;
    leasesRoot: string;
    arbitrationPath: string;
  }> {
    return resolveLeaseScope(executionRoot);
  }

  /** Shared stale-owner predicate for callers inspecting persisted leases. */
  static isLeaseStale(
    lease: Pick<ExecutionLease, "pid" | "lastHeartbeat">
  ): boolean {
    return isOwnerStale(lease.pid, lease.lastHeartbeat);
  }

  /** Expose the process check without creating another staleness model. */
  static isProcessAlive(pid: number): boolean {
    return isProcessAlive(pid);
  }
}
