import { describe, expect, it } from "vitest";
import { tokenize } from "react-diff-view";
import {
  buildDiffRenderPlan,
  getRenderedDiffStats,
  parseUnifiedDiffToFiles,
  type RenderedDiffRun,
} from "@utils/rdvAdapter";
import {
  getLanguageFromPath,
  normalizeSyntaxLanguage,
  refractor,
} from "@utils/syntaxHighlighting";

describe("getRenderedDiffStats", () => {
  it("merges contiguous unified rows with the same rendered signature", () => {
    const result = getRenderedDiffStats(
      [
        {
          content: "@@ -1,4 +1,4 @@",
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 4,
          changes: [
            {
              type: "normal",
              isNormal: true,
              oldLineNumber: 1,
              newLineNumber: 1,
              content: "context 1",
            },
            {
              type: "normal",
              isNormal: true,
              oldLineNumber: 2,
              newLineNumber: 2,
              content: "context 2",
            },
            {
              type: "insert",
              isInsert: true,
              lineNumber: 3,
              content: "added 1",
            },
            {
              type: "insert",
              isInsert: true,
              lineNumber: 4,
              content: "added 2",
            },
          ],
        },
      ],
      "unified"
    );

    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.runs).toEqual<RenderedDiffRun[]>([
      { count: 2, addedLines: 0, removedLines: 0 },
      { count: 2, addedLines: 1, removedLines: 0 },
    ]);
  });

  it("uses split-view row pairing for adjacent delete/insert changes", () => {
    const result = getRenderedDiffStats(
      [
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
              content: "removed",
            },
            {
              type: "insert",
              isInsert: true,
              lineNumber: 1,
              content: "added",
            },
            {
              type: "normal",
              isNormal: true,
              oldLineNumber: 2,
              newLineNumber: 2,
              content: "context",
            },
            {
              type: "delete",
              isDelete: true,
              lineNumber: 3,
              content: "removed only",
            },
          ],
        },
      ],
      "split"
    );

    expect(result.added).toBe(1);
    expect(result.removed).toBe(2);
    expect(result.runs).toEqual<RenderedDiffRun[]>([
      { count: 1, addedLines: 1, removedLines: 1 },
      { count: 1, addedLines: 0, removedLines: 0 },
      { count: 1, addedLines: 0, removedLines: 1 },
    ]);
  });
});

describe("buildDiffRenderPlan", () => {
  const replaceHunk = [
    {
      content: "@@ -1,3 +1,3 @@",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      changes: [
        {
          type: "delete" as const,
          isDelete: true as const,
          lineNumber: 1,
          content: "removed",
        },
        {
          type: "insert" as const,
          isInsert: true as const,
          lineNumber: 1,
          content: "added",
        },
        {
          type: "normal" as const,
          isNormal: true as const,
          oldLineNumber: 2,
          newLineNumber: 2,
          content: "context",
        },
      ],
    },
  ];

  it("builds row-sizing pieces from rendered stats", () => {
    const plan = buildDiffRenderPlan(replaceHunk, {
      viewType: "unified",
      outputFontSize: 13,
    });

    expect(plan.runs).toEqual<RenderedDiffRun[]>([
      { count: 1, addedLines: 0, removedLines: 1 },
      { count: 1, addedLines: 1, removedLines: 0 },
      { count: 1, addedLines: 0, removedLines: 0 },
    ]);
    expect(plan.renderedRows).toBe(3);
    expect(plan.bodyHeight).toBeCloseTo(plan.renderedRows * plan.lineHeight);
    expect(plan.diffBlockHeight).toBeCloseTo(
      plan.headerHeight + plan.bodyHeight
    );
    expect(plan.totalHeight).toBeCloseTo(
      plan.toolLineHeight +
        plan.headerHeight +
        plan.decorationHeight +
        plan.bodyHeight
    );
  });

  it("models split replacements with fewer rendered rows than unified", () => {
    const unifiedPlan = buildDiffRenderPlan(replaceHunk, {
      viewType: "unified",
      outputFontSize: 13,
    });
    const splitPlan = buildDiffRenderPlan(replaceHunk, {
      viewType: "split",
      outputFontSize: 13,
    });

    expect(unifiedPlan.renderedRows).toBe(3);
    expect(splitPlan.renderedRows).toBe(2);
    expect(splitPlan.bodyHeight).toBeLessThan(unifiedPlan.bodyHeight);
    expect(splitPlan.totalHeight).toBeLessThan(unifiedPlan.totalHeight);
  });
});

