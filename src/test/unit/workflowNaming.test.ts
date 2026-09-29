import * as assert from "assert";
import { suite, test } from "mocha";
import { generateWorkflowNameFromPrompt } from "../../utils/workflowNaming";

suite("workflowNaming", () => {
  test("preserves Unicode letters and numbers while trimming punctuation", () => {
    for (const [prompt, expected] of [
      ["Écrire un résumé", "Écrire un résumé"],
      ["Überprüfe die Tests", "Überprüfe die Tests"],
      ["naïve café test", "naïve café test"],
      ["修复登录错误", "修复登录错误"],
    ]) {
      assert.strictEqual(generateWorkflowNameFromPrompt(prompt), expected);
    }
  });

  test("continues trimming ASCII punctuation around words", () => {
    assert.strictEqual(
      generateWorkflowNameFromPrompt("...hello, (world)! --again--"),
      "hello world again"
    );
  });
});
