import * as assert from "assert";
import { suite, test } from "mocha";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";

// ============================================================================

suite("QwenCliProvider", () => {
  suite("buildHeadlessArgs", () => {
    const provider = new QwenCliProvider();

    test("includes --input-format stream-json alongside --output-format stream-json", () => {
      const result = provider.buildHeadlessArgs(["--base"], "do the thing");
      assert.deepStrictEqual(result, [
        "do the thing",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--base",
      ]);
    });
  });

  suite("buildInteractiveArgs", () => {
    const provider = new QwenCliProvider();

    test("does not add --output-format/--input-format (interactive mode never hits the non-interactive gate)", () => {
      const result = provider.buildInteractiveArgs(["--base"], "do the thing");
      assert.deepStrictEqual(result, ["-i", "do the thing", "--base"]);
    });
  });
});
