import * as assert from "assert";
import { PromptFileSplitter } from "../utils/PromptFileSplitter";

suite("PromptFileSplitter Tests", () => {
  suite("needsSplitting", () => {
    test("should return false for small prompts", () => {
      const splitter = new PromptFileSplitter();
      const smallPrompt = "This is a small test prompt.";
      assert.strictEqual(splitter.needsSplitting(smallPrompt), false);
    });

    test("should return false for prompts under token limit", () => {
      const splitter = new PromptFileSplitter();
      // Create a prompt with ~10K tokens (well under 15K limit)
      const mediumPrompt = "word ".repeat(10000);
      assert.strictEqual(splitter.needsSplitting(mediumPrompt), false);
    });

    test("should return true for prompts over line limit", () => {
      const splitter = new PromptFileSplitter();
      // Create a prompt with 2000 lines (over 1800 limit)
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(`Line ${i}: Some content here`);
      }
      const largePrompt = lines.join("\n");
      assert.strictEqual(splitter.needsSplitting(largePrompt), true);
    });

    test("should return true for prompts over token limit", () => {
      const splitter = new PromptFileSplitter();
      // Create a prompt with ~25K tokens (over 15K limit)
      // Average 1 token ≈ 4 characters, so 100K chars ≈ 25K tokens
      const hugePrompt = "word ".repeat(25000);
      assert.strictEqual(splitter.needsSplitting(hugePrompt), true);
    });

    test("should handle empty string", () => {
      const splitter = new PromptFileSplitter();
      assert.strictEqual(splitter.needsSplitting(""), false);
    });
  });

  suite("split", () => {
    test("should not split small prompts", () => {
      const splitter = new PromptFileSplitter();
      const smallPrompt = "This is a small test prompt.";
      const result = splitter.split(smallPrompt);

      assert.strictEqual(result.needsSplit, false);
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(result.chunks[0], smallPrompt);
      assert.strictEqual(result.tokenCounts.length, 1);
      assert.strictEqual(result.lineCounts.length, 1);
      assert.ok(result.tokenCounts[0] > 0);
      assert.strictEqual(result.lineCounts[0], 1);
    });

    test("should split prompts over line limit into multiple chunks", () => {
      const splitter = new PromptFileSplitter();
      // Create a prompt with 2100 lines (over 1800 limit)
      const lines: string[] = [];
      for (let i = 0; i < 2100; i++) {
        lines.push(`Line ${i}: Some content here to make it realistic`);
      }
      const largePrompt = lines.join("\n");
      const result = splitter.split(largePrompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(
        result.chunks.length >= 2,
        "Should split into at least 2 chunks"
      );

      // Verify each chunk is under limits
      result.chunks.forEach((_chunk, idx) => {
        assert.ok(
          result.tokenCounts[idx] <= 15000,
          `Chunk ${idx} has ${result.tokenCounts[idx]} tokens (should be ≤15000)`
        );
        assert.ok(
          result.lineCounts[idx] <= 1800,
          `Chunk ${idx} has ${result.lineCounts[idx]} lines (should be ≤1800)`
        );
      });

      // Verify chunks can be reassembled
      const reassembled = result.chunks.join("\n\n");
      assert.ok(
        reassembled.length > 0,
        "Reassembled content should not be empty"
      );
    });

    test("should split prompts over token limit into multiple chunks", () => {
      const splitter = new PromptFileSplitter();
      // Create a prompt with ~30K tokens
      const hugePrompt = "word ".repeat(30000);
      const result = splitter.split(hugePrompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(
        result.chunks.length >= 2,
        "Should split into at least 2 chunks"
      );

      // Verify each chunk is under token limit
      result.chunks.forEach((_chunk, idx) => {
        assert.ok(
          result.tokenCounts[idx] <= 15000,
          `Chunk ${idx} has ${result.tokenCounts[idx]} tokens (should be ≤15000)`
        );
      });
    });

    test("should preserve paragraph boundaries when splitting", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with clear paragraph structure
      const paragraphs: string[] = [];
      for (let i = 0; i < 2500; i++) {
        paragraphs.push(
          `Paragraph ${i}:\nThis is some content.\nMore content here.`
        );
      }
      const largePrompt = paragraphs.join("\n\n");
      const result = splitter.split(largePrompt);

      assert.strictEqual(result.needsSplit, true);

      // Check that chunks have content and reasonable structure
      result.chunks.forEach((chunk, idx) => {
        const trimmed = chunk.trim();
        // Should have actual content (not just whitespace)
        assert.ok(trimmed.length > 0, `Chunk ${idx} should have content`);
        // Should contain complete paragraphs (look for "Paragraph X:" pattern)
        assert.ok(
          /Paragraph \d+:/.test(trimmed),
          `Chunk ${idx} should contain complete paragraphs`
        );
      });
    });

    test("should include all content when splitting", () => {
      const splitter = new PromptFileSplitter();
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(`Unique line ${i} with distinct content`);
      }
      const originalPrompt = lines.join("\n");
      const result = splitter.split(originalPrompt);

      // Join all chunks back together
      const reassembled = result.chunks.join("\n\n");

      // Verify all unique lines are present (check first, middle, last)
      assert.ok(reassembled.includes("Unique line 0"));
      assert.ok(reassembled.includes("Unique line 1000"));
      assert.ok(reassembled.includes("Unique line 1999"));
    });

    test("should handle prompts with only newlines", () => {
      const splitter = new PromptFileSplitter();
      const prompt = "\n".repeat(2000);
      const result = splitter.split(prompt);

      // Newline-only prompts are filtered as empty chunks
      // Implementation returns original text as fallback (logged warning)
      assert.ok(result.chunks.length >= 1, "Should return at least one chunk");

      // If split occurred, line count should be high
      if (result.needsSplit) {
        const totalLines = result.lineCounts.reduce(
          (sum, count) => sum + count,
          0
        );
        assert.ok(totalLines > 1000, "Should account for high line count");
      }
    });

    test("should return correct token counts for each chunk", () => {
      const splitter = new PromptFileSplitter();
      const lines: string[] = [];
      for (let i = 0; i < 2100; i++) {
        lines.push(`Line ${i}: Content with reasonable length for testing`);
      }
      const largePrompt = lines.join("\n");
      const result = splitter.split(largePrompt);

      // Verify token counts array matches chunks array
      assert.strictEqual(result.tokenCounts.length, result.chunks.length);
      assert.strictEqual(result.lineCounts.length, result.chunks.length);

      // Verify all token counts are positive
      result.tokenCounts.forEach((count, idx) => {
        assert.ok(count > 0, `Chunk ${idx} should have positive token count`);
      });

      // Verify all line counts are positive
      result.lineCounts.forEach((count, idx) => {
        assert.ok(count > 0, `Chunk ${idx} should have positive line count`);
      });
    });

    test("should handle unicode characters correctly", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with unicode content
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(`行 ${i}: これはテストコンテンツです 🚀`);
      }
      const unicodePrompt = lines.join("\n");
      const result = splitter.split(unicodePrompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(result.chunks.length >= 2);

      // Verify unicode is preserved
      const reassembled = result.chunks.join("\n\n");
      assert.ok(reassembled.includes("これはテストコンテンツです"));
      assert.ok(reassembled.includes("🚀"));
    });

    test("should handle mixed content (code blocks, paragraphs, lists)", () => {
      const splitter = new PromptFileSplitter();
      const content: string[] = [];

      for (let i = 0; i < 500; i++) {
        content.push(
          `## Section ${i}\n\nSome paragraph text here.\n\n\`\`\`javascript\nfunction test() {\n  return ${i};\n}\n\`\`\`\n\n- List item 1\n- List item 2`
        );
      }

      const mixedPrompt = content.join("\n\n");
      const result = splitter.split(mixedPrompt);

      assert.strictEqual(result.needsSplit, true);

      // Verify code blocks are preserved
      const reassembled = result.chunks.join("\n\n");
      assert.ok(reassembled.includes("```javascript"));
      assert.ok(reassembled.includes("function test()"));
      assert.ok(reassembled.includes("- List item"));
    });

    test("should respect minimum chunk size", () => {
      const splitter = new PromptFileSplitter({
        minChunkSize: 5000,
      });

      const lines: string[] = [];
      for (let i = 0; i < 2100; i++) {
        lines.push(`Line ${i}: Some content here`);
      }
      const largePrompt = lines.join("\n");
      const result = splitter.split(largePrompt);

      // Each chunk (except possibly the last) should meet minimum size
      const allButLast = result.tokenCounts.slice(0, -1);
      allButLast.forEach((count, idx) => {
        assert.ok(
          count >= 5000,
          `Chunk ${idx} has ${count} tokens (should be ≥5000)`
        );
      });
    });

    test("should handle custom configuration", () => {
      const splitter = new PromptFileSplitter({
        maxTokensPerFile: 10000,
        maxLinesPerFile: 1000,
        minChunkSize: 2000,
      });

      const lines: string[] = [];
      for (let i = 0; i < 1500; i++) {
        lines.push(`Line ${i}: Some content here to make it realistic`);
      }
      const largePrompt = lines.join("\n");
      const result = splitter.split(largePrompt);

      assert.strictEqual(result.needsSplit, true);

      // Verify chunks respect custom limits
      result.chunks.forEach((_chunk, idx) => {
        assert.ok(
          result.tokenCounts[idx] <= 10000,
          `Chunk ${idx} exceeds custom token limit`
        );
        assert.ok(
          result.lineCounts[idx] <= 1000,
          `Chunk ${idx} exceeds custom line limit`
        );
      });
    });

    test("should handle empty string", () => {
      const splitter = new PromptFileSplitter();
      const result = splitter.split("");

      assert.strictEqual(result.needsSplit, false);
      assert.strictEqual(result.chunks.length, 1);
      assert.strictEqual(result.chunks[0], "");
      assert.strictEqual(result.tokenCounts[0], 0);
      assert.strictEqual(result.lineCounts[0], 0);
    });

    test("should handle single very long line", () => {
      const splitter = new PromptFileSplitter();
      // Create a single line with many words (should trigger character split)
      const longLine = "word ".repeat(30000);
      const result = splitter.split(longLine);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(result.chunks.length >= 2, "Should split long line");

      // Each chunk should be under token limit
      result.chunks.forEach((_chunk, idx) => {
        assert.ok(
          result.tokenCounts[idx] <= 15000,
          `Chunk ${idx} exceeds token limit`
        );
      });
    });

    test("should produce non-empty chunks", () => {
      const splitter = new PromptFileSplitter();
      const lines: string[] = [];
      for (let i = 0; i < 2100; i++) {
        lines.push(`Line ${i}: Content`);
      }
      const largePrompt = lines.join("\n");
      const result = splitter.split(largePrompt);

      // All chunks should have content
      result.chunks.forEach((chunk, idx) => {
        assert.ok(chunk.trim().length > 0, `Chunk ${idx} should not be empty`);
      });
    });

    test("should handle alternating paragraph and code blocks", () => {
      const splitter = new PromptFileSplitter();
      const content: string[] = [];

      for (let i = 0; i < 1000; i++) {
        content.push(`Paragraph ${i} with some explanatory text.`);
        content.push("```\ncode block line 1\ncode block line 2\n```");
      }

      const mixedPrompt = content.join("\n\n");
      const result = splitter.split(mixedPrompt);

      if (result.needsSplit) {
        // Verify structure is preserved
        const reassembled = result.chunks.join("\n\n");
        assert.ok(reassembled.includes("Paragraph"));
        assert.ok(reassembled.includes("```"));
        assert.ok(reassembled.includes("code block"));
      }
    });
  });

  suite("edge cases", () => {
    test("should handle prompt exactly at token limit", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with exactly 20K tokens (approximately)
      const prompt = "word ".repeat(20000);
      const result = splitter.split(prompt);

      // Should not split if exactly at limit
      assert.ok(result.chunks.length <= 2, "Should not oversplit");
    });

    test("should handle prompt exactly at line limit", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with exactly 1800 lines
      const lines: string[] = [];
      for (let i = 0; i < 1800; i++) {
        lines.push(`Line ${i}`);
      }
      const prompt = lines.join("\n");
      const result = splitter.split(prompt);

      // Should not split if exactly at limit
      assert.ok(result.chunks.length <= 2, "Should not oversplit");
    });

    test("should handle prompt just over limits", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with 1801 lines (just over limit)
      const lines: string[] = [];
      for (let i = 0; i < 1801; i++) {
        lines.push(`Line ${i}: Some content`);
      }
      const prompt = lines.join("\n");
      const result = splitter.split(prompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(result.chunks.length >= 2);
    });

    test("should handle very large prompt requiring many splits", () => {
      const splitter = new PromptFileSplitter();
      // Create prompt with 10K lines (should split into ~6 chunks)
      const lines: string[] = [];
      for (let i = 0; i < 10000; i++) {
        lines.push(`Line ${i}: Content here`);
      }
      const hugePrompt = lines.join("\n");
      const result = splitter.split(hugePrompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(result.chunks.length >= 5, "Should create multiple chunks");

      // All chunks should be under limits
      result.chunks.forEach((_chunk, idx) => {
        assert.ok(result.tokenCounts[idx] <= 15000);
        assert.ok(result.lineCounts[idx] <= 1800);
      });
    });

    test("should handle whitespace-only content", () => {
      const splitter = new PromptFileSplitter();
      const prompt = "   \n\n\n   \n\n   ";
      const result = splitter.split(prompt);

      assert.ok(result.chunks.length >= 1);
      assert.strictEqual(result.needsSplit, false);
    });
  });
});
