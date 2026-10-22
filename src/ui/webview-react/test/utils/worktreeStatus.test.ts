import { describe, expect, it } from "vitest";
import { WORKTREE_MERGE_READINESS } from "@root/types/DashboardConstants";
import {
  describeWorktreeStatus,
  resolveWorktreeMergeReadiness,
} from "@utils/worktreeStatus";

const clean = {
  staged: { added: 0, modified: 0, deleted: 0 },
  unstaged: { added: 0, modified: 0, deleted: 0 },
  conflicted: 0,
};

describe("resolveWorktreeMergeReadiness", () => {
  it("is ready only when clean and carrying commits the source branch lacks", () => {
    expect(
      resolveWorktreeMergeReadiness({
        workingTree: clean,
        sourceComparison: { ahead: 3, behind: 2 },
      })
    ).toBe(WORKTREE_MERGE_READINESS.READY);
    expect(
      resolveWorktreeMergeReadiness({
        workingTree: clean,
        sourceComparison: { ahead: 0, behind: 2 },
      })
    ).toBe(WORKTREE_MERGE_READINESS.BEHIND);
    expect(
      resolveWorktreeMergeReadiness({
        workingTree: clean,
        sourceComparison: { ahead: 0, behind: 0 },
      })
    ).toBe(WORKTREE_MERGE_READINESS.UP_TO_DATE);
  });

  it("puts conflicts ahead of uncommitted changes ahead of commit counts", () => {
    const dirty = { ...clean, unstaged: { added: 1, modified: 0, deleted: 0 } };
    expect(
      resolveWorktreeMergeReadiness({
        workingTree: { ...dirty, conflicted: 1 },
        sourceComparison: { ahead: 3, behind: 0 },
      })
    ).toBe(WORKTREE_MERGE_READINESS.CONFLICTED);
    expect(
      resolveWorktreeMergeReadiness({
        workingTree: dirty,
        sourceComparison: { ahead: 3, behind: 0 },
      })
    ).toBe(WORKTREE_MERGE_READINESS.UNCOMMITTED);
  });

  it("has no verdict without status, or for a clean source checkout", () => {
    expect(resolveWorktreeMergeReadiness({})).toBeUndefined();
    expect(
      resolveWorktreeMergeReadiness({ workingTree: clean })
    ).toBeUndefined();
  });
});

describe("describeWorktreeStatus", () => {
  it("spells out commits and changes against the source branch", () => {
    expect(
      describeWorktreeStatus(
        {
          branchName: "feature/x",
          sourceComparison: { ahead: 1, behind: 4 },
          workingTree: {
            ...clean,
            staged: { added: 1, modified: 0, deleted: 0 },
            unstaged: { added: 0, modified: 2, deleted: 0 },
          },
        },
        "main"
      )
    ).toBe(
      "feature/x — 1 commit ahead of main, 4 behind — 1 staged and 2 unstaged changes"
    );
  });
});
