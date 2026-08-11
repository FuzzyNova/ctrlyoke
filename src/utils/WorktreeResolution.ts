import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import {
  WORKTREE_MODES,
  type WorktreeMode,
} from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeDefaultConfig,
  WorktreeResolution,
} from "../types/CtrlYokeTypes";
import { evaluateWorkspaceEligibility } from "./WorktreeUtils";

/** The result used to construct an execution workspace for one workflow run. */
export interface WorkspaceWorktreeResolution extends WorktreeResolution {
  /** Present only when an inherited default was safely ignored. */
  notice?: string;
}

function normalizeDefault(
  value: WorktreeDefaultConfig
): WorktreeResolution {
  if (value.mode === WORKTREE_MODES.NONE) {
    return { origin: "default" };
  }
  if (
    value.mode === WORKTREE_MODES.NAMED &&
    (!value.branch || value.branch.trim().length === 0)
  ) {
    throw new Error("Named worktree mode requires a branch.");
  }
  return {
    origin: "default",
    config: { ...value },
  };
}

function normalizeAuthored(
  value: Exclude<WorktreeConfig, false | undefined>
): WorktreeResolution {
  if (typeof value === "string") {
    return {
      origin: "authored",
      config: {
        mode: WORKTREE_MODES.NAMED,
        branch: value,
      },
    };
  }
  return {
    origin: "authored",
    config: {
      mode: value.mode,
      branch: value.branch,
      base: value.base,
      setup: value.setup,
    },
  };
}

/** Resolve only the workflow-authored and settings-default tiers. */
export function resolveWorktreeSelection(
  authored: WorktreeConfig | undefined,
  defaultValue: WorktreeDefaultConfig
): WorktreeResolution {
  if (authored !== undefined) {
    if (authored === false) {
      return { origin: "authored" };
    }
    return normalizeAuthored(authored);
  }
  return normalizeDefault(defaultValue);
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
  if (!selection.config || selection.config.mode === WORKTREE_MODES.NONE) {
    return selection;
  }

  const eligibility = await evaluateWorkspaceEligibility(namedRoots);
  if (eligibility.eligible) {
    return selection;
  }

  const reason = eligibility.reason ?? "Workspace is not eligible for worktree mode.";
  if (selection.origin === "authored") {
    // Keep the shared eligibility reason in the hard failure.
    throw new Error(reason);
  }

  return {
    origin: selection.origin,
    notice: `Configured worktree default did not apply: ${reason}`,
  };
}

export function isWorktreeMode(value: WorktreeMode): boolean {
  return value !== WORKTREE_MODES.NONE;
}
