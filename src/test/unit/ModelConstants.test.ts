import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getModelDisplayName,
  isKnownCopilotModel,
  getClaudeModelName,
  isValidClaudeModel,
  getClaudeContextWindowSize,
  getQwenModelName,
  getQwenContextWindowSize,
  getAntigravityModelName,
  getAntigravityContextWindowSize,
  COPILOT_MODELS,
  CLAUDE_CLI_MODELS,
  QWEN_CLI_MODELS,
  ANTIGRAVITY_CLI_MODELS,
  MODEL_NONE,
} from "../../utils/ModelConstants";

suite("ModelConstants", () => {
  suite("getModelDisplayName", () => {
    test("returns display name for known Copilot model", () => {
      assert.strictEqual(getModelDisplayName("gpt-4o-mini"), "GPT-4o Mini");
    });

    test("returns display name for another known model", () => {
      assert.strictEqual(
        getModelDisplayName("claude-sonnet-4.5"),
        "Claude Sonnet 4.5"
      );
    });

    test("formats unknown model ID as capitalized words", () => {
      assert.strictEqual(
        getModelDisplayName("my-custom-model"),
        "My Custom Model"
      );
    });

    test("handles single-word unknown model", () => {
      assert.strictEqual(getModelDisplayName("turbo"), "Turbo");
    });

    test("returns 'Auto' for auto model", () => {
      assert.strictEqual(getModelDisplayName("auto"), "Auto");
    });
  });

  suite("isKnownCopilotModel", () => {
    test("returns true for known model", () => {
      assert.strictEqual(isKnownCopilotModel("gpt-4o-mini"), true);
    });

    test("returns true for auto", () => {
      assert.strictEqual(isKnownCopilotModel("auto"), true);
    });

    test("returns false for unknown model", () => {
      assert.strictEqual(isKnownCopilotModel("unknown-model"), false);
    });

    test("returns false for empty string", () => {
      assert.strictEqual(isKnownCopilotModel(""), false);
    });
  });

  suite("getClaudeModelName", () => {
    test("returns alias for fable", () => {
      assert.strictEqual(getClaudeModelName("fable"), "fable");
    });

    test("returns alias for direct match", () => {
      assert.strictEqual(getClaudeModelName("sonnet"), "sonnet");
    });

    test("returns alias for opus", () => {
      assert.strictEqual(getClaudeModelName("opus"), "opus");
    });

    test("returns alias for haiku", () => {
      assert.strictEqual(getClaudeModelName("haiku"), "haiku");
    });

    test("maps Copilot-style name to alias", () => {
      assert.strictEqual(getClaudeModelName("claude-sonnet-4.5"), "sonnet");
    });

    test("maps Copilot-style opus name to alias", () => {
      assert.strictEqual(getClaudeModelName("claude-opus-4.6"), "opus");
    });

    test("maps Copilot-style fable name to alias", () => {
      assert.strictEqual(getClaudeModelName("claude-fable-5"), "fable");
    });

    test("returns undefined for unrecognized model", () => {
      assert.strictEqual(getClaudeModelName("gpt-4o"), undefined);
    });

    test("handles case-insensitive matching", () => {
      assert.strictEqual(getClaudeModelName("Sonnet"), "sonnet");
    });
  });

  suite("isValidClaudeModel", () => {
    test("returns true for fable alias", () => {
      assert.strictEqual(isValidClaudeModel("fable"), true);
    });

    test("returns true for valid alias", () => {
      assert.strictEqual(isValidClaudeModel("sonnet"), true);
    });

    test("returns true for 1m context variant", () => {
      assert.strictEqual(isValidClaudeModel("sonnet[1m]"), true);
    });

    test("returns false for Copilot-style name", () => {
      assert.strictEqual(isValidClaudeModel("claude-sonnet-4.5"), false);
    });

    test("returns false for empty string", () => {
      assert.strictEqual(isValidClaudeModel(""), false);
    });
  });

  suite("getClaudeContextWindowSize", () => {
    test("returns 1M for fable", () => {
      assert.strictEqual(getClaudeContextWindowSize("fable"), 1_000_000);
      assert.strictEqual(
        getClaudeContextWindowSize("claude-fable-5"),
        1_000_000
      );
    });

    test("returns 1M for bare sonnet (resolves to Sonnet 5)", () => {
      assert.strictEqual(getClaudeContextWindowSize("sonnet"), 1_000_000);
    });

    test("returns 1M for sonnet-5.x", () => {
      assert.strictEqual(
        getClaudeContextWindowSize("claude-sonnet-5"),
        1_000_000
      );
    });

    test("returns 200k for sonnet-4.x", () => {
      assert.strictEqual(
        getClaudeContextWindowSize("claude-sonnet-4"),
        200_000
      );
      assert.strictEqual(
        getClaudeContextWindowSize("claude-sonnet-4.5"),
        200_000
      );
      assert.strictEqual(
        getClaudeContextWindowSize("claude-sonnet-4.6"),
        200_000
      );
    });

    test("returns 1M for [1m] variant", () => {
      assert.strictEqual(getClaudeContextWindowSize("sonnet[1m]"), 1_000_000);
    });

    test("returns 1M for model containing '1m' substring", () => {
      assert.strictEqual(getClaudeContextWindowSize("opus[1m]"), 1_000_000);
    });

    test("returns 1M for opus", () => {
      assert.strictEqual(getClaudeContextWindowSize("opus"), 1_000_000);
    });

    test("returns 200k for haiku", () => {
      assert.strictEqual(getClaudeContextWindowSize("haiku"), 200_000);
    });
  });

  suite("getQwenModelName", () => {
    test("returns model name for known Qwen model", () => {
      assert.strictEqual(getQwenModelName("qwen3.5-plus"), "qwen3.5-plus");
    });

    test("returns arbitrary model string as-is", () => {
      assert.strictEqual(getQwenModelName("custom-qwen"), "custom-qwen");
    });

    test("returns undefined for empty string", () => {
      assert.strictEqual(getQwenModelName(""), undefined);
    });
  });

  suite("getQwenContextWindowSize", () => {
    test("returns 1M for any model", () => {
      assert.strictEqual(getQwenContextWindowSize("qwen3.5-plus"), 1_000_000);
    });
  });

  suite("getAntigravityModelName", () => {
    test("returns model name for known Antigravity model", () => {
      assert.strictEqual(
        getAntigravityModelName("Claude Sonnet 4.6 (Thinking)"),
        "Claude Sonnet 4.6 (Thinking)"
      );
    });

    test("returns arbitrary model string as-is", () => {
      assert.strictEqual(
        getAntigravityModelName("Custom AGY Model"),
        "Custom AGY Model"
      );
    });

    test("returns undefined for empty string", () => {
      assert.strictEqual(getAntigravityModelName(""), undefined);
    });
  });

  suite("getAntigravityContextWindowSize", () => {
    test("returns 1M for Gemini Antigravity models", () => {
      assert.strictEqual(
        getAntigravityContextWindowSize("Gemini 3.5 Flash (Low)"),
        1_000_000
      );
    });

    test("returns 200k for Claude Antigravity models", () => {
      assert.strictEqual(
        getAntigravityContextWindowSize("Claude Sonnet 4.6 (Thinking)"),
        200_000
      );
    });

    test("returns 128k for GPT-OSS Antigravity models", () => {
      assert.strictEqual(
        getAntigravityContextWindowSize("GPT-OSS 120B (Medium)"),
        128_000
      );
    });
  });

  suite("constant arrays", () => {
    test("COPILOT_MODELS has entries", () => {
      assert.ok(Object.keys(COPILOT_MODELS).length > 0);
    });

    test("CLAUDE_CLI_MODELS includes fable", () => {
      assert.ok(CLAUDE_CLI_MODELS.includes("fable"));
    });

    test("CLAUDE_CLI_MODELS includes sonnet", () => {
      assert.ok(CLAUDE_CLI_MODELS.includes("sonnet"));
    });

    test("QWEN_CLI_MODELS includes qwen3.5-plus", () => {
      assert.ok(QWEN_CLI_MODELS.includes("qwen3.5-plus"));
    });

    test("ANTIGRAVITY_CLI_MODELS includes Claude Sonnet 4.6 (Thinking)", () => {
      assert.ok(
        ANTIGRAVITY_CLI_MODELS.includes("Claude Sonnet 4.6 (Thinking)")
      );
    });

    test("MODEL_NONE is 'none'", () => {
      assert.strictEqual(MODEL_NONE, "none");
    });
  });
});

