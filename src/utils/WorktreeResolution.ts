import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import {
  WORKTREE_CONFIG_ORIGINS,
  WORKTREE_DIRECTORY_VALUE_KINDS,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeDefaultConfig,
  WorktreeObjectConfig,
  WorktreeResolution,
  WorkingFileWorktreeRuntime,
} from "../types/CtrlYokeTypes";
import { evaluateWorkspaceEligibility } from "./WorktreeUtils";
import {
  classifyWorktreeDirectoryValue,
  toWorktreeObjectConfig,
  worktreeDirectoryNameError,
} from "./WorktreeConfigShape";

function normalizeNamedDirectory(
  config: ReturnType<typeof toWorktreeObjectConfig>
) {
  if (
    config === false ||
    config.mode !== WORKTREE_MODES.NAMED ||
    config.directory === undefined
  )
    return config;
  const directory = config.directory.trim();
  if (!directory)
    throw new Error("Named worktree directory must not be empty.");
  const nameError =
    classifyWorktreeDirectoryValue(directory) ===
    WORKTREE_DIRECTORY_VALUE_KINDS.NAME
      ? worktreeDirectoryNameError(directory)
      : undefined;
  if (nameError) {
    throw new Error(`Named worktree directory ${nameError}.`);
  }
  return { ...config, directory };
}

/** The result used to construct an execution workspace for one workflow run. */
export interface WorkspaceWorktreeResolution extends WorktreeResolution {
  /** Present only when an inherited default was safely ignored. */
  notice?: string;
}

function normalizeDefault(value: WorktreeDefaultConfig): WorktreeResolution {
  const config = normalizeNamedDirectory(toWorktreeObjectConfig(value));
  if (config === false) {
    return { origin: WORKTREE_CONFIG_ORIGINS.DEFAULT };
  }
  // Only an explicit object default is validated; a string shorthand keeps
  // whatever branch it names.
  if (
    typeof value === "object" &&
    config.mode === WORKTREE_MODES.NAMED &&
    (!config.branch || config.branch.trim().length === 0)
  ) {
    throw new Error("Named worktree mode requires a branch.");
  }
  return { origin: WORKTREE_CONFIG_ORIGINS.DEFAULT, config: { ...config } };
}

/** Resolve only the workflow-authored and settings-default tiers. */
export function resolveWorktreeSelection(
  authored: WorktreeConfig | undefined,
  defaultValue: WorktreeDefaultConfig
): WorktreeResolution {
  if (authored === undefined) {
    return normalizeDefault(defaultValue);
  }
  const config = normalizeNamedDirectory(toWorktreeObjectConfig(authored));
  return config === false
    ? { origin: WORKTREE_CONFIG_ORIGINS.AUTHORED }
    : { origin: WORKTREE_CONFIG_ORIGINS.AUTHORED, config: { ...config } };
}

/**
 * Resolve a worktree selection against the workspace eligibility guard.
 * Authored values fail closed; inherited defaults are safe to carry between
 * workspaces and therefore degrade to ordinary execution with a durable notice.
 */
export async function resolveWorktreeForWorkspace(
  authored: WorktreeConfig | undefined,
  defaultValue: WorktreeDefaultConfig,
  namedRoots: readonly ResolverWorkspaceFolder[]
): Promise<WorkspaceWorktreeResolution> {
  const selection = resolveWorktreeSelection(authored, defaultValue);
  if (!selection.config) {
    return selection;
  }

  const eligibility = await evaluateWorkspaceEligibility(namedRoots);
  if (eligibility.eligible) {
    return selection;
  }

  const reason =
    eligibility.reason ?? "Workspace is not eligible for worktree mode.";
  if (selection.origin === WORKTREE_CONFIG_ORIGINS.AUTHORED) {
    // Keep the shared eligibility reason in the hard failure.
    throw new Error(reason);
  }

  return {
    origin: selection.origin,
    notice: `Configured worktree default did not apply: ${reason}`,
  };
}

/** Preserve a recorded named directory during continue while taking setup from current config. */
export function recordedWorktreeConfigForContinue(
  recorded: WorkingFileWorktreeRuntime | undefined,
  current: WorktreeObjectConfig | false
): WorktreeObjectConfig | undefined {
  if (
    !recorded ||
    recorded.mode !== WORKTREE_MODES.NAMED ||
    recorded.directory === undefined ||
    current === false
  ) {
    return undefined;
  }
  return {
    mode: WORKTREE_MODES.NAMED,
    directory: recorded.executionCheckoutRoot,
    branch: recorded.branchName,
    base: recorded.baseCommit,
    ...(current.setup ? { setup: current.setup } : {}),
  };
}
