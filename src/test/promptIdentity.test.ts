import * as assert from "assert";
import { hashPromptContent } from "../utils/PromptIdentity";
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
});
