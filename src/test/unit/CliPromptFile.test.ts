import * as assert from "assert";
import { suite, test } from "mocha";
import { applyCliAppendOverrides } from "../../cli/CliPromptFile";
import { HARNESS_IDS } from "../../types/DashboardConstants";

suite("CLI prompt file helpers", () => {
  test("append flags fill only prompt steps without their own harness or model", () => {
    const overridden = applyCliAppendOverrides(
      [
        { prompt: "inherit" },
        { prompt: "authored harness", harness: HARNESS_IDS.CLAUDE_CLI },
        { prompt: "authored model", model: "model-authored" },
        { type: "script", script: "echo safe" },
      ],
      HARNESS_IDS.CODEX_CLI,
      "model-flag"
    );

    assert.deepStrictEqual(overridden, [
      {
        prompt: "inherit",
        harness: HARNESS_IDS.CODEX_CLI,
        model: "model-flag",
      },
      {
        prompt: "authored harness",
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "model-flag",
      },
      {
        prompt: "authored model",
        model: "model-authored",
        harness: HARNESS_IDS.CODEX_CLI,
      },
      { type: "script", script: "echo safe" },
    ]);
  });
});
