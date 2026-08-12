import * as path from "path";
import * as crypto from "crypto";
import {
  addWorktree,
  gitCommonDir,
  hasUncommittedChanges,
  listWorktrees as listGitWorktrees,
  repoToplevel,
  resolveCommit,
  validateBranchName,
  type GitWorktreeEntry,
} from "../../utils/GitUtils";
import {
  createWorktreeDirectoryName,
  resolveThroughNearestExistingAncestor,
  resolveWorktreeRoot as resolveConfiguredRoot,
  withRepositoryWorktreeMutationLock,
} from "../../utils/WorktreeUtils";
import { isPathWithinDirectory } from "../../utils/PathSecurity";
import { pathsEqual } from "../../utils/PathCasing";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { WorkspaceInitializer } from "./WorkspaceInitializer";
import { ScriptProcessRunner } from "./ScriptProcessRunner";
import {
  ExecutionRootLeaseManager,
  type ExecutionLeaseHandle,
  type ExecutionLeaseRequest,
} from "./ExecutionRootLeaseManager";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { ExecutionWorkspace } from "../../types/WorkflowContextTypes";
import type {
  RunRef,
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
  lease: ExecutionLeaseHandle;
  /** Process-session trust held while this worktree remains discoverable. */
  runtimeTrust: RuntimeTrustedRootHandle;
  setupOutcome?: "pending" | "running" | "succeeded" | "failed";
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
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
  public async resolveWorktreeRoot(sourceCheckoutRoot: string): Promise<string> {
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
    return listGitWorktrees(await this.requireRepositoryRoot(sourceCheckoutRoot));
  }

  /**
   * Resolve a named branch, attaching or creating its linked checkout as
   * necessary. The returned lease must be released by the execution owner.
   */
  public async resolveNamedWorktree(
    options: ResolveNamedWorktreeOptions
  ): Promise<WorktreeInfo> {
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
        (await resolveCommit(sourceCheckoutRoot, options.base?.trim() || "HEAD")));

    let origin: WorktreeOrigin = initialBranchCheckout
      ? "discovered"
      : "created";
    let worktreePath = initialBranchCheckout?.worktreePath;
    const needsProvisioning = !worktreePath;
    if (needsProvisioning) {
      const commonDirectory = await this.requireCommonDirectory(
        sourceCheckoutRoot
      );
      worktreePath = path.join(
        root!,
        createWorktreeDirectoryName(branchName, commonDirectory, {
          kind: "named",
          branchRef: branchName,
        })
      );
    }

    await this.persistRuntime({
      ...this.buildRuntime(
        repositoryInputs,
        branchName,
        worktreePath!
      ),
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
        ...repositoryInputs.workspaceRoots.map((sourceRoot) => mapSourcePath(sourceRoot)),
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
        await this.runSetup(executionCheckoutRoot, options.setup!, options.vars);
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

    const info: WorktreeInfo = {
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
      ...this.buildRuntime(
        repositoryInputs,
        branchName,
        executionCheckoutRoot
      ),
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
  ): Promise<WorktreeInfo> {
    if (!options.setup?.trim()) {
      throw new Error("Retry Setup requires a configured setup command.");
    }
    return this.resolveNamedWorktree({ ...options, retrySetup: true });
  }

  /** Release the lease held by a resolved worktree. No Git cleanup is performed. */
  public async releaseWorktree(info: WorktreeInfo): Promise<void> {
    await info.lease.release();
  }

  /** Release process-session trust after the run/session is no longer loaded. */
  public releaseRuntimeTrust(info: WorktreeInfo): void {
    info.runtimeTrust.release();
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

  private async requireRepositoryRoot(sourceCheckoutRoot: string): Promise<string> {
    const root = await repoToplevel(sourceCheckoutRoot);
    if (!root) {
      throw new Error(`Cannot resolve a Git repository for ${sourceCheckoutRoot}.`);
    }
    return path.resolve(root);
  }

  private async requireCommonDirectory(repositoryRoot: string): Promise<string> {
    const common = await gitCommonDir(repositoryRoot);
    if (!common) throw new Error("Cannot resolve the repository Git common directory.");
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
    options: ResolveNamedWorktreeOptions
  ): Promise<ResolvedRepositoryInputs> {
    const sourceRoot = await resolveThroughNearestExistingAncestor(
      sourceCheckoutRoot
    );
    const stateRoot = await resolveThroughNearestExistingAncestor(options.stateRoot);
    const namedWorkspaceRoots: ResolverWorkspaceFolder[] = [];
    for (const root of options.namedWorkspaceRoots) {
      const resolvedRoot = await resolveThroughNearestExistingAncestor(root.fsPath);
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
      const resolvedRoot = await resolveThroughNearestExistingAncestor(workspaceRoot);
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
      const resolvedTrustRoot = await resolveThroughNearestExistingAncestor(
        trustRoot
      );
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
