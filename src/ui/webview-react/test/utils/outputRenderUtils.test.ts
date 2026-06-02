import { describe, expect, it } from "vitest";
import { computeOutputDiffStats } from "@utils/outputRenderUtils";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";

describe("computeOutputDiffStats", () => {
  const structuredPatch = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-line 1", "+updated start"],
    },
    {
      oldStart: 42,
      oldLines: 1,
      newStart: 42,
      newLines: 1,
      lines: ["-line 42", "+updated end"],
    },
  ];

  const workspaceSnapshot = {
    capturedAt: Date.now(),
    strategy: "git" as const,
    git: {
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
    },
    changedFiles: [
      {
        path: "src/example.ts",
        changeType: "modified" as const,
        beforeContent: Array.from(
          { length: 42 },
          (_, index) => `line ${index + 1}`
        ).join("\n"),
        structuredPatch,
      },
    ],
  };

  const event = {
    type: CLI_EVENT_TYPES.FILE_EDIT,
    data: {
      path: "src/example.ts",
      status: OPERATION_STATUS.COMPLETED,
      structuredPatch,
    },
  };

  it("builds exact expanded-gap render plans when snapshot old content is available", () => {
    const base = computeOutputDiffStats(event, workspaceSnapshot, {
      viewType: "unified",
      outputFontSize: 13,
    });
    const expanded = computeOutputDiffStats(event, workspaceSnapshot, {
      viewType: "unified",
      outputFontSize: 13,
      expandedGaps: new Map([[1, 27]]),
    });

    expect(base.renderPlan.gapExpansion).toEqual({
      model: "none",
      requestedGaps: 0,
      appliedGaps: 0,
    });
    expect(expanded.renderPlan.gapExpansion).toEqual({
      model: "exact",
      requestedGaps: 1,
      appliedGaps: 1,
    });
    expect(expanded.renderPlan.renderedRows).toBeGreaterThan(
      base.renderPlan.renderedRows
    );
    expect(expanded.renderPlan.totalHeight).toBeGreaterThan(
      base.renderPlan.totalHeight
    );
  });

  it("keeps base stats when expanded gaps are requested without old content", () => {
    const base = computeOutputDiffStats(event, undefined, {
      viewType: "unified",
      outputFontSize: 13,
    });
    const expanded = computeOutputDiffStats(event, undefined, {
      viewType: "unified",
      outputFontSize: 13,
      expandedGaps: new Map([[1, 27]]),
    });

    expect(expanded.runs).toEqual(base.runs);
    expect(expanded.renderPlan.renderedRows).toBe(base.renderPlan.renderedRows);
    expect(expanded.renderPlan.totalHeight).toBe(base.renderPlan.totalHeight);
    expect(expanded.renderPlan.gapExpansion).toEqual({
      model: "base-only-missing-old-content",
      requestedGaps: 1,
      appliedGaps: 0,
    });
  });
});
