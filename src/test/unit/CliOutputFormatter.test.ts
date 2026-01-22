import * as assert from "assert";
import {
  CliOutputFormatter,
  DashboardOutput,
} from "../../flightpath/cli/shared/CliOutputFormatter";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  OutputMetadata,
  ToolResult,
} from "../../types/CliOutputTypes";

suite("CliOutputFormatter Tests", () => {
  // Helper to create test output with defaults
  function createTestOutput(
    overrides: Partial<UniversalCliOutput> = {}
  ): UniversalCliOutput {
    return {
      text: "",
      toolCalls: [],
      thinkingBlocks: [],
      metadata: {},
      ...overrides,
    };
  }

  // Helper to create a test tool call
  function createToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    return {
      name: "test_tool",
      parameters: {},
      ...overrides,
    };
  }

  // Helper to create a test thinking block
  function createThinkingBlock(
    overrides: Partial<ThinkingBlock> = {}
  ): ThinkingBlock {
    return {
      text: "thinking text",
      ...overrides,
    };
  }

  suite("toPlainText", () => {
    test("formats text-only output", () => {
      const output = createTestOutput({ text: "Hello world" });
      const result = CliOutputFormatter.toPlainText(output);
      assert.strictEqual(result, "Hello world");
    });

    test("returns empty string for empty output", () => {
      const output = createTestOutput();
      const result = CliOutputFormatter.toPlainText(output);
      assert.strictEqual(result, "");
    });

    test("formats output with tool calls", () => {
      const output = createTestOutput({
        text: "Running tests",
        toolCalls: [
          createToolCall({
            name: "shell",
            parameters: { command: "npm test" },
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Running tests"));
      assert.ok(result.includes("--- Tool Calls ---"));
      assert.ok(result.includes("shell"));
      assert.ok(result.includes("npm test"));
    });

    test("formats output with multiple tool calls", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({ name: "read_file", parameters: { path: "foo.ts" } }),
          createToolCall({
            name: "write_file",
            parameters: { path: "bar.ts", content: "code" },
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("read_file"));
      assert.ok(result.includes("foo.ts"));
      assert.ok(result.includes("write_file"));
      assert.ok(result.includes("bar.ts"));
    });

    test("formats tool call with successful result", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "shell",
            parameters: { command: "echo hello" },
            result: { success: true, output: "hello" },
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✓ hello"));
    });

    test("formats tool call with failed result", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "shell",
            parameters: { command: "exit 1" },
            result: { success: false, error: "Command failed" },
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✗ Command failed"));
    });

    test("formats tool call with empty result", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "noop",
            parameters: {},
            result: { success: true },
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✓"));
    });

    test("formats output with thinking blocks", () => {
      const output = createTestOutput({
        text: "Final answer",
        thinkingBlocks: [
          createThinkingBlock({ text: "Let me think about this" }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Final answer"));
      assert.ok(result.includes("--- Thinking ---"));
      assert.ok(result.includes("Let me think about this"));
    });

    test("formats thinking blocks with labels", () => {
      const output = createTestOutput({
        thinkingBlocks: [
          createThinkingBlock({ text: "Planning steps", label: "Planning" }),
          createThinkingBlock({ text: "Analyzing code", label: "Analysis" }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("[Planning] Planning steps"));
      assert.ok(result.includes("[Analysis] Analyzing code"));
    });

    test("formats thinking blocks without labels", () => {
      const output = createTestOutput({
        thinkingBlocks: [createThinkingBlock({ text: "Just thinking" })],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Just thinking"));
      assert.ok(!result.includes("["));
    });

    test("formats output with all components", () => {
      const output = createTestOutput({
        text: "Here is the result",
        toolCalls: [
          createToolCall({
            name: "read_file",
            parameters: { path: "test.ts" },
            result: { success: true, output: "content" },
          }),
        ],
        thinkingBlocks: [
          createThinkingBlock({
            text: "Analyzing the file",
            label: "Analysis",
          }),
        ],
      });
      const result = CliOutputFormatter.toPlainText(output);

      // All sections present
      assert.ok(result.includes("Here is the result"));
      assert.ok(result.includes("--- Tool Calls ---"));
      assert.ok(result.includes("read_file"));
      assert.ok(result.includes("--- Thinking ---"));
      assert.ok(result.includes("[Analysis] Analyzing the file"));
    });

    test("handles empty arrays gracefully", () => {
      const output = createTestOutput({
        text: "Just text",
        toolCalls: [],
        thinkingBlocks: [],
      });
      const result = CliOutputFormatter.toPlainText(output);

      assert.strictEqual(result, "Just text");
      assert.ok(!result.includes("---"));
    });
  });

  suite("toDashboardFormat", () => {
    test("converts basic output to dashboard format", () => {
      const output = createTestOutput({
        text: "Response text",
        metadata: { model: "gpt-4" },
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.text, "Response text");
      assert.deepStrictEqual(result.toolCalls, []);
      assert.deepStrictEqual(result.thinkingBlocks, []);
      assert.deepStrictEqual(result.metadata, { model: "gpt-4" });
    });

    test("preserves all tool call fields", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "shell",
            parameters: { command: "npm test", cwd: "/app" },
            id: "tool-123",
            result: { success: true, output: "passed" },
          }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].name, "shell");
      assert.deepStrictEqual(result.toolCalls[0].parameters, {
        command: "npm test",
        cwd: "/app",
      });
      assert.strictEqual(result.toolCalls[0].id, "tool-123");
      assert.deepStrictEqual(result.toolCalls[0].result, {
        success: true,
        output: "passed",
        error: undefined,
      });
    });

    test("preserves tool call without result", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "read_file",
            parameters: { path: "test.ts" },
          }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.toolCalls[0].result, undefined);
    });

    test("preserves failed tool call result", () => {
      const output = createTestOutput({
        toolCalls: [
          createToolCall({
            name: "shell",
            parameters: { command: "fail" },
            result: { success: false, error: "Command not found" },
          }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.toolCalls[0].result?.success, false);
      assert.strictEqual(
        result.toolCalls[0].result?.error,
        "Command not found"
      );
    });

    test("preserves all thinking block fields with default label", () => {
      const timestamp = Date.now();
      const output = createTestOutput({
        thinkingBlocks: [
          createThinkingBlock({
            text: "Deep thought",
            timestamp: timestamp,
          }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.thinkingBlocks.length, 1);
      assert.strictEqual(result.thinkingBlocks[0].text, "Deep thought");
      assert.strictEqual(result.thinkingBlocks[0].label, "Thinking"); // Default label
      assert.strictEqual(result.thinkingBlocks[0].timestamp, timestamp);
    });

    test("preserves thinking block with custom label", () => {
      const output = createTestOutput({
        thinkingBlocks: [
          createThinkingBlock({
            text: "Planning implementation",
            label: "Planning",
          }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.thinkingBlocks[0].label, "Planning");
    });

    test("preserves all metadata fields", () => {
      const metadata: OutputMetadata = {
        sessionId: "session-uuid-123",
        model: "claude-sonnet-4.5",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cliVersion: "1.0.0",
        elapsed: 2500,
        provider: "claude-cli",
      };
      const output = createTestOutput({ metadata });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.deepStrictEqual(result.metadata, metadata);
    });

    test("handles multiple tool calls and thinking blocks", () => {
      const output = createTestOutput({
        text: "Result",
        toolCalls: [
          createToolCall({ name: "tool1", parameters: { a: 1 } }),
          createToolCall({ name: "tool2", parameters: { b: 2 } }),
        ],
        thinkingBlocks: [
          createThinkingBlock({ text: "First thought", label: "A" }),
          createThinkingBlock({ text: "Second thought", label: "B" }),
        ],
      });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.toolCalls.length, 2);
      assert.strictEqual(result.thinkingBlocks.length, 2);
    });
  });

  suite("formatStatistics", () => {
    test("formats all metadata fields", () => {
      const metadata: OutputMetadata = {
        sessionId: "abc-123-def-456",
        model: "claude-sonnet-4.5",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        elapsed: 2500,
      };
      const result = CliOutputFormatter.formatStatistics(metadata);

      assert.strictEqual(
        result,
        "Session: abc-123- | Model: claude-sonnet-4.5 | Tokens: 100 in / 50 out | Time: 2.5s"
      );
    });

    test("handles empty metadata", () => {
      const result = CliOutputFormatter.formatStatistics({});
      assert.strictEqual(result, "");
    });

    test("handles sessionId only", () => {
      const result = CliOutputFormatter.formatStatistics({
        sessionId: "12345678-abcd-efgh",
      });
      assert.strictEqual(result, "Session: 12345678");
    });

    test("handles model only", () => {
      const result = CliOutputFormatter.formatStatistics({
        model: "gpt-5",
      });
      assert.strictEqual(result, "Model: gpt-5");
    });

    test("handles usage only", () => {
      const result = CliOutputFormatter.formatStatistics({
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      });
      assert.strictEqual(result, "Tokens: 500 in / 200 out");
    });

    test("handles elapsed only", () => {
      const result = CliOutputFormatter.formatStatistics({
        elapsed: 1234,
      });
      assert.strictEqual(result, "Time: 1.2s");
    });

    test("truncates sessionId to 8 chars", () => {
      const result = CliOutputFormatter.formatStatistics({
        sessionId: "abcdefghijklmnop",
      });
      assert.strictEqual(result, "Session: abcdefgh");
    });

    test("handles short sessionId without truncation", () => {
      const result = CliOutputFormatter.formatStatistics({
        sessionId: "abc",
      });
      assert.strictEqual(result, "Session: abc");
    });

    test("handles partial metadata with multiple fields", () => {
      const result = CliOutputFormatter.formatStatistics({
        model: "claude-sonnet-4.5",
        elapsed: 3000,
      });
      assert.strictEqual(result, "Model: claude-sonnet-4.5 | Time: 3.0s");
    });

    test("rounds elapsed time to one decimal", () => {
      const result = CliOutputFormatter.formatStatistics({
        elapsed: 1555,
      });
      assert.strictEqual(result, "Time: 1.6s");
    });

    test("handles elapsed time of 0", () => {
      const result = CliOutputFormatter.formatStatistics({
        elapsed: 0,
      });
      assert.strictEqual(result, "Time: 0.0s");
    });

    test("ignores non-displayed metadata fields", () => {
      const result = CliOutputFormatter.formatStatistics({
        cliVersion: "1.0.0",
        provider: "copilot-cli",
      });
      // cliVersion and provider are not displayed in statistics
      assert.strictEqual(result, "");
    });
  });

  suite("createEmpty", () => {
    test("returns valid empty structure", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.strictEqual(result.text, "");
      assert.deepStrictEqual(result.toolCalls, []);
      assert.deepStrictEqual(result.thinkingBlocks, []);
      assert.deepStrictEqual(result.metadata, {});
    });

    test("all arrays are empty", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.strictEqual(result.toolCalls.length, 0);
      assert.strictEqual(result.thinkingBlocks.length, 0);
    });

    test("all fields have correct types", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.strictEqual(typeof result.text, "string");
      assert.ok(Array.isArray(result.toolCalls));
      assert.ok(Array.isArray(result.thinkingBlocks));
      assert.strictEqual(typeof result.metadata, "object");
      assert.ok(result.metadata !== null);
    });

    test("returns new object each time", () => {
      const result1 = CliOutputFormatter.createEmpty();
      const result2 = CliOutputFormatter.createEmpty();

      assert.notStrictEqual(result1, result2);
      assert.notStrictEqual(result1.toolCalls, result2.toolCalls);
      assert.notStrictEqual(result1.thinkingBlocks, result2.thinkingBlocks);
      assert.notStrictEqual(result1.metadata, result2.metadata);
    });
  });

  suite("merge", () => {
    test("combines text from multiple outputs", () => {
      const outputs = [
        createTestOutput({ text: "First " }),
        createTestOutput({ text: "Second" }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.text, "First Second");
    });

    test("handles empty array", () => {
      const result = CliOutputFormatter.merge([]);

      assert.strictEqual(result.text, "");
      assert.deepStrictEqual(result.toolCalls, []);
      assert.deepStrictEqual(result.thinkingBlocks, []);
      assert.deepStrictEqual(result.metadata, {});
    });

    test("returns single output unchanged", () => {
      const output = createTestOutput({
        text: "Single",
        metadata: { model: "test" },
      });
      const result = CliOutputFormatter.merge([output]);

      assert.strictEqual(result, output);
    });

    test("combines tool calls from multiple outputs", () => {
      const outputs = [
        createTestOutput({
          toolCalls: [createToolCall({ name: "tool1", parameters: { a: 1 } })],
        }),
        createTestOutput({
          toolCalls: [createToolCall({ name: "tool2", parameters: { b: 2 } })],
        }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.toolCalls.length, 2);
      assert.strictEqual(result.toolCalls[0].name, "tool1");
      assert.strictEqual(result.toolCalls[1].name, "tool2");
    });

    test("combines thinking blocks from multiple outputs", () => {
      const outputs = [
        createTestOutput({
          thinkingBlocks: [createThinkingBlock({ text: "First thought" })],
        }),
        createTestOutput({
          thinkingBlocks: [createThinkingBlock({ text: "Second thought" })],
        }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.thinkingBlocks.length, 2);
      assert.strictEqual(result.thinkingBlocks[0].text, "First thought");
      assert.strictEqual(result.thinkingBlocks[1].text, "Second thought");
    });

    test("last metadata wins", () => {
      const outputs = [
        createTestOutput({
          metadata: { model: "gpt-4", sessionId: "old-session" },
        }),
        createTestOutput({
          metadata: { model: "gpt-5", sessionId: "new-session" },
        }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.metadata.model, "gpt-5");
      assert.strictEqual(result.metadata.sessionId, "new-session");
    });

    test("merges three outputs correctly", () => {
      const outputs = [
        createTestOutput({
          text: "A",
          toolCalls: [createToolCall({ name: "t1", parameters: {} })],
        }),
        createTestOutput({
          text: "B",
          thinkingBlocks: [createThinkingBlock({ text: "think" })],
        }),
        createTestOutput({
          text: "C",
          metadata: { model: "final" },
        }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.text, "ABC");
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.thinkingBlocks.length, 1);
      assert.strictEqual(result.metadata.model, "final");
    });

    test("handles outputs with empty arrays", () => {
      const outputs = [
        createTestOutput({ text: "Has data", toolCalls: [] }),
        createTestOutput({ text: " More", thinkingBlocks: [] }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.text, "Has data More");
      assert.deepStrictEqual(result.toolCalls, []);
      assert.deepStrictEqual(result.thinkingBlocks, []);
    });

    test("preserves tool call details during merge", () => {
      const outputs = [
        createTestOutput({
          toolCalls: [
            createToolCall({
              name: "shell",
              parameters: { cmd: "test" },
              id: "id-1",
              result: { success: true, output: "ok" },
            }),
          ],
        }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      const tool = result.toolCalls[0];
      assert.strictEqual(tool.name, "shell");
      assert.strictEqual(tool.id, "id-1");
      assert.strictEqual(tool.result?.success, true);
      assert.strictEqual(tool.result?.output, "ok");
    });
  });
});
