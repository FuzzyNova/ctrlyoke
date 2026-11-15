import * as assert from "assert";
import { suite, test } from "mocha";
import { parseAskUserQuestionOptionRecord } from "../../core/harness/shared/AskUserQuestionPreview";

suite("AskUserQuestionPreview", () => {
  suite("parseAskUserQuestionOptionRecord", () => {
    test("preserves string label, description, and preview fields", () => {
      assert.deepStrictEqual(
        parseAskUserQuestionOptionRecord({
          label: "Option",
          description: "Details",
          preview: " /\\",
        }),
        {
          label: "Option",
          description: "Details",
          preview: " /\\",
        }
      );
    });

    test("uses undefined values for missing or non-string fields", () => {
      assert.deepStrictEqual(
        parseAskUserQuestionOptionRecord({
          label: "Option",
          description: 42,
          preview: false,
        }),
        {
          label: "Option",
          description: undefined,
          preview: undefined,
        }
      );
      assert.deepStrictEqual(parseAskUserQuestionOptionRecord(null), {
        label: "",
        description: undefined,
        preview: undefined,
      });
    });
  });
});
