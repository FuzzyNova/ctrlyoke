import {
  WORKTREE_DIRECTORY_VALUE_KINDS,
  WORKTREE_DIRECTORY_FIELD,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "../types/CtrlYokeTypes";

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
