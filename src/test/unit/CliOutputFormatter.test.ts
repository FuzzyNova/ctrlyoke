import * as assert from "assert";
import { CliOutputFormatter } from "../../flightpath/harness/shared/CliOutputFormatter";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  OutputMetadata,
  CliEvent,
  TextData,
} from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

suite("CliOutputFormatter Tests", () => {
  // Helper to create test output with defaults
  function createTestOutput(
    events: CliEvent[] = [],
    metadata: OutputMetadata = {}
  ): UniversalCliOutput {
    return {
      events,
      metadata,
    };
  }

  // Helper to create a text event
  function createTextEvent(text: string): CliEvent {
    return {
      type: "text",
      timestamp: Date.now(),
      data: { text } as TextData,
    };
  }

  // Helper to create a tool call event
  function createToolCallEvent(overrides: Partial<ToolCall> = {}): CliEvent {
    return {
      type: "toolCall",
      timestamp: Date.now(),
      data: {
        name: "test_tool",
        parameters: {},
        ...overrides,
      } as ToolCall,
    };
  }

  // Helper to create a thinking block event
  function createThinkingEvent(
    overrides: Partial<ThinkingBlock> = {}
  ): CliEvent {
    return {
      type: "thinking",
      timestamp: Date.now(),
      data: {
        text: "thinking text",
        ...overrides,
      } as ThinkingBlock,
    };
  }

  suite("toPlainText", () => {
    test("formats text-only output", () => {
      const output = createTestOutput([createTextEvent("Hello world")]);
      const result = CliOutputFormatter.toPlainText(output);
      assert.strictEqual(result, "Hello world");
    });

    test("returns empty string for empty output", () => {
      const output = createTestOutput();
      const result = CliOutputFormatter.toPlainText(output);
      assert.strictEqual(result, "");
    });

    test("formats output with tool calls", () => {
      const output = createTestOutput([
        createTextEvent("Running tests"),
        createToolCallEvent({
          name: "shell",
          parameters: { command: "npm test" },
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Running tests"));
      assert.ok(result.includes("--- Tool Call ---"));
      assert.ok(result.includes("shell"));
      assert.ok(result.includes("npm test"));
    });

    test("formats output with multiple tool calls", () => {
      const output = createTestOutput([
        createToolCallEvent({
          name: "read_file",
          parameters: { path: "foo.ts" },
        }),
        createToolCallEvent({
          name: "write_file",
          parameters: { path: "bar.ts", content: "code" },
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("read_file"));
      assert.ok(result.includes("foo.ts"));
      assert.ok(result.includes("write_file"));
      assert.ok(result.includes("bar.ts"));
    });

    test("formats tool call with successful result", () => {
      const output = createTestOutput([
        createToolCallEvent({
          name: "shell",
          parameters: { command: "echo hello" },
          result: { success: true, output: "hello" },
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✓ hello"));
    });

    test("formats tool call with failed result", () => {
      const output = createTestOutput([
        createToolCallEvent({
          name: "shell",
          parameters: { command: "exit 1" },
          result: { success: false, error: "Command failed" },
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✗ Command failed"));
    });

    test("formats tool call with empty result", () => {
      const output = createTestOutput([
        createToolCallEvent({
          name: "noop",
          parameters: {},
          result: { success: true },
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Result: ✓"));
    });

    test("formats output with thinking blocks", () => {
      const output = createTestOutput([
        createTextEvent("Final answer"),
        createThinkingEvent({ text: "Let me think about this" }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Final answer"));
      assert.ok(result.includes("--- Thinking ---"));
      assert.ok(result.includes("Let me think about this"));
    });

    test("formats thinking blocks with labels", () => {
      const output = createTestOutput([
        createThinkingEvent({ text: "Planning steps", label: "Planning" }),
        createThinkingEvent({ text: "Analyzing code", label: "Analysis" }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("[Planning] Planning steps"));
      assert.ok(result.includes("[Analysis] Analyzing code"));
    });

    test("formats thinking blocks without labels", () => {
      const output = createTestOutput([
        createThinkingEvent({ text: "Just thinking" }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.ok(result.includes("Just thinking"));
      assert.ok(!result.includes("["));
    });

    test("formats output with all components", () => {
      const output = createTestOutput([
        createTextEvent("Here is the result"),
        createToolCallEvent({
          name: "read_file",
          parameters: { path: "test.ts" },
          result: { success: true, output: "content" },
        }),
        createThinkingEvent({
          text: "Analyzing the file",
          label: "Analysis",
        }),
      ]);
      const result = CliOutputFormatter.toPlainText(output);

      // All sections present
      assert.ok(result.includes("Here is the result"));
      assert.ok(result.includes("--- Tool Call ---"));
      assert.ok(result.includes("read_file"));
      assert.ok(result.includes("--- Thinking ---"));
      assert.ok(result.includes("[Analysis] Analyzing the file"));
    });

    test("handles empty arrays gracefully", () => {
      const output = createTestOutput([createTextEvent("Just text")]);
      const result = CliOutputFormatter.toPlainText(output);

      assert.strictEqual(result, "Just text");
      assert.ok(!result.includes("---"));
    });
  });

  suite("toDashboardFormat", () => {
    test("converts basic output to dashboard format", () => {
      const events = [createTextEvent("Response text")];
      const output = createTestOutput(events, { model: "gpt-4" });
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.deepStrictEqual(result.metadata, { model: "gpt-4" });
    });

    test("preserves all tool call fields", () => {
      const events = [
        createToolCallEvent({
          name: "shell",
          parameters: { command: "npm test", cwd: "/app" },
          id: "tool-123",
          result: { success: true, output: "passed" },
        }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.TOOL_CALL);
      const toolCall = result.events[0].data as ToolCall;
      assert.strictEqual(toolCall.name, "shell");
      assert.deepStrictEqual(toolCall.parameters, {
        command: "npm test",
        cwd: "/app",
      });
      assert.strictEqual(toolCall.id, "tool-123");
      assert.deepStrictEqual(toolCall.result, {
        success: true,
        output: "passed",
      });
    });

    test("preserves tool call without result", () => {
      const events = [
        createToolCallEvent({
          name: "read_file",
          parameters: { path: "test.ts" },
        }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      const toolCall = result.events[0].data as ToolCall;
      assert.strictEqual(toolCall.result, undefined);
    });

    test("preserves failed tool call result", () => {
      const events = [
        createToolCallEvent({
          name: "shell",
          parameters: { command: "fail" },
          result: { success: false, error: "Command not found" },
        }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      const toolCall = result.events[0].data as ToolCall;
      assert.strictEqual(toolCall.result?.success, false);
      assert.strictEqual(toolCall.result?.error, "Command not found");
    });

    test("preserves all thinking block fields with default label", () => {
      const timestamp = Date.now();
      const events = [
        createThinkingEvent({
          text: "Deep thought",
          timestamp: timestamp,
        }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.events.length, 1);
      const thinking = result.events[0].data as ThinkingBlock;
      assert.strictEqual(thinking.text, "Deep thought");
      assert.strictEqual(thinking.timestamp, timestamp);
    });

    test("preserves thinking block with custom label", () => {
      const events = [
        createThinkingEvent({
          text: "Planning implementation",
          label: "Planning",
        }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      const thinking = result.events[0].data as ThinkingBlock;
      assert.strictEqual(thinking.label, "Planning");
    });

    test("preserves all metadata fields", () => {
      const metadata: OutputMetadata = {
        sessionId: "session-uuid-123",
        model: "claude-sonnet-4.5",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cliVersion: "1.0.0",
        elapsed: 2500,
        harness: "claude-cli",
      };
      const output = createTestOutput([], metadata);
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.deepStrictEqual(result.metadata, metadata);
    });

    test("handles multiple tool calls and thinking blocks", () => {
      const events = [
        createTextEvent("Result"),
        createToolCallEvent({ name: "tool1", parameters: { a: 1 } }),
        createToolCallEvent({ name: "tool2", parameters: { b: 2 } }),
        createThinkingEvent({ text: "First thought", label: "A" }),
        createThinkingEvent({ text: "Second thought", label: "B" }),
      ];
      const output = createTestOutput(events);
      const result = CliOutputFormatter.toDashboardFormat(output);

      assert.strictEqual(result.events.length, 5);
      // Check that events maintain their order
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual(result.events[1].type, CLI_EVENT_TYPES.TOOL_CALL);
      assert.strictEqual(result.events[2].type, CLI_EVENT_TYPES.TOOL_CALL);
      assert.strictEqual(result.events[3].type, CLI_EVENT_TYPES.THINKING);
      assert.strictEqual(result.events[4].type, CLI_EVENT_TYPES.THINKING);
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
        harness: "copilot-cli",
      });
      // cliVersion and harness are not displayed in statistics
      assert.strictEqual(result, "");
    });
  });

  suite("createEmpty", () => {
    test("returns valid empty structure", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.deepStrictEqual(result.events, []);
      assert.deepStrictEqual(result.metadata, {});
    });

    test("events array is empty", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.strictEqual(result.events.length, 0);
    });

    test("all fields have correct types", () => {
      const result = CliOutputFormatter.createEmpty();

      assert.ok(Array.isArray(result.events));
      assert.strictEqual(typeof result.metadata, "object");
      assert.ok(result.metadata !== null);
    });

    test("returns new object each time", () => {
      const result1 = CliOutputFormatter.createEmpty();
      const result2 = CliOutputFormatter.createEmpty();

      assert.notStrictEqual(result1, result2);
      assert.notStrictEqual(result1.events, result2.events);
      assert.notStrictEqual(result1.metadata, result2.metadata);
    });
  });

  suite("merge", () => {
    test("combines text from multiple outputs", () => {
      const outputs = [
        createTestOutput([createTextEvent("First ")]),
        createTestOutput([createTextEvent("Second")]),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.events.length, 2);
      assert.strictEqual((result.events[0].data as TextData).text, "First ");
      assert.strictEqual((result.events[1].data as TextData).text, "Second");
    });

    test("handles empty array", () => {
      const result = CliOutputFormatter.merge([]);

      assert.deepStrictEqual(result.events, []);
      assert.deepStrictEqual(result.metadata, {});
    });

    test("returns single output unchanged", () => {
      const output = createTestOutput([createTextEvent("Single")], {
        model: "test",
      });
      const result = CliOutputFormatter.merge([output]);

      assert.strictEqual(result, output);
    });

    test("combines tool calls from multiple outputs", () => {
      const outputs = [
        createTestOutput([
          createToolCallEvent({ name: "tool1", parameters: { a: 1 } }),
        ]),
        createTestOutput([
          createToolCallEvent({ name: "tool2", parameters: { b: 2 } }),
        ]),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.events.length, 2);
      assert.strictEqual((result.events[0].data as ToolCall).name, "tool1");
      assert.strictEqual((result.events[1].data as ToolCall).name, "tool2");
    });

    test("combines thinking blocks from multiple outputs", () => {
      const outputs = [
        createTestOutput([createThinkingEvent({ text: "First thought" })]),
        createTestOutput([createThinkingEvent({ text: "Second thought" })]),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.events.length, 2);
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.THINKING);
      assert.strictEqual(result.events[1].type, CLI_EVENT_TYPES.THINKING);
      assert.strictEqual(
        (result.events[0].data as ThinkingBlock).text,
        "First thought"
      );
      assert.strictEqual(
        (result.events[1].data as ThinkingBlock).text,
        "Second thought"
      );
    });

    test("last metadata wins", () => {
      const outputs = [
        createTestOutput([], { model: "gpt-4", sessionId: "old-session" }),
        createTestOutput([], { model: "gpt-5", sessionId: "new-session" }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.metadata.model, "gpt-5");
      assert.strictEqual(result.metadata.sessionId, "new-session");
    });

    test("merges three outputs correctly", () => {
      const outputs = [
        createTestOutput([
          createTextEvent("A"),
          createToolCallEvent({ name: "t1", parameters: {} }),
        ]),
        createTestOutput([
          createTextEvent("B"),
          createThinkingEvent({ text: "think" }),
        ]),
        createTestOutput([createTextEvent("C")], { model: "final" }),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.events.length, 5);
      assert.strictEqual(result.metadata.model, "final");
    });

    test("handles outputs with empty arrays", () => {
      const outputs = [
        createTestOutput([createTextEvent("Has data")]),
        createTestOutput([createTextEvent(" More")]),
      ];
      const result = CliOutputFormatter.merge(outputs);

      assert.strictEqual(result.events.length, 2);
      assert.strictEqual((result.events[0].data as TextData).text, "Has data");
      assert.strictEqual((result.events[1].data as TextData).text, " More");
    });

    test("preserves tool call details during merge", () => {
      const outputs = [
        createTestOutput([
          createToolCallEvent({
            name: "shell",
            parameters: { cmd: "test" },
            id: "id-1",
            result: { success: true, output: "ok" },
          }),
        ]),
      ];
      const result = CliOutputFormatter.merge(outputs);

      const tool = result.events[0].data as ToolCall;
      assert.strictEqual(tool.name, "shell");
      assert.strictEqual(tool.id, "id-1");
      assert.strictEqual(tool.result?.success, true);
      assert.strictEqual(tool.result?.output, "ok");
    });
  });
});
