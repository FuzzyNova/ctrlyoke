import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import {
  addWorktree,
  commitAll,
  currentBranch,
  deleteLocalBranch,
  gitCommonDir,
  getGitTrackedAndUntrackedFiles,
  hasGitOperationInProgress,
  hasUncommittedChanges,
  listWorktrees as listGitWorktrees,
  removeWorktree,
  repoToplevel,
  resolveCommit,
  validateBranchName,
  type GitWorktreeEntry,
} from "../../utils/GitUtils";
import {
  createManagedBranchName,
  createWorktreeDirectoryName,
  resolveThroughNearestExistingAncestor,
  resolveWorktreeRoot as resolveConfiguredRoot,
  withRepositoryWorktreeMutationLock,
} from "../../utils/WorktreeUtils";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { LOCK_STATUS } from "../../types/DashboardConstants";
import { isPathWithinDirectory } from "../../utils/PathSecurity";
import { pathsEqual } from "../../utils/PathCasing";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  WorkspaceInitializer,
  isWorkspaceInitializerRuntimePath,
} from "./WorkspaceInitializer";
import { ScriptProcessRunner } from "./ScriptProcessRunner";
import {
  ExecutionRootLeaseManager,
  type ExecutionLeaseHandle,
  type ExecutionLeaseConflict,
  type ExecutionLeaseRequest,
} from "./ExecutionRootLeaseManager";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { ExecutionWorkspace } from "../../types/WorkflowContextTypes";
import type {
  RunRef,
  WorktreeCompletionResult,
  WorkflowKey,
  WorktreeResolution,
  WorkingFileWorktreeRuntimePatch,
} from "../../types/CtrlYokeTypes";
import { VarSubstitutor } from "../../utils/VarSubstitutor";
import {
  runtimeTrustedRootRegistry,
  type RuntimeTrustedRootHandle,
} from "../../utils/RuntimeTrustedRootRegistry";

export type WorktreeMode = "managed" | "named";
export type WorktreeManagerMode = WorktreeMode;
export type WorktreeOrigin = "created" | "discovered" | "recovered";
export type WorktreeLifecycleOwner = "ctrlyoke" | "user";
export type ManagedWorktreeRecoveryOutcome =
  | "landed"
  | "no-changes"
  | "orphaned";

export const MANAGED_WORKTREE_RECORD_SCHEMA_VERSION = 1 as const;

export interface ManagedWorktreeOwnershipRecord {
  schemaVersion: typeof MANAGED_WORKTREE_RECORD_SCHEMA_VERSION;
  branchName: string;
  worktreePath: string;
  sourceCheckoutRoot: string;
  baseCommit: string;
  targetBranch?: string;
  lastVerifiedBranchTip: string;
  stateRoot: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  createdAt: number;
  lifecycleState:
    | "provisioning"
    | "ready"
    | "finalizing"
    | "blocked"
    | "orphaned"
    | "settled";
  directoryState: "present" | "removed" | "missing" | "remove-failed";
  branchState: "present" | "deleted" | "missing";
  recoveryOutcome?: ManagedWorktreeRecoveryOutcome;
  finalBranchTip?: string;
}

/** The durable and in-memory identity of a resolved worktree run. */
export interface WorktreeInfo {
  mode: WorktreeMode;
  origin: WorktreeOrigin;
  lifecycleOwner: WorktreeLifecycleOwner;
  branchName: string;
  worktreePath: string;
  sourceCheckoutRoot: string;
  baseCommit: string;
  targetBranch?: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  createdAt: number;
  executionWorkspace: ExecutionWorkspace;
  /** Existing named worktrees are allowed to be dirty; this is informational. */
  dirty: boolean;
  /** The exclusive lease held for the lifetime of this resolved run. */
  lease?: ExecutionLeaseHandle;
  /** Process-session trust held while this worktree remains discoverable. */
  runtimeTrust?: RuntimeTrustedRootHandle;
  setupOutcome?: "pending" | "running" | "succeeded" | "failed";
  recoveryOutcome?: ManagedWorktreeRecoveryOutcome;
}

/** A resolved worktree that owns the process-local lease and trust handles. */
export interface ActiveWorktreeInfo extends WorktreeInfo {
  lease: ExecutionLeaseHandle;
  runtimeTrust: RuntimeTrustedRootHandle;
}

export interface WorktreeManagerOptions {
  /** User-scope placement override. Falls back to the configured setting. */
  worktreeRoot?: string;
  homeDirectory?: string;
  leaseManager?: ExecutionRootLeaseManager;
  now?: () => number;
  /** Disk-authoritative runtime patch, normally PromptQueue.updateWorktreeRuntime. */
  updateWorktreeRuntime?: (
    patch: WorkingFileWorktreeRuntimePatch
  ) => Promise<void>;
}

/** One Git-discovered checkout plus read-only ctrlyoke lease/ownership state. */
export interface WorktreeDiscoveryEntry extends GitWorktreeEntry {
  managed: boolean;
  inUse: boolean;
  leaseOwners: ExecutionLeaseConflict[];
  stale: boolean;
}

/** Activation-time worktree report. It performs no Git or lease mutations. */
export interface WorktreeActivationDiscovery {
  worktrees: WorktreeDiscoveryEntry[];
  recoverableManagedWorktrees: WorktreeInfo[];
  staleManagedWorktrees: ManagedWorktreeOwnershipRecord[];
}

export interface CompleteManagedRunOptions {
  keep?: boolean;
  /** The integration cleanup barrier must pass before Git is touched. */
  artifactsClean?: boolean;
  cleanupMessage?: string;
}

export interface ResolveNamedWorktreeOptions {
  sourceCheckoutRoot: string;
  branchName: string;
  base?: string;
  stateRoot: string;
  /** Trusted workspace roots as authored; the state root is intentionally omitted from the result. */
  workspaceRoots?: readonly string[];
  /** Open workspace folders as authored, source-side paths. */
  namedWorkspaceRoots: readonly ResolverWorkspaceFolder[];
  /** These roots are carried through for trust decisions, but never become workspace roots. */
  approvedExternalRoots?: readonly string[];
  /** CLI --add-dir and equivalent caller-supplied roots. */
  additionalRoots?: readonly string[];
  /** Alias used by callers that distinguish trusted from additional roots. */
  additionalTrustedRoots?: readonly string[];
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runner?: ExecutionLeaseRequest["runner"];
  instanceId?: string;
  /** Authored/default selection to retain on the execution workspace. */
  worktree?: WorktreeResolution;
  /** Setup is automatically attempted only for a newly created checkout. */
  setup?: string;
  /** Workflow vars are exported as CTRLYOKE_VAR_* by the shared runner. */
  vars?: Record<string, string>;
  /** Explicit user action to retry a pending/running/failed setup. */
  retrySetup?: boolean;
  /** Setup outcome restored from the addressed working file. */
  existingSetupOutcome?: "pending" | "running" | "succeeded" | "failed";
}

export interface EnsureManagedWorktreeOptions extends Omit<
  ResolveNamedWorktreeOptions,
  "branchName" | "workflowKey" | "runRef"
> {
  /** Display name used for both the managed branch slug and directory slug. */
  workflowName?: string;
  /** Existing promoted identity. A resolver may supply it for fresh runs. */
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
  /** Resolve/promote the run before any Git discovery or mutation. */
  resolveRun?: () => Promise<{ workflowKey: WorkflowKey; runRef: RunRef }>;
  /** Must acquire the lineage runner lock before worktree mutation begins. */
  acquireRunnerLock?: (identity: {
    workflowKey: WorkflowKey;
    runRef: RunRef;
  }) => Promise<void>;
  targetBranch?: string;
}

