import * as assert from "assert";
import { CliOutputFormatter } from "../../core/harness/shared/CliOutputFormatter";
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
});
