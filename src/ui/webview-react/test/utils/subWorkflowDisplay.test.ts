import { describe, expect, it } from "vitest";
import {
  getInlinePromptStep,
  getInlineWorktreeDefinedBranch,
  getSubWorkflowMergeWarning,
  hasInlineWorktree,
  resolveEffectiveStepHarness,
} from "@utils/subWorkflowDisplay";
import {
  HARNESS_IDS,
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

function namedLane(branch: string): SubWorkflowStep {
  return {
    type: STEP_TYPES.WORKFLOW,
    workflow: {
      prompt: "Write the docs.",
      worktree: { mode: WORKTREE_MODES.NAMED, branch },
    },
  };
}

describe("subWorkflowDisplay", () => {
  it("exposes an inline prompt child for harness and model display", () => {
    expect(getInlinePromptStep(lane)).toMatchObject({ harness: "codex-cli" });
    expect(getInlinePromptStep(fileReference)).toBeUndefined();
    expect(getInlinePromptStep(inlineScript)).toBeUndefined();
  });

  it("recognizes an inline child with its own worktree", () => {
    expect(hasInlineWorktree(lane)).toBe(true);
    expect(hasInlineWorktree(namedLane("ctrlyoke/docs"))).toBe(true);
    expect(hasInlineWorktree(fileReference)).toBe(false);
    expect(hasInlineWorktree(inlineScript)).toBe(false);
    expect(
      hasInlineWorktree({
        type: STEP_TYPES.WORKFLOW,
        workflow: { prompt: "Inherit the parent's checkout." },
      })
    ).toBe(false);
  });

  it("resolves a step's harness the same way for every step kind", () => {
    const inherited = HARNESS_IDS.QWEN_CLI;
    expect(resolveEffectiveStepHarness(lane, inherited)).toBe(
      HARNESS_IDS.CODEX_CLI
    );
    expect(
      resolveEffectiveStepHarness(
        { type: STEP_TYPES.WORKFLOW, workflow: { prompt: "Inherit." } },
        inherited
      )
    ).toBe(inherited);
    expect(resolveEffectiveStepHarness(fileReference, inherited)).toBe(
      undefined
    );
    expect(resolveEffectiveStepHarness(inlineScript, inherited)).toBe(
      undefined
    );
    expect(
      resolveEffectiveStepHarness(
        { type: STEP_TYPES.SCRIPT, script: "npm test" },
        inherited
      )
    ).toBe(undefined);
    expect(resolveEffectiveStepHarness({ prompt: "Plain." }, inherited)).toBe(
      inherited
    );
    // A started prompt step keeps the harness it ran on.
    expect(
      resolveEffectiveStepHarness(
        {
          prompt: "Started.",
          harness: HARNESS_IDS.CLAUDE_CLI,
          _runtime: { harness: HARNESS_IDS.COPILOT_CLI },
        },
        inherited
      )
    ).toBe(HARNESS_IDS.COPILOT_CLI);
  });

  it("names a named worktree's branch from the definition", () => {
    expect(getInlineWorktreeDefinedBranch(namedLane("ctrlyoke/docs"))).toBe(
      "ctrlyoke/docs"
    );
    expect(
      getInlineWorktreeDefinedBranch({
        type: STEP_TYPES.WORKFLOW,
        workflow: { prompt: "Shorthand.", worktree: "ctrlyoke/short" },
      })
    ).toBe("ctrlyoke/short");
    // A managed worktree's branch exists only once its child creates it.
    expect(getInlineWorktreeDefinedBranch(lane)).toBeUndefined();
    expect(getInlineWorktreeDefinedBranch(fileReference)).toBeUndefined();
    // The child substitutes a placeholder, so the authored text is not its branch.
    expect(
      getInlineWorktreeDefinedBranch(namedLane("ctrlyoke/{{topic}}"))
    ).toBeUndefined();
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
