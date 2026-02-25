import * as assert from "assert";
import {
  hashPromptContent,
  shouldInjectExtensionInstructions,
} from "../utils/PromptIdentity";
import { PromptItem } from "../types/FlightPathTypes";

suite("PromptIdentity Tests", () => {
  suite("hashPromptContent", () => {
    test("should generate consistent SHA-256 hash for same content", () => {
      const hash1 = hashPromptContent("Hello, world!");
      const hash2 = hashPromptContent("Hello, world!");
      assert.strictEqual(hash1, hash2);
      // SHA-256 hash is 64 hex characters
      assert.strictEqual(hash1.length, 64);
    });

    test("should normalize whitespace before hashing", () => {
      const hash1 = hashPromptContent("hello   world");
      const hash2 = hashPromptContent("hello world");
      assert.strictEqual(hash1, hash2);
    });

    test("should produce different hashes for different content", () => {
      const hash1 = hashPromptContent("Hello");
      const hash2 = hashPromptContent("World");
      assert.notStrictEqual(hash1, hash2);
    });

    test("should handle empty string", () => {
      const hash = hashPromptContent("");
      assert.ok(hash);
      assert.strictEqual(hash.length, 64);
    });

    test("should handle unicode characters", () => {
      const hash1 = hashPromptContent("こんにちは世界");
      const hash2 = hashPromptContent("こんにちは世界");
      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash1.length, 64);
    });

    test("should handle very long prompts", () => {
      const longPrompt = "a".repeat(100000);
      const hash = hashPromptContent(longPrompt);
      assert.ok(hash);
      assert.strictEqual(hash.length, 64);
    });

    test("should trim leading and trailing whitespace", () => {
      const hash1 = hashPromptContent("  hello world  ");
      const hash2 = hashPromptContent("hello world");
      assert.strictEqual(hash1, hash2);
    });

    test("should collapse internal whitespace", () => {
      const hash1 = hashPromptContent("hello\t\nworld");
      const hash2 = hashPromptContent("hello world");
      assert.strictEqual(hash1, hash2);
    });
  });

  suite("completion tracking via completedAt", () => {
    test("a prompt with completedAt is completed", () => {
      const prompt: PromptItem = {
        prompt: "Test prompt",
        _runtime: { startedAt: 1000, completedAt: 2000 },
      };
      assert.strictEqual(prompt._runtime?.completedAt !== undefined, true);
    });

    test("a prompt without completedAt is not completed", () => {
      const prompt: PromptItem = {
        prompt: "Test prompt",
        _runtime: { startedAt: 1000 },
      };
      assert.strictEqual(prompt._runtime?.completedAt !== undefined, false);
    });

    test("a prompt with no _runtime is not completed", () => {
      const prompt: PromptItem = { prompt: "Test prompt" };
      assert.strictEqual(prompt._runtime?.completedAt !== undefined, false);
    });
  });

  suite("shouldInjectExtensionInstructions", () => {
    test("should return true when allowDynamicExtension is explicitly true", () => {
      const prompts: PromptItem[] = [
        { prompt: "First", allowDynamicExtension: true },
        { prompt: "Second" },
      ];
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, true),
        true
      );
    });

    test("should return false when allowDynamicExtension is explicitly false", () => {
      const prompts: PromptItem[] = [
        { prompt: "First", allowDynamicExtension: false },
      ];
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, true),
        false
      );
    });

    test("should return true for last prompt when no explicit flags exist", () => {
      const prompts: PromptItem[] = [
        { prompt: "First" },
        { prompt: "Second" },
        { prompt: "Last" },
      ];
      // Last prompt (index 2) should get instructions
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[2], 2, prompts, true),
        true
      );
    });

    test("should return false for non-last prompts when no explicit flags", () => {
      const prompts: PromptItem[] = [
        { prompt: "First" },
        { prompt: "Second" },
        { prompt: "Last" },
      ];
      // First prompt (index 0) should NOT get instructions
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, true),
        false
      );
      // Second prompt (index 1) should NOT get instructions
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[1], 1, prompts, true),
        false
      );
    });

    test("should respect dynamicExtensionOnLastPrompt=false setting", () => {
      const prompts: PromptItem[] = [{ prompt: "Last" }];
      // Even though it's the last prompt, setting is false
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, false),
        false
      );
    });

    test("should not auto-inject on last prompt if any prompt has explicit flag", () => {
      const prompts: PromptItem[] = [
        { prompt: "First", allowDynamicExtension: true },
        { prompt: "Last" }, // No explicit flag, but First has one
      ];
      // Last prompt should NOT auto-inject because First has an explicit flag
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[1], 1, prompts, true),
        false
      );
    });

    test("should handle single prompt workflow", () => {
      const prompts: PromptItem[] = [{ prompt: "Only prompt" }];
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, true),
        true
      );
    });

    test("should handle explicit false on last prompt with true on first", () => {
      const prompts: PromptItem[] = [
        { prompt: "First", allowDynamicExtension: true },
        { prompt: "Last", allowDynamicExtension: false },
      ];
      // First should inject, Last should not
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[0], 0, prompts, true),
        true
      );
      assert.strictEqual(
        shouldInjectExtensionInstructions(prompts[1], 1, prompts, true),
        false
      );
    });
  });
});
