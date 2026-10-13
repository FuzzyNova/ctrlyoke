import * as assert from "assert";
import { suite, test } from "mocha";
import {
  countStructuredPatchChanges,
  countUnifiedDiffChanges,
  formatCreatedFileDiff,
  formatEditDiff,
  formatStructuredPatch,
} from "../../utils/CliEventDiff";

suite("CliEventDiff", () => {
  test("formats structured and content-based edit diffs", () => {
    const structured = {
      path: "src/example.ts",
      structuredPatch: [
        {
          oldStart: 2,
          oldLines: 1,
          newStart: 2,
          newLines: 1,
          lines: ["-before", "+after"],
        },
      ],
    };

    assert.strictEqual(
      formatStructuredPatch("src/example.ts", structured.structuredPatch),
      "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -2,1 +2,1 @@\n-before\n+after"
    );
    assert.ok(formatEditDiff(structured)?.includes("+after"));
    assert.ok(
      formatEditDiff({
        path: "a.txt",
        oldContent: "old",
        newContent: "new",
      })?.includes("+new")
    );
    assert.strictEqual(formatEditDiff({ path: "a.txt" }), undefined);
  });

  test("formats created files and counts added and removed patch lines", () => {
    assert.ok(
      formatCreatedFileDiff({ path: "new.txt", content: "one\ntwo" }).includes(
        "/dev/null"
      )
    );
    assert.deepStrictEqual(
      countStructuredPatchChanges([
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [" context", "-old", "+new"],
        },
      ]),
      { added: 1, removed: 1 }
    );
  });

  test("counts unified diff lines that look like file headers inside hunks", () => {
    assert.deepStrictEqual(
      countUnifiedDiffChanges(
        formatStructuredPatch("query.sql", [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: ["--- old comment", "+++i;", " keep"],
          },
        ])
      ),
      { added: 1, removed: 1 }
    );
    assert.deepStrictEqual(
      countUnifiedDiffChanges(
        formatCreatedFileDiff({ path: "new.txt", content: "one\ntwo\n" })
      ),
      { added: 2, removed: 0 }
    );
    assert.deepStrictEqual(countUnifiedDiffChanges(""), {
      added: 0,
      removed: 0,
    });
  });
});
