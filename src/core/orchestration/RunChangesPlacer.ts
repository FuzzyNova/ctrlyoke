import * as fs from "fs/promises";
import * as path from "path";
import {
  WORKTREE_LIFECYCLE_OWNERS,
  WORKTREE_LIFECYCLE_STATES,
  WORKTREE_MODES,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_BRANCH_STATES,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkingFileWorktreeRuntime,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { isPathWithinDirectory } from "../../utils/PathSecurity";
import { execGit, resolveCommit } from "../../utils/GitUtils";
import { WorktreeManager, type ActiveWorktreeInfo } from "./WorktreeManager";

export type RunChangesTarget = "worktree" | "checkout" | "skip";

export interface RunChangesPlacement {
  target: RunChangesTarget;
  applied: boolean;
  canContinue?: boolean;
  worktreePath?: string;
  warning?: string;
  worktreeRuntime?: WorkingFileWorktreeRuntime;
}

export interface RunChangesPlacementOptions {
  workspaceRoot: string;
  patchPath?: string;
  baseCommit: string;
  target: RunChangesTarget;
  worktreeMode: "none" | "managed" | "named";
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workflowName: string;
}

/** Safely places the exported tree delta for a continuation. */
export class RunChangesPlacer {
  constructor(private readonly worktreeManager = new WorktreeManager()) {}

  async place(
    options: RunChangesPlacementOptions
  ): Promise<RunChangesPlacement> {
    const root = path.resolve(options.workspaceRoot);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(options.baseCommit)) {
      return {
        target: options.target,
        applied: false,
        canContinue: false,
        warning: `The bundle has an invalid base commit (${options.baseCommit.slice(0, 7)}); this import is view-only.`,
      };
    }
    try {
      await execGit([
        "-C",
        root,
        "cat-file",
        "-e",
        `${options.baseCommit}^{commit}`,
      ]);
    } catch {
      return {
        target: options.target,
        applied: false,
        canContinue: false,
        warning: `Base commit ${options.baseCommit.slice(0, 7)} is unavailable. Fetch it with: git fetch (push/fetch commit ${options.baseCommit.slice(0, 7)}), then import again; this import is view-only.`,
      };
    }

    if (!options.patchPath) {
      if (options.target === "skip")
        return { target: options.target, applied: false };
      return {
        target: options.target,
        applied: false,
        canContinue: false,
        warning:
          "The bundle contains no changes.patch. Use --changes skip after syncing the code yourself; this import is view-only.",
      };
    }

    let targetRoot = root;
    let worktreeInfo: ActiveWorktreeInfo | undefined;
    let worktreeHandlesReleased = false;
    const releaseWorktreeHandles = async (): Promise<void> => {
      if (!worktreeInfo || worktreeHandlesReleased) return;
      worktreeInfo.runtimeTrust.release();
      await worktreeInfo.lease.release();
      worktreeHandlesReleased = true;
    };
    if (options.target === "worktree") {
      if (options.worktreeMode !== "managed")
        throw new Error(
          "--changes worktree is only available for managed runs."
        );
      worktreeInfo = await this.worktreeManager.ensureManagedWorktree({
        sourceCheckoutRoot: root,
        stateRoot: root,
        workflowKey: options.workflowKey,
        runRef: options.runRef,
        workflowName: options.workflowName,
        base: options.baseCommit,
        workspaceRoots: [root],
        namedWorkspaceRoots: [{ name: path.basename(root), fsPath: root }],
        runner: "cli",
      });
      targetRoot = worktreeInfo.executionWorkspace.executionRoot;
    } else if (options.target === "checkout") {
      const status = await execGit([
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const head = await resolveCommit(root, "HEAD");
      if (status.stdout.trim() || head !== options.baseCommit) {
        throw new Error(
          `The checkout must be clean and at base commit ${options.baseCommit.slice(0, 7)}. Use --changes worktree or --changes skip.`
        );
      }
    }

    try {
      const patch = await fs.readFile(options.patchPath, "utf8");
      await validatePatchPaths(targetRoot, patch);
      if (options.target === "skip") {
        try {
          await execGit([
            "-C",
            targetRoot,
            "apply",
            "--check",
            "--reverse",
            "--",
            options.patchPath,
          ]);
          return { target: options.target, applied: false };
        } catch {
          return {
            target: options.target,
            applied: false,
            warning:
              "The checkout does not appear to contain the exported changes; continuation may not match the earlier run.",
          };
        }
      }
      await execGit([
        "-C",
        targetRoot,
        "apply",
        "--index",
        "--3way",
        "--",
        options.patchPath,
      ]);
      return {
        target: options.target,
        applied: true,
        ...(worktreeInfo
          ? {
              worktreePath: worktreeInfo.worktreePath,
              worktreeRuntime: runtimeFor(worktreeInfo),
            }
          : {}),
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (options.target !== "skip") {
        try {
          await execGit([
            "-C",
            targetRoot,
            "reset",
            "--hard",
            options.baseCommit,
          ]);
          await execGit(["-C", targetRoot, "clean", "-fd"]);
          const status = await execGit([
            "-C",
            targetRoot,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]);
          if (status.stdout.trim())
            throw new Error("Git reported remaining tree or index changes.");
        } catch (rollbackError) {
          cleanupErrors.push(
            `tree/index rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      if (worktreeInfo) {
        try {
          await releaseWorktreeHandles();
        } catch (cleanupError) {
          cleanupErrors.push(
            `managed worktree lease cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          );
        }
        try {
          await this.worktreeManager.removeImportedManagedWorktree(
            worktreeInfo
          );
        } catch (cleanupError) {
          cleanupErrors.push(
            `managed worktree cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          );
        }
      }
      if (cleanupErrors.length)
        throw new Error(
          `Workspace changes were rejected and cleanup could not be verified (${cleanupErrors.join("; ")}).`
        );
      return {
        target: options.target,
        applied: false,
        canContinue: false,
        warning: `Workspace changes were not applied; the imported run is view-only. ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await releaseWorktreeHandles();
    }
  }
}

async function validatePatchPaths(root: string, patch: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const raw = line.slice(4).split("\t", 1)[0];
    if (!raw || raw === "/dev/null") continue;
    const relative = decodePatchPath(raw).replace(/^[ab]\//, "");
    const candidate = path.resolve(root, relative);
    if (!isPathWithinDirectory(candidate, root))
      throw new Error(`Patch path escapes the target workspace: ${relative}`);
    let existing = candidate;
    while (true) {
      try {
        const realExisting = await fs.realpath(existing);
        if (!isPathWithinDirectory(realExisting, realRoot))
          throw new Error(
            `Patch path resolves outside the target workspace: ${relative}`
          );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    paths.add(candidate);
  }
  if (!paths.size && patch.trim())
    throw new Error("The changes patch contains no safe target paths.");
}

function decodePatchPath(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error("The changes patch contains an invalid quoted path.");
  }
}

function runtimeFor(info: ActiveWorktreeInfo): WorkingFileWorktreeRuntime {
  return {
    schemaVersion: 1,
    mode: WORKTREE_MODES.MANAGED,
    origin: info.origin,
    branchName: info.branchName,
    worktreePath: info.worktreePath,
    executionRoot: info.executionWorkspace.executionRoot,
    executionCheckoutRoot:
      info.executionWorkspace.executionCheckoutRoot ?? info.worktreePath,
    sourceCheckoutRoot: info.sourceCheckoutRoot,
    namedWorkspaceRoots: [...info.executionWorkspace.namedWorkspaceRoots],
    baseCommit: info.baseCommit,
    lifecycleOwner: WORKTREE_LIFECYCLE_OWNERS.CTRLYOKE,
    lifecycleState: WORKTREE_LIFECYCLE_STATES.READY,
    directoryState: WORKTREE_DIRECTORY_STATES.PRESENT,
    branchState: WORKTREE_BRANCH_STATES.PRESENT,
    updatedAt: info.createdAt,
  };
}
