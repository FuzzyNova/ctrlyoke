import type { WorktreeRunProjection } from "../types/CtrlYokeTypes";

/** Human-readable notice for a named checkout switched for this run. */
export function worktreeSwitchNotice(
  worktree: WorktreeRunProjection | undefined
): string | undefined {
  if (!worktree?.checkout || !worktree.previousBranch) return undefined;
  return `Switched ${worktree.checkout} from \`${worktree.previousBranch}\` to \`${worktree.branchName}\``;
}
