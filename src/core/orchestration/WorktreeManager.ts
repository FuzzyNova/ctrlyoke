import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import { Log } from "../../utils/Log";
import { getErrorMessage } from "../../utils/ErrorUtils";
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
  GitLocationMemo,
  liveGitLocations,
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
  resolveCommit,
  isCommitAncestor,
  localBranchExists,
  validateBranchName,
  type GitLocationLookup,
  type GitWorktreeEntry,
} from "../../utils/GitUtils";
import {
  createManagedBranchName,
  createWorktreeDirectoryName,
  resolveThroughNearestExistingAncestor,
  resolveWorktreeRoot as resolveConfiguredRoot,
  withWorktreeMutationLock,
} from "../../utils/WorktreeUtils";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import { readWorkflowLockInspection } from "../../utils/WorkflowLockInspector";
import {
  WORKTREE_MANAGEMENT_ACTIONS,
  WORKTREE_BRANCH_STATES,
  WORKTREE_DIRECTORY_OUTCOMES,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_LIFECYCLE_OWNERS,
  WORKTREE_LIFECYCLE_STATES,
  WORKTREE_MODES,
  WORKTREE_RECOVERY_OUTCOMES,
  WORKTREE_SETUP_OUTCOMES,
  WORKFLOW_LOCK_LIVENESS,
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
import { summarizeStatusError } from "./ScriptExecutionReporter";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { ExecutionWorkspace } from "../../types/WorkflowContextTypes";
import type {
  RunRef,
  WorktreeCompletionResult,
  WorkflowKey,
  WorktreeResolution,
  WorkingFileWorktreeRuntimePatch,
  WorkspaceWorktreeOwnership,
} from "../../types/CtrlYokeTypes";
import { VarSubstitutor } from "../../utils/VarSubstitutor";
import {
  runtimeTrustedRootRegistry,
  type RuntimeTrustedRootHandle,
} from "../../utils/RuntimeTrustedRootRegistry";

export type WorktreeMode =
  typeof WORKTREE_MODES.MANAGED | typeof WORKTREE_MODES.NAMED;
export type WorktreeManagerMode = WorktreeMode;
export const WORKTREE_ORIGINS = {
  CREATED: "created",
  DISCOVERED: "discovered",
  RECOVERED: "recovered",
} as const;
export type WorktreeOrigin =
  (typeof WORKTREE_ORIGINS)[keyof typeof WORKTREE_ORIGINS];
export type WorktreeLifecycleOwner =
  (typeof WORKTREE_LIFECYCLE_OWNERS)[keyof typeof WORKTREE_LIFECYCLE_OWNERS];
export type ManagedWorktreeRecoveryOutcome =
  (typeof WORKTREE_RECOVERY_OUTCOMES)[keyof typeof WORKTREE_RECOVERY_OUTCOMES];

export const MANAGED_WORKTREE_RECORD_SCHEMA_VERSION = 1 as const;
export const NAMED_WORKTREE_SETUP_RECORD_SCHEMA_VERSION = 1 as const;

export type NamedWorktreeSetupOutcome =
  | typeof WORKTREE_SETUP_OUTCOMES.PENDING
  | typeof WORKTREE_SETUP_OUTCOMES.RUNNING
  | typeof WORKTREE_SETUP_OUTCOMES.SUCCEEDED
  | typeof WORKTREE_SETUP_OUTCOMES.FAILED;

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
  lifecycleState: (typeof WORKTREE_LIFECYCLE_STATES)[keyof typeof WORKTREE_LIFECYCLE_STATES];
  directoryState: (typeof WORKTREE_DIRECTORY_STATES)[keyof typeof WORKTREE_DIRECTORY_STATES];
  branchState: (typeof WORKTREE_BRANCH_STATES)[keyof typeof WORKTREE_BRANCH_STATES];
  recoveryOutcome?: ManagedWorktreeRecoveryOutcome;
  finalBranchTip?: string;
  /** A failed managed setup is eligible for deferred cleanup on re-run. */
  setupOutcome?:
    | typeof WORKTREE_SETUP_OUTCOMES.SUCCEEDED
    | typeof WORKTREE_SETUP_OUTCOMES.FAILED;
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

/** Where one operation's repository lives; see `resolveRepositoryContext`. */
interface RepositoryContext {
  repositoryRoot: string;
  commonDirectory: string;
  git: GitLocationMemo;
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

type WorktreeSetupRunnerArgs = Parameters<WorktreeSetupRunner["run"]>[0];

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
  branchState: (typeof WORKTREE_BRANCH_STATES)[keyof typeof WORKTREE_BRANCH_STATES];
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
  /** Canonical Git toplevel entries are compared against, e.g. to hide sync/removal actions on the source checkout's own row. */
  sourceCheckoutRoot: string;
  sourceCheckoutBranch: string | null;
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
  currentManagedWorktree?: WorkspaceWorktreeOwnership;
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

/** Result of a two-way named-worktree sync; see `syncNamedWorktree`. */
export interface WorktreeSyncResult {
  sourceBranch: string;
  worktreeBranch: string;
  /** The worktree's branch merged into the source checkout's current branch. */
  intoSource: WorktreeMergeResult;
  /** The source checkout's current branch merged into the worktree. */
  intoWorktree: WorktreeMergeResult;
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
  /** Advisory sink for unresolved workflow variables in worktree setup. */
  reportUnresolvedVariables?: (placeholders: readonly string[]) => void;
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
    const causeText = cause instanceof Error ? cause.message : String(cause);
    super(
      `Worktree setup failed in ${worktreePath}: ${summarizeStatusError(causeText)}`
    );
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
    return this.resolveWorktreeRootFor(
      await this.requireRepositoryRoot(
        sourceCheckoutRoot,
        new GitLocationMemo()
      )
    );
  }

  /** {@link resolveWorktreeRoot} for a caller that already holds the repository root. */
  private async resolveWorktreeRootFor(sourceRoot: string): Promise<string> {
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
      await this.requireRepositoryRoot(sourceCheckoutRoot, liveGitLocations)
    );
  }

  /**
   * Read-only preview of the `ExecutionWorkspace` a worktree run would use
   * once `executionCheckoutRoot` exists. Dry-run/preview only — performs no
   * Git or filesystem mutation, and never requires `executionCheckoutRoot`
   * to exist yet (a not-yet-created named worktree's deterministic best-guess
   * directory is a valid input). Reuses the exact same source→execution root
   * mapping (`resolveExecutionInputs` + `buildExecutionWorkspace`) real
   * worktree execution uses, so preview and execution can never diverge on
   * which roots are trusted. Returns undefined when the inputs cannot be
   * safely mapped (e.g. an approved external root overlaps the source
   * checkout) rather than throwing, so a preview build degrades to ordinary
   * (non-remapped) behavior instead of failing outright.
   */
  public async previewExecutionWorkspace(
    sourceCheckoutRoot: string,
    executionCheckoutRoot: string,
    options: {
      stateRoot: string;
      namedWorkspaceRoots: readonly ResolverWorkspaceFolder[];
      workspaceRoots?: readonly string[];
      approvedExternalRoots?: readonly string[];
    }
  ): Promise<ExecutionWorkspace | undefined> {
    try {
      const inputs = await this.resolveExecutionInputs(
        sourceCheckoutRoot,
        options
      );
      return this.buildExecutionWorkspace(inputs, executionCheckoutRoot, {
        stateRoot: options.stateRoot,
      });
    } catch (error) {
      Log.warn(
        `[WorktreeManager] Cannot preview execution workspace for ${sourceCheckoutRoot}: ${getErrorMessage(error)}`
      );
      return undefined;
    }
  }

  /**
   * Return the stable record location for a managed branch. The branch itself
   * is never used as a path component; only its bounded hash is.
   */
  public async managedWorktreeRecordPath(
    sourceCheckoutRoot: string,
    branchName: string
  ): Promise<string> {
    const { commonDirectory } =
      await this.resolveRepositoryContext(sourceCheckoutRoot);
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
    const { commonDirectory } =
      await this.resolveRepositoryContext(sourceCheckoutRoot);
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
        await this.requireRepositoryRoot(sourceCheckoutRoot, liveGitLocations),
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
    const { repositoryRoot, commonDirectory } =
      await this.resolveRepositoryContext(sourceCheckoutRoot);
    const normalizedBranch = normalizeBranchName(branchName.trim());
    await withWorktreeMutationLock(commonDirectory, async () => {
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
    const git = new GitLocationMemo();
    const blocked = async (
      message: string,
      branchState: WorktreeCompletionResult["branchState"] = WORKTREE_BRANCH_STATES.PRESENT,
      mergeOutcome?: WorktreeMergeOutcome,
      conflictFiles?: string[]
    ): Promise<WorktreeCompletionResult> => {
      await this.persistManagedSettlement(
        info,
        {
          lifecycleState: WORKTREE_LIFECYCLE_STATES.BLOCKED,
          landingOutcome: WORKTREE_LANDING_OUTCOMES.BLOCKED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState,
          ...(mergeOutcome ? { mergeOutcome } : {}),
          ...(conflictFiles ? { conflictFiles } : {}),
          message,
        },
        git
      );
      return {
        landingOutcome: WORKTREE_LANDING_OUTCOMES.BLOCKED,
        ...(mergeOutcome ? { mergeOutcome } : {}),
        directoryOutcome: WORKTREE_DIRECTORY_OUTCOMES.KEPT,
        branchState,
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
        ...(conflictFiles ? { conflictFiles } : {}),
        message,
      };
    };

    try {
      if (
        info.mode !== WORKTREE_MODES.MANAGED ||
        info.lifecycleOwner !== WORKTREE_LIFECYCLE_OWNERS.CTRLYOKE
      ) {
        return blocked("Only ctrlyoke-owned managed worktrees can be settled.");
      }
      if (options.artifactsClean === false) {
        return blocked(
          options.cleanupMessage ??
            "Provider artifacts could not be proven clean; managed landing is blocked."
        );
      }

      const { repositoryRoot, commonDirectory } =
        await this.resolveRepositoryContext(info.sourceCheckoutRoot, git);
      const recordPath = this.recordPath(commonDirectory, info.branchName);

      return await withWorktreeMutationLock(commonDirectory, async () => {
        const record = await this.tryReadRecord(recordPath);
        if (!record || record.branchName !== info.branchName) {
          return blocked("Managed ownership record is missing or mismatched.");
        }
        if (
          !(await this.tryResolveLocalBranch(repositoryRoot, info.branchName))
        ) {
          return blocked(
            "Managed branch ref is missing; refusing to finalize an unowned checkout.",
            WORKTREE_BRANCH_STATES.MISSING
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
            buildManagedAutoCommitMessage(info.workflowName ?? info.branchName)
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
          lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
          lastVerifiedBranchTip: finalTip,
          finalBranchTip: finalTip,
        };
        await this.writeRecord(recordPath, landedRecord);
        await this.persistRuntime({
          lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
          landingOutcome: WORKTREE_LANDING_OUTCOMES.LANDED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
            landingOutcome: WORKTREE_LANDING_OUTCOMES.LANDED,
            ...(mergeResult ? { mergeOutcome: mergeResult.mergeOutcome } : {}),
            directoryOutcome: WORKTREE_DIRECTORY_OUTCOMES.KEPT,
            branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
      });
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
      return await this.attemptGuardedMerge(
        info.sourceCheckoutRoot,
        `refs/heads/${info.branchName}`
      );
    } finally {
      await sourceLease.release().catch(() => undefined);
    }
  }

  /**
   * Attempt to merge `ref` into the checkout at `dir`: fast-forward first,
   * then a non-interactive merge commit, aborting cleanly and reporting
   * conflict paths on failure. Callers are responsible for their own
   * clean/branch/lease guards before calling this — it performs no guard of
   * its own and always leaves `dir` in a well-defined, non-partial state
   * (merged, blocked-and-untouched, cleanly-aborted, or explicitly
   * abort-failed for manual recovery).
   */
  private async attemptGuardedMerge(
    dir: string,
    ref: string
  ): Promise<WorktreeMergeResult> {
    try {
      await this.mergeOperations.fastForward(dir, ref);
      return { mergeOutcome: "fast-forward" };
    } catch {
      // A fast-forward refusal is the expected signal for a divergent
      // target. The guarded non-ff attempt below handles that case.
    }

    try {
      await this.mergeOperations.noFastForward(dir, ref);
      return { mergeOutcome: "merge-commit" };
    } catch (error) {
      const conflictFiles = await this.mergeOperations
        .getUnmergedPaths(dir)
        .catch(() => []);
      const mergeInProgress = await hasGitOperationInProgress(dir);
      const failureMessage =
        error instanceof Error ? error.message : String(error);
      if (!mergeInProgress && conflictFiles.length === 0) {
        return {
          mergeOutcome: "blocked",
          message: `Merge blocked: ${failureMessage}`,
        };
      }

      try {
        await this.mergeOperations.abort(dir);
      } catch (abortError) {
        return {
          mergeOutcome: "abort-failed",
          conflictFiles,
          message: `Merge conflict abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`,
        };
      }

      const abortRestoredCleanState =
        !(await hasGitOperationInProgress(dir)) &&
        !(await hasUncommittedChanges(dir));
      if (!abortRestoredCleanState) {
        return {
          mergeOutcome: "abort-failed",
          conflictFiles,
          message:
            "Merge conflict abort did not restore a clean, non-merging checkout.",
        };
      }

      return { mergeOutcome: "conflict", conflictFiles };
    }
  }

  /**
   * Two-way sync for a user-owned named worktree: fast-forward (or merge)
   * the worktree's branch into whatever branch the source checkout currently
   * has checked out, then merge that same source branch back into the
   * worktree. This is exactly the pair of `git merge` commands worktree
   * users otherwise run by hand before starting new work on a named
   * worktree; see "ctrlyoke does not automatically rebase, pull, or
   * synchronize named branches" in WORKTREE_SUPPORT_PLAN.md for why this is
   * an explicit, user-invoked dashboard action rather than automatic
   * behavior — it deliberately touches the live source checkout.
   */
  public async syncNamedWorktree(options: {
    sourceCheckoutRoot: string;
    worktreePath: string;
  }): Promise<WorktreeSyncResult> {
    const {
      repositoryRoot: sourceCheckoutRoot,
      commonDirectory,
      git,
    } = await this.resolveRepositoryContext(options.sourceCheckoutRoot);
    const entries = await listGitWorktrees(sourceCheckoutRoot);
    const entry = entries.find((candidate) =>
      pathsEqual(candidate.worktreePath, options.worktreePath)
    );
    if (!entry) {
      throw new Error(
        "The worktree admin entry is stale; repair or refresh first."
      );
    }
    if (!entry.branchName) {
      throw new Error("A detached worktree has no branch to sync.");
    }
    if (pathsEqual(entry.worktreePath, sourceCheckoutRoot)) {
      throw new Error("The source checkout cannot be synced with itself.");
    }
    const worktreeBranch = entry.branchName;

    // Managed worktrees already have a dedicated, lease-integrated merge
    // path tied to their own run; sync is for user-owned named worktrees.
    const records = await this.readRecords(commonDirectory);
    if (records.some((record) => record.branchName === worktreeBranch)) {
      throw new Error(
        "Managed worktrees use the workflow's own merge action, not sync."
      );
    }

    const worktreeInspections = await ExecutionRootLeaseManager.inspectLeases(
      entry.worktreePath,
      undefined,
      git
    );
    const liveWorktreeLease = worktreeInspections.find(
      (inspection) => !inspection.stale
    );
    if (liveWorktreeLease) {
      const owner = liveWorktreeLease.lease;
      throw new Error(
        `Worktree is in use by workflow ${owner.workflowKey}, run ${owner.runRef}.`
      );
    }

    const sourceBranch = await currentBranch(sourceCheckoutRoot);
    if (!sourceBranch) {
      throw new Error(
        "Sync is unavailable while the source checkout is on a detached HEAD."
      );
    }

    let sourceLease: ExecutionLeaseHandle | undefined;
    try {
      sourceLease = await this.leaseManager.acquire(
        {
          mode: "exclusive-worktree",
          stateRoot: sourceCheckoutRoot,
          executionRoot: sourceCheckoutRoot,
          workflowKey: "worktree-sync" as WorkflowKey,
          runRef: `sync-${this.now()}` as RunRef,
          runner: "vscode",
          instanceId: crypto.randomUUID(),
        },
        git
      );
    } catch (error) {
      throw new Error(
        `Sync blocked: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const intoSource = await this.guardedSyncMerge(
        sourceCheckoutRoot,
        `refs/heads/${worktreeBranch}`,
        sourceBranch
      );
      const intoWorktree = await this.guardedSyncMerge(
        entry.worktreePath,
        `refs/heads/${sourceBranch}`,
        worktreeBranch
      );
      return { sourceBranch, worktreeBranch, intoSource, intoWorktree };
    } finally {
      await sourceLease.release().catch(() => undefined);
    }
  }

  private async guardedSyncMerge(
    dir: string,
    ref: string,
    expectedCheckedOutBranch: string
  ): Promise<WorktreeMergeResult> {
    const checkedOutBranch = await currentBranch(dir);
    if (checkedOutBranch !== expectedCheckedOutBranch) {
      return {
        mergeOutcome: "blocked",
        message: `Merge blocked: "${dir}" is on "${checkedOutBranch ?? "detached HEAD"}", expected "${expectedCheckedOutBranch}".`,
      };
    }
    if (await hasGitOperationInProgress(dir)) {
      return {
        mergeOutcome: "blocked",
        message: `Merge blocked: a Git operation is already in progress in "${dir}".`,
      };
    }
    if (await hasUncommittedChanges(dir)) {
      return {
        mergeOutcome: "blocked",
        message: `Merge blocked: "${dir}" has uncommitted changes.`,
      };
    }
    return this.attemptGuardedMerge(dir, ref);
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
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
        recoveryOutcome: WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES,
        finalBranchTip: getManagedWorktreeWatermark(record),
      });
      await this.persistRuntime({
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        landingOutcome: WORKTREE_LANDING_OUTCOMES.NO_CHANGES,
        directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
        finalBranchTip: getManagedWorktreeWatermark(record),
        changedFileCount: 0,
        updatedAt: this.now(),
      });
      return {
        landingOutcome: WORKTREE_LANDING_OUTCOMES.NO_CHANGES,
        directoryOutcome: WORKTREE_DIRECTORY_OUTCOMES.KEPT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
        branchName: info.branchName,
        ...(info.targetBranch ? { targetBranch: info.targetBranch } : {}),
      };
    }
    return this.removeAfterLanding(
      repositoryRoot,
      recordPath,
      {
        ...record,
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        recoveryOutcome: WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES,
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
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        directoryState: WORKTREE_DIRECTORY_STATES.REMOVE_FAILED,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
      });
      await this.persistRuntime({
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        landingOutcome:
          record.recoveryOutcome === WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
            ? WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
            : WORKTREE_RECOVERY_OUTCOMES.LANDED,
        directoryState: WORKTREE_DIRECTORY_STATES.REMOVE_FAILED,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
          record.recoveryOutcome === WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
            ? WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
            : WORKTREE_RECOVERY_OUTCOMES.LANDED,
        directoryOutcome: WORKTREE_DIRECTORY_OUTCOMES.REMOVE_FAILED,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
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

    let branchState: WorktreeCompletionResult["branchState"] =
      WORKTREE_BRANCH_STATES.PRESENT;
    let message: string | undefined;
    if (record.recoveryOutcome === WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES) {
      const branchTip = await this.tryResolveLocalBranch(
        repositoryRoot,
        info.branchName
      );
      // Settlement uses the per-attempt watermark above, but deletion must
      // stay gated on the original base so a landed append's branch survives.
      if (branchTip !== record.baseCommit) {
        branchState = branchTip
          ? WORKTREE_BRANCH_STATES.PRESENT
          : WORKTREE_BRANCH_STATES.MISSING;
        message =
          "Managed no-change branch changed before deletion; it was kept.";
      } else {
        try {
          await deleteLocalBranch(repositoryRoot, info.branchName);
          branchState = WORKTREE_BRANCH_STATES.DELETED;
        } catch (error) {
          message = `Managed no-change branch deletion failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    const landingOutcome =
      record.recoveryOutcome === WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
        ? WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
        : WORKTREE_RECOVERY_OUTCOMES.LANDED;
    const finalRecord: ManagedWorktreeOwnershipRecord = {
      ...record,
      lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
      directoryState: WORKTREE_DIRECTORY_STATES.REMOVED,
      branchState,
    };
    await this.writeRecord(recordPath, finalRecord);
    await this.persistRuntime({
      lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
      landingOutcome,
      directoryState: WORKTREE_DIRECTORY_STATES.REMOVED,
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

    if (
      landingOutcome === WORKTREE_LANDING_OUTCOMES.NO_CHANGES &&
      branchState === WORKTREE_BRANCH_STATES.DELETED
    ) {
      // The record is no longer needed only after both independent resources
      // are durably recorded as gone. A crash before this unlink leaves the
      // record as a safe reconciliation tombstone.
      await fs.unlink(recordPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }

    return {
      landingOutcome,
      directoryOutcome: WORKTREE_DIRECTORY_OUTCOMES.REMOVED,
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
    },
    git: GitLocationMemo
  ): Promise<void> {
    const { commonDirectory } = await this.resolveRepositoryContext(
      info.sourceCheckoutRoot,
      git
    );
    const recordPath = this.recordPath(commonDirectory, info.branchName);
    const record = await this.tryReadRecord(recordPath);
    if (record) {
      await this.writeRecord(recordPath, {
        ...record,
        lifecycleState:
          patch.lifecycleState ?? WORKTREE_LIFECYCLE_STATES.BLOCKED,
        directoryState:
          patch.directoryState ?? WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: patch.branchState ?? WORKTREE_BRANCH_STATES.PRESENT,
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

    const {
      repositoryRoot: sourceCheckoutRoot,
      commonDirectory,
      git,
    } = await this.resolveRepositoryContext(options.sourceCheckoutRoot);
    const repositoryInputs = await this.resolveExecutionInputs(
      sourceCheckoutRoot,
      options
    );

    return withWorktreeMutationLock(commonDirectory, async () => {
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
      const root = await this.resolveWorktreeRootFor(sourceCheckoutRoot);
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
        lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
        directoryState: WORKTREE_DIRECTORY_STATES.MISSING,
        branchState: WORKTREE_BRANCH_STATES.MISSING,
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
        lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
        directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
        git,
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
    const {
      repositoryRoot: sourceCheckoutRoot,
      commonDirectory,
      git,
    } = await this.resolveRepositoryContext(options.sourceCheckoutRoot);
    return withWorktreeMutationLock(commonDirectory, async () => {
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
            ? WORKTREE_RECOVERY_OUTCOMES.NO_CHANGES
            : branchTip === record.lastVerifiedBranchTip &&
                record.lastVerifiedBranchTip !== record.baseCommit
              ? WORKTREE_RECOVERY_OUTCOMES.LANDED
              : WORKTREE_RECOVERY_OUTCOMES.ORPHANED;
        await this.writeRecord(recordPath, {
          ...record,
          directoryState: WORKTREE_DIRECTORY_STATES.MISSING,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
          recoveryOutcome,
          finalBranchTip: branchTip,
          lifecycleState:
            recoveryOutcome === WORKTREE_RECOVERY_OUTCOMES.ORPHANED
              ? WORKTREE_LIFECYCLE_STATES.ORPHANED
              : WORKTREE_LIFECYCLE_STATES.SETTLED,
        });
        return undefined;
      }
      if (!entry || !pathsEqual(entry.worktreePath, record.worktreePath)) {
        return undefined;
      }

      if (options.acquireLease === false) {
        return this.buildManagedInfoWithoutLease(record, options, "recovered");
      }

      const lockInspection = await readWorkflowLockInspection(
        record.stateRoot,
        record.workflowKey
      );
      if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
        return undefined;
      }
      return this.acquireManagedInfo({
        record: {
          ...record,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
          lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
        },
        recordPath,
        repositoryInputs: await this.resolveExecutionInputs(
          sourceCheckoutRoot,
          this.recoveryAsResolveOptions(record, options)
        ),
        origin: "recovered",
        directoryRecreated: false,
        options: this.recoveryAsResolveOptions(record, options),
        git,
      });
    });
  }

  /** Read-only activation discovery. Returned infos do not own a lease/trust. */
  public async discoverRecoverableManagedWorktrees(
    options: Omit<RecoverManagedWorktreeOptions, "branchName" | "acquireLease">
  ): Promise<WorktreeInfo[]> {
    return this.discoverRecoverableManagedWorktreesIn(
      await this.resolveRepositoryContext(options.sourceCheckoutRoot),
      options
    );
  }

  private async discoverRecoverableManagedWorktreesIn(
    { repositoryRoot: sourceCheckoutRoot, commonDirectory }: RepositoryContext,
    options: Omit<RecoverManagedWorktreeOptions, "branchName" | "acquireLease">
  ): Promise<WorktreeInfo[]> {
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
      const lockInspection = await readWorkflowLockInspection(
        record.stateRoot,
        record.workflowKey
      );
      if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) continue;
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
    const repository = await this.resolveRepositoryContext(
      options.sourceCheckoutRoot
    );
    const { repositoryRoot: sourceCheckoutRoot, commonDirectory } = repository;
    const [records, entries, recoverableManagedWorktrees] = await Promise.all([
      this.readRecords(commonDirectory),
      listGitWorktrees(sourceCheckoutRoot),
      this.discoverRecoverableManagedWorktreesIn(repository, {
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

    const currentEntry = worktrees.find((entry) =>
      pathsEqual(entry.worktreePath, sourceCheckoutRoot)
    );
    const currentOwnership = records.find(
      (record) =>
        currentEntry?.managed === true &&
        pathsEqual(record.worktreePath, sourceCheckoutRoot) &&
        record.branchName === currentEntry.branchName
    );

    return {
      worktrees,
      recoverableManagedWorktrees,
      staleManagedWorktrees,
      currentManagedWorktree: currentOwnership
        ? {
            branchName: currentOwnership.branchName,
            worktreePath: currentOwnership.worktreePath,
            sourceCheckoutRoot: currentOwnership.sourceCheckoutRoot,
          }
        : undefined,
    };
  }

  /**
   * Read the settings-page management model. This method never mutates Git;
   * divergence is deliberately served from the process cache when available.
   */
  public async getManagementState(
    sourceCheckoutRoot: string
  ): Promise<WorktreeManagementState> {
    return this.getManagementStateIn(
      await this.resolveRepositoryContext(sourceCheckoutRoot)
    );
  }

  private async getManagementStateIn({
    repositoryRoot: sourceRoot,
    commonDirectory,
  }: RepositoryContext): Promise<WorktreeManagementState> {
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
          ? WORKTREE_BRANCH_STATES.PRESENT
          : WORKTREE_BRANCH_STATES.MISSING
        : WORKTREE_BRANCH_STATES.MISSING;
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
            entry.ownership === WORKTREE_MODES.MANAGED &&
            entry.branchName === record.branchName &&
            pathsEqual(entry.worktreePath, record.worktreePath)
        )
    );

    for (const staleRecord of staleManagedRecords) {
      // A record lands here only when `listGitWorktrees` returned no matching
      // entry at all — i.e. Git's own admin dir for this worktree is gone.
      // (A merely-prunable worktree, whose admin dir survives but whose
      // directory is missing, is still enumerated by `git worktree list` and
      // was already pushed to `managedEntries` in the loop above.) With no
      // admin dir left, `git worktree repair` has nothing to reconnect this
      // path to and can never succeed here, regardless of whether a leftover
      // directory still happens to exist on disk (e.g. after a Windows file
      // lock left remove-behind files). Reconcile unconditionally on every
      // load/refresh so users never have to click a button just to make a
      // ghost entry disappear.
      const record = await this.markRecordDirectoryReconciled(
        sourceRoot,
        commonDirectory,
        staleRecord
      );
      if (record.branchState !== WORKTREE_BRANCH_STATES.PRESENT) {
        // Both resources this record tracked are gone; drop the tombstone so
        // it stops appearing forever. Best-effort — a failure just leaves it
        // for the next refresh to retry.
        await fs
          .unlink(this.recordPath(commonDirectory, record.branchName))
          .catch(() => undefined);
        continue;
      }
      const branchCleanup = await this.getBranchCleanupEligibility(
        sourceRoot,
        record,
        undefined,
        false
      );
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
        stale: false,
        branchCleanupEligible: branchCleanup.eligible,
        ...(branchCleanup.reason
          ? { branchCleanupReason: branchCleanup.reason }
          : {}),
        ...(record.targetBranch ? { targetBranch: record.targetBranch } : {}),
      });
    }

    return {
      resolvedRoot: await this.resolveWorktreeRootFor(sourceRoot),
      sourceCheckoutRoot: sourceRoot,
      sourceCheckoutBranch: await currentBranch(sourceRoot),
      entries: managedEntries,
      staleManagedRecords,
      generatedAt: now,
    };
  }

  /** Refresh named-branch divergence and return a new management snapshot. */
  public async refreshManagementState(
    sourceCheckoutRoot: string
  ): Promise<WorktreeManagementState> {
    const repository = await this.resolveRepositoryContext(sourceCheckoutRoot);
    const sourceRoot = repository.repositoryRoot;
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
    return this.getManagementStateIn(repository);
  }

  /** Apply one explicitly requested management action after revalidation. */
  public async applyManagementAction(
    options: WorktreeManagementActionOptions
  ): Promise<void> {
    const { repositoryRoot: sourceRoot, commonDirectory } =
      await this.resolveRepositoryContext(options.sourceCheckoutRoot);
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

    await withWorktreeMutationLock(commonDirectory, async () => {
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
        if (!entry) {
          // Git has already fully forgotten this worktree — it is absent
          // from `git worktree list` entirely, not merely prunable. There is
          // no admin dir left for `git worktree repair` to reconnect this
          // path to, so repair can never succeed here; the stale ownership
          // record is what "Remove"/"Force remove" must clear instead. A
          // leftover directory can still exist on disk (e.g. remove-behind
          // files from a Windows file lock during a prior removal); clear it
          // best-effort rather than leaving it for a repair action that can
          // never resolve it.
          if (await this.pathExists(record.worktreePath)) {
            await fs.rm(record.worktreePath, { recursive: true, force: true });
          }
          await this.markRecordDirectoryReconciled(
            sourceRoot,
            commonDirectory,
            record
          );
          return;
        }
        await removeWorktree(
          sourceRoot,
          record.worktreePath,
          options.action === WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE
        );
        await this.writeRecord(
          this.recordPath(commonDirectory, record.branchName),
          {
            ...record,
            lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
            directoryState: WORKTREE_DIRECTORY_STATES.REMOVED,
          }
        );
        return;
      }

      if (options.action === WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH) {
        if (entry) throw new Error("A checked-out branch cannot be deleted.");
        const lockInspection = await readWorkflowLockInspection(
          record.stateRoot,
          record.workflowKey
        );
        if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
          throw new Error("The managed run is still live or recoverable.");
        }
        const currentTip = await this.tryResolveLocalBranch(
          sourceRoot,
          record.branchName
        );
        if (!currentTip) {
          // Branch is already gone — deleted outside ctrlyoke, or a prior
          // cleanup attempt that deleted it on the Git side but failed
          // before the record could be written. Nothing left to delete;
          // reconcile the tombstone so it stops appearing.
          await this.writeRecord(
            this.recordPath(commonDirectory, record.branchName),
            { ...record, branchState: WORKTREE_BRANCH_STATES.DELETED }
          );
          return;
        }
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
          { ...record, branchState: WORKTREE_BRANCH_STATES.DELETED }
        );
      }
    });
  }

  /**
   * Mark a managed record's directory as reconciled-removed once Git has
   * fully forgotten the worktree (absent from `git worktree list`, not
   * merely prunable) and nothing remains on disk. Callers must have already
   * confirmed the directory is gone — this performs no existence check of
   * its own, since the two call sites (an explicit Remove action, and the
   * automatic sweep in `getManagementState`) need different behavior when
   * the directory is still ambiguous.
   */
  private async markRecordDirectoryReconciled(
    sourceRoot: string,
    commonDirectory: string,
    record: ManagedWorktreeOwnershipRecord
  ): Promise<ManagedWorktreeOwnershipRecord> {
    const survivingBranchTip = await this.tryResolveLocalBranch(
      sourceRoot,
      record.branchName
    );
    const branchState: ManagedWorktreeOwnershipRecord["branchState"] =
      survivingBranchTip
        ? WORKTREE_BRANCH_STATES.PRESENT
        : WORKTREE_BRANCH_STATES.MISSING;
    if (
      record.directoryState === WORKTREE_DIRECTORY_STATES.REMOVED &&
      record.branchState === branchState
    ) {
      // Already reconciled and nothing changed since — skip the redundant
      // write. Branch state is still re-checked above on every call so a
      // branch deleted after the worktree was reconciled (outside ctrlyoke,
      // or by a cleanup action that succeeded on Git but didn't persist)
      // is caught on the next refresh instead of leaving a stale "present"
      // tombstone that can never be swept up.
      return record;
    }
    const updated: ManagedWorktreeOwnershipRecord = {
      ...record,
      lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
      directoryState: WORKTREE_DIRECTORY_STATES.REMOVED,
      branchState,
    };
    await this.writeRecord(
      this.recordPath(commonDirectory, record.branchName),
      updated
    );
    return updated;
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

    const {
      repositoryRoot: sourceCheckoutRoot,
      commonDirectory,
      git,
    } = await this.resolveRepositoryContext(options.sourceCheckoutRoot);
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
      : await this.resolveWorktreeRootFor(sourceCheckoutRoot);
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
      lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
      directoryState: needsProvisioning
        ? WORKTREE_DIRECTORY_STATES.MISSING
        : WORKTREE_DIRECTORY_STATES.PRESENT,
      branchState: initialBranchCheckout
        ? WORKTREE_BRANCH_STATES.PRESENT
        : WORKTREE_BRANCH_STATES.MISSING,
      baseCommit: capturedBase,
    });

    if (needsProvisioning) {
      const mutation = await withWorktreeMutationLock(
        commonDirectory,
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
      namedSetupRecord.setupOutcome !== WORKTREE_SETUP_OUTCOMES.SUCCEEDED &&
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

    const lease = await this.leaseManager.acquire(
      {
        mode: "exclusive-worktree",
        stateRoot: options.stateRoot,
        executionRoot: executionWorkspace.executionRoot,
        workflowKey: options.workflowKey,
        runRef: options.runRef,
        runner: options.runner ?? "vscode",
        instanceId: options.instanceId ?? crypto.randomUUID(),
      },
      git
    );

    let runtimeTrust: RuntimeTrustedRootHandle;
    try {
      runtimeTrust = await runtimeTrustedRootRegistry.register({
        rootPath: executionCheckoutRoot,
        repositoryRoot: sourceCheckoutRoot,
        ownerToken: options.instanceId,
        git,
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
      (origin === WORKTREE_ORIGINS.CREATED ||
        namedSetupRecord?.setupOutcome !== WORKTREE_SETUP_OUTCOMES.SUCCEEDED);
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
        lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
        directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
          lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
          setupOutcome,
          updatedAt: this.now(),
        });
        await this.runSetup(
          executionCheckoutRoot,
          options.setup!,
          options.vars,
          options.setupAttemptIndex ?? 0,
          options.worktreeSetupRunner,
          options.reportUnresolvedVariables
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
          lifecycleState: WORKTREE_LIFECYCLE_STATES.BLOCKED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
      lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.USER,
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
      lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
      directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
      branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
    setupRunner?: WorktreeSetupRunner,
    reportUnresolvedVariables?: (placeholders: readonly string[]) => void
  ): Promise<void> {
    if (vars && Object.keys(vars).length > 0) {
      const unresolved = VarSubstitutor.findUnresolvedVariables(setup, vars);
      if (unresolved.length > 0) {
        reportUnresolvedVariables?.(unresolved);
      }
    }
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
            parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.SUCCEEDED &&
            parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.FAILED) ||
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
          (parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.PENDING &&
            parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.RUNNING &&
            parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.SUCCEEDED &&
            parsed.setupOutcome !== WORKTREE_SETUP_OUTCOMES.FAILED) ||
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
        record.lifecycleState === WORKTREE_LIFECYCLE_STATES.BLOCKED &&
        record.setupOutcome === WORKTREE_SETUP_OUTCOMES.FAILED
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
        WORKTREE_BRANCH_STATES.MISSING;
      if (branchTip) {
        // A changed watermark is evidence that ctrlyoke landed or otherwise
        // verified commits on this branch. Keep it even though setup failed.
        const branchIsUntouched =
          branchTip === record.lastVerifiedBranchTip &&
          getManagedWorktreeWatermark(record) === record.baseCommit;
        if (branchIsUntouched) {
          try {
            await deleteLocalBranch(repositoryRoot, record.branchName);
            branchState = WORKTREE_BRANCH_STATES.DELETED;
          } catch {
            branchState = WORKTREE_BRANCH_STATES.PRESENT;
          }
        } else {
          branchState = WORKTREE_BRANCH_STATES.PRESENT;
        }
      }

      const recordPath = this.recordPath(commonDirectory, record.branchName);
      const reconciledRecord: ManagedWorktreeOwnershipRecord = {
        ...record,
        lifecycleState: WORKTREE_LIFECYCLE_STATES.SETTLED,
        directoryState: WORKTREE_DIRECTORY_STATES.REMOVED,
        branchState,
      };
      await this.writeRecord(recordPath, reconciledRecord);

      if (
        branchState === WORKTREE_BRANCH_STATES.DELETED ||
        branchState === WORKTREE_BRANCH_STATES.MISSING
      ) {
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
      mode: WORKTREE_MODES.MANAGED,
      origin,
      lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.CTRLYOKE,
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
    git: GitLocationLookup;
  }): Promise<ActiveWorktreeInfo> {
    const executionWorkspace = this.buildExecutionWorkspace(
      args.repositoryInputs,
      args.record.worktreePath,
      args.options
    );
    const lease = await this.leaseManager.acquire(
      {
        mode: "exclusive-worktree",
        stateRoot: args.record.stateRoot,
        executionRoot: executionWorkspace.executionRoot,
        workflowKey: args.record.workflowKey,
        runRef: args.record.runRef,
        runner: args.options.runner ?? "vscode",
        instanceId: args.options.instanceId ?? crypto.randomUUID(),
      },
      args.git
    );
    let runtimeTrust: RuntimeTrustedRootHandle;
    try {
      runtimeTrust = await runtimeTrustedRootRegistry.register({
        rootPath: args.record.worktreePath,
        repositoryRoot: args.record.sourceCheckoutRoot,
        ownerToken: args.options.instanceId,
        git: args.git,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
    const shouldRunSetup =
      Boolean(args.options.setup?.trim()) &&
      (args.origin === WORKTREE_ORIGINS.CREATED || args.directoryRecreated);
    let setupOutcome: WorktreeInfo["setupOutcome"];
    if (shouldRunSetup) {
      setupOutcome = "pending";
      await this.persistRuntime({
        lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
        directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
        branchState: WORKTREE_BRANCH_STATES.PRESENT,
        setupOutcome,
        updatedAt: this.now(),
      });
      try {
        setupOutcome = "running";
        await this.persistRuntime({
          lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
          args.options.worktreeSetupRunner,
          args.options.reportUnresolvedVariables
        );
        setupOutcome = "succeeded";
      } catch (error) {
        setupOutcome = "failed";
        await this.writeRecord(args.recordPath, {
          ...args.record,
          lifecycleState: WORKTREE_LIFECYCLE_STATES.BLOCKED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
          setupOutcome,
        });
        await this.persistRuntime({
          lifecycleState: WORKTREE_LIFECYCLE_STATES.BLOCKED,
          directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
          branchState: WORKTREE_BRANCH_STATES.PRESENT,
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
      lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
      directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
      branchState: WORKTREE_BRANCH_STATES.PRESENT,
    };
    if (
      setupOutcome === WORKTREE_SETUP_OUTCOMES.SUCCEEDED ||
      setupOutcome === WORKTREE_SETUP_OUTCOMES.FAILED
    ) {
      readyRecord.setupOutcome = setupOutcome;
    } else {
      delete readyRecord.setupOutcome;
    }
    await this.writeRecord(args.recordPath, readyRecord);
    const dirty = await hasUncommittedChanges(args.record.worktreePath);
    const info: ActiveWorktreeInfo = {
      mode: WORKTREE_MODES.MANAGED,
      origin: args.origin,
      lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.CTRLYOKE,
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
      mode: WORKTREE_MODES.MANAGED,
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
      lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.CTRLYOKE,
      lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
      directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
      branchState: WORKTREE_BRANCH_STATES.PRESENT,
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

  /**
   * Ask Git once per operation where the repository lives. Every public
   * operation that needs the repository calls this first and passes the
   * returned `git` to anything else it asks Git about; see `GitLocationMemo`
   * for why this is per operation rather than a cache on the manager.
   */
  private async resolveRepositoryContext(
    sourceCheckoutRoot: string,
    git: GitLocationMemo = new GitLocationMemo()
  ): Promise<RepositoryContext> {
    const repositoryRoot = await this.requireRepositoryRoot(
      sourceCheckoutRoot,
      git
    );
    const commonDirectory = await this.requireCommonDirectory(
      repositoryRoot,
      git
    );
    return { repositoryRoot, commonDirectory, git };
  }

  private async requireRepositoryRoot(
    sourceCheckoutRoot: string,
    git: GitLocationLookup
  ): Promise<string> {
    const root = await git.repoToplevel(sourceCheckoutRoot);
    if (!root) {
      throw new Error(
        `Cannot resolve a Git repository for ${sourceCheckoutRoot}.`
      );
    }
    return path.resolve(root);
  }

  private async requireCommonDirectory(
    repositoryRoot: string,
    git: GitLocationLookup
  ): Promise<string> {
    const common = await git.gitCommonDir(repositoryRoot);
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
    const lockInspection = await readWorkflowLockInspection(
      record.stateRoot,
      record.workflowKey
    );
    if (lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
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
      lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.USER,
      lifecycleState: WORKTREE_LIFECYCLE_STATES.PROVISIONING,
      directoryState: WORKTREE_DIRECTORY_STATES.MISSING,
      branchState: WORKTREE_BRANCH_STATES.MISSING,
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
