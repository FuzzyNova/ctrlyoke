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
  getGeminiModelName,
  getGeminiContextWindowSize,
  COPILOT_MODELS,
  CLAUDE_CLI_MODELS,
  GEMINI_CLI_MODELS,
  QWEN_CLI_MODELS,
  MODEL_NONE,
} from "../../utils/ModelConstants";

suite("ModelConstants", () => {
  suite("getModelDisplayName", () => {
    test("returns display name for known Copilot model", () => {
      assert.strictEqual(getModelDisplayName("gpt-4o"), "GPT-4o");
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
      assert.strictEqual(isKnownCopilotModel("gpt-4o"), true);
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

    test("returns undefined for unrecognized model", () => {
      assert.strictEqual(getClaudeModelName("gpt-4o"), undefined);
    });

    test("handles case-insensitive matching", () => {
      assert.strictEqual(getClaudeModelName("Sonnet"), "sonnet");
    });
  });

  suite("isValidClaudeModel", () => {
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
    test("returns 400k for sonnet model", () => {
      assert.strictEqual(getClaudeContextWindowSize("sonnet"), 400_000);
    });

    test("returns 1M for [1m] variant", () => {
      assert.strictEqual(getClaudeContextWindowSize("sonnet[1m]"), 1_000_000);
    });

    test("returns 1M for model containing '1m' substring", () => {
      assert.strictEqual(getClaudeContextWindowSize("opus[1m]"), 1_000_000);
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

  suite("getGeminiModelName", () => {
    test("returns model name for known Gemini model", () => {
      assert.strictEqual(
        getGeminiModelName("gemini-2.5-pro"),
        "gemini-2.5-pro"
      );
    });

    test("returns arbitrary model string as-is", () => {
      assert.strictEqual(getGeminiModelName("gemini-custom"), "gemini-custom");
    });

    test("returns undefined for empty string", () => {
      assert.strictEqual(getGeminiModelName(""), undefined);
    });
  });

  suite("getGeminiContextWindowSize", () => {
    test("returns 1M for any model", () => {
      assert.strictEqual(
        getGeminiContextWindowSize("gemini-2.5-pro"),
        1_000_000
      );
    });
  });

  suite("constant arrays", () => {
    test("COPILOT_MODELS has entries", () => {
      assert.ok(Object.keys(COPILOT_MODELS).length > 0);
    });

    test("CLAUDE_CLI_MODELS includes sonnet", () => {
      assert.ok(CLAUDE_CLI_MODELS.includes("sonnet"));
    });

    test("GEMINI_CLI_MODELS includes gemini-2.5-pro", () => {
      assert.ok(GEMINI_CLI_MODELS.includes("gemini-2.5-pro"));
    });

    test("QWEN_CLI_MODELS includes qwen3.5-plus", () => {
      assert.ok(QWEN_CLI_MODELS.includes("qwen3.5-plus"));
    });

    test("MODEL_NONE is 'none'", () => {
      assert.strictEqual(MODEL_NONE, "none");
    });
  });
});