describe("syntaxHighlighting", () => {
  it("resolves file extensions and fence aliases through one registry", () => {
    expect(getLanguageFromPath("src/example.tsx")).toBe("tsx");
    expect(getLanguageFromPath("config/workflow.yml")).toBe("yaml");
    expect(normalizeSyntaxLanguage("tsx")).toBe("tsx");
    expect(normalizeSyntaxLanguage("yml")).toBe("yaml");
  });

  it("registers the React-oriented refractor grammars used by DiffView", () => {
    expect(refractor.registered("typescript")).toBe(true);
    expect(refractor.registered("tsx")).toBe(true);
    expect(refractor.registered("javascript")).toBe(true);
    expect(refractor.registered("jsx")).toBe(true);
  });

  it("adapts refractor.highlight() to the array shape react-diff-view tokenize() expects", () => {
    const hunks = [
      {
        content: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        changes: [
          {
            type: "normal" as const,
            isNormal: true as const,
            oldLineNumber: 1,
            newLineNumber: 1,
            content: "const value = 1;",
          },
        ],
      },
    ];

    expect(() =>
      tokenize(hunks, {
        highlight: true,
        refractor,
        language: "typescript",
        oldSource: "const value = 1;",
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseUnifiedDiffToFiles
// ---------------------------------------------------------------------------

const SAMPLE_UNIFIED_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
diff --git a/src/bar.md b/src/bar.md
index 111aaaa..222bbbb 100644
--- a/src/bar.md
+++ b/src/bar.md
@@ -1,2 +1,2 @@
-# Old heading
+# New heading
 Some text.
`;

const SAMPLE_GIT_SHOW_DIFF = `commit abc1234567890abcdef
Author: Dev <dev@example.com>
Date:   Fri Jun 12 12:00:00 2026 -0500

    feat: add files

 src/foo.ts | 2 +-
 src/bar.md | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)

${SAMPLE_UNIFIED_DIFF}`;

describe("parseUnifiedDiffToFiles", () => {
  it("returns an empty array for empty input", () => {
    expect(parseUnifiedDiffToFiles("")).toHaveLength(0);
    expect(parseUnifiedDiffToFiles("   \n  ")).toHaveLength(0);
  });

  it("parses a multi-file diff into one entry per file", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_UNIFIED_DIFF);
    expect(files).toHaveLength(2);
  });

  it("parses git show output with commit metadata and stat preamble", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_GIT_SHOW_DIFF);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("src/foo.ts");
    expect(files[1]!.path).toBe("src/bar.md");
  });

  it("sets the path from the b/ header", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_UNIFIED_DIFF);
    expect(files[0]!.path).toBe("src/foo.ts");
    expect(files[1]!.path).toBe("src/bar.md");
  });

  it("infers language from the file extension", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_UNIFIED_DIFF);
    expect(files[0]!.language).toBe("typescript");
    expect(files[1]!.language).toBe("markdown");
  });

  it("produces non-empty hunks for each changed file", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_UNIFIED_DIFF);
    for (const file of files) {
      expect(file.hunks.length).toBeGreaterThan(0);
    }
  });

  it("does not throw on malformed / binary-only input", () => {
    expect(() => parseUnifiedDiffToFiles("not a real diff")).not.toThrow();
  });
});
