import { describe, expect, it, vi } from "vitest";
import type { HunkData } from "react-diff-view";
import type { DiffFileCardProps } from "@components/diff/DiffFileCard";
import type { WorkspaceFileHistoryDiffResponse } from "@root/types/HostedWorkspaceViewerTypes";
import {
  DIFF_FILE_LIST_ROW_GAP,
  estimateDiffFileCardSize,
  projectDiffFileListRows,
} from "@utils/diffFileRows";
import * as rdvAdapter from "@utils/rdvAdapter";

const replacementHunk: HunkData[] = [
  {
    content: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    changes: [
      {
        type: "delete",
        isDelete: true,
        lineNumber: 1,
        content: "old value",
      },
      {
        type: "insert",
        isInsert: true,
        lineNumber: 1,
        content: "new value",
      },
      {
        type: "normal",
        isNormal: true,
        oldLineNumber: 2,
        newLineNumber: 2,
        content: "context",
      },
    ],
  },
];

function file(
  key: string,
  source: DiffFileCardProps["source"] = {
    kind: "hunks",
    hunks: replacementHunk,
    diffType: "modify",
  }
): DiffFileCardProps & { key: string } {
  return {
    key,
    path: key,
    changeType: "modified",
    source,
  };
}

describe("projectDiffFileListRows", () => {
  it("projects summary, headings, and files in display order", () => {
    const rows = projectDiffFileListRows({
      selectionSummary: "summary",
      groups: [
        {
          key: "reported",
          heading: "Reported",
          headingHint: "Known edits",
          files: [file("src/one.ts")],
        },
        { key: "empty", heading: "Empty", files: [] },
        { key: "other", files: [file("src/two.ts")] },
      ],
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "selection-summary",
      "group-heading",
      "file",
      "file",
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      "selection-summary",
      "reported\u001fheading",
      "reported\u001fsrc/one.ts",
      "other\u001fsrc/two.ts",
    ]);
    expect(rows[0]?.estimateSize).toBe(16 + DIFF_FILE_LIST_ROW_GAP);
    expect(rows[2]?.estimateSize).toBeGreaterThan(DIFF_FILE_LIST_ROW_GAP);
    expect(rows[3]?.hasInterRowGap).toBe(false);
  });

  it.each([
    ["one non-empty group", [{ heading: "Only", files: [file("one")] }]],
    [
      "multiple groups without headings",
      [{ files: [file("one")] }, { files: [file("two")] }],
    ],
  ])("suppresses headings for %s", (_caseName, groups) => {
    const rows = projectDiffFileListRows({ groups });
    expect(rows.some((row) => row.kind === "group-heading")).toBe(false);
  });

  it("renders only headings that have text when heading mode is active", () => {
    const rows = projectDiffFileListRows({
      groups: [
        { key: "first", heading: "First", files: [file("one")] },
        { key: "second", files: [file("two")] },
      ],
    });

    expect(rows.filter((row) => row.kind === "group-heading")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "file")).toHaveLength(2);
  });

  it("keeps the same path distinct in semantic groups", () => {
    const rows = projectDiffFileListRows({
      groups: [
        { key: "step-1", files: [file("src/shared.ts")] },
        { key: "step-2", files: [file("src/shared.ts")] },
      ],
    });

    expect(
      rows.filter((row) => row.kind === "file").map((row) => row.key)
    ).toEqual(["step-1\u001fsrc/shared.ts", "step-2\u001fsrc/shared.ts"]);
  });
});

describe("diff file estimates", () => {
  it("uses bounded O(1) estimates for image and binary sources", () => {
    const imageSource: DiffFileCardProps["source"] = {
      kind: "image",
      get image(): { oldImageDataUri?: string; newImageDataUri?: string } {
        throw new Error("image bytes must not be inspected by the estimator");
      },
    };
    const image = file("assets/logo.png", imageSource);
    const binary = file("assets/data.bin", { kind: "binary" });

    const imageExpanded = estimateDiffFileCardSize(image);
    const imageCollapsed = estimateDiffFileCardSize(image, { collapsed: true });
    const binaryExpanded = estimateDiffFileCardSize(binary);
    const binaryCollapsed = estimateDiffFileCardSize(binary, {
      collapsed: true,
    });

    expect(imageExpanded).toBeGreaterThan(imageCollapsed);
    expect(binaryExpanded).toBeGreaterThan(binaryCollapsed);
    expect(binaryExpanded).toBeLessThan(imageExpanded);
  });

  it("estimates deferred history cards from collapsed chrome only", () => {
    const source: DiffFileCardProps["source"] = {
      kind: "deferred",
      commit: "commit-1",
      state: "not-loaded",
      get detail(): WorkspaceFileHistoryDiffResponse {
        throw new Error(
          "deferred detail must not be inspected by the estimator"
        );
      },
    };
    const card = file("src/file.ts", source);
    const estimate = estimateDiffFileCardSize(card, { collapsed: true });

    expect(estimate).toBeGreaterThan(0);
    expect(estimateDiffFileCardSize(card)).toBe(estimate);
  });

  it("does not recompute raw content metrics when card props are rebuilt", () => {
    let oldReads = 0;
    let newReads = 0;
    const source: DiffFileCardProps["source"] = {
      kind: "content",
      get oldContent() {
        oldReads++;
        return "before\nunchanged";
      },
      get newContent() {
        newReads++;
        return "after\nunchanged";
      },
    };

    const first = estimateDiffFileCardSize(file("src/file.ts", source), {
      outputContentWidth: 320,
    });
    const readsAfterFirstEstimate = { oldReads, newReads };
    const second = estimateDiffFileCardSize(file("src/file.ts", source), {
      outputContentWidth: 320,
    });

    expect(second).toBe(first);
    expect({ oldReads, newReads }).toEqual(readsAfterFirstEstimate);
  });

  it("keys geometry by view type, font size, and width bucket", () => {
    const longHunk: HunkData[] = [
      {
        ...replacementHunk[0]!,
        changes: replacementHunk[0]!.changes.map((change) => ({
          ...change,
          content: `${change.content} ${"long text ".repeat(30)}`,
        })),
      },
    ];
    const card = file("src/file.ts", {
      kind: "hunks",
      hunks: longHunk,
      diffType: "modify",
    });

    const unified = estimateDiffFileCardSize(card, {
      viewType: "unified",
      outputFontSize: 13,
      outputContentWidth: 320,
    });
    const split = estimateDiffFileCardSize(card, {
      viewType: "split",
      outputFontSize: 13,
      outputContentWidth: 320,
    });
    const largerFont = estimateDiffFileCardSize(card, {
      viewType: "unified",
      outputFontSize: 16,
      outputContentWidth: 320,
    });
    const widerBucket = estimateDiffFileCardSize(card, {
      viewType: "unified",
      outputFontSize: 13,
      outputContentWidth: 512,
    });

    expect(split).not.toBe(unified);
    expect(largerFont).not.toBe(unified);
    expect(widerBucket).not.toBe(unified);
  });

  it("counts structured patch lines without parsing raw content", () => {
    const toRdvFromContent = vi.spyOn(rdvAdapter, "toRdvFromContent");
    const estimate = estimateDiffFileCardSize(
      file("src/file.ts", {
        kind: "patch",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: ["-before", "+after", " context"],
          },
        ],
        oldContent: "before",
      })
    );

    expect(estimate).toBeGreaterThan(DIFF_FILE_LIST_ROW_GAP);
    expect(toRdvFromContent).not.toHaveBeenCalled();
    toRdvFromContent.mockRestore();
  });
});
