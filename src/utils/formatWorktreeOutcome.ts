import {
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_MERGE_OUTCOMES,
} from "../types/DashboardConstants";
import type { WorktreeRunProjection } from "../types/CtrlYokeTypes";

export const WORKTREE_OUTCOME_SEVERITIES = {
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type WorktreeOutcomeSeverity =
  (typeof WORKTREE_OUTCOME_SEVERITIES)[keyof typeof WORKTREE_OUTCOME_SEVERITIES];

export interface WorktreeOutcome {
  severity: WorktreeOutcomeSeverity;
  text: string;
}

export function formatRelativeWorktreePath(
  worktree: WorktreeRunProjection
): string {
  const target = worktree.worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const source = worktree.sourceCheckoutRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const parentEnd = source.lastIndexOf("/");
  if (parentEnd < 0) return target;

  const parent = source.slice(0, parentEnd) || "/";
  const comparable = (value: string) =>
    /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
  const comparableParent = comparable(parent);
  const comparableTarget = comparable(target);
  if (
    comparableTarget === comparableParent ||
    comparableTarget.startsWith(`${comparableParent}/`)
  ) {
    return target.slice(parent.length + (parent === "/" ? 0 : 1));
  }
  return target;
}

export function formatWorktreeOutcome(
  worktree: WorktreeRunProjection
): WorktreeOutcome | undefined {
  switch (worktree.mergeOutcome) {
    case WORKTREE_MERGE_OUTCOMES.FAST_FORWARD:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.SUCCESS,
        text: "Merged (fast-forward)",
      };
    case WORKTREE_MERGE_OUTCOMES.MERGE_COMMIT:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.SUCCESS,
        text: "Merged (merge commit)",
      };
    case WORKTREE_MERGE_OUTCOMES.CONFLICT:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.WARNING,
        text: "Merge conflict — branch preserved",
      };
    case WORKTREE_MERGE_OUTCOMES.BLOCKED:
    case WORKTREE_MERGE_OUTCOMES.ABORT_FAILED:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.ERROR,
        text: "Auto merge blocked — source branch changed or checkout is dirty",
      };
  }
  if (worktree.directoryState === WORKTREE_DIRECTORY_STATES.REMOVE_FAILED) {
    return {
      severity: WORKTREE_OUTCOME_SEVERITIES.WARNING,
      text: "Worktree removal failed — branch safe, directory kept",
    };
  }
  switch (worktree.landingOutcome) {
    case WORKTREE_LANDING_OUTCOMES.LANDED:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.SUCCESS,
        text: `Branch ready — ${worktree.changedFileCount ?? 0} file${
          worktree.changedFileCount === 1 ? "" : "s"
        }`,
      };
    case WORKTREE_LANDING_OUTCOMES.NO_CHANGES:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.SUCCESS,
        text: "No changes",
      };
    case WORKTREE_LANDING_OUTCOMES.BLOCKED:
      return {
        severity: WORKTREE_OUTCOME_SEVERITIES.WARNING,
        text: `Commit blocked — worktree kept at ${formatRelativeWorktreePath(
          worktree
        )}`,
      };
    default:
      return undefined;
  }
}
