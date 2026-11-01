import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";
import { HEADLESS_PROMPT_DELIVERIES } from "../../types/DashboardConstants";

suite("CLI provider argument characterization", () => {
  const baseArgs = ["--model", "model-x", "--add-dir", "/workspace"];
  const prompt = "prompt text";

  test("preserves Claude headless argument order", () => {
    assert.deepStrictEqual(
      new ClaudeCliProvider().buildHeadlessArgs(baseArgs, prompt),
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
      new CopilotCliProvider().buildHeadlessArgs(baseArgs, prompt),
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
      new CodexCliProvider().buildHeadlessArgs(baseArgs, prompt),
      ["--model", "model-x", "--add-dir", "/workspace", "prompt text"]
    );
  });

  test("keeps the OpenCode headless prompt out of argv for stdin delivery", () => {
    // `opencode run` quote-wraps a positional message containing a space, so
    // the prompt is piped on stdin instead.
    const provider = new OpenCodeCliProvider();
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
      new QwenCliProvider().buildHeadlessArgs(baseArgs, prompt),
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
      new AntigravityCliProvider().buildHeadlessArgs(baseArgs, prompt),
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
