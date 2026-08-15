import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import {
  addWorktree,
  abortMerge,
  commitAll,
  currentBranch,
  getDiffFilesBetweenRefs,
  getAheadBehind,
  getBranchUpstream,
  getUnmergedPaths,
  deleteLocalBranch,
  gitCommonDir,
  getGitTrackedAndUntrackedFiles,
  getGitUntrackedFiles,
  hasGitOperationInProgress,
  hasUncommittedChanges,
  listWorktrees as listGitWorktrees,
  mergeFastForward,
  mergeNoFastForward,
  removeWorktree,
  pruneWorktrees,
  repairWorktree,
  repoToplevel,
  resolveCommit,
  isCommitAncestor,
  localBranchExists,
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
import {
  LOCK_STATUS,
  WORKTREE_MANAGEMENT_ACTIONS,
  type WorktreeManagementAction,
} from "../../types/DashboardConstants";
import { isPathWithinDirectory } from "../../utils/PathSecurity";
import { pathsEqual } from "../../utils/PathCasing";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import {
  WorkspaceInitializer,
  isWorkspaceInitializerRuntimePath,
  isWorkspaceInitializerUnsafePath,
} from "./WorkspaceInitializer";
import {
  ScriptProcessRunner,
  type ScriptProcessResult,
} from "./ScriptProcessRunner";
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
export const NAMED_WORKTREE_SETUP_RECORD_SCHEMA_VERSION = 1 as const;

export type NamedWorktreeSetupOutcome =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

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
  /** A failed managed setup is eligible for deferred cleanup on re-run. */
  setupOutcome?: "succeeded" | "failed";
}

export interface NamedWorktreeSetupRecord {
  schemaVersion: typeof NAMED_WORKTREE_SETUP_RECORD_SCHEMA_VERSION;
  worktreePath: string;
  setupOutcome: NamedWorktreeSetupOutcome;
  updatedAt: number;
}

function getManagedWorktreeWatermark(
  record: ManagedWorktreeOwnershipRecord
): string {
  return record.finalBranchTip ?? record.baseCommit;
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
  /**
   * Display name captured at creation time, in-memory only (never persisted
   * to the ownership record). Used to label the managed auto-commit message;
   * falls back to `branchName` when unavailable (e.g. after crash recovery,
   * when the caller did not resupply it).
   */
  workflowName?: string;
  createdAt: number;
  executionWorkspace: ExecutionWorkspace;
  /** Existing named worktrees are allowed to be dirty; this is informational. */
  dirty: boolean;
  /** Captured at managed-worktree creation; source changes are not copied. */
  sourceCheckoutDirty?: boolean;
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
  /** Injectable Git seam for merge recovery tests and future adapters. */
  mergeOperations?: Partial<WorktreeMergeOperations>;
  /** Process-level seam for setup; reporters are supplied by workflow owners. */
  worktreeSetupRunner?: WorktreeSetupRunner;
}

export interface WorktreeMergeOperations {
  fastForward: (dir: string, ref: string) => Promise<void>;
  noFastForward: (dir: string, ref: string) => Promise<void>;
  getUnmergedPaths: (dir: string) => Promise<string[]>;
  abort: (dir: string) => Promise<void>;
}

export interface WorktreeSetupRunner {
  run(args: {
    executionRoot: string;
    command: string;
    vars?: Record<string, string>;
    timeoutMs: number;
    attemptIndex: number;
  }): Promise<ScriptProcessResult>;
}

type WorktreeSetupRunnerArgs = Parameters<
  WorktreeSetupRunner["run"]
>[0];

/** Headless setup transport used when no live reporter is available. */
export class DefaultWorktreeSetupRunner implements WorktreeSetupRunner {
  async run({
    executionRoot,
    command,
    vars,
    timeoutMs,
  }: WorktreeSetupRunnerArgs): Promise<ScriptProcessResult> {
    const runner = new ScriptProcessRunner(executionRoot);
    try {
      return await runner.run({
        cwd: executionRoot,
        timeout: timeoutMs,
        argv: [command],
        vars,
        viaShell: true,
      });
    } finally {
      runner.dispose();
    }
  }
}

/** One Git-discovered checkout plus read-only ctrlyoke lease/ownership state. */
export interface WorktreeDiscoveryEntry extends GitWorktreeEntry {
  managed: boolean;
  inUse: boolean;
  leaseOwners: ExecutionLeaseConflict[];
  stale: boolean;
}

export interface NamedBranchDivergence {
  comparisonLabel: string;
  comparisonCommit: string;
  ahead: number;
  behind: number;
  calculatedAt: number;
}

export interface WorktreeManagementEntry {
  worktreePath: string;
  headCommit: string;
  branchName?: string;
  ownership: "managed" | "user";
  lifecycleState?: ManagedWorktreeOwnershipRecord["lifecycleState"];
  directoryState?: ManagedWorktreeOwnershipRecord["directoryState"];
  branchState: "present" | "missing" | "deleted";
  createdAt?: number;
  ageMs?: number;
  inUse: boolean;
  leaseOwners: ExecutionLeaseConflict[];
  stale: boolean;
  prunableReason?: string;
  targetBranch?: string;
  branchCleanupEligible: boolean;
  branchCleanupReason?: string;
  divergence?: NamedBranchDivergence;
}

export interface WorktreeManagementState {
  resolvedRoot: string;
  entries: WorktreeManagementEntry[];
  staleManagedRecords: ManagedWorktreeOwnershipRecord[];
  generatedAt: number;
}

export interface WorktreeManagementActionOptions {
  sourceCheckoutRoot: string;
  action: WorktreeManagementAction;
  worktreePath?: string;
  branchName?: string;
  confirmed?: boolean;
}

/** Activation-time worktree report. It performs no Git or lease mutations. */
export interface WorktreeActivationDiscovery {
  worktrees: WorktreeDiscoveryEntry[];
  recoverableManagedWorktrees: WorktreeInfo[];
  staleManagedWorktrees: ManagedWorktreeOwnershipRecord[];
}

