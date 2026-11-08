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
import {
  RUN_CHANGES_TARGETS,
  type RunBundleWorktreeMode,
  type RunChangesTarget,
} from "../../types/RunBundleTypes";
import { isPathWithinDirectory } from "../../utils/PathSecurity";
import { execGit, resolveCommit } from "../../utils/GitUtils";
import { WorktreeManager, type ActiveWorktreeInfo } from "./WorktreeManager";
import { getErrorMessage } from "../../utils/ErrorUtils";

export type { RunChangesTarget };

export interface RunChangesPlacement {
  target: RunChangesTarget;
  applied: boolean;
  canContinue?: boolean;
  worktreePath?: string;
  warning?: string;
  worktreeRuntime?: WorkingFileWorktreeRuntime;
  /** Reverts a successful placement if the enclosing import later fails. */
  rollback?: () => Promise<void>;
}

export interface RunChangesPlacementOptions {
  workspaceRoot: string;
  patchPath?: string;
  baseCommit: string;
  target: RunChangesTarget;
  worktreeMode: RunBundleWorktreeMode;
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
      if (options.target === RUN_CHANGES_TARGETS.SKIP)
        return { target: options.target, applied: false };
      return {
        target: options.target,
        applied: false,
        canContinue: false,
        warning:
          "The bundle contains no changes.patch. Use --changes skip after syncing the code yourself; this import is view-only.",
      };
    }

    const repositoryRoot = await resolveRepositoryRoot(root);
    let targetRoot = repositoryRoot;
    let worktreeInfo: ActiveWorktreeInfo | undefined;
    let worktreeHandlesReleased = false;
    const releaseWorktreeHandles = async (): Promise<void> => {
      if (!worktreeInfo || worktreeHandlesReleased) return;
      worktreeInfo.runtimeTrust.release();
      await worktreeInfo.lease.release();
      worktreeHandlesReleased = true;
    };
    if (options.target === RUN_CHANGES_TARGETS.WORKTREE) {
      // Valid for every worktree mode: it is the safe fallback the checkout
      // error below names for a `none`/`named` run (§5.3).
      worktreeInfo = await this.worktreeManager.ensureManagedWorktree({
        sourceCheckoutRoot: repositoryRoot,
        stateRoot: root,
        workflowKey: options.workflowKey,
        runRef: options.runRef,
        workflowName: options.workflowName,
        base: options.baseCommit,
        workspaceRoots: [root],
        namedWorkspaceRoots: [{ name: path.basename(root), fsPath: root }],
        runner: "cli",
      });
      // The patch is produced from the repository index, so its paths are
      // relative to the worktree checkout root even for a subdirectory run.
      targetRoot = worktreeInfo.worktreePath;
    } else if (options.target === RUN_CHANGES_TARGETS.CHECKOUT) {
      const status = await execGit([
        "-C",
        repositoryRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const head = await resolveCommit(repositoryRoot, "HEAD");
      if (status.stdout.trim() || head !== options.baseCommit) {
        throw new Error(
          `The checkout must be clean and at base commit ${options.baseCommit.slice(0, 7)}. Use --changes worktree or --changes skip.`
        );
      }
    }

    try {
      const patch = await fs.readFile(options.patchPath, "utf8");
      await validatePatchPaths(targetRoot, patch);
      if (options.target === RUN_CHANGES_TARGETS.SKIP) {
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
      let rolledBack = false;
      const rollback = async (): Promise<void> => {
        if (rolledBack) return;
        rolledBack = true;
        if (worktreeInfo) {
          await releaseWorktreeHandles();
          await this.worktreeManager.removeImportedManagedWorktree(
            worktreeInfo
          );
          return;
        }
        await rollbackTree(targetRoot, options.baseCommit);
      };
      return {
        target: options.target,
        applied: true,
        rollback,
        ...(worktreeInfo
          ? {
              worktreePath: worktreeInfo.worktreePath,
              worktreeRuntime: runtimeFor(worktreeInfo),
            }
          : {}),
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (options.target !== RUN_CHANGES_TARGETS.SKIP) {
        try {
          await rollbackTree(targetRoot, options.baseCommit);
        } catch (rollbackError) {
          cleanupErrors.push(
            `tree/index rollback failed: ${getErrorMessage(rollbackError)}`
          );
        }
      }
      if (worktreeInfo) {
        try {
          await releaseWorktreeHandles();
        } catch (cleanupError) {
          cleanupErrors.push(
            `managed worktree lease cleanup failed: ${getErrorMessage(cleanupError)}`
          );
        }
        try {
          await this.worktreeManager.removeImportedManagedWorktree(
            worktreeInfo
          );
        } catch (cleanupError) {
          cleanupErrors.push(
            `managed worktree cleanup failed: ${getErrorMessage(cleanupError)}`
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
        warning: `Workspace changes were not applied; the imported run is view-only. ${getErrorMessage(error)}`,
      };
    } finally {
      await releaseWorktreeHandles();
    }
  }
}

async function validatePatchPaths(root: string, patch: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const paths = new Set<string>();
  const hasGitDiffHeaders = patch
    .split(/\r?\n/)
    .some((line) => line.startsWith("diff --git "));
  let inFileHeader = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inFileHeader = true;
      for (const raw of parseDiffGitPaths(line.slice("diff --git ".length)))
        await validate(raw, false, true);
      continue;
    }
    if (!hasGitDiffHeaders && !inFileHeader && line.startsWith("--- ")) {
      inFileHeader = true;
    }
    if (!inFileHeader) continue;
    if (
      line.startsWith("@@") ||
      line === "GIT binary patch" ||
      line.startsWith("Binary files ")
    ) {
      inFileHeader = false;
      continue;
    }
    const header =
      /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(
        line
      );
    if (!header) continue;
    const raw = header[1].split("\t", 1)[0];
    await validate(
      raw,
      raw === "/dev/null",
      line.startsWith("--- ") || line.startsWith("+++ ")
    );
  }
  if (!paths.size && patch.trim())
    throw new Error("The changes patch contains no safe target paths.");

  async function validate(
    raw: string,
    allowDevNull: boolean,
    stripSidePrefix: boolean
  ): Promise<void> {
    if (!raw || (allowDevNull && raw === "/dev/null")) return;
    const decoded = decodePatchPath(raw);
    if (path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded))
      throw new Error(`Patch path must be relative: ${decoded}`);
    const relative = stripSidePrefix ? decoded.replace(/^[ab]\//, "") : decoded;
    if (relative.split(/[\\/]/).some((segment) => segment === ".."))
      throw new Error(`Patch path escapes the target workspace: ${relative}`);
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
}

function parseDiffGitPaths(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length && tokens.length < 2) {
    while (value[index] === " ") index++;
    if (value[index] === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < value.length; end++) {
        if (!escaped && value[end] === '"') break;
        escaped = !escaped && value[end] === "\\";
        if (value[end] !== "\\") escaped = false;
      }
      if (end === value.length) throw new Error("Invalid diff path header.");
      tokens.push(value.slice(index, end + 1));
      index = end + 1;
    } else {
      const end = value.indexOf(" ", index);
      tokens.push(value.slice(index, end < 0 ? value.length : end));
      index = end < 0 ? value.length : end;
    }
  }
  if (tokens.length !== 2) throw new Error("Invalid diff path header.");
  return tokens;
}

async function resolveRepositoryRoot(workspaceRoot: string): Promise<string> {
  const result = await execGit([
    "-C",
    workspaceRoot,
    "rev-parse",
    "--show-toplevel",
  ]);
  return path.resolve(result.stdout.trim());
}

async function rollbackTree(root: string, baseCommit: string): Promise<void> {
  await execGit(["-C", root, "reset", "--hard", baseCommit]);
  await execGit(["-C", root, "clean", "-fd"]);
  const status = await execGit([
    "-C",
    root,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.stdout.trim())
    throw new Error("Git reported remaining tree or index changes.");
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
