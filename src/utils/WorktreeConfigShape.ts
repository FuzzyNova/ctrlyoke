import { WORKTREE_MODES } from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "../types/CtrlYokeTypes";

/** Convert shorthand worktree selections to the object form used by the UI. */
export function toWorktreeObjectConfig(
  value: WorktreeConfig | undefined
): WorktreeObjectConfig | false {
  if (value === undefined || value === false) return false;
  if (value === true) return { mode: WORKTREE_MODES.MANAGED };
  if (typeof value === "string") {
    return { mode: WORKTREE_MODES.NAMED, branch: value };
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
