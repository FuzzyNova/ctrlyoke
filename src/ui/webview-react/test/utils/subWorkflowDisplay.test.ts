import { describe, expect, it } from "vitest";
import {
  getInlinePromptStep,
  getSubWorkflowMergeWarning,
  hasInlineWorktree,
} from "@utils/subWorkflowDisplay";
import {
  STEP_TYPES,
  SUB_WORKFLOW_DASHBOARD_LABELS,
  WORKTREE_MERGE_OUTCOMES,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import type { SubWorkflowStep } from "@root/types/CtrlYokeTypes";

const lane: SubWorkflowStep = {
  type: STEP_TYPES.WORKFLOW,
  workflow: {
    prompt: "Implement it.",
    harness: "codex-cli",
    worktree: { mode: WORKTREE_MODES.MANAGED },
  },
};
const fileReference: SubWorkflowStep = {
  type: STEP_TYPES.WORKFLOW,
  workflow: "workflows/verify.ctrlyoke.yaml",
};
const inlineScript: SubWorkflowStep = {
  type: STEP_TYPES.WORKFLOW,
  workflow: { type: STEP_TYPES.SCRIPT, script: "npm test", worktree: false },
};

describe("subWorkflowDisplay", () => {
  it("exposes an inline prompt child for harness and model display", () => {
    expect(getInlinePromptStep(lane)).toMatchObject({ harness: "codex-cli" });
    expect(getInlinePromptStep(fileReference)).toBeUndefined();
    expect(getInlinePromptStep(inlineScript)).toBeUndefined();
  });

  it("recognizes an inline child with its own worktree", () => {
    expect(hasInlineWorktree(lane)).toBe(true);
    expect(hasInlineWorktree(fileReference)).toBe(false);
    expect(hasInlineWorktree(inlineScript)).toBe(false);
  });

  it("warns only for a merge that did not land cleanly", () => {
    const worktree = (
      mergeOutcome?: (typeof WORKTREE_MERGE_OUTCOMES)[keyof typeof WORKTREE_MERGE_OUTCOMES]
    ) => ({
      mode: WORKTREE_MODES.MANAGED,
      branchName: "ctrlyoke/lane",
      baseCommit: "base",
      ...(mergeOutcome ? { mergeOutcome } : {}),
    });
    expect(getSubWorkflowMergeWarning(undefined)).toBeUndefined();
    expect(getSubWorkflowMergeWarning(worktree())).toBeUndefined();
    expect(
      getSubWorkflowMergeWarning(worktree(WORKTREE_MERGE_OUTCOMES.FAST_FORWARD))
    ).toBeUndefined();
    expect(
      getSubWorkflowMergeWarning(worktree(WORKTREE_MERGE_OUTCOMES.MERGE_COMMIT))
    ).toBeUndefined();
    expect(
      getSubWorkflowMergeWarning(worktree(WORKTREE_MERGE_OUTCOMES.BLOCKED))
        ?.label
    ).toBe(SUB_WORKFLOW_DASHBOARD_LABELS.mergeBlocked);
    expect(
      getSubWorkflowMergeWarning(worktree(WORKTREE_MERGE_OUTCOMES.ABORT_FAILED))
        ?.label
    ).toBe(SUB_WORKFLOW_DASHBOARD_LABELS.mergeAbortFailed);
    expect(
      getSubWorkflowMergeWarning({
        ...worktree(WORKTREE_MERGE_OUTCOMES.CONFLICT),
        conflictFiles: ["src/a.ts"],
      })
    ).toEqual({
      label: SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflict,
      reason: `${SUB_WORKFLOW_DASHBOARD_LABELS.mergeConflictReason} ${SUB_WORKFLOW_DASHBOARD_LABELS.conflictFiles}: src/a.ts`,
    });
  });
});
