import { describe, expect, it } from "vitest";
import { tokenize } from "react-diff-view";
import {
  buildDiffRenderPlan,
  getRenderedDiffStats,
  locateActiveDiffMatch,
  mergeNonTextDiffEntries,
  parseUnifiedDiffToFiles,
  type RenderedDiffRun,
} from "@utils/rdvAdapter";
import type { UnifiedDiffHunk } from "@/types/cliEvents";
import { DIFF_HORIZONTAL_SCROLLBAR_HEIGHT } from "@utils/outputLineMetrics";
import { DIFF_PAYLOAD_KINDS } from "@root/types/DashboardConstants";
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

  // Row height is the one part of a diff estimate that is derivable from CSS
  // rather than calibrated, so it is pinned here. The invented
  // `max(18, (fs - 1) * 1.55)` that preceded it read 18.6 against a real 18px
  // grid — a silent 3.3% on every diff, ~100px on the 167-row diff in the
  // 2026-08-13 log — and its floor over-predicted every base font below 13px.
  it.each([
    [13, 18],
    [12, 16.5],
    [16, 22.5],
  ])(
    "puts diff rows on the DOM's line-height grid at %ipx",
    (fontSize, expected) => {
      const plan = buildDiffRenderPlan(replaceHunk, {
        viewType: "unified",
        outputFontSize: fontSize,
      });

      expect(plan.lineHeight).toBeCloseTo(expected);
      expect(plan.bodyHeight).toBeCloseTo(3 * expected);
    }
  );

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

  // `ui.wordWrap` off: a change never wraps, so it is exactly one row, and the
  // only extra height is the scrollbar track DiffView's wrapper grows once a
  // line overflows the pane.
  describe("unwrapped (ui.wordWrap off)", () => {
    const singleLineHunk = (content: string) => [
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
            content,
          },
        ],
      },
    ];
    const longLine = "x".repeat(400);

    it("keeps an overflowing line on one row and charges the scrollbar", () => {
      const options = {
        viewType: "unified" as const,
        outputFontSize: 13,
        outputContentWidth: 400,
      };
      const wrapped = buildDiffRenderPlan(singleLineHunk(longLine), options);
      const unwrapped = buildDiffRenderPlan(singleLineHunk(longLine), {
        ...options,
        wordWrap: false,
      });

      expect(wrapped.bodyHeight).toBeGreaterThan(2 * wrapped.lineHeight);
      expect(wrapped.horizontalScrollbarHeight).toBe(0);
      expect(unwrapped.horizontalScrollbarHeight).toBe(
        DIFF_HORIZONTAL_SCROLLBAR_HEIGHT
      );
      expect(unwrapped.bodyHeight).toBeCloseTo(
        unwrapped.lineHeight + DIFF_HORIZONTAL_SCROLLBAR_HEIGHT
      );
      expect(unwrapped.diffBlockHeight).toBeCloseTo(
        unwrapped.headerHeight + unwrapped.bodyHeight
      );
    });

    it("charges no scrollbar when every line fits", () => {
      const plan = buildDiffRenderPlan(replaceHunk, {
        viewType: "unified",
        outputFontSize: 13,
        wordWrap: false,
      });

      expect(plan.horizontalScrollbarHeight).toBe(0);
      expect(plan.bodyHeight).toBeCloseTo(3 * plan.lineHeight);
    });

    it("charges nothing while collapsed", () => {
      const plan = buildDiffRenderPlan(singleLineHunk(longLine), {
        viewType: "unified",
        outputFontSize: 13,
        outputContentWidth: 400,
        collapsed: true,
        wordWrap: false,
      });

      expect(plan.horizontalScrollbarHeight).toBe(0);
      expect(plan.bodyHeight).toBe(0);
    });
  });

  // Each collapsed gap between hunks renders its own "Show N hidden lines" bar
  // that estimateRenderedVisualRows never walks (it only sums hunk.changes),
  // so a multi-hunk diff with a gap still open under-counted by exactly one bar.
  describe("gap decoration rows", () => {
    const twoHunksWithGap = [
      {
        content: "@@ -1,3 +1,3 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        changes: [
          {
            type: "normal" as const,
            isNormal: true as const,
            oldLineNumber: 1,
            newLineNumber: 1,
            content: "context",
          },
        ],
      },
      {
        content: "@@ -10,2 +10,2 @@",
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 2,
        changes: [
          {
            type: "normal" as const,
            isNormal: true as const,
            oldLineNumber: 10,
            newLineNumber: 10,
            content: "more context",
          },
        ],
      },
    ];

    it("counts a gap between two hunks and adds its height to the body", () => {
      const withGap = buildDiffRenderPlan(twoHunksWithGap, {
        viewType: "unified",
        outputFontSize: 13,
      });
      const withoutGap = buildDiffRenderPlan([twoHunksWithGap[0]], {
        viewType: "unified",
        outputFontSize: 13,
      });

      expect(withGap.gapDecorationRows).toBe(1);
      expect(withGap.gapDecorationsHeight).toBeGreaterThan(0);
      expect(withGap.bodyHeight).toBeCloseTo(
        withGap.renderedRows * withGap.lineHeight + withGap.gapDecorationsHeight
      );
      expect(withoutGap.gapDecorationRows).toBe(0);
    });

    it("does not count a zero-length gap between adjacent hunks", () => {
      const adjacentHunks = [
        twoHunksWithGap[0],
        { ...twoHunksWithGap[1], oldStart: 4, newStart: 4 },
      ];

      expect(
        buildDiffRenderPlan(adjacentHunks, {
          viewType: "unified",
          outputFontSize: 13,
        }).gapDecorationRows
      ).toBe(0);
    });

    it("omits gap decoration height while collapsed", () => {
      const plan = buildDiffRenderPlan(twoHunksWithGap, {
        viewType: "unified",
        outputFontSize: 13,
        collapsed: true,
      });

      expect(plan.gapDecorationsHeight).toBe(0);
      expect(plan.bodyHeight).toBe(0);
    });
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

const SAMPLE_CHANGE_TYPES_DIFF = `diff --git a/src/created.ts b/src/created.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/created.ts
@@ -0,0 +1,1 @@
+export const created = true;
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/deleted.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const deleted = true;
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/src/modified.ts b/src/modified.ts
index 3333333..4444444 100644
--- a/src/modified.ts
+++ b/src/modified.ts
@@ -1,1 +1,1 @@
-export const modified = false;
+export const modified = true;
`;

const SAMPLE_TWO_DELETES_DIFF = `diff --git a/src/first.ts b/src/first.ts
deleted file mode 100644
index 5555555..0000000
--- a/src/first.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-first
diff --git a/src/second.ts b/src/second.ts
deleted file mode 100644
index 6666666..0000000
--- a/src/second.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-second
`;

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

  it("normalizes added, deleted, renamed, and modified file metadata", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_CHANGE_TYPES_DIFF);

    expect(
      files.map(({ path, oldPath, changeType }) => ({
        path,
        oldPath,
        changeType,
      }))
    ).toEqual([
      { path: "src/created.ts", oldPath: undefined, changeType: "created" },
      { path: "src/deleted.ts", oldPath: undefined, changeType: "deleted" },
      {
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        changeType: "renamed",
      },
      { path: "src/modified.ts", oldPath: undefined, changeType: "modified" },
    ]);
    expect(JSON.stringify(files)).not.toContain("/dev/null");
  });

  it("keeps distinct real paths for multiple deleted files", () => {
    const files = parseUnifiedDiffToFiles(SAMPLE_TWO_DELETES_DIFF);

    expect(files.map((file) => file.path)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(new Set(files.map((file) => file.path)).size).toBe(2);
    expect(JSON.stringify(files)).not.toContain("/dev/null");
  });

  it("does not throw on malformed / binary-only input", () => {
    expect(() => parseUnifiedDiffToFiles("not a real diff")).not.toThrow();
  });
});

