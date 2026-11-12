import type { WorktreeRunProjection } from "../types/CtrlYokeTypes";

/** Human-readable notice for a named worktree directory switched for this run. */
export function worktreeSwitchNotice(
  worktree: WorktreeRunProjection | undefined
): string | undefined {
  if (!worktree?.directory || !worktree.previousBranch) return undefined;
  return `Switched ${worktree.directory} from \`${worktree.previousBranch}\` to \`${worktree.branchName}\``;
}