export interface CompleteManagedRunOptions {
  keep?: boolean;
  /** Merge the managed branch into the captured source checkout. */
  merge?: boolean;
  /** The integration cleanup barrier must pass before Git is touched. */
  artifactsClean?: boolean;
  cleanupMessage?: string;
}

export type WorktreeMergeOutcome = Exclude<
  NonNullable<WorktreeCompletionResult["mergeOutcome"]>,
  undefined
>;

export interface WorktreeMergeResult {
  mergeOutcome: WorktreeMergeOutcome;
  conflictFiles?: string[];
  message?: string;
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
  /** Managed setup is automatically attempted for each newly created or recreated checkout. */
  setup?: string;
  /** Workflow vars are exported as CTRLYOKE_VAR_* by the shared runner. */
  vars?: Record<string, string>;
  /** Attempt identity for setup output within this run. */
  setupAttemptIndex?: number;
  /** Optional per-execution reporter-backed setup transport. */
  worktreeSetupRunner?: WorktreeSetupRunner;
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
  /** Display name for the managed auto-commit message; see `WorktreeInfo.workflowName`. */
  workflowName?: string;
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

/**
 * Build the deterministic, non-AI commit message used to land a managed
 * worktree's changes (see `WORKTREE_SUPPORT_PLAN.md` "Finalization order").
 * `label` is the workflow's display name when available, falling back to the
 * generated branch name (e.g. after crash recovery, when the original caller
 * did not resupply `workflowName`). Newlines are collapsed so the subject
 * always stays a single line.
 */
function buildManagedAutoCommitMessage(label: string): string {
  const singleLine = label.replace(/\s*\n\s*/g, " ").trim();
  return `chore(ctrlyoke): auto-commit changes for "${singleLine}"`;
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
  private static readonly namedDivergenceCache = new Map<
    string,
    NamedBranchDivergence
  >();
  private readonly leaseManager: ExecutionRootLeaseManager;
  private readonly now: () => number;
  private readonly mergeOperations: WorktreeMergeOperations;
  private readonly worktreeSetupRunner: WorktreeSetupRunner;

  public constructor(private readonly options: WorktreeManagerOptions = {}) {
    this.leaseManager = options.leaseManager ?? new ExecutionRootLeaseManager();
    this.now = options.now ?? Date.now;
    this.mergeOperations = {
      fastForward: mergeFastForward,
      noFastForward: mergeNoFastForward,
      getUnmergedPaths,
      abort: abortMerge,
      ...options.mergeOperations,
    };
    this.worktreeSetupRunner =
      options.worktreeSetupRunner ?? new DefaultWorktreeSetupRunner();
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

  /** Read the durable setup outcome associated with a named worktree path. */
  public async readNamedWorktreeSetupRecord(
    sourceCheckoutRoot: string,
    worktreePath: string
  ): Promise<NamedWorktreeSetupRecord | undefined> {
    const repositoryRoot = await this.requireRepositoryRoot(sourceCheckoutRoot);
    const commonDirectory = await this.requireCommonDirectory(repositoryRoot);
    return this.tryReadNamedSetupRecord(
      this.recordPath(commonDirectory, worktreePath, "named-worktrees")
    );
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
      branchState: WorktreeCompletionResult["branchState"] = "present",
      mergeOutcome?: WorktreeMergeOutcome,
      conflictFiles?: string[]
    ): Promise<WorktreeCompletionResult> => {
      await this.persistManagedSettlement(info, {
        lifecycleState: "blocked",
        landingOutcome: "blocked",
        directoryState: "present",
        branchState,
        ...(mergeOutcome ? { mergeOutcome } : {}),
        ...(conflictFiles ? { conflictFiles } : {}),
        message,
      });
      return {
        landingOutcome: "blocked",
        ...(mergeOutcome ? { mergeOutcome } : {}),
        directoryOutcome: "kept",
        branchState,
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
        ...(conflictFiles ? { conflictFiles } : {}),
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
            return blocked(
              "Managed ownership record is missing or mismatched."
            );
          }
          if (
            !(await this.tryResolveLocalBranch(repositoryRoot, info.branchName))
          ) {
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

          const [paths, untrackedPaths] = await Promise.all([
            getGitTrackedAndUntrackedFiles(info.worktreePath),
            getGitUntrackedFiles(info.worktreePath),
          ]);
          const untrackedPathSet = new Set(untrackedPaths);
          const executionRootRelative = path.relative(
            info.executionWorkspace.executionCheckoutRoot ?? info.worktreePath,
            info.executionWorkspace.executionRoot
          );
          const blockedRuntimePaths = paths.filter(
            (repositoryRelativePath) =>
              (untrackedPathSet.has(repositoryRelativePath) &&
                isWorkspaceInitializerRuntimePath(
                  repositoryRelativePath,
                  executionRootRelative
                )) ||
              isWorkspaceInitializerUnsafePath(
                repositoryRelativePath,
                executionRootRelative
              )
          );
          if (blockedRuntimePaths.length > 0) {
            return blocked(
              `Managed landing is blocked by unsafe or non-ignored untracked runtime paths: ${blockedRuntimePaths.join(", ")}`
            );
          }

          const changed = await hasUncommittedChanges(info.worktreePath);
          if (changed) {
            await commitAll(
              info.worktreePath,
              buildManagedAutoCommitMessage(
                info.workflowName ?? info.branchName
              )
            );
          }

          const committedHead = await resolveCommit(info.worktreePath, "HEAD");
          const watermark = getManagedWorktreeWatermark(record);
          if (committedHead === watermark) {
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

          let changedFileCount: number | undefined;
          try {
            changedFileCount = (
              await getDiffFilesBetweenRefs(
                repositoryRoot,
                watermark,
                committedHead
              )
            ).length;
          } catch {
            // A missing count must not turn an already-landed commit into a
            // blocked settlement. The branch and base remain authoritative.
          }
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
            directoryState: "present",
            branchState: "present",
            lastVerifiedBranchTip: finalTip,
            finalBranchTip: finalTip,
          };
          await this.writeRecord(recordPath, landedRecord);
          await this.persistRuntime({
            lifecycleState: "settled",
            landingOutcome: "landed",
            directoryState: "present",
            branchState: "present",
            finalBranchTip: finalTip,
            ...(changedFileCount !== undefined ? { changedFileCount } : {}),
            updatedAt: this.now(),
          });

          const mergeResult = options.merge
            ? await this.mergeManagedWorktree(info)
            : undefined;
          if (mergeResult) {
            await this.persistRuntime({
              mergeOutcome: mergeResult.mergeOutcome,
              ...(mergeResult.conflictFiles
                ? { conflictFiles: mergeResult.conflictFiles }
                : {}),
              ...(mergeResult.message ? { message: mergeResult.message } : {}),
              updatedAt: this.now(),
            });
          }

          if (keep) {
            return {
              landingOutcome: "landed",
              ...(mergeResult
                ? { mergeOutcome: mergeResult.mergeOutcome }
                : {}),
              directoryOutcome: "kept",
              branchState: "present",
              branchName: info.branchName,
              ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
              autoCommitted: true,
              ...(changedFileCount !== undefined ? { changedFileCount } : {}),
              ...(mergeResult?.conflictFiles
                ? { conflictFiles: mergeResult.conflictFiles }
                : {}),
              ...(mergeResult?.message ? { message: mergeResult.message } : {}),
            };
          }

          return this.removeAfterLanding(
            repositoryRoot,
            recordPath,
            landedRecord,
            info,
            true,
            changedFileCount,
            mergeResult
          );
        }
      );
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error));
    } finally {
      await info.lease?.release().catch(() => undefined);
    }
  }

  /**
   * Merge the managed branch into the source checkout captured at creation.
   * This is deliberately independent of worktree removal so the dashboard can
   * reuse the same guarded operation once merge actions are exposed.
   */
  public async mergeManagedWorktree(
    info: WorktreeInfo
  ): Promise<WorktreeMergeResult> {
    const guard = async (): Promise<string | undefined> => {
      if (!info.targetBranch) {
        return "Merge is unavailable because the source checkout was detached when the worktree was created.";
      }
      const checkedOutBranch = await currentBranch(info.sourceCheckoutRoot);
      if (checkedOutBranch !== info.targetBranch) {
        return `Merge blocked: source checkout is on "${checkedOutBranch ?? "detached HEAD"}", expected "${info.targetBranch}".`;
      }
      if (await hasGitOperationInProgress(info.sourceCheckoutRoot)) {
        return "Merge blocked: a Git operation is already in progress in the source checkout.";
      }
      if (await hasUncommittedChanges(info.sourceCheckoutRoot)) {
        return "Merge blocked: the source checkout working tree or index is dirty.";
      }
      return undefined;
    };

    const initialGuardFailure = await guard();
    if (initialGuardFailure) {
      return { mergeOutcome: "blocked", message: initialGuardFailure };
    }

    let sourceLease: ExecutionLeaseHandle | undefined;
    try {
      sourceLease = await this.leaseManager.acquire({
        mode: "exclusive-worktree",
        stateRoot: info.lease?.stateRoot ?? info.executionWorkspace.stateRoot,
        executionRoot: info.sourceCheckoutRoot,
        workflowKey: info.workflowKey,
        runRef: info.runRef,
        runner: info.lease?.runner ?? "vscode",
        instanceId: info.lease?.instanceId ?? crypto.randomUUID(),
      });
    } catch (error) {
      return {
        mergeOutcome: "blocked",
        message: `Merge blocked: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const postLeaseGuardFailure = await guard();
      if (postLeaseGuardFailure) {
        return { mergeOutcome: "blocked", message: postLeaseGuardFailure };
      }

      const managedBranchRef = `refs/heads/${info.branchName}`;
      try {
        await this.mergeOperations.fastForward(
          info.sourceCheckoutRoot,
          managedBranchRef
        );
        return { mergeOutcome: "fast-forward" };
      } catch {
        // A fast-forward refusal is the expected signal for a divergent
        // source branch. The guarded non-ff attempt below handles that case.
      }

      try {
        await this.mergeOperations.noFastForward(
          info.sourceCheckoutRoot,
          managedBranchRef
        );
        return { mergeOutcome: "merge-commit" };
      } catch (error) {
        const conflictFiles = await this.mergeOperations
          .getUnmergedPaths(info.sourceCheckoutRoot)
          .catch(() => []);
        const mergeInProgress = await hasGitOperationInProgress(
          info.sourceCheckoutRoot
        );
        const failureMessage =
          error instanceof Error ? error.message : String(error);
        if (!mergeInProgress && conflictFiles.length === 0) {
          return {
            mergeOutcome: "blocked",
            message: `Merge blocked: ${failureMessage}`,
          };
        }

        try {
          await this.mergeOperations.abort(info.sourceCheckoutRoot);
        } catch (abortError) {
          return {
            mergeOutcome: "abort-failed",
            conflictFiles,
            message: `Merge conflict abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`,
          };
        }

        const abortRestoredCleanState =
          !(await hasGitOperationInProgress(info.sourceCheckoutRoot)) &&
          !(await hasUncommittedChanges(info.sourceCheckoutRoot));
        if (!abortRestoredCleanState) {
          return {
            mergeOutcome: "abort-failed",
            conflictFiles,
            message:
              "Merge conflict abort did not restore a clean, non-merging source checkout.",
          };
        }

        return { mergeOutcome: "conflict", conflictFiles };
      }
    } finally {
      await sourceLease.release().catch(() => undefined);
    }
  }

  private async validateManagedCheckoutIdentity(
    repositoryRoot: string,
    info: WorktreeInfo,
    record: ManagedWorktreeOwnershipRecord
  ): Promise<
    { ok: true; headCommit: string } | { ok: false; message: string }
  > {
    if (!(await this.pathExists(info.worktreePath))) {
      return { ok: false, message: "Managed worktree directory is missing." };
    }
    if (await hasGitOperationInProgress(info.worktreePath)) {
      return {
        ok: false,
        message: "A Git operation is in progress in the managed worktree.",
      };
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
      return {
        ok: false,
        message: "Managed worktree HEAD does not match its branch ref.",
      };
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
        finalBranchTip: getManagedWorktreeWatermark(record),
      });
      await this.persistRuntime({
        lifecycleState: "settled",
        landingOutcome: "no-changes",
        directoryState: "present",
        branchState: "present",
        finalBranchTip: getManagedWorktreeWatermark(record),
        changedFileCount: 0,
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
        finalBranchTip: getManagedWorktreeWatermark(record),
      },
      info,
      false,
      0
    );
  }

  private async removeAfterLanding(
    repositoryRoot: string,
    recordPath: string,
    record: ManagedWorktreeOwnershipRecord,
    info: WorktreeInfo,
    autoCommitted: boolean,
    changedFileCount?: number,
    mergeResult?: WorktreeMergeResult
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
        landingOutcome:
          record.recoveryOutcome === "no-changes" ? "no-changes" : "landed",
        directoryState: "remove-failed",
        branchState: "present",
        ...(mergeResult ? { mergeOutcome: mergeResult.mergeOutcome } : {}),
        ...(mergeResult?.conflictFiles
          ? { conflictFiles: mergeResult.conflictFiles }
          : {}),
        ...(mergeResult?.message ? { message: mergeResult.message } : {}),
        finalBranchTip: record.finalBranchTip,
        ...(changedFileCount !== undefined ? { changedFileCount } : {}),
        updatedAt: this.now(),
      });
      return {
        landingOutcome:
          record.recoveryOutcome === "no-changes" ? "no-changes" : "landed",
        directoryOutcome: "remove-failed",
        branchState: "present",
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
        ...(mergeResult ? { mergeOutcome: mergeResult.mergeOutcome } : {}),
        ...(autoCommitted ? { autoCommitted: true } : {}),
        ...(changedFileCount !== undefined ? { changedFileCount } : {}),
        ...(mergeResult?.conflictFiles
          ? { conflictFiles: mergeResult.conflictFiles }
          : {}),
        ...(mergeResult?.message ? { message: mergeResult.message } : {}),
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
      // Settlement uses the per-attempt watermark above, but deletion must
      // stay gated on the original base so a landed append's branch survives.
      if (branchTip !== record.baseCommit) {
        branchState = branchTip ? "present" : "missing";
        message =
          "Managed no-change branch changed before deletion; it was kept.";
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
      ...(mergeResult ? { mergeOutcome: mergeResult.mergeOutcome } : {}),
      ...(mergeResult?.conflictFiles
        ? { conflictFiles: mergeResult.conflictFiles }
        : {}),
      ...(mergeResult?.message ? { message: mergeResult.message } : {}),
      finalBranchTip: record.finalBranchTip,
      ...(changedFileCount !== undefined ? { changedFileCount } : {}),
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
      ...(mergeResult ? { mergeOutcome: mergeResult.mergeOutcome } : {}),
      ...(autoCommitted ? { autoCommitted: true } : {}),
      ...(changedFileCount !== undefined ? { changedFileCount } : {}),
      ...(mergeResult?.conflictFiles
        ? { conflictFiles: mergeResult.conflictFiles }
        : {}),
      ...(mergeResult?.message ? { message: mergeResult.message } : {}),
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
        ...(patch.finalBranchTip
          ? { finalBranchTip: patch.finalBranchTip }
          : {}),
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
      let records = await this.readRecords(commonDirectory);
      await this.reconcileBlockedManagedWorktrees(
        sourceCheckoutRoot,
        commonDirectory,
        records
      );
      records = await this.readRecords(commonDirectory);
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
      const sourceCheckoutDirty = existingRecord
        ? undefined
        : await hasUncommittedChanges(sourceCheckoutRoot);
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
      let directoryRecreated = false;
      if (!attached) {
        directoryRecreated = true;
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

      const executionRoot = this.buildExecutionWorkspace(
        repositoryInputs,
        worktreePath,
        options
      ).executionRoot;
      await WorkspaceInitializer.initializeIfNeeded(executionRoot);
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
        recordPath,
        repositoryInputs,
        origin,
        // The observed addWorktree call is authoritative: it proves this
        // invocation provisioned a directory. A recorded "removed" state is
        // corroboration for the normal append shape, but may be stale if the
        // checkout was retained, so it must not replace the observation.
        directoryRecreated,
        options,
        sourceCheckoutDirty,
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
      let records = await this.readRecords(commonDirectory);
      await this.reconcileBlockedManagedWorktrees(
        sourceCheckoutRoot,
        commonDirectory,
        records
      );
      records = await this.readRecords(commonDirectory);
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
        recordPath,
        repositoryInputs: await this.resolveExecutionInputs(
          sourceCheckoutRoot,
          this.recoveryAsResolveOptions(record, options)
        ),
        origin: "recovered",
        directoryRecreated: false,
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
   * Read the settings-page management model. This method never mutates Git;
   * divergence is deliberately served from the process cache when available.
   */
  public async getManagementState(
    sourceCheckoutRoot: string
  ): Promise<WorktreeManagementState> {
    const sourceRoot = await this.requireRepositoryRoot(sourceCheckoutRoot);
    const commonDirectory = await this.requireCommonDirectory(sourceRoot);
    const [records, entries] = await Promise.all([
      this.readRecords(commonDirectory),
      listGitWorktrees(sourceRoot),
    ]);
    const now = this.now();
    const managedEntries: WorktreeManagementEntry[] = [];

    for (const entry of entries) {
      const record = records.find(
        (candidate) =>
          candidate.branchName === entry.branchName &&
          pathsEqual(candidate.worktreePath, entry.worktreePath)
      );
      const inspections = await ExecutionRootLeaseManager.inspectLeases(
        entry.worktreePath,
        now
      );
      const leaseOwners = inspections
        .filter((inspection) => !inspection.stale)
        .map((inspection) => ({
          lease: inspection.lease,
          ageMs: inspection.ageMs,
          retryAction: "retry" as const,
        }));
      const inUse = leaseOwners.length > 0;
      const branchState = entry.branchName
        ? (await localBranchExists(sourceRoot, entry.branchName))
          ? "present"
          : "missing"
        : "missing";
      const divergence =
        !record && entry.branchName
          ? WorktreeManager.namedDivergenceCache.get(
              this.divergenceCacheKey(sourceRoot, entry.branchName)
            )
          : undefined;
      const createdAt = record?.createdAt;
      const branchCleanup = record
        ? await this.getBranchCleanupEligibility(
            sourceRoot,
            record,
            entry,
            inUse
          )
        : { eligible: false, reason: "Only ctrlyoke-owned branches qualify." };
      managedEntries.push({
        worktreePath: entry.worktreePath,
        headCommit: entry.headCommit,
        ...(entry.branchName ? { branchName: entry.branchName } : {}),
        ownership: record ? "managed" : "user",
        ...(record?.lifecycleState
          ? { lifecycleState: record.lifecycleState }
          : {}),
        ...(record?.directoryState
          ? { directoryState: record.directoryState }
          : {}),
        branchState,
        ...(createdAt !== undefined
          ? { createdAt, ageMs: now - createdAt }
          : {}),
        inUse,
        leaseOwners,
        stale: Boolean(entry.prunableReason),
        ...(entry.prunableReason
          ? { prunableReason: entry.prunableReason }
          : {}),
        ...(record?.targetBranch ? { targetBranch: record.targetBranch } : {}),
        branchCleanupEligible: branchCleanup.eligible,
        ...(branchCleanup.reason
          ? { branchCleanupReason: branchCleanup.reason }
          : {}),
        ...(divergence ? { divergence } : {}),
      });
    }

    const staleManagedRecords = records.filter(
      (record) =>
        !managedEntries.some(
          (entry) =>
            entry.ownership === "managed" &&
            entry.branchName === record.branchName &&
            pathsEqual(entry.worktreePath, record.worktreePath)
        )
    );

    for (const record of staleManagedRecords) {
      managedEntries.push({
        worktreePath: record.worktreePath,
        headCommit: record.lastVerifiedBranchTip,
        branchName: record.branchName,
        ownership: "managed",
        lifecycleState: record.lifecycleState,
        directoryState: record.directoryState,
        branchState: record.branchState,
        createdAt: record.createdAt,
        ageMs: now - record.createdAt,
        inUse: false,
        leaseOwners: [],
        stale: true,
        branchCleanupEligible: false,
        branchCleanupReason:
          "The Git worktree admin entry is stale; repair is required.",
        ...(record.targetBranch ? { targetBranch: record.targetBranch } : {}),
      });
    }

    return {
      resolvedRoot: await this.resolveWorktreeRoot(sourceRoot),
      entries: managedEntries,
      staleManagedRecords,
      generatedAt: now,
    };
  }

  /** Refresh named-branch divergence and return a new management snapshot. */
  public async refreshManagementState(
    sourceCheckoutRoot: string
  ): Promise<WorktreeManagementState> {
    const sourceRoot = await this.requireRepositoryRoot(sourceCheckoutRoot);
    const entries = await listGitWorktrees(sourceRoot);
    for (const entry of entries) {
      if (!entry.branchName || pathsEqual(entry.worktreePath, sourceRoot))
        continue;
      const label = await getBranchUpstream(sourceRoot, entry.branchName);
      if (!label) continue;
      try {
        const comparisonCommit = await resolveCommit(sourceRoot, label);
        const counts = await getAheadBehind(
          sourceRoot,
          comparisonCommit,
          `refs/heads/${entry.branchName}`
        );
        WorktreeManager.namedDivergenceCache.set(
          this.divergenceCacheKey(sourceRoot, entry.branchName),
          {
            comparisonLabel: label,
            comparisonCommit,
            ...counts,
            calculatedAt: this.now(),
          }
        );
      } catch {
        // Divergence is informational. An unavailable upstream never blocks a run.
      }
    }
    return this.getManagementState(sourceRoot);
  }

  /** Apply one explicitly requested management action after revalidation. */
  public async applyManagementAction(
    options: WorktreeManagementActionOptions
  ): Promise<void> {
    const sourceRoot = await this.requireRepositoryRoot(
      options.sourceCheckoutRoot
    );
    if (
      (options.action === WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE ||
        (options.action === WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH &&
          options.confirmed)) &&
      options.confirmed !== true
    ) {
      throw new Error(
        "This destructive worktree action requires confirmation."
      );
    }
    if (options.action === WORKTREE_MANAGEMENT_ACTIONS.PRUNE) {
      await pruneWorktrees(sourceRoot);
      return;
    }
    if (!options.worktreePath && !options.branchName) {
      throw new Error("A worktree or branch target is required.");
    }

    await withRepositoryWorktreeMutationLock(sourceRoot, async () => {
      const commonDirectory = await this.requireCommonDirectory(sourceRoot);
      const records = await this.readRecords(commonDirectory);
      const record = records.find(
        (candidate) =>
          (options.branchName && candidate.branchName === options.branchName) ||
          (options.worktreePath &&
            pathsEqual(candidate.worktreePath, options.worktreePath))
      );
      if (!record) {
        throw new Error(
          "Only a valid ctrlyoke ownership record can be changed."
        );
      }
      if (options.action === WORKTREE_MANAGEMENT_ACTIONS.REPAIR) {
        if (!pathsEqual(record.worktreePath, options.worktreePath ?? "")) {
          throw new Error(
            "Targeted repair must name the recorded worktree path."
          );
        }
        await repairWorktree(sourceRoot, record.worktreePath);
        return;
      }

      const currentEntries = await listGitWorktrees(sourceRoot);
      const entry = currentEntries.find(
        (candidate) =>
          candidate.branchName === record.branchName &&
          pathsEqual(candidate.worktreePath, record.worktreePath)
      );
      const inspections = entry
        ? await ExecutionRootLeaseManager.inspectLeases(record.worktreePath)
        : [];
      const liveLease = inspections.find((inspection) => !inspection.stale);
      if (liveLease) {
        const owner = liveLease.lease;
        throw new Error(
          `Worktree is in use by workflow ${owner.workflowKey}, run ${owner.runRef}.`
        );
      }

      if (
        options.action === WORKTREE_MANAGEMENT_ACTIONS.REMOVE ||
        options.action === WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE
      ) {
        if (!entry)
          throw new Error(
            "The worktree admin entry is stale; repair it first."
          );
        await removeWorktree(
          sourceRoot,
          record.worktreePath,
          options.action === WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE
        );
        await this.writeRecord(
          this.recordPath(commonDirectory, record.branchName),
          {
            ...record,
            lifecycleState: "settled",
            directoryState: "removed",
          }
        );
        return;
      }

      if (options.action === WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH) {
        if (entry) throw new Error("A checked-out branch cannot be deleted.");
        const runnerStatus = await WorkflowLockManager.checkLock(
          record.stateRoot,
          record.workflowKey
        );
        if (runnerStatus !== LOCK_STATUS.NONE) {
          throw new Error("The managed run is still live or recoverable.");
        }
        const currentTip = await resolveCommit(
          sourceRoot,
          `refs/heads/${record.branchName}`
        );
        if (currentTip !== record.lastVerifiedBranchTip) {
          throw new Error(
            "The branch tip changed outside ctrlyoke; refusing cleanup."
          );
        }
        const eligible = await this.getBranchCleanupEligibility(
          sourceRoot,
          record,
          undefined,
          false
        );
        if (!eligible.eligible && options.confirmed !== true) {
          throw new Error(
            `${eligible.reason ?? "Branch is not provably merged."} Confirm explicit deletion to continue.`
          );
        }
        await deleteLocalBranch(
          sourceRoot,
          record.branchName,
          options.confirmed === true
        );
        await this.writeRecord(
          this.recordPath(commonDirectory, record.branchName),
          { ...record, branchState: "deleted" }
        );
      }
    });
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

    const commonDirectory =
      await this.requireCommonDirectory(sourceCheckoutRoot);
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
    const executionCheckoutRoot = worktreePath;
    const namedSetupRecordPath = this.recordPath(
      commonDirectory,
      executionCheckoutRoot,
      "named-worktrees"
    );
    const namedSetupRecord =
      await this.tryReadNamedSetupRecord(namedSetupRecordPath);
    const mapSourcePath = (sourcePath: string): string =>
      path.resolve(
        executionCheckoutRoot,
        path.relative(sourceCheckoutRoot, sourcePath)
      );
    const executionRoot = mapSourcePath(repositoryInputs.executionRoot);
    if (
      namedSetupRecord &&
      namedSetupRecord.setupOutcome !== "succeeded" &&
      !options.setup?.trim()
    ) {
      throw new Error(
        `Named worktree setup is ${namedSetupRecord.setupOutcome}; a setup command is required to re-provision it.`
      );
    }
    await WorkspaceInitializer.initializeIfNeeded(executionRoot);
    const dirty = await hasUncommittedChanges(executionCheckoutRoot);
    const baseCommit = await resolveCommit(executionCheckoutRoot, "HEAD");
    const comparisonBaseLabel =
      options.base?.trim() ||
      (await getBranchUpstream(executionCheckoutRoot, branchName));
    let comparisonBaseCommit: string | undefined;
    if (comparisonBaseLabel) {
      try {
        comparisonBaseCommit = await resolveCommit(
          executionCheckoutRoot,
          comparisonBaseLabel
        );
        void getAheadBehind(
          executionCheckoutRoot,
          comparisonBaseCommit,
          `refs/heads/${branchName}`
        )
          .then((counts) => {
            WorktreeManager.namedDivergenceCache.set(
              this.divergenceCacheKey(sourceCheckoutRoot, branchName),
              {
                comparisonLabel: comparisonBaseLabel,
                comparisonCommit: comparisonBaseCommit!,
                ...counts,
                calculatedAt: this.now(),
              }
            );
          })
          .catch(() => undefined);
      } catch {
        // A missing configured comparison base is informational only.
        WorktreeManager.namedDivergenceCache.delete(
          this.divergenceCacheKey(sourceCheckoutRoot, branchName)
        );
      }
    } else {
      WorktreeManager.namedDivergenceCache.delete(
        this.divergenceCacheKey(sourceCheckoutRoot, branchName)
      );
    }
    const mappedNamedWorkspaceRoots = repositoryInputs.namedWorkspaceRoots.map(
      (rootEntry) => ({
        ...rootEntry,
        fsPath: mapSourcePath(rootEntry.fsPath),
      })
    );
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

    // A checkout this call created is unprovisioned by definition, so it must
    // run setup even when a record survives from a previous checkout at the
    // same path: named worktree paths are derived deterministically from the
    // branch, so removing and recreating one reuses the earlier record's key.
    const shouldRunSetup =
      Boolean(options.setup?.trim()) &&
      (origin === "created" || namedSetupRecord?.setupOutcome !== "succeeded");
    let setupOutcome: WorktreeInfo["setupOutcome"] = options.setup?.trim()
      ? namedSetupRecord?.setupOutcome
      : undefined;
    if (shouldRunSetup) {
      setupOutcome = "pending";
      await this.writeNamedSetupRecord(namedSetupRecordPath, {
        worktreePath: executionCheckoutRoot,
        setupOutcome,
      });
      await this.persistRuntime({
        lifecycleState: "provisioning",
        directoryState: "present",
        branchState: "present",
        setupOutcome,
        updatedAt: this.now(),
      });
      try {
        setupOutcome = "running";
        await this.writeNamedSetupRecord(namedSetupRecordPath, {
          worktreePath: executionCheckoutRoot,
          setupOutcome,
        });
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
          options.vars,
          options.setupAttemptIndex ?? 0,
          options.worktreeSetupRunner
        );
        setupOutcome = "succeeded";
        await this.writeNamedSetupRecord(namedSetupRecordPath, {
          worktreePath: executionCheckoutRoot,
          setupOutcome,
        });
      } catch (error) {
        setupOutcome = "failed";
        await this.writeNamedSetupRecord(namedSetupRecordPath, {
          worktreePath: executionCheckoutRoot,
          setupOutcome,
        });
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
      ...(comparisonBaseLabel && comparisonBaseCommit
        ? { comparisonBaseLabel, comparisonBaseCommit }
        : {}),
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
      ...(comparisonBaseLabel && comparisonBaseCommit
        ? { comparisonBaseLabel, comparisonBaseCommit }
        : {}),
      ...(setupOutcome ? { setupOutcome } : {}),
    });
    return info;
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
    vars: Record<string, string> | undefined,
    attemptIndex: number,
    setupRunner?: WorktreeSetupRunner
  ): Promise<void> {
    const command = VarSubstitutor.substitute(setup, vars ?? {});
    const result = await (setupRunner ?? this.worktreeSetupRunner).run({
      executionRoot,
      command,
      vars,
      timeoutMs: ConfigurationUtils.getScriptTimeoutMs(),
      attemptIndex,
    });
    if (!result.success) {
      throw new Error(
        result.error || `Setup exited with code ${result.exitCode ?? "unknown"}`
      );
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

  private recordPath(
    commonDirectory: string,
    key: string,
    store: "managed-worktrees" | "named-worktrees" = "managed-worktrees"
  ): string {
    const recordKey =
      store === "managed-worktrees"
        ? normalizeBranchName(key)
        : path.resolve(key);
    const keyHash = crypto
      .createHash("sha256")
      .update(recordKey, "utf8")
      .digest("hex");
    return path.join(commonDirectory, "ctrlyoke", store, `${keyHash}.json`);
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
    return this.tryReadJsonRecord<ManagedWorktreeOwnershipRecord>(
      recordPath,
      (parsed) => {
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
          (parsed.setupOutcome !== undefined &&
            parsed.setupOutcome !== "succeeded" &&
            parsed.setupOutcome !== "failed") ||
          !parsed.lifecycleState ||
          !parsed.directoryState ||
          !parsed.branchState
        ) {
          return undefined;
        }
        return parsed as ManagedWorktreeOwnershipRecord;
      }
    );
  }

  private async tryReadNamedSetupRecord(
    recordPath: string
  ): Promise<NamedWorktreeSetupRecord | undefined> {
    return this.tryReadJsonRecord<NamedWorktreeSetupRecord>(
      recordPath,
      (parsed) => {
        if (
          parsed.schemaVersion !== NAMED_WORKTREE_SETUP_RECORD_SCHEMA_VERSION ||
          typeof parsed.worktreePath !== "string" ||
          (parsed.setupOutcome !== "pending" &&
            parsed.setupOutcome !== "running" &&
            parsed.setupOutcome !== "succeeded" &&
            parsed.setupOutcome !== "failed") ||
          typeof parsed.updatedAt !== "number"
        ) {
          return undefined;
        }
        return parsed as NamedWorktreeSetupRecord;
      }
    );
  }

  private async tryReadJsonRecord<T>(
    recordPath: string,
    validate: (parsed: Partial<T>) => T | undefined
  ): Promise<T | undefined> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(recordPath, "utf8")
      ) as Partial<T>;
      return validate(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A partially written/corrupt record is not ownership or setup evidence.
      return undefined;
    }
  }

  private async writeNamedSetupRecord(
    recordPath: string,
    record: Pick<NamedWorktreeSetupRecord, "worktreePath" | "setupOutcome">
  ): Promise<void> {
    await this.writeRecord(recordPath, {
      schemaVersion: NAMED_WORKTREE_SETUP_RECORD_SCHEMA_VERSION,
      ...record,
      updatedAt: this.now(),
    });
  }

  private async writeRecord(
    recordPath: string,
    record: ManagedWorktreeOwnershipRecord | NamedWorktreeSetupRecord
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
    const inspections =
      await ExecutionRootLeaseManager.inspectLeases(executionRoot);
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

  /**
   * Reclaim failed managed setup attempts when a managed run is retried or a
   * durable record is explicitly recovered. The failed checkout remains
   * inspectable until that trigger, but it must not become permanent state.
   *
   * This method is called while the repository mutation lock is held. It only
   * considers records that explicitly identify a failed setup, checks the
   * worktree lease before removal, and unlinks the ownership record last.
   */
  private async reconcileBlockedManagedWorktrees(
    repositoryRoot: string,
    commonDirectory: string,
    records: readonly ManagedWorktreeOwnershipRecord[]
  ): Promise<void> {
    const candidates = records.filter(
      (record) =>
        pathsEqual(record.sourceCheckoutRoot, repositoryRoot) &&
        record.lifecycleState === "blocked" &&
        record.setupOutcome === "failed"
    );
    if (candidates.length === 0) return;

    let entries = await listGitWorktrees(repositoryRoot);
    for (const record of candidates) {
      const liveLease = (
        await ExecutionRootLeaseManager.inspectLeases(record.worktreePath)
      ).some((inspection) => !inspection.stale);
      if (liveLease) continue;

      const entry = entries.find(
        (candidate) =>
          candidate.branchName === record.branchName &&
          pathsEqual(candidate.worktreePath, record.worktreePath)
      );
      const unexpectedEntry = entries.find(
        (candidate) => candidate.branchName === record.branchName
      );
      if (unexpectedEntry && !entry) continue;

      if (entry) {
        try {
          // A failed setup may have left ignored or untracked output behind.
          // The ownership record and the absence of a live lease authorize
          // removing this managed checkout on the retry/recovery trigger.
          await removeWorktree(repositoryRoot, record.worktreePath, true);
        } catch {
          continue;
        }
        entries = await listGitWorktrees(repositoryRoot);
        if (
          entries.some(
            (candidate) => candidate.branchName === record.branchName
          )
        ) {
          continue;
        }
      } else if (await this.pathExists(record.worktreePath)) {
        // A directory without its matching Git admin entry needs explicit
        // repair; never remove an ambiguous path during reconciliation.
        continue;
      }

      const branchTip = await this.tryResolveLocalBranch(
        repositoryRoot,
        record.branchName
      );
      let branchState: ManagedWorktreeOwnershipRecord["branchState"] =
        "missing";
      if (branchTip) {
        // A changed watermark is evidence that ctrlyoke landed or otherwise
        // verified commits on this branch. Keep it even though setup failed.
        const branchIsUntouched =
          branchTip === record.lastVerifiedBranchTip &&
          getManagedWorktreeWatermark(record) === record.baseCommit;
        if (branchIsUntouched) {
          try {
            await deleteLocalBranch(repositoryRoot, record.branchName);
            branchState = "deleted";
          } catch {
            branchState = "present";
          }
        } else {
          branchState = "present";
        }
      }

      const recordPath = this.recordPath(commonDirectory, record.branchName);
      const reconciledRecord: ManagedWorktreeOwnershipRecord = {
        ...record,
        lifecycleState: "settled",
        directoryState: "removed",
        branchState,
      };
      await this.writeRecord(recordPath, reconciledRecord);

      if (branchState === "deleted" || branchState === "missing") {
        // Keep the record as a tombstone until both independently-owned
        // resources have been observed gone. A crash before this unlink is
        // therefore safe to reconcile again.
        await fs.unlink(recordPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
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
      ...(options.workflowName ? { workflowName: options.workflowName } : {}),
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
    recordPath: string;
    repositoryInputs: ResolvedRepositoryInputs;
    origin: WorktreeOrigin;
    directoryRecreated: boolean;
    options: EnsureManagedWorktreeOptions;
    sourceCheckoutDirty?: boolean;
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
      Boolean(args.options.setup?.trim()) &&
      (args.origin === "created" || args.directoryRecreated);
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
        // Recreated managed directories omit ignored dependencies and caches,
        // so setup must remain idempotent as append continuations re-provision.
        await this.runSetup(
          args.record.worktreePath,
          args.options.setup!,
          args.options.vars,
          args.options.setupAttemptIndex ?? 0,
          args.options.worktreeSetupRunner
        );
        setupOutcome = "succeeded";
      } catch (error) {
        setupOutcome = "failed";
        await this.writeRecord(args.recordPath, {
          ...args.record,
          lifecycleState: "blocked",
          directoryState: "present",
          branchState: "present",
          setupOutcome,
        });
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
    const readyRecord: ManagedWorktreeOwnershipRecord = {
      ...args.record,
      lifecycleState: "ready",
      directoryState: "present",
      branchState: "present",
    };
    if (setupOutcome === "succeeded" || setupOutcome === "failed") {
      readyRecord.setupOutcome = setupOutcome;
    } else {
      delete readyRecord.setupOutcome;
    }
    await this.writeRecord(args.recordPath, readyRecord);
    const dirty = await hasUncommittedChanges(args.record.worktreePath);
    const info: ActiveWorktreeInfo = {
      mode: "managed",
      origin: args.origin,
      lifecycleOwner: "ctrlyoke",
      branchName: args.record.branchName,
      worktreePath: args.record.worktreePath,
      sourceCheckoutRoot: args.record.sourceCheckoutRoot,
      baseCommit: args.record.baseCommit,
      ...(args.sourceCheckoutDirty !== undefined
        ? { sourceCheckoutDirty: args.sourceCheckoutDirty }
        : {}),
      targetBranch: args.record.targetBranch,
      workflowKey: args.record.workflowKey,
      runRef: args.record.runRef,
      ...(args.options.workflowName
        ? { workflowName: args.options.workflowName }
        : {}),
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
      ...(args.sourceCheckoutDirty !== undefined
        ? { sourceCheckoutDirty: args.sourceCheckoutDirty }
        : {}),
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

  private divergenceCacheKey(sourceRoot: string, branchName: string): string {
    return `${path.resolve(sourceRoot)}\0${branchName}`;
  }

  private async getBranchCleanupEligibility(
    sourceRoot: string,
    record: ManagedWorktreeOwnershipRecord,
    entry: GitWorktreeEntry | undefined,
    inUse: boolean
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (entry) return { eligible: false, reason: "Branch is checked out." };
    if (inUse) return { eligible: false, reason: "Worktree has a live lease." };
    if (!record.targetBranch) {
      return {
        eligible: false,
        reason: "The ownership record has no recorded target branch.",
      };
    }
    if (
      (await WorkflowLockManager.checkLock(
        record.stateRoot,
        record.workflowKey
      )) !== LOCK_STATUS.NONE
    ) {
      return {
        eligible: false,
        reason: "The managed run is live or recoverable.",
      };
    }
    let currentTip: string;
    try {
      currentTip = await resolveCommit(
        sourceRoot,
        `refs/heads/${record.branchName}`
      );
    } catch {
      return {
        eligible: false,
        reason: "The recorded branch no longer exists.",
      };
    }
    if (currentTip !== record.lastVerifiedBranchTip) {
      return {
        eligible: false,
        reason: "The branch tip changed outside ctrlyoke.",
      };
    }
    if (
      !(await isCommitAncestor(
        sourceRoot,
        `refs/heads/${record.branchName}`,
        record.targetBranch
      ))
    ) {
      return {
        eligible: false,
        reason: `The branch is not proven merged into ${record.targetBranch}.`,
      };
    }
    return { eligible: true };
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
