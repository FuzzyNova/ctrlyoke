import * as assert from "assert";
import {
  hashPromptContent,
  isPromptCompleted,
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

  suite("isPromptCompleted", () => {
    test("should return true when concatenated ID:hash matches", () => {
      const prompt: PromptItem = { id: "prompt-123", prompt: "Test prompt" };
      const hash = hashPromptContent("Test prompt");
      const completedIds = new Set([`prompt-123:${hash}`]);
      assert.strictEqual(isPromptCompleted(prompt, completedIds), true);
    });

    test("should return true when content hash matches completed set (no ID)", () => {
      const prompt: PromptItem = { prompt: "Test prompt" };
      const hash = hashPromptContent("Test prompt");
      const completedIds = new Set([hash]);
      assert.strictEqual(isPromptCompleted(prompt, completedIds), true);
    });

    test("should return true when prompt executed with ID, reloaded without ID", () => {
      // Scenario: Prompt originally had ID "review", was executed, then reloaded without ID
      const executedPrompt: PromptItem = {
        id: "review",
        prompt: "Review code",
      };
      const hash = hashPromptContent("Review code");
      // Completed set has concatenated format from markPromptCompleted
      const completedIds = new Set([`review:${hash}`]);

      // Now prompt reloaded without ID, but same content
      const reloadedPrompt: PromptItem = { prompt: "Review code" };
      assert.strictEqual(isPromptCompleted(reloadedPrompt, completedIds), true);
    });

    test("should return true when prompt executed without ID, reloaded with auto-assigned hash ID", () => {
      // Scenario: Prompt originally had no ID, was executed with hash tracking,
      // then updateWorkingFile auto-assigned the hash as the ID
      const executedPrompt: PromptItem = { prompt: "Review code" };
      const hash = hashPromptContent("Review code");
      // Completed set has just the hash
      const completedIds = new Set([hash]);

      // Now prompt reloaded with auto-assigned hash ID (id === hash)
      const reloadedPrompt: PromptItem = { id: hash, prompt: "Review code" };
      // Should recognize this as "no explicit ID" and use hash fallback
      assert.strictEqual(isPromptCompleted(reloadedPrompt, completedIds), true);
    });

    test("should return false when neither ID nor hash matches", () => {
      const prompt: PromptItem = { id: "prompt-456", prompt: "Test prompt" };
      const hash = hashPromptContent("Different content");
      const completedIds = new Set([`prompt-789:${hash}`]);
      assert.strictEqual(isPromptCompleted(prompt, completedIds), false);
    });

    test("should handle empty completed set", () => {
      const prompt: PromptItem = { id: "prompt-123", prompt: "Test prompt" };
      const completedIds = new Set<string>();
      assert.strictEqual(isPromptCompleted(prompt, completedIds), false);
    });

    test("should allow duplicate content with different explicit IDs", () => {
      // This is the KEY FIX: Different explicit IDs with same content should BOTH execute
      // This allows legitimate workflows like: plan, review-1, review-2, implement
      const prompt1: PromptItem = { id: "review-1", prompt: "Review code" };
      const prompt2: PromptItem = { id: "review-2", prompt: "Review code" };
      const hash = hashPromptContent("Review code");

      // review-1 was completed
      const completedIds = new Set([`review-1:${hash}`]);

      // review-1 should be completed (exact match)
      assert.strictEqual(isPromptCompleted(prompt1, completedIds), true);

      // review-2 should NOT be completed (different explicit ID, even though same content)
      // This allows intentional duplicate content with different IDs
      assert.strictEqual(isPromptCompleted(prompt2, completedIds), false);
    });

    test("should deduplicate non-explicit IDs with same content", () => {
      // AI-appended prompts without IDs should be deduplicated by content
      const prompt1: PromptItem = { prompt: "Review code" };
      const prompt2: PromptItem = { prompt: "Review code" };
      const hash = hashPromptContent("Review code");

      // First prompt was completed (no ID, just hash)
      const completedIds = new Set([hash]);

      // Second prompt with same content should be skipped (deduplication)
      assert.strictEqual(isPromptCompleted(prompt1, completedIds), true);
      assert.strictEqual(isPromptCompleted(prompt2, completedIds), true);
    });

    test("should deduplicate when explicit ID prompt completed, then appended without ID", () => {
      // Scenario: User had "review-1" prompt, it completed, AI appends same content without ID
      const explicitPrompt: PromptItem = {
        id: "review-1",
        prompt: "Review code",
      };
      const appendedPrompt: PromptItem = { prompt: "Review code" };
      const hash = hashPromptContent("Review code");

      // Explicit ID prompt was completed
      const completedIds = new Set([`review-1:${hash}`]);

      // Explicit prompt should match exactly
      assert.strictEqual(isPromptCompleted(explicitPrompt, completedIds), true);

      // Appended prompt without ID should ALSO be skipped (hash fallback finds it)
      assert.strictEqual(isPromptCompleted(appendedPrompt, completedIds), true);

      // NOTE: Initial workflow CAN contain duplicate content (loadPrompts doesn't deduplicate).
      // This deduplication only applies during reloadAndMergeQueue to prevent AI from
      // appending the same prompt it just completed.
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