export interface RecoverManagedWorktreeOptions {
  sourceCheckoutRoot: string;
  stateRoot?: string;
  workflowKey?: WorkflowKey;
  runRef?: RunRef;
  branchName?: string;
  workspaceRoots?: readonly string[];
  namedWorkspaceRoots?: readonly ResolverWorkspaceFolder[];
  approvedExternalRoots?: readonly string[];
  additionalRoots?: readonly string[];
  additionalTrustedRoots?: readonly string[];
  runner?: ExecutionLeaseRequest["runner"];
  instanceId?: string;
  /** Discovery is read-only; recovery itself acquires a lease and trust. */
  acquireLease?: boolean;
}

export class WorktreeSetupError extends Error {
  readonly worktreePath: string;

  constructor(worktreePath: string, cause: unknown) {
    super(`Worktree setup failed in ${worktreePath}: ${cause}`);
    this.name = "WorktreeSetupError";
    this.worktreePath = worktreePath;
  }
}

interface ResolvedRepositoryInputs {
  sourceCheckoutRoot: string;
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
  workspaceRoots: string[];
  approvedExternalRoots: string[];
  executionRoot: string;
}

function normalizeBranchName(branchName: string): string {
  return branchName.startsWith("refs/heads/")
    ? branchName.slice("refs/heads/".length)
    : branchName;
}

function pathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return (
    isPathWithinDirectory(resolvedLeft, resolvedRight) ||
    isPathWithinDirectory(resolvedRight, resolvedLeft)
  );
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    const resolved = path.resolve(value);
    const key =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

/**
 * Owns named-worktree policy. Git remains the source of truth for checkout
 * discovery and mutation; this class supplies the execution-workspace,
 * trust, lease, and runtime-persistence boundaries around it.
 */
export class WorktreeManager {
  private readonly leaseManager: ExecutionRootLeaseManager;
  private readonly now: () => number;

  public constructor(private readonly options: WorktreeManagerOptions = {}) {
    this.leaseManager = options.leaseManager ?? new ExecutionRootLeaseManager();
    this.now = options.now ?? Date.now;
  }

  /** Resolve the configured/sibling/fallback placement root for a repository. */
  public async resolveWorktreeRoot(
    sourceCheckoutRoot: string
  ): Promise<string> {
    const sourceRoot = await this.requireRepositoryRoot(sourceCheckoutRoot);
    const worktrees = await listGitWorktrees(sourceRoot);
    const result = await resolveConfiguredRoot({
      sourceCheckoutRoot: sourceRoot,
      explicitRoot:
        this.options.worktreeRoot ?? ConfigurationUtils.getWorktreeRoot(),
      homeDirectory: this.options.homeDirectory,
      discoveredWorktrees: worktrees,
    });
    return result.root;
  }

  /** List linked checkouts from the repository's canonical Git toplevel. */
  public async listWorktrees(
    sourceCheckoutRoot: string
  ): Promise<GitWorktreeEntry[]> {
    return listGitWorktrees(
      await this.requireRepositoryRoot(sourceCheckoutRoot)
    );
  }

  /**
   * Return the stable record location for a managed branch. The branch itself
   * is never used as a path component; only its bounded hash is.
   */
  public async managedWorktreeRecordPath(
    sourceCheckoutRoot: string,
    branchName: string
  ): Promise<string> {
    const commonDirectory = await this.requireCommonDirectory(
      await this.requireRepositoryRoot(sourceCheckoutRoot)
    );
    return this.recordPath(commonDirectory, branchName);
  }

  /** Read one ownership record without treating its presence as ownership. */
  public async readManagedWorktreeRecord(
    sourceCheckoutRoot: string,
    branchName: string
  ): Promise<ManagedWorktreeOwnershipRecord | undefined> {
    const recordPath = await this.managedWorktreeRecordPath(
      sourceCheckoutRoot,
      normalizeBranchName(branchName.trim())
    );
    return this.tryReadRecord(recordPath);
  }

  /**
   * Check the only condition settlement may use before deleting a managed
   * branch. A naming prefix or a worktree path is deliberately irrelevant.
   */
  public async isManagedBranchOwned(
    sourceCheckoutRoot: string,
    branchName: string
  ): Promise<boolean> {
    const normalizedBranch = normalizeBranchName(branchName.trim());
    const record = await this.readManagedWorktreeRecord(
      sourceCheckoutRoot,
      normalizedBranch
    );
    if (!record || record.branchName !== normalizedBranch) return false;
    try {
      const currentTip = await resolveCommit(
        await this.requireRepositoryRoot(sourceCheckoutRoot),
        `refs/heads/${normalizedBranch}`
      );
      return currentTip === record.lastVerifiedBranchTip;
    } catch {
      return false;
    }
  }

  /** Record a tip verified by settlement without deleting or landing anything. */
  public async markManagedBranchTipVerified(
    sourceCheckoutRoot: string,
    branchName: string,
    branchTip: string
  ): Promise<void> {
    const repositoryRoot = await this.requireRepositoryRoot(sourceCheckoutRoot);
    const normalizedBranch = normalizeBranchName(branchName.trim());
    const commonDirectory = await this.requireCommonDirectory(repositoryRoot);
    await withRepositoryWorktreeMutationLock(repositoryRoot, async () => {
      const recordPath = this.recordPath(commonDirectory, normalizedBranch);
      const record = await this.tryReadRecord(recordPath);
      if (!record || record.branchName !== normalizedBranch) {
        throw new Error(
          `No managed ownership record exists for "${normalizedBranch}".`
        );
      }
      const currentTip = await resolveCommit(
        repositoryRoot,
        `refs/heads/${normalizedBranch}`
      );
      if (currentTip !== branchTip) {
        throw new Error(
          `Managed branch "${normalizedBranch}" moved before its tip could be verified.`
        );
      }
      await this.writeRecord(recordPath, {
        ...record,
        lastVerifiedBranchTip: branchTip,
        finalBranchTip: branchTip,
      });
    });
  }

