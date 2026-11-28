import {
  SUB_WORKFLOW_WORKTREE_PLACEMENTS,
  WORKTREE_DIRECTORY_VALUE_KINDS,
  WORKTREE_DIRECTORY_FIELD,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "../types/CtrlYokeTypes";
import type { SubWorkflowWorktreePlan } from "../types/SubWorkflowTypes";
import { normalizeNamedWorktreeBranch } from "./BranchName";

export type WorktreeDirectoryValueKind =
  (typeof WORKTREE_DIRECTORY_VALUE_KINDS)[keyof typeof WORKTREE_DIRECTORY_VALUE_KINDS];

/** Classify `directory` values independently of the host platform. */
export function classifyWorktreeDirectoryValue(
  value: string
): WorktreeDirectoryValueKind {
  return value === "~" ||
    /^~[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
    ? WORKTREE_DIRECTORY_VALUE_KINDS.PATH
    : WORKTREE_DIRECTORY_VALUE_KINDS.NAME;
}

/**
 * Why a bare-name `directory` cannot be used as a directory name on any
 * platform ctrlyoke runs on, or undefined when it can. A bare name is created
 * as exactly `<worktree root>/<name>`, so it must be one portable path segment.
 */
export function worktreeDirectoryNameError(name: string): string | undefined {
  if (/[\\/]/.test(name))
    return "must be an absolute or ~-prefixed path, or a bare name without slash or backslash";
  if (name === "." || name === "..") return `cannot be "${name}"`;
  if (/[<>:"|?*\u0000-\u001f]/.test(name))
    return 'must not contain < > : " | ? * or control characters';
  if (/[. ]$/.test(name)) return "must not end with a dot or a space";
  return undefined;
}

/** Convert shorthand worktree selections to the object form used by the UI. */
export function toWorktreeObjectConfig(
  value: WorktreeConfig | undefined
): WorktreeObjectConfig | false {
  if (value === undefined || value === false) return false;
  if (value === true) return { mode: WORKTREE_MODES.MANAGED };
  if (typeof value === "string") {
    return { mode: WORKTREE_MODES.NAMED, branch: value };
  }
  if (value.mode === WORKTREE_MODES.MANAGED && "directory" in value) {
    const { directory: _directory, ...managed } = value;
    return managed as WorktreeObjectConfig;
  }
  return value;
}

/**
 * The worktree a workflow runs with: its authored value when set, otherwise the
 * inherited settings value. Returns a copy so callers can't mutate either source.
 */
export function effectiveWorktreeObjectConfig(
  authored: WorktreeConfig | undefined,
  inherited: WorktreeConfig | undefined
): WorktreeObjectConfig | false {
  const effective = toWorktreeObjectConfig(
    authored === undefined ? inherited : authored
  );
  return effective === false ? false : { ...effective };
}

/** Shown, and refused on save, for a named worktree without a branch. */
export const NAMED_WORKTREE_BRANCH_REQUIRED =
  "Branch is required for named worktree mode.";

/**
 * Why a worktree config cannot be saved as it stands, or undefined: a named
 * worktree needs a branch. The worktree editor's one blocking check.
 */
export function namedWorktreeBranchError(
  value: WorktreeConfig | undefined
): string | undefined {
  const config = toWorktreeObjectConfig(value);
  return config !== false &&
    config.mode === WORKTREE_MODES.NAMED &&
    !config.branch?.trim()
    ? NAMED_WORKTREE_BRANCH_REQUIRED
    : undefined;
}

/**
 * Set one field of an object worktree config. An empty `directory` removes
 * the key, because a stored `directory: ""` is invalid and "empty" means
 * "derive the directory from the branch".
 */
export function withWorktreeField<T extends object>(
  config: T,
  field: string,
  value: string | boolean
): T {
  const next = { ...config, [field]: value } as T & { directory?: unknown };
  if (
    field === WORKTREE_DIRECTORY_FIELD &&
    typeof value === "string" &&
    !value.trim()
  ) {
    delete next.directory;
  }
  return next;
}

/**
 * The optional string fields of an object worktree config. An empty one means
 * "not set", and the schema refuses some of them empty (`base` has
 * `minLength: 1`), so an editor omits them rather than storing `""`.
 */
const OPTIONAL_WORKTREE_STRING_FIELDS = [
  WORKTREE_DIRECTORY_FIELD,
  "base",
  "setup",
] as const;

/**
 * `config` without its blank optional string fields (`directory`, `base`,
 * `setup`). A named worktree's required `branch` is left as it is, so its own
 * refusal (`namedWorktreeBranchError`) still applies.
 */
export function withoutBlankOptionalWorktreeFields<
  T extends WorktreeObjectConfig,
>(config: T): T {
  const next: Record<string, unknown> = { ...config };
  for (const field of OPTIONAL_WORKTREE_STRING_FIELDS) {
    const value = next[field];
    if (typeof value === "string" && !value.trim()) delete next[field];
  }
  return next as T;
}

/** Classify a child definition's `worktree` key by the D4 table. */
export function classifySubWorkflowWorktree(
  worktree: WorktreeConfig | undefined
): SubWorkflowWorktreePlan {
  if (worktree === undefined) {
    return {
      placement: SUB_WORKFLOW_WORKTREE_PLACEMENTS.INHERITED,
      mergesIntoParent: false,
    };
  }
  const config = toWorktreeObjectConfig(worktree);
  if (config === false) {
    return {
      placement: SUB_WORKFLOW_WORKTREE_PLACEMENTS.MAIN_CHECKOUT,
      mergesIntoParent: false,
    };
  }
  return config.mode === WORKTREE_MODES.MANAGED
    ? {
        placement: SUB_WORKFLOW_WORKTREE_PLACEMENTS.MANAGED,
        mergesIntoParent: config.merge === true,
      }
    : {
        placement: SUB_WORKFLOW_WORKTREE_PLACEMENTS.NAMED,
        mergesIntoParent: false,
        ...namedBranchField(config.branch),
      };
}

function namedBranchField(branch: string): { namedBranch?: string } {
  const namedBranch = normalizeNamedWorktreeBranch(branch);
  return namedBranch && !namedBranch.includes("{{") ? { namedBranch } : {};
}

/** Whether a classified child creates (or reuses) a worktree of its own. */
export function subWorkflowCreatesWorktree(
  plan: SubWorkflowWorktreePlan | undefined
): boolean {
  return (
    plan?.placement === SUB_WORKFLOW_WORKTREE_PLACEMENTS.MANAGED ||
    plan?.placement === SUB_WORKFLOW_WORKTREE_PLACEMENTS.NAMED
  );
}