describe("mergeNonTextDiffEntries", () => {
  it("retains binary/image entries and merges them by path", () => {
    const files = mergeNonTextDiffEntries(
      [
        {
          path: "src/text.ts",
          changeType: "modified",
          hunks: [],
          diffType: "modify",
        },
      ],
      [
        {
          path: "assets/logo.png",
          changeType: "created",
          payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
          image: { newImageDataUri: "data:image/png;base64,new" },
        },
        {
          path: "assets/data.bin",
          changeType: "modified",
          payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
        },
      ]
    );

    expect(files.map((file) => file.path)).toEqual([
      "src/text.ts",
      "assets/logo.png",
      "assets/data.bin",
    ]);
    expect(files[1]).toMatchObject({
      payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
      image: { newImageDataUri: "data:image/png;base64,new" },
    });
    expect(files[2]).toMatchObject({
      payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
      hunks: [],
    });
  });
});

describe("locateActiveDiffMatch", () => {
  // Mirrors getStructuredPatchText's join semantics exactly: rendered line
  // content flattened across hunks and joined with "\n", without prefixes.
  // Content lengths here: "context1"=8, "removed"=7, "added"=5, "context2"=8.
  const hunk: UnifiedDiffHunk = {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    lines: [" context1", "-removed", "+added", " context2"],
  };

  it("locates a match on a deleted (old-side) line", () => {
    // "removed" begins after "context1" and its join separator.
    const result = locateActiveDiffMatch([hunk], 9, 16);
    expect(result).toEqual({ side: "old", lineNumber: 11, start: 0, end: 7 });
  });

  it("locates a match on an inserted (new-side) line", () => {
    // "added" begins after "context1\nremoved\n".
    const result = locateActiveDiffMatch([hunk], 17, 22);
    expect(result).toEqual({ side: "new", lineNumber: 11, start: 0, end: 5 });
  });

  it("locates a match on a context line as a new-side line", () => {
    // "context2" begins after "context1\nremoved\nadded\n".
    const result = locateActiveDiffMatch([hunk], 23, 31);
    expect(result).toEqual({ side: "new", lineNumber: 12, start: 0, end: 8 });
  });

  it("returns null for an out-of-range offset", () => {
    expect(locateActiveDiffMatch([hunk], 1000, 1004)).toBeNull();
  });

  it("returns null when there is no structured patch", () => {
    expect(locateActiveDiffMatch(undefined, 0, 4)).toBeNull();
  });

  it("indexes against the deduplicated hunk sequence, matching getStructuredPatchText", () => {
    // An exact-duplicate hunk is dropped by normalizeStructuredPatch, so an
    // offset must resolve against ONE copy's worth of text, not two.
    const result = locateActiveDiffMatch([hunk, hunk], 9, 16);
    expect(result).toEqual({ side: "old", lineNumber: 11, start: 0, end: 7 });
  });
});
