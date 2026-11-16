import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravityHarnessAdapter } from "../../core/harness/antigravity/AntigravityHarnessAdapter";
import { ClaudeHarnessAdapter } from "../../core/harness/claude/ClaudeHarnessAdapter";
import { CodexHarnessAdapter } from "../../core/harness/codex/CodexHarnessAdapter";
import { CopilotHarnessAdapter } from "../../core/harness/copilot/CopilotHarnessAdapter";
import { OpenCodeHarnessAdapter } from "../../core/harness/opencode/OpenCodeHarnessAdapter";
import { QwenHarnessAdapter } from "../../core/harness/qwen/QwenHarnessAdapter";
import { HEADLESS_PROMPT_DELIVERIES } from "../../types/DashboardConstants";

suite("CLI provider argument characterization", () => {
  const baseArgs = ["--model", "model-x", "--add-dir", "/workspace"];
  const prompt = "prompt text";

  test("preserves Claude headless argument order", () => {
    assert.deepStrictEqual(
      new ClaudeHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      [
        "prompt text",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "model-x",
        "--add-dir",
        "/workspace",
      ]
    );
  });

  test("keeps the Copilot headless prompt out of argv for stdin delivery", () => {
    const provider = new CopilotHarnessAdapter();
    assert.strictEqual(
      provider.config.headlessPromptDelivery,
      HEADLESS_PROMPT_DELIVERIES.STDIN
    );
    assert.deepStrictEqual(provider.buildHeadlessArgs(baseArgs, prompt), [
      "--output-format",
      "json",
      "--model",
      "model-x",
      "--add-dir",
      "/workspace",
    ]);
  });

  test("reads the Codex headless prompt from stdin with `-`", () => {
    const provider = new CodexHarnessAdapter();
    assert.strictEqual(
      provider.config.headlessPromptDelivery,
      HEADLESS_PROMPT_DELIVERIES.STDIN
    );
    assert.deepStrictEqual(provider.buildHeadlessArgs(baseArgs, prompt), [
      "--model",
      "model-x",
      "--add-dir",
      "/workspace",
      "-",
    ]);
  });

  test("keeps the OpenCode headless prompt out of argv for stdin delivery", () => {
    // `opencode run` quote-wraps a positional message containing a space, so
    // the prompt is piped on stdin instead.
    const provider = new OpenCodeHarnessAdapter();
    assert.strictEqual(
      provider.config.headlessPromptDelivery,
      HEADLESS_PROMPT_DELIVERIES.STDIN
    );
    assert.deepStrictEqual(provider.buildHeadlessArgs(baseArgs, prompt), [
      "--model",
      "model-x",
      "--add-dir",
      "/workspace",
    ]);
  });

  test("keeps the Qwen headless prompt out of argv for its control channel", () => {
    assert.deepStrictEqual(
      new QwenHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--model",
        "model-x",
        "--add-dir",
        "/workspace",
      ]
    );
  });

  test("keeps the Antigravity headless prompt out of argv for stdin delivery", () => {
    const provider = new AntigravityHarnessAdapter();
    assert.strictEqual(
      provider.config.headlessPromptDelivery,
      HEADLESS_PROMPT_DELIVERIES.STDIN
    );
    assert.deepStrictEqual(provider.buildHeadlessArgs(baseArgs, prompt), [
      "--output-format",
      "stream-json",
      "--model",
      "model-x",
      "--add-dir",
      "/workspace",
    ]);
  });
});
