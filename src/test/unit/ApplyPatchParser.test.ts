import * as assert from "assert";
import { ApplyPatchParser } from "../../core/harness/shared/ApplyPatchParser";
import { APPLY_PATCH_FILE_EDIT_KINDS } from "../../types/DashboardConstants";

suite("ApplyPatchParser", () => {
  test("keeps file-header text inside hunk lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-*** Update File: removed.ts",
      "+*** Add File: added.ts",
      " *** Update File: context.ts",
      " unchanged",
      "*** End Patch",
    ].join("\n");

    const edits = ApplyPatchParser.parseFileEdits(patch);

    assert.strictEqual(edits.length, 1);
    assert.deepStrictEqual(edits[0], {
      path: "src/example.ts",
      kind: APPLY_PATCH_FILE_EDIT_KINDS.UPDATE,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            "-*** Update File: removed.ts",
            "+*** Add File: added.ts",
            " *** Update File: context.ts",
            " unchanged",
          ],
        },
      ],
    });
    assert.strictEqual(
      ApplyPatchParser.extractFirstPath(patch),
      "src/example.ts"
    );
  });
});
