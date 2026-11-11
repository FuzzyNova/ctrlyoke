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
