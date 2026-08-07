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
      // Create a prompt with ~6K tokens (well under 10K limit)
      const mediumPrompt = "word ".repeat(6000);
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
      // Create a prompt with ~25K tokens (over 10K limit)
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
          result.tokenCounts[idx] <= 10000,
          `Chunk ${idx} has ${result.tokenCounts[idx]} tokens (should be ≤10000)`
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
          result.tokenCounts[idx] <= 10000,
          `Chunk ${idx} has ${result.tokenCounts[idx]} tokens (should be ≤10000)`
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
          result.tokenCounts[idx] <= 10000,
          `Chunk ${idx} exceeds token limit`
        );
      });
    });

    test("should bound tokenizer work for a large minified repeated line", () => {
      const splitter = new PromptFileSplitter();
      const minifiedPrompt = "x".repeat(512 * 1024 + 1);

      const result = splitter.split(minifiedPrompt);

      assert.strictEqual(result.needsSplit, true);
      assert.ok(result.chunks.length > 1);
      result.tokenCounts.forEach((count, idx) => {
        assert.ok(count <= 10000, `Chunk ${idx} exceeds token limit`);
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

      // 20K tokens at a 10K limit needs 2-3 chunks; assert it doesn't over-fragment
      assert.ok(result.chunks.length <= 3, "Should not oversplit");
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
        assert.ok(result.tokenCounts[idx] <= 10000);
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

  suite("small leading paragraph followed by oversized paragraph", () => {
    test("should bundle tiny preamble with oversized content instead of isolating it", () => {
      // Regression test: a small first paragraph (<minChunkSize) followed by an
      // oversized second paragraph previously caused the small paragraph to be
      // flushed as its own standalone chunk due to `|| chunks.length === 0`.
      const splitter = new PromptFileSplitter({
        maxTokensPerFile: 2000,
        minChunkSize: 500,
      });

      // Para A: tiny preamble well under minChunkSize
      const preamble =
        "git diff summary\n2 files changed, 38 insertions, 0 deletions";

      // Para B: a very long paragraph far exceeding maxTokensPerFile.
      // Use "word " repeats (each ~1 token) rather than repeated single chars
      // — gpt-tokenizer compresses long same-char runs into very few tokens,
      // making it unreliable for these threshold tests.
      const oversizedLine =
        "diff --git a/styles.css b/styles.css\n" + "word ".repeat(3000);

      const content = preamble + "\n\n" + oversizedLine;
      const result = splitter.split(content);

      assert.strictEqual(result.needsSplit, true, "Should need splitting");

      // The preamble must appear in the SAME chunk as the start of the large content.
      assert.ok(
        result.chunks[0].includes("git diff summary"),
        "First chunk should include the small preamble"
      );
      assert.ok(
        result.chunks[0].includes("diff --git"),
        "First chunk should also include the oversized content, not just the preamble"
      );

      // No chunk should be an isolated preamble-only fragment.
      const isolatedPreamble = result.chunks.find(
        (c) => c.includes("git diff summary") && !c.includes("diff --git")
      );
      assert.strictEqual(
        isolatedPreamble,
        undefined,
        "Should not produce a standalone chunk containing only the small preamble"
      );
    });

    test("should bundle tiny preamble inside an oversized attachment block with large content", () => {
      // End-to-end variant: the oversized content is wrapped in <attachment> tags,
      // matching the real scenario where a git diff excerpt has a small header
      // followed by a huge CSS diff with base64 SVG data.
      const splitter = new PromptFileSplitter({
        maxTokensPerFile: 2000,
        minChunkSize: 500,
      });

      const attachment =
        `<attachment id="git:diff">\n` +
        `Working tree changes\n\n` +
        `2 files changed\n\n` +
        `diff --git a/icons.css b/icons.css\n` +
        "base64_svg_data: " +
        "word ".repeat(3000) +
        "\n" +
        `</attachment>`;

      const result = splitter.split(attachment);

      assert.strictEqual(result.needsSplit, true);

      // The small header must land in the same chunk as the large diff content.
      assert.ok(
        result.chunks[0].includes("Working tree changes"),
        "First chunk should contain the attachment preamble"
      );
      assert.ok(
        result.chunks[0].includes("diff --git"),
        "First chunk should also contain the start of the large diff, not just the preamble"
      );

      const isolatedHeader = result.chunks.find(
        (c) => c.includes("Working tree changes") && !c.includes("diff --git")
      );
      assert.strictEqual(
        isolatedHeader,
        undefined,
        "Should not produce an isolated chunk with only the small attachment preamble"
      );
    });
  });
});
