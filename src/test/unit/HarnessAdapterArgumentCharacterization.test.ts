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

  test("preserves Copilot headless argument order", () => {
    assert.deepStrictEqual(
      new CopilotHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      [
        "--output-format",
        "json",
        "--prompt",
        "prompt text",
        "--model",
        "model-x",
        "--add-dir",
        "/workspace",
      ]
    );
  });

  test("preserves Codex headless argument order", () => {
    assert.deepStrictEqual(
      new CodexHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      ["--model", "model-x", "--add-dir", "/workspace", "prompt text"]
    );
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

  test("preserves Qwen headless argument order", () => {
    assert.deepStrictEqual(
      new QwenHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      [
        "prompt text",
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

  test("preserves Antigravity headless argument order", () => {
    assert.deepStrictEqual(
      new AntigravityHarnessAdapter().buildHeadlessArgs(baseArgs, prompt),
      [
        "--print",
        "prompt text",
        "--output-format",
        "stream-json",
        "--model",
        "model-x",
        "--add-dir",
        "/workspace",
      ]
    );
  });
});