  /**
   * Settle a managed run while its exclusive execution lease is still held.
   * Cleanup of harness integrations is deliberately supplied by
   * WorkflowInstance; this method owns the Git identity/runtime guards,
   * landing, no-change branch cleanup, record persistence, and removal.
   */
  public async completeManagedRun(
    info: WorktreeInfo,
    options: CompleteManagedRunOptions = {}
  ): Promise<WorktreeCompletionResult> {
    const keep = options.keep === true;
    const blocked = async (
      message: string,
      branchState: WorktreeCompletionResult["branchState"] = "present"
    ): Promise<WorktreeCompletionResult> => {
      await this.persistManagedSettlement(info, {
        lifecycleState: "blocked",
        landingOutcome: "blocked",
        directoryState: "present",
        branchState,
        message,
      });
      return {
        landingOutcome: "blocked",
        directoryOutcome: "kept",
        branchState,
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
        message,
      };
    };

    try {
      if (info.mode !== "managed" || info.lifecycleOwner !== "ctrlyoke") {
        return blocked("Only ctrlyoke-owned managed worktrees can be settled.");
      }
      if (options.artifactsClean === false) {
        return blocked(
          options.cleanupMessage ??
            "Provider artifacts could not be proven clean; managed landing is blocked."
        );
      }

      const repositoryRoot = await this.requireRepositoryRoot(
        info.sourceCheckoutRoot
      );
      const commonDirectory = await this.requireCommonDirectory(repositoryRoot);
      const recordPath = this.recordPath(commonDirectory, info.branchName);

      return await withRepositoryWorktreeMutationLock(
        repositoryRoot,
        async () => {
          const record = await this.tryReadRecord(recordPath);
          if (!record || record.branchName !== info.branchName) {
            return blocked("Managed ownership record is missing or mismatched.");
          }
          if (!(await this.tryResolveLocalBranch(repositoryRoot, info.branchName))) {
            return blocked(
              "Managed branch ref is missing; refusing to finalize an unowned checkout.",
              "missing"
            );
          }
          const identity = await this.validateManagedCheckoutIdentity(
            repositoryRoot,
            info,
            record
          );
          if (!identity.ok) return blocked(identity.message);

          const paths = await getGitTrackedAndUntrackedFiles(
            info.worktreePath
          );
          const runtimePaths = paths.filter((repositoryRelativePath) =>
            isWorkspaceInitializerRuntimePath(repositoryRelativePath)
          );
          if (runtimePaths.length > 0) {
            return blocked(
              `Managed landing would stage runtime paths: ${runtimePaths.join(", ")}`
            );
          }

          const changed = await hasUncommittedChanges(info.worktreePath);
          if (identity.headCommit === record.baseCommit && !changed) {
            return this.completeManagedNoChange(
              repositoryRoot,
              recordPath,
              record,
              info,
              keep
            );
          }

          if (!changed) {
            return blocked(
              "Managed branch changed without a ctrlyoke landing; refusing to overwrite its identity."
            );
          }

          const committed = await commitAll(
            info.worktreePath,
            "ctrlyoke: land managed workflow changes"
          );
          if (!committed) {
            return blocked("Managed worktree commit found no changes to commit.");
          }

          const committedHead = await resolveCommit(info.worktreePath, "HEAD");
          const landedIdentity = await this.validateManagedCheckoutIdentity(
            repositoryRoot,
            info,
            { ...record, lastVerifiedBranchTip: committedHead }
          );
          if (!landedIdentity.ok) return blocked(landedIdentity.message);
          const finalTip = landedIdentity.headCommit;
          const landedRecord: ManagedWorktreeOwnershipRecord = {
            ...record,
            lifecycleState: "settled",
            directoryState: keep ? "present" : "present",
            branchState: "present",
            lastVerifiedBranchTip: finalTip,
            finalBranchTip: finalTip,
          };
          await this.writeRecord(recordPath, landedRecord);
          await this.persistRuntime({
            lifecycleState: "settled",
            landingOutcome: "landed",
            directoryState: keep ? "present" : "present",
            branchState: "present",
            finalBranchTip: finalTip,
            updatedAt: this.now(),
          });

          if (keep) {
            return {
              landingOutcome: "landed",
              directoryOutcome: "kept",
              branchState: "present",
              branchName: info.branchName,
              ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
              autoCommitted: true,
            };
          }

          return this.removeAfterLanding(
            repositoryRoot,
            recordPath,
            landedRecord,
            info,
            true
          );
        }
      );
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error));
    } finally {
      await info.lease?.release().catch(() => undefined);
    }
  }

  private async validateManagedCheckoutIdentity(
    repositoryRoot: string,
    info: WorktreeInfo,
    record: ManagedWorktreeOwnershipRecord
  ): Promise<{ ok: true; headCommit: string } | { ok: false; message: string }> {
    if (!(await this.pathExists(info.worktreePath))) {
      return { ok: false, message: "Managed worktree directory is missing." };
    }
    if (await hasGitOperationInProgress(info.worktreePath)) {
      return { ok: false, message: "A Git operation is in progress in the managed worktree." };
    }
    const checkedOutBranch = await currentBranch(info.worktreePath);
    if (checkedOutBranch !== info.branchName) {
      return {
        ok: false,
        message: `Managed worktree is attached to "${checkedOutBranch ?? "detached HEAD"}", expected "${info.branchName}".`,
      };
    }
    const headCommit = await resolveCommit(info.worktreePath, "HEAD");
    const branchTip = await resolveCommit(
      repositoryRoot,
      `refs/heads/${info.branchName}`
    );
    if (headCommit !== branchTip) {
      return { ok: false, message: "Managed worktree HEAD does not match its branch ref." };
    }
    if (branchTip !== record.lastVerifiedBranchTip) {
      return {
        ok: false,
        message: "Managed branch ref moved since ctrlyoke last verified it.",
      };
    }
    return { ok: true, headCommit };
  }

  private async completeManagedNoChange(
    repositoryRoot: string,
    recordPath: string,
    record: ManagedWorktreeOwnershipRecord,
    info: WorktreeInfo,
    keep: boolean
  ): Promise<WorktreeCompletionResult> {
    if (keep) {
      await this.writeRecord(recordPath, {
        ...record,
        lifecycleState: "settled",
        directoryState: "present",
        branchState: "present",
        recoveryOutcome: "no-changes",
        finalBranchTip: record.baseCommit,
      });
      await this.persistRuntime({
        lifecycleState: "settled",
        landingOutcome: "no-changes",
        directoryState: "present",
        branchState: "present",
        finalBranchTip: record.baseCommit,
        updatedAt: this.now(),
      });
      return {
        landingOutcome: "no-changes",
        directoryOutcome: "kept",
        branchState: "present",
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
      };
    }
    return this.removeAfterLanding(
      repositoryRoot,
      recordPath,
      {
        ...record,
        lifecycleState: "settled",
        recoveryOutcome: "no-changes",
        finalBranchTip: record.baseCommit,
      },
      info,
      false
    );
  }

  private async removeAfterLanding(
    repositoryRoot: string,
    recordPath: string,
    record: ManagedWorktreeOwnershipRecord,
    info: WorktreeInfo,
    autoCommitted: boolean
  ): Promise<WorktreeCompletionResult> {
    try {
      await removeWorktree(repositoryRoot, info.worktreePath);
    } catch (error) {
      const message = `Managed worktree removal failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await this.writeRecord(recordPath, {
        ...record,
        lifecycleState: "settled",
        directoryState: "remove-failed",
        branchState: "present",
      });
      await this.persistRuntime({
        lifecycleState: "settled",
        landingOutcome: record.recoveryOutcome === "no-changes" ? "no-changes" : "landed",
        directoryState: "remove-failed",
        branchState: "present",
        finalBranchTip: record.finalBranchTip,
        updatedAt: this.now(),
      });
      return {
        landingOutcome: record.recoveryOutcome === "no-changes" ? "no-changes" : "landed",
        directoryOutcome: "remove-failed",
        branchState: "present",
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
        ...(autoCommitted ? { autoCommitted: true } : {}),
        message,
      };
    }

    let branchState: WorktreeCompletionResult["branchState"] = "present";
    let message: string | undefined;
    if (record.recoveryOutcome === "no-changes") {
      const branchTip = await this.tryResolveLocalBranch(
        repositoryRoot,
        info.branchName
      );
      if (branchTip !== record.baseCommit) {
        branchState = branchTip ? "present" : "missing";
        message = "Managed no-change branch changed before deletion; it was kept.";
      } else {
        try {
          await deleteLocalBranch(repositoryRoot, info.branchName);
          branchState = "deleted";
        } catch (error) {
          message = `Managed no-change branch deletion failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    const landingOutcome =
      record.recoveryOutcome === "no-changes" ? "no-changes" : "landed";
    const finalRecord: ManagedWorktreeOwnershipRecord = {
      ...record,
      lifecycleState: "settled",
      directoryState: "removed",
      branchState,
    };
    await this.writeRecord(recordPath, finalRecord);
    await this.persistRuntime({
      lifecycleState: "settled",
      landingOutcome,
      directoryState: "removed",
      branchState,
      finalBranchTip: record.finalBranchTip,
      updatedAt: this.now(),
    });

    if (landingOutcome === "no-changes" && branchState === "deleted") {
      // The record is no longer needed only after both independent resources
      // are durably recorded as gone. A crash before this unlink leaves the
      // record as a safe reconciliation tombstone.
      await fs.unlink(recordPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }

    return {
      landingOutcome,
      directoryOutcome: "removed",
      branchState,
      branchName: info.branchName,
      ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
      ...(autoCommitted ? { autoCommitted: true } : {}),
      ...(message ? { message } : {}),
    };
  }

  private async persistManagedSettlement(
    info: WorktreeInfo,
    patch: WorkingFileWorktreeRuntimePatch & {
      landingOutcome: WorktreeCompletionResult["landingOutcome"];
      message?: string;
    }
  ): Promise<void> {
    const commonDirectory = await this.requireCommonDirectory(
      await this.requireRepositoryRoot(info.sourceCheckoutRoot)
    );
    const recordPath = this.recordPath(commonDirectory, info.branchName);
    const record = await this.tryReadRecord(recordPath);
    if (record) {
      await this.writeRecord(recordPath, {
        ...record,
        lifecycleState: patch.lifecycleState ?? "blocked",
        directoryState: patch.directoryState ?? "present",
        branchState: patch.branchState ?? "present",
        ...(patch.finalBranchTip ? { finalBranchTip: patch.finalBranchTip } : {}),
      });
    }
    await this.persistRuntime({
      ...patch,
      updatedAt: this.now(),
    });
  }

  /**
   * Create or re-enter a managed worktree. The resolver and runner-lock hook
   * are intentionally before Git discovery so callers cannot accidentally
   * create a worktree for a draft or a merely viewed run.
   */
  public async ensureManagedWorktree(
    options: EnsureManagedWorktreeOptions
  ): Promise<ActiveWorktreeInfo> {
    const identity = options.resolveRun
      ? await options.resolveRun()
      : this.requireRunIdentity(options);
    await options.acquireRunnerLock?.(identity);

    const sourceCheckoutRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    const repositoryInputs = await this.resolveExecutionInputs(
      sourceCheckoutRoot,
      options
    );
    const commonDirectory =
      await this.requireCommonDirectory(sourceCheckoutRoot);

    return withRepositoryWorktreeMutationLock(sourceCheckoutRoot, async () => {
      const records = await this.readRecords(commonDirectory);
      const existingRecord = records.find(
        (record) =>
          pathsEqual(record.sourceCheckoutRoot, sourceCheckoutRoot) &&
          record.workflowKey === identity.workflowKey &&
          record.runRef === identity.runRef
      );
      const generatedBranchName = createManagedBranchName(
        options.workflowName ?? String(identity.workflowKey),
        identity.runRef
      );
      const branchName = existingRecord?.branchName ?? generatedBranchName;
      await validateBranchName(branchName);

      const entries = await listGitWorktrees(sourceCheckoutRoot);
      let existingCheckout = entries.find(
        (entry) => entry.branchName === branchName
      );
      if (
        existingCheckout &&
        pathsEqual(existingCheckout.worktreePath, sourceCheckoutRoot)
      ) {
        throw new Error(
          `Managed branch "${branchName}" is already checked out in the source checkout.`
        );
      }

      const baseCommit =
        existingRecord?.baseCommit ??
        (await resolveCommit(
          sourceCheckoutRoot,
          options.base?.trim() || "HEAD"
        ));
      const targetBranch =
        existingRecord?.targetBranch ??
        options.targetBranch?.trim() ??
        (await currentBranch(sourceCheckoutRoot)) ??
        undefined;
      const root = await this.resolveWorktreeRoot(sourceCheckoutRoot);
      const worktreePath =
        existingRecord?.worktreePath ??
        path.join(
          root,
          createWorktreeDirectoryName(
            options.workflowName ?? String(identity.workflowKey),
            commonDirectory,
            {
              kind: "managed",
              workflowKey: identity.workflowKey,
              runRef: identity.runRef,
            }
          )
        );

      if (
        existingCheckout &&
        !(await this.pathExists(existingCheckout.worktreePath))
      ) {
        throw new Error(
          `Managed branch "${branchName}" has a stale Git worktree entry at "${existingCheckout.worktreePath}"; explicit repair is required.`
        );
      }

      if (
        existingCheckout &&
        !pathsEqual(existingCheckout.worktreePath, worktreePath)
      ) {
        throw new Error(
          `Managed branch "${branchName}" is checked out at an unexpected path.`
        );
      }
      await this.assertManagedPathIsAvailable(
        worktreePath,
        existingCheckout?.worktreePath
      );
      const localBranchCommit = existingCheckout
        ? undefined
        : await this.tryResolveLocalBranch(sourceCheckoutRoot, branchName);
      if (localBranchCommit && !existingRecord) {
        throw new Error(
          `Managed branch collision: branch "${branchName}" exists without its ownership record.`
        );
      }

      const recordPath = this.recordPath(commonDirectory, branchName);
      const record: ManagedWorktreeOwnershipRecord = existingRecord ?? {
        schemaVersion: MANAGED_WORKTREE_RECORD_SCHEMA_VERSION,
        branchName,
        worktreePath,
        sourceCheckoutRoot,
        baseCommit,
        ...(targetBranch ? { targetBranch } : {}),
        lastVerifiedBranchTip: baseCommit,
        stateRoot: path.resolve(options.stateRoot),
        workflowKey: identity.workflowKey,
        runRef: identity.runRef,
        createdAt: this.now(),
        lifecycleState: "provisioning",
        directoryState: "missing",
        branchState: "missing",
      };

      if (existingRecord) {
        this.assertRecordMatchesRequest(existingRecord, {
          sourceCheckoutRoot,
          workflowKey: identity.workflowKey,
          runRef: identity.runRef,
        });
      } else {
        await this.writeRecord(recordPath, record);
      }

      const origin: WorktreeOrigin = existingRecord ? "recovered" : "created";
      let attached = existingCheckout;
      if (!attached) {
        await addWorktree(sourceCheckoutRoot, worktreePath, {
          branchName,
          createBranch: !localBranchCommit,
          ...(localBranchCommit ? {} : { baseRef: baseCommit }),
        });
        attached = (await listGitWorktrees(sourceCheckoutRoot)).find(
          (entry) => entry.branchName === branchName
        );
        if (!attached) {
          throw new Error(
            `Git created managed worktree "${branchName}" but it was not discoverable afterward.`
          );
        }
      }
      if (!pathsEqual(attached.worktreePath, worktreePath)) {
        throw new Error(
          `Managed branch "${branchName}" was attached at an unexpected path.`
        );
      }

      await WorkspaceInitializer.initializeIfNeeded(worktreePath);
      const updatedRecord: ManagedWorktreeOwnershipRecord = {
        ...record,
        worktreePath,
        lifecycleState: "ready",
        directoryState: "present",
        branchState: "present",
      };
      await this.writeRecord(recordPath, updatedRecord);

      return this.acquireManagedInfo({
        record: updatedRecord,
        repositoryInputs,
        origin,
        options,
      });
    });
  }

  /**
   * Reconcile one durable record. Missing directories are classified from the
   * recorded base and verified tip, never from branch naming or path location.
   */
  public async recoverManagedWorktree(
    options: RecoverManagedWorktreeOptions
  ): Promise<WorktreeInfo | undefined> {
    const sourceCheckoutRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    const commonDirectory =
      await this.requireCommonDirectory(sourceCheckoutRoot);
    return withRepositoryWorktreeMutationLock(sourceCheckoutRoot, async () => {
      const records = await this.readRecords(commonDirectory);
      const record = records.find(
        (candidate) =>
          pathsEqual(candidate.sourceCheckoutRoot, sourceCheckoutRoot) &&
          (options.branchName === undefined ||
            candidate.branchName === normalizeBranchName(options.branchName)) &&
          (options.workflowKey === undefined ||
            candidate.workflowKey === options.workflowKey) &&
          (options.runRef === undefined || candidate.runRef === options.runRef)
      );
      if (!record) return undefined;

      const branchTip = await this.tryResolveLocalBranch(
        sourceCheckoutRoot,
        record.branchName
      );
      const recordPath = this.recordPath(commonDirectory, record.branchName);
      if (!branchTip) {
        // The user deleted the branch. Removing only this now-stale record is
        // safe reconciliation; no Git object is deleted by recovery.
        await fs.unlink(recordPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        return undefined;
      }

      const entries = await listGitWorktrees(sourceCheckoutRoot);
      const entry = entries.find(
        (candidate) => candidate.branchName === record.branchName
      );
      const directoryPresent = Boolean(
        entry && (await this.pathExists(entry.worktreePath))
      );
      if (!directoryPresent) {
        const recoveryOutcome =
          branchTip === record.baseCommit
            ? "no-changes"
            : branchTip === record.lastVerifiedBranchTip &&
                record.lastVerifiedBranchTip !== record.baseCommit
              ? "landed"
              : "orphaned";
        await this.writeRecord(recordPath, {
          ...record,
          directoryState: "missing",
          branchState: "present",
          recoveryOutcome,
          finalBranchTip: branchTip,
          lifecycleState:
            recoveryOutcome === "orphaned" ? "orphaned" : "settled",
        });
        return undefined;
      }
      if (!entry || !pathsEqual(entry.worktreePath, record.worktreePath)) {
        return undefined;
      }

      if (options.acquireLease === false) {
        return this.buildManagedInfoWithoutLease(record, options, "recovered");
      }

      const runnerStatus = await WorkflowLockManager.checkLock(
        record.stateRoot,
        record.workflowKey
      );
      if (
        runnerStatus === LOCK_STATUS.ACTIVE_CLI ||
        runnerStatus === LOCK_STATUS.ACTIVE_VSCODE
      ) {
        return undefined;
      }
      return this.acquireManagedInfo({
        record: {
          ...record,
          directoryState: "present",
          branchState: "present",
          lifecycleState: "ready",
        },
        repositoryInputs: await this.resolveExecutionInputs(
          sourceCheckoutRoot,
          this.recoveryAsResolveOptions(record, options)
        ),
        origin: "recovered",
        options: this.recoveryAsResolveOptions(record, options),
      });
    });
  }

  /** Read-only activation discovery. Returned infos do not own a lease/trust. */
  public async discoverRecoverableManagedWorktrees(
    options: Omit<RecoverManagedWorktreeOptions, "branchName" | "acquireLease">
  ): Promise<WorktreeInfo[]> {
    const sourceCheckoutRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    const commonDirectory =
      await this.requireCommonDirectory(sourceCheckoutRoot);
    const records = await this.readRecords(commonDirectory);
    const entries = await listGitWorktrees(sourceCheckoutRoot);
    const result: WorktreeInfo[] = [];
    for (const record of records) {
      if (!pathsEqual(record.sourceCheckoutRoot, sourceCheckoutRoot)) continue;
      if (
        options.workflowKey !== undefined &&
        record.workflowKey !== options.workflowKey
      )
        continue;
      if (options.runRef !== undefined && record.runRef !== options.runRef)
        continue;
      const entry = entries.find(
        (candidate) =>
          candidate.branchName === record.branchName &&
          pathsEqual(candidate.worktreePath, record.worktreePath)
      );
      if (!entry || !(await this.pathExists(record.worktreePath))) continue;
      const runnerStatus = await WorkflowLockManager.checkLock(
        record.stateRoot,
        record.workflowKey
      );
      if (
        runnerStatus === LOCK_STATUS.ACTIVE_CLI ||
        runnerStatus === LOCK_STATUS.ACTIVE_VSCODE
      )
        continue;
      if (await this.hasLiveLease(record.worktreePath)) continue;
      result.push(
        await this.buildManagedInfoWithoutLease(
          record,
          { ...options, sourceCheckoutRoot },
          "recovered"
        )
      );
    }
    return result;
  }

  /**
   * Read-only activation discovery. Git's porcelain entry, ownership record,
   * lease owners, and prunable marker are returned together so callers can
   * render recovery warnings without guessing from branch names or paths.
   */
  public async discoverActivationState(
    options: Omit<RecoverManagedWorktreeOptions, "branchName" | "acquireLease">
  ): Promise<WorktreeActivationDiscovery> {
    const sourceCheckoutRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    const commonDirectory =
      await this.requireCommonDirectory(sourceCheckoutRoot);
    const [records, entries, recoverableManagedWorktrees] = await Promise.all([
      this.readRecords(commonDirectory),
      listGitWorktrees(sourceCheckoutRoot),
      this.discoverRecoverableManagedWorktrees({
        ...options,
        sourceCheckoutRoot,
      }),
    ]);

    const worktrees: WorktreeDiscoveryEntry[] = [];
    for (const entry of entries) {
      const ownership = records.find(
        (record) =>
          record.branchName === entry.branchName &&
          pathsEqual(record.worktreePath, entry.worktreePath)
      );
      const inspections = await ExecutionRootLeaseManager.inspectLeases(
        entry.worktreePath
      );
      const leaseOwners: ExecutionLeaseConflict[] = inspections
        .filter((inspection) => !inspection.stale)
        .map((inspection) => ({
          lease: inspection.lease,
          ageMs: inspection.ageMs,
          retryAction: "retry",
        }));
      worktrees.push({
        ...entry,
        managed: ownership !== undefined,
        inUse: leaseOwners.length > 0,
        leaseOwners,
        stale: Boolean(entry.prunableReason),
      });
    }

    const staleManagedWorktrees = records.filter((record) => {
      const entry = worktrees.find(
        (candidate) =>
          candidate.branchName === record.branchName &&
          pathsEqual(candidate.worktreePath, record.worktreePath)
      );
      return !entry || entry.stale;
    });

    return {
      worktrees,
      recoverableManagedWorktrees,
      staleManagedWorktrees,
    };
  }

  /**
   * Resolve a named branch, attaching or creating its linked checkout as
   * necessary. The returned lease must be released by the execution owner.
   */
  public async resolveNamedWorktree(
    options: ResolveNamedWorktreeOptions
  ): Promise<ActiveWorktreeInfo> {
    const branchName = normalizeBranchName(options.branchName.trim());
    if (!branchName) throw new Error("Named worktree mode requires a branch.");

    const sourceCheckoutRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    const repositoryInputs = await this.resolveExecutionInputs(
      sourceCheckoutRoot,
      options
    );
    await validateBranchName(branchName);
    const initialEntries = await listGitWorktrees(sourceCheckoutRoot);
    const initialBranchCheckout = initialEntries.find(
      (entry) => entry.branchName === branchName
    );

    if (
      initialBranchCheckout &&
      pathsEqual(initialBranchCheckout.worktreePath, sourceCheckoutRoot)
    ) {
      throw new Error(
        `Named branch "${branchName}" is already checked out in the initiating source checkout.`
      );
    }

    const root = initialBranchCheckout
      ? undefined
      : await this.resolveWorktreeRoot(sourceCheckoutRoot);
    const existingLocalBranchCommit = initialBranchCheckout
      ? undefined
      : await this.tryResolveLocalBranch(sourceCheckoutRoot, branchName);
    const capturedBase = initialBranchCheckout
      ? initialBranchCheckout.headCommit
      : (existingLocalBranchCommit ??
        (await resolveCommit(
          sourceCheckoutRoot,
          options.base?.trim() || "HEAD"
        )));

    let origin: WorktreeOrigin = initialBranchCheckout
      ? "discovered"
      : "created";
    let worktreePath = initialBranchCheckout?.worktreePath;
    const needsProvisioning = !worktreePath;
    if (needsProvisioning) {
      const commonDirectory =
        await this.requireCommonDirectory(sourceCheckoutRoot);
      worktreePath = path.join(
        root!,
        createWorktreeDirectoryName(branchName, commonDirectory, {
          kind: "named",
          branchRef: branchName,
        })
      );
    }

    await this.persistRuntime({
      ...this.buildRuntime(repositoryInputs, branchName, worktreePath!),
      origin,
      lifecycleState: "provisioning",
      directoryState: needsProvisioning ? "missing" : "present",
      branchState: initialBranchCheckout ? "present" : "missing",
      baseCommit: capturedBase,
    });

    if (needsProvisioning) {
      const mutation = await withRepositoryWorktreeMutationLock(
        sourceCheckoutRoot,
        async () => {
          const entries = await listGitWorktrees(sourceCheckoutRoot);
          const discovered = entries.find(
            (entry) => entry.branchName === branchName
          );
          if (discovered) {
            if (pathsEqual(discovered.worktreePath, sourceCheckoutRoot)) {
              throw new Error(
                `Named branch "${branchName}" is already checked out in the initiating source checkout.`
              );
            }
            return { entry: discovered, created: false };
          }

          const localBranchCommit = await this.tryResolveLocalBranch(
            sourceCheckoutRoot,
            branchName
          );
          await addWorktree(sourceCheckoutRoot, worktreePath!, {
            branchName,
            ...(localBranchCommit
              ? { createBranch: false }
              : { createBranch: true, baseRef: capturedBase }),
          });
          const attached = (await listGitWorktrees(sourceCheckoutRoot)).find(
            (entry) => entry.branchName === branchName
          );
          if (!attached) {
            throw new Error(
              `Git created named worktree "${branchName}" but it was not discoverable afterward.`
            );
          }
          return { entry: attached, created: true };
        }
      );

      worktreePath = mutation.entry.worktreePath;
      origin = mutation.created ? "created" : "discovered";
    }

    if (!worktreePath) {
      throw new Error(`Named worktree "${branchName}" could not be resolved.`);
    }
    if (
      options.existingSetupOutcome &&
      options.existingSetupOutcome !== "succeeded" &&
      !options.retrySetup
    ) {
      throw new Error(
        `Named worktree setup is ${options.existingSetupOutcome}; use Retry Setup to run it explicitly.`
      );
    }
    const executionCheckoutRoot = worktreePath;
    await WorkspaceInitializer.initializeIfNeeded(executionCheckoutRoot);
    const dirty = await hasUncommittedChanges(executionCheckoutRoot);
    const baseCommit = await resolveCommit(executionCheckoutRoot, "HEAD");
    const mapSourcePath = (sourcePath: string): string =>
      path.resolve(
        executionCheckoutRoot,
        path.relative(sourceCheckoutRoot, sourcePath)
      );
    const mappedNamedWorkspaceRoots = repositoryInputs.namedWorkspaceRoots.map(
      (rootEntry) => ({
        ...rootEntry,
        fsPath: mapSourcePath(rootEntry.fsPath),
      })
    );
    const executionRoot = mapSourcePath(repositoryInputs.executionRoot);
    const executionWorkspace: ExecutionWorkspace = {
      stateRoot: options.stateRoot,
      executionRoot,
      sourceCheckoutRoot,
      executionCheckoutRoot,
      workspaceRoots: dedupePaths([
        executionRoot,
        ...repositoryInputs.workspaceRoots.map((sourceRoot) =>
          mapSourcePath(sourceRoot)
        ),
      ]),
      namedWorkspaceRoots: mappedNamedWorkspaceRoots,
      approvedExternalRoots: repositoryInputs.approvedExternalRoots,
      ...(options.worktree ? { worktree: options.worktree } : {}),
    };

    const lease = await this.leaseManager.acquire({
      mode: "exclusive-worktree",
      stateRoot: options.stateRoot,
      executionRoot: executionWorkspace.executionRoot,
      workflowKey: options.workflowKey,
      runRef: options.runRef,
      runner: options.runner ?? "vscode",
      instanceId: options.instanceId ?? crypto.randomUUID(),
    });

    let runtimeTrust: RuntimeTrustedRootHandle;
    try {
      runtimeTrust = await runtimeTrustedRootRegistry.register({
        rootPath: executionCheckoutRoot,
        repositoryRoot: sourceCheckoutRoot,
        ownerToken: options.instanceId,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }

    const shouldRunSetup =
      Boolean(options.setup?.trim()) &&
      (origin === "created" || options.retrySetup === true);
    let setupOutcome: WorktreeInfo["setupOutcome"];
    if (shouldRunSetup) {
      setupOutcome = "pending";
      await this.persistRuntime({
        lifecycleState: "provisioning",
        directoryState: "present",
        branchState: "present",
        setupOutcome,
        updatedAt: this.now(),
      });
      try {
        setupOutcome = "running";
        await this.persistRuntime({
          lifecycleState: "provisioning",
          directoryState: "present",
          branchState: "present",
          setupOutcome,
          updatedAt: this.now(),
        });
        await this.runSetup(
          executionCheckoutRoot,
          options.setup!,
          options.vars
        );
        setupOutcome = "succeeded";
      } catch (error) {
        setupOutcome = "failed";
        await this.persistRuntime({
          lifecycleState: "blocked",
          directoryState: "present",
          branchState: "present",
          setupOutcome,
          dirty: await hasUncommittedChanges(executionCheckoutRoot).catch(
            () => undefined
          ),
          updatedAt: this.now(),
        });
        runtimeTrust.release();
        await lease.release();
        throw new WorktreeSetupError(executionCheckoutRoot, error);
      }
    }

    const info: ActiveWorktreeInfo = {
      mode: "named",
      origin,
      lifecycleOwner: "user",
      branchName,
      worktreePath: executionCheckoutRoot,
      sourceCheckoutRoot,
      baseCommit,
      workflowKey: options.workflowKey,
      runRef: options.runRef,
      createdAt: this.now(),
      executionWorkspace,
      dirty,
      lease,
      runtimeTrust,
      setupOutcome,
    };

    await this.persistRuntime({
      ...this.buildRuntime(repositoryInputs, branchName, executionCheckoutRoot),
      origin,
      lifecycleState: "ready",
      directoryState: "present",
      branchState: "present",
      baseCommit,
      dirty,
      ...(setupOutcome ? { setupOutcome } : {}),
    });
    return info;
  }

  /** Explicit user action for a previously blocked or interrupted setup. */
  public async retrySetup(
    options: ResolveNamedWorktreeOptions
  ): Promise<ActiveWorktreeInfo> {
    if (!options.setup?.trim()) {
      throw new Error("Retry Setup requires a configured setup command.");
    }
    return this.resolveNamedWorktree({ ...options, retrySetup: true });
  }

  /** Release the lease held by a resolved worktree. No Git cleanup is performed. */
  public async releaseWorktree(info: WorktreeInfo): Promise<void> {
    await info.lease?.release();
  }

  /** Release process-session trust after the run/session is no longer loaded. */
  public releaseRuntimeTrust(info: WorktreeInfo): void {
    info.runtimeTrust?.release();
  }

  private async runSetup(
    executionRoot: string,
    setup: string,
    vars?: Record<string, string>
  ): Promise<void> {
    const command = VarSubstitutor.substitute(setup, vars ?? {});
    const runner = new ScriptProcessRunner(executionRoot);
    try {
      const result = await runner.run({
        cwd: executionRoot,
        timeout: ConfigurationUtils.getScriptTimeoutMs(),
        argv: [command],
        vars,
        viaShell: true,
      });
      if (!result.success) {
        throw new Error(
          result.error ||
            `Setup exited with code ${result.exitCode ?? "unknown"}`
        );
      }
    } finally {
      runner.dispose();
    }
  }

  private requireRunIdentity(options: EnsureManagedWorktreeOptions): {
    workflowKey: WorkflowKey;
    runRef: RunRef;
  } {
    if (!options.workflowKey || !options.runRef) {
      throw new Error(
        "Managed worktree execution requires a promoted workflowKey and runRef."
      );
    }
    return { workflowKey: options.workflowKey, runRef: options.runRef };
  }

  private recordPath(commonDirectory: string, branchName: string): string {
    const branchHash = crypto
      .createHash("sha256")
      .update(normalizeBranchName(branchName), "utf8")
      .digest("hex");
    return path.join(
      commonDirectory,
      "ctrlyoke",
      "managed-worktrees",
      `${branchHash}.json`
    );
  }

  private async readRecords(
    commonDirectory: string
  ): Promise<ManagedWorktreeOwnershipRecord[]> {
    const directory = path.join(
      commonDirectory,
      "ctrlyoke",
      "managed-worktrees"
    );
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ManagedWorktreeOwnershipRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.tryReadRecord(path.join(directory, entry.name));
      if (record) records.push(record);
    }
    return records;
  }

  private async tryReadRecord(
    recordPath: string
  ): Promise<ManagedWorktreeOwnershipRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(recordPath, "utf8")
      ) as Partial<ManagedWorktreeOwnershipRecord>;
      if (
        parsed.schemaVersion !== MANAGED_WORKTREE_RECORD_SCHEMA_VERSION ||
        typeof parsed.branchName !== "string" ||
        typeof parsed.worktreePath !== "string" ||
        typeof parsed.sourceCheckoutRoot !== "string" ||
        typeof parsed.baseCommit !== "string" ||
        typeof parsed.lastVerifiedBranchTip !== "string" ||
        typeof parsed.stateRoot !== "string" ||
        typeof parsed.workflowKey !== "string" ||
        typeof parsed.runRef !== "string" ||
        typeof parsed.createdAt !== "number" ||
        !parsed.lifecycleState ||
        !parsed.directoryState ||
        !parsed.branchState
      ) {
        return undefined;
      }
      return parsed as ManagedWorktreeOwnershipRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A partially written/corrupt record is not ownership evidence. Ignore
      // it during discovery; the next explicit ensure will fail on collisions
      // rather than silently adopting it.
      return undefined;
    }
  }

  private async writeRecord(
    recordPath: string,
    record: ManagedWorktreeOwnershipRecord
  ): Promise<void> {
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private assertRecordMatchesRequest(
    record: ManagedWorktreeOwnershipRecord,
    request: {
      sourceCheckoutRoot: string;
      workflowKey: WorkflowKey;
      runRef: RunRef;
    }
  ): void {
    if (
      !pathsEqual(record.sourceCheckoutRoot, request.sourceCheckoutRoot) ||
      record.workflowKey !== request.workflowKey ||
      record.runRef !== request.runRef
    ) {
      throw new Error(
        `Managed ownership record for "${record.branchName}" belongs to another run.`
      );
    }
  }

  private async assertManagedPathIsAvailable(
    worktreePath: string,
    expectedPath?: string
  ): Promise<void> {
    if (expectedPath && pathsEqual(worktreePath, expectedPath)) return;
    try {
      const stats = await fs.lstat(worktreePath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Managed worktree path is not an available directory: ${worktreePath}`
        );
      }
      throw new Error(`Managed worktree path collision: ${worktreePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async hasLiveLease(executionRoot: string): Promise<boolean> {
    const inspections = await ExecutionRootLeaseManager.inspectLeases(
      executionRoot
    );
    return inspections.some((inspection) => !inspection.stale);
  }

  private recoveryAsResolveOptions(
    record: ManagedWorktreeOwnershipRecord,
    options: RecoverManagedWorktreeOptions
  ): EnsureManagedWorktreeOptions {
    const namedWorkspaceRoots = options.namedWorkspaceRoots ?? [
      { name: "repository", fsPath: record.sourceCheckoutRoot },
    ];
    return {
      sourceCheckoutRoot: record.sourceCheckoutRoot,
      stateRoot: options.stateRoot ?? record.stateRoot,
      workspaceRoots: options.workspaceRoots,
      namedWorkspaceRoots,
      approvedExternalRoots: options.approvedExternalRoots,
      additionalRoots: options.additionalRoots,
      additionalTrustedRoots: options.additionalTrustedRoots,
      workflowKey: record.workflowKey,
      runRef: record.runRef,
      runner: options.runner ?? "vscode",
      instanceId: options.instanceId,
      targetBranch: record.targetBranch,
    };
  }

  private async buildManagedInfoWithoutLease(
    record: ManagedWorktreeOwnershipRecord,
    options: RecoverManagedWorktreeOptions,
    origin: WorktreeOrigin
  ): Promise<WorktreeInfo> {
    const resolvedOptions = this.recoveryAsResolveOptions(record, options);
    const inputs = await this.resolveExecutionInputs(
      record.sourceCheckoutRoot,
      resolvedOptions
    );
    const executionWorkspace = this.buildExecutionWorkspace(
      inputs,
      record.worktreePath,
      resolvedOptions
    );
    return {
      mode: "managed",
      origin,
      lifecycleOwner: "ctrlyoke",
      branchName: record.branchName,
      worktreePath: record.worktreePath,
      sourceCheckoutRoot: record.sourceCheckoutRoot,
      baseCommit: record.baseCommit,
      targetBranch: record.targetBranch,
      workflowKey: record.workflowKey,
      runRef: record.runRef,
      createdAt: record.createdAt,
      executionWorkspace,
      dirty: false,
      ...(record.recoveryOutcome
        ? { recoveryOutcome: record.recoveryOutcome }
        : {}),
    };
  }

  private async acquireManagedInfo(args: {
    record: ManagedWorktreeOwnershipRecord;
    repositoryInputs: ResolvedRepositoryInputs;
    origin: WorktreeOrigin;
    options: EnsureManagedWorktreeOptions;
  }): Promise<ActiveWorktreeInfo> {
    const executionWorkspace = this.buildExecutionWorkspace(
      args.repositoryInputs,
      args.record.worktreePath,
      args.options
    );
    const lease = await this.leaseManager.acquire({
      mode: "exclusive-worktree",
      stateRoot: args.record.stateRoot,
      executionRoot: executionWorkspace.executionRoot,
      workflowKey: args.record.workflowKey,
      runRef: args.record.runRef,
      runner: args.options.runner ?? "vscode",
      instanceId: args.options.instanceId ?? crypto.randomUUID(),
    });
    let runtimeTrust: RuntimeTrustedRootHandle;
    try {
      runtimeTrust = await runtimeTrustedRootRegistry.register({
        rootPath: args.record.worktreePath,
        repositoryRoot: args.record.sourceCheckoutRoot,
        ownerToken: args.options.instanceId,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
    const shouldRunSetup =
      Boolean(args.options.setup?.trim()) && args.origin === "created";
    let setupOutcome: WorktreeInfo["setupOutcome"];
    if (shouldRunSetup) {
      setupOutcome = "pending";
      await this.persistRuntime({
        lifecycleState: "provisioning",
        directoryState: "present",
        branchState: "present",
        setupOutcome,
        updatedAt: this.now(),
      });
      try {
        setupOutcome = "running";
        await this.persistRuntime({
          lifecycleState: "provisioning",
          directoryState: "present",
          branchState: "present",
          setupOutcome,
          updatedAt: this.now(),
        });
        await this.runSetup(
          args.record.worktreePath,
          args.options.setup!,
          args.options.vars
        );
        setupOutcome = "succeeded";
      } catch (error) {
        setupOutcome = "failed";
        await this.persistRuntime({
          lifecycleState: "blocked",
          directoryState: "present",
          branchState: "present",
          setupOutcome,
          dirty: await hasUncommittedChanges(args.record.worktreePath).catch(
            () => undefined
          ),
          updatedAt: this.now(),
        });
        runtimeTrust.release();
        await lease.release();
        throw new WorktreeSetupError(args.record.worktreePath, error);
      }
    }
    const dirty = await hasUncommittedChanges(args.record.worktreePath);
    const info: ActiveWorktreeInfo = {
      mode: "managed",
      origin: args.origin,
      lifecycleOwner: "ctrlyoke",
      branchName: args.record.branchName,
      worktreePath: args.record.worktreePath,
      sourceCheckoutRoot: args.record.sourceCheckoutRoot,
      baseCommit: args.record.baseCommit,
      targetBranch: args.record.targetBranch,
      workflowKey: args.record.workflowKey,
      runRef: args.record.runRef,
      createdAt: args.record.createdAt,
      executionWorkspace,
      dirty,
      lease,
      runtimeTrust,
      ...(setupOutcome ? { setupOutcome } : {}),
      ...(args.record.recoveryOutcome
        ? { recoveryOutcome: args.record.recoveryOutcome }
        : {}),
    };
    await this.persistRuntime({
      schemaVersion: 1,
      mode: "managed",
      origin: args.origin,
      branchName: args.record.branchName,
      worktreePath: args.record.worktreePath,
      executionRoot: executionWorkspace.executionRoot,
      executionCheckoutRoot: args.record.worktreePath,
      sourceCheckoutRoot: args.record.sourceCheckoutRoot,
      namedWorkspaceRoots: [...executionWorkspace.namedWorkspaceRoots],
      baseCommit: args.record.baseCommit,
      ...(args.record.targetBranch
        ? { targetBranch: args.record.targetBranch }
        : {}),
      lifecycleOwner: "ctrlyoke",
      lifecycleState: "ready",
      directoryState: "present",
      branchState: "present",
      dirty,
      ...(setupOutcome ? { setupOutcome } : {}),
    });
    return info;
  }

  private buildExecutionWorkspace(
    inputs: ResolvedRepositoryInputs,
    executionCheckoutRoot: string,
    options: { stateRoot: string; worktree?: WorktreeResolution }
  ): ExecutionWorkspace {
    const mapSourcePath = (sourcePath: string): string =>
      path.resolve(
        executionCheckoutRoot,
        path.relative(inputs.sourceCheckoutRoot, sourcePath)
      );
    const executionRoot = mapSourcePath(inputs.executionRoot);
    return {
      stateRoot: path.resolve(options.stateRoot),
      executionRoot,
      executionCheckoutRoot,
      sourceCheckoutRoot: inputs.sourceCheckoutRoot,
      workspaceRoots: dedupePaths([
        executionRoot,
        ...inputs.workspaceRoots.map((sourceRoot) => mapSourcePath(sourceRoot)),
      ]),
      namedWorkspaceRoots: inputs.namedWorkspaceRoots.map((rootEntry) => ({
        ...rootEntry,
        fsPath: mapSourcePath(rootEntry.fsPath),
      })),
      approvedExternalRoots: inputs.approvedExternalRoots,
      ...(options.worktree ? { worktree: options.worktree } : {}),
    };
  }

  private async requireRepositoryRoot(
    sourceCheckoutRoot: string
  ): Promise<string> {
    const root = await repoToplevel(sourceCheckoutRoot);
    if (!root) {
      throw new Error(
        `Cannot resolve a Git repository for ${sourceCheckoutRoot}.`
      );
    }
    return path.resolve(root);
  }

  private async requireCommonDirectory(
    repositoryRoot: string
  ): Promise<string> {
    const common = await gitCommonDir(repositoryRoot);
    if (!common)
      throw new Error("Cannot resolve the repository Git common directory.");
    return common;
  }

  private async tryResolveLocalBranch(
    repositoryRoot: string,
    branchName: string
  ): Promise<string | undefined> {
    try {
      return await resolveCommit(repositoryRoot, `refs/heads/${branchName}`);
    } catch {
      return undefined;
    }
  }

  private async resolveExecutionInputs(
    sourceCheckoutRoot: string,
    options: {
      stateRoot: string;
      namedWorkspaceRoots: readonly ResolverWorkspaceFolder[];
      workspaceRoots?: readonly string[];
      approvedExternalRoots?: readonly string[];
      additionalRoots?: readonly string[];
      additionalTrustedRoots?: readonly string[];
    }
  ): Promise<ResolvedRepositoryInputs> {
    const sourceRoot =
      await resolveThroughNearestExistingAncestor(sourceCheckoutRoot);
    const stateRoot = await resolveThroughNearestExistingAncestor(
      options.stateRoot
    );
    const namedWorkspaceRoots: ResolverWorkspaceFolder[] = [];
    for (const root of options.namedWorkspaceRoots) {
      const resolvedRoot = await resolveThroughNearestExistingAncestor(
        root.fsPath
      );
      if (!isPathWithinDirectory(resolvedRoot, sourceRoot)) {
        throw new Error(
          `Named workspace root is outside the source checkout and cannot be mapped: ${root.fsPath}`
        );
      }
      namedWorkspaceRoots.push({ ...root, fsPath: resolvedRoot });
    }

    const repositoryWorkspaceRoots: string[] = [];
    for (const workspaceRoot of options.workspaceRoots ?? [
      ...namedWorkspaceRoots.map((root) => root.fsPath),
    ]) {
      const resolvedRoot =
        await resolveThroughNearestExistingAncestor(workspaceRoot);
      if (isPathWithinDirectory(resolvedRoot, sourceRoot)) {
        repositoryWorkspaceRoots.push(resolvedRoot);
      } else if (!pathsEqual(resolvedRoot, stateRoot)) {
        throw new Error(
          `Workspace root is outside the source checkout and cannot be mapped: ${workspaceRoot}`
        );
      }
    }

    const trustRoots = dedupePaths([
      ...(options.approvedExternalRoots ?? []),
      ...(options.additionalRoots ?? []),
      ...(options.additionalTrustedRoots ?? []),
    ]);
    for (const trustRoot of trustRoots) {
      const resolvedTrustRoot =
        await resolveThroughNearestExistingAncestor(trustRoot);
      if (pathsOverlap(resolvedTrustRoot, sourceRoot)) {
        throw new Error(
          `Trusted or additional root overlaps the source checkout and is not allowed in worktree mode: ${trustRoot}`
        );
      }
    }

    const executionRoot = isPathWithinDirectory(stateRoot, sourceRoot)
      ? path.resolve(sourceRoot, path.relative(sourceRoot, stateRoot))
      : sourceRoot;

    return {
      sourceCheckoutRoot: sourceRoot,
      namedWorkspaceRoots,
      workspaceRoots: dedupePaths(repositoryWorkspaceRoots),
      approvedExternalRoots: dedupePaths(options.approvedExternalRoots ?? []),
      executionRoot,
    };
  }

  private buildRuntime(
    inputs: ResolvedRepositoryInputs,
    branchName: string,
    worktreePath: string,
    origin: WorktreeOrigin = "created"
  ): WorkingFileWorktreeRuntimePatch {
    return {
      schemaVersion: 1,
      mode: "named",
      origin,
      branchName,
      worktreePath,
      executionRoot: path.resolve(
        worktreePath,
        path.relative(inputs.sourceCheckoutRoot, inputs.executionRoot)
      ),
      executionCheckoutRoot: worktreePath,
      sourceCheckoutRoot: inputs.sourceCheckoutRoot,
      namedWorkspaceRoots: inputs.namedWorkspaceRoots.map((root) => ({
        ...root,
        fsPath: path.resolve(
          worktreePath,
          path.relative(inputs.sourceCheckoutRoot, root.fsPath)
        ),
      })),
      baseCommit: "",
      lifecycleOwner: "user",
      lifecycleState: "provisioning",
      directoryState: "missing",
      branchState: "missing",
      updatedAt: this.now(),
    };
  }

  private async persistRuntime(
    patch: WorkingFileWorktreeRuntimePatch
  ): Promise<void> {
    await this.options.updateWorktreeRuntime?.({
      ...patch,
      updatedAt: patch.updatedAt ?? this.now(),
    });
  }
}

export type { GitWorktreeEntry } from "../../utils/GitUtils";
export type { WorktreeCompletionResult } from "../../types/CtrlYokeTypes";
