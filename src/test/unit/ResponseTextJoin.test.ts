import * as assert from "assert";
import { suite, test } from "mocha";
import {
  appendResponseText,
  joinResponseText,
} from "../../utils/ResponseTextJoin";

suite("ResponseTextJoin", () => {
  test("inserts a paragraph break between two messages", () => {
    assert.strictEqual(
      appendResponseText("in the trash.", "All of these"),
      "in the trash.\n\nAll of these"
    );
  });

  test("returns the other side unchanged when either side is empty", () => {
    assert.strictEqual(appendResponseText("", "next"), "next");
    assert.strictEqual(appendResponseText("prev", ""), "prev");
  });

  test("does not add a separator when the boundary already breaks a line", () => {
    assert.strictEqual(appendResponseText("a\n", "b"), "a\nb");
    assert.strictEqual(
      appendResponseText("a", "\n[Edited: x]"),
      "a\n[Edited: x]"
    );
  });

  test("joins pieces in order and skips empty ones", () => {
    assert.strictEqual(joinResponseText(["a", "", "b", "c"]), "a\n\nb\n\nc");
  });
});
