import * as assert from "assert";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import {
  getModelPricingFromRegistry,
  resolveModelPricingFromRegistry,
  type ModelPricingRegistryData,
} from "../../utils/ModelPricingRegistry";

const fixture: ModelPricingRegistryData = {
  sourceUrl: "https://models.dev/api.json",
  generatedAt: "2026-08-21",
  providers: {
    "github-copilot": {
      "claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3 },
      "gpt-5.6-sol": { input: 2.5, output: 15 },
    },
    anthropic: {
      "claude-sonnet-4-5": { input: 3, output: 15 },
      "claude-sonnet-4-6": { input: 3, output: 15 },
      "claude-sonnet-5": {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      },
      "claude-opus-4-6": { input: 5, output: 25 },
      "claude-haiku-4-5": { input: 1, output: 5 },
      "claude-fable-5": { input: 10, output: 50 },
      "claude-sonnet-4-5-20250929": { input: 999, output: 999 },
    },
    openai: {
      "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5 },
    },
    opencode: {
      "big-pickle": { input: 0, output: 0 },
      "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
    },
    alibaba: {
      "qwen3.5-plus": { input: 0.4, output: 2.4 },
    },
    google: {
      "gemini-3.6-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
    },
    groq: {
      "openai/gpt-oss-120b": { input: 0.15, output: 0.6, cacheRead: 0.075 },
    },
  },
};

suite("ModelPricingRegistry", () => {
  test("resolves Copilot CLI models against the github-copilot provider bucket", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.COPILOT_CLI,
      "claude-sonnet-4.6"
    );

    assert.strictEqual(result?.inputPerMTok, 3);
    assert.strictEqual(result?.outputPerMTok, 15);
    assert.strictEqual(result?.cachedInputPerMTok, 0.3);
    assert.ok(result?.sourceUrl.includes('provider="github-copilot"'));
  });

  test("resolves Codex CLI's fully-versioned model IDs directly against openai", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.CODEX_CLI,
      "gpt-5.6-sol"
    );

    assert.strictEqual(result?.inputPerMTok, 5);
    assert.strictEqual(result?.outputPerMTok, 30);
    assert.ok(result?.sourceUrl.includes('provider="openai"'));
  });

  test("resolves Claude CLI's bare 'sonnet' alias to the newest sonnet version", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.CLAUDE_CLI,
      "sonnet"
    );

    // Highest version among claude-sonnet-4-5, claude-sonnet-4-6, and
    // claude-sonnet-5 (dated 4-5 snapshot excluded) is claude-sonnet-5.
    assert.strictEqual(result?.inputPerMTok, 2);
    assert.strictEqual(result?.outputPerMTok, 10);
    assert.strictEqual(result?.cachedInputPerMTok, 0.2);
    assert.strictEqual(result?.cacheWritePerMTok, 2.5);
  });

  test("strips Claude CLI's [1m] suffix before resolving the alias", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.CLAUDE_CLI,
      "opus[1m]"
    );

    assert.strictEqual(result?.inputPerMTok, 5);
    assert.strictEqual(result?.outputPerMTok, 25);
  });

  test("resolves Claude CLI's other aliases (haiku, fable)", () => {
    const haiku = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.CLAUDE_CLI,
      "haiku"
    );
    const fable = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.CLAUDE_CLI,
      "fable"
    );

    assert.strictEqual(haiku?.inputPerMTok, 1);
    assert.strictEqual(fable?.inputPerMTok, 10);
  });

  test("resolves OpenCode's own <provider>/<model> ID via the explicit provider bucket", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.OPENCODE_CLI,
      "anthropic/claude-sonnet-4-6"
    );

    assert.strictEqual(result?.inputPerMTok, 3);
    assert.strictEqual(result?.outputPerMTok, 15);
    assert.ok(result?.sourceUrl.includes('provider="anthropic"'));
  });

  test("resolves OpenCode's own gateway model with no provider prefix", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.OPENCODE_CLI,
      "opencode/big-pickle"
    );

    assert.strictEqual(result?.inputPerMTok, 0);
    assert.strictEqual(result?.outputPerMTok, 0);
  });

  test("resolves Qwen's model against the alibaba provider bucket", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.QWEN_CLI,
      "qwen3.5-plus"
    );

    assert.strictEqual(result?.inputPerMTok, 0.4);
    assert.strictEqual(result?.outputPerMTok, 2.4);
  });

  test("strips Antigravity's reasoning-effort suffix before matching Gemini", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      "gemini-3.6-flash-high"
    );

    assert.strictEqual(result?.inputPerMTok, 0.75);
    assert.strictEqual(result?.outputPerMTok, 3.75);
  });

  test("matches Antigravity's gpt-oss model against a provider-prefixed key via fuzzy fallback", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      "gpt-oss-120b-medium"
    );

    assert.strictEqual(result?.inputPerMTok, 0.15);
    assert.strictEqual(result?.outputPerMTok, 0.6);
    assert.ok(result?.sourceUrl.includes('provider="groq"'));
  });

  test("returns undefined when nothing in the registry matches", () => {
    const result = resolveModelPricingFromRegistry(
      fixture,
      HARNESS_IDS.QWEN_CLI,
      "totally-unknown-model-xyz"
    );

    assert.strictEqual(result, undefined);
  });

  test("the real downloaded snapshot resolves models for every harness", () => {
    // Smoke test against the actual generated data file (not the fixture) to
    // catch drift between the matcher and the committed snapshot's shape.
    const copilot = getModelPricingFromRegistry(
      HARNESS_IDS.COPILOT_CLI,
      "claude-sonnet-4.6"
    );
    const claude = getModelPricingFromRegistry(
      HARNESS_IDS.CLAUDE_CLI,
      "sonnet"
    );
    const codex = getModelPricingFromRegistry(
      HARNESS_IDS.CODEX_CLI,
      "gpt-5.6-sol"
    );
    const qwen = getModelPricingFromRegistry(
      HARNESS_IDS.QWEN_CLI,
      "qwen3.5-plus"
    );

    for (const result of [copilot, claude, codex, qwen]) {
      assert.ok(result, "expected a resolvable price from the real snapshot");
      assert.ok(typeof result?.inputPerMTok === "number");
      assert.ok(typeof result?.outputPerMTok === "number");
      assert.ok(result?.sourceUrl.includes("models.dev"));
    }
  });
});
