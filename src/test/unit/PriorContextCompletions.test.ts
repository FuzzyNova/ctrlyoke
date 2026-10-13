import * as assert from "assert";
import { suite, test } from "mocha";
import { getPriorContextCompletionItems } from "../../completions/PriorContextCompletions";

suite("PriorContextCompletions", () => {
  test("offers every summary selector with deterministic detail", () => {
    const items = getPriorContextCompletionItems("summary:");
    assert.deepStrictEqual(
      items.map((item) => item.label),
      [
        "summary:previous",
        "summary:previous:",
        "summary:all",
        "summary:finalStep",
        "summary:allFinalStep",
        "summary:step:",
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
