import * as assert from "assert";
import { suite, test } from "mocha";
import { getPriorContextCompletionItems } from "../../completions/PriorContextCompletions";

suite("PriorContextCompletions", () => {
  test("offers every summary selector with deterministic detail", () => {
    const items = getPriorContextCompletionItems("").filter((item) =>
      item.label.includes(":summary")
    );
    assert.deepStrictEqual(
      items.map((item) => item.label),
      [
        "previous:summary",
        "previous:summary:",
        "all:summary",
        "finalStep:summary",
        "allFinalStep:summary",
        "step:summary:",
      ]
    );
    assert.ok(
      items.every((item) =>
        item.detail?.includes(
          "deterministic excerpt: head of prompt, files changed, tail of text; no AI call"
        )
      )
    );
  });
});
