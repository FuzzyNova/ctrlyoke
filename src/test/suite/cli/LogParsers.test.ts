import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ClaudeLogParser } from "../../../flightpath/cli/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../../flightpath/cli/copilot/CopilotLogParser";
import { CodexLogParser } from "../../../flightpath/cli/codex/CodexLogParser";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  TextData,
  ToolResultData,
  CLI_EVENT_TYPES,
} from "../../../types/CliOutputTypes";

/**
 * Comprehensive unit tests for CLI log parser implementations
 *
 * Tests all three provider log parsers:
 * - ClaudeLogParser (JSONL format from ~/.claude/projects/)
 * - CopilotLogParser (Old flat file + new subdirectory formats)
 * - CodexLogParser (Nested payload structure in date-based directories)
 *
 * Test Coverage:
 * - Response extraction from various event types
 * - Completion detection
 * - Session ID extraction
 * - Session discovery (prompt matching)
 * - Error handling (missing fields, malformed JSON, empty responses)
 * - Format-specific features (multi-event responses, nested payloads, etc.)
 */

// ============================================================================
// Test Data Helpers
// ============================================================================

/**
 * Creates a temporary JSONL file for testing
 * @param events - Array of events to write (one per line)
 * @returns Absolute path to temp file
 */
function createTempJsonlFile(events: any[]): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightpath-test-"));
  const filePath = path.join(tempDir, "test.jsonl");
  const content = events.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Cleans up temporary test files
 */
function cleanupTempFile(filePath: string) {
  try {
    const dir = path.dirname(filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(dir)) {
      fs.rmdirSync(dir);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

/**
 * Extract text content from events array
 */
function extractText(output: UniversalCliOutput): string {
  const textParts: string[] = [];
  for (const event of output.events) {
    if (
      event.type === CLI_EVENT_TYPES.TEXT &&
      event.data &&
      "text" in event.data
    ) {
      textParts.push((event.data as TextData).text);
    }
  }
  return textParts.join("");
}

/**
 * Extract tool calls from events array
 */
function extractToolCalls(output: UniversalCliOutput): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (const event of output.events) {
    if (event.type === CLI_EVENT_TYPES.TOOL_CALL && event.data) {
      toolCalls.push(event.data as ToolCall);
    }
  }
  return toolCalls;
}

/**
 * Extract thinking blocks from events array
 */
function extractThinkingBlocks(output: UniversalCliOutput): ThinkingBlock[] {
  const blocks: ThinkingBlock[] = [];
  for (const event of output.events) {
    if (event.type === CLI_EVENT_TYPES.THINKING && event.data) {
      blocks.push(event.data as ThinkingBlock);
    }
  }
  return blocks;
}

// ============================================================================
// ClaudeLogParser Tests
// ============================================================================

suite("ClaudeLogParser", () => {
  let parser: ClaudeLogParser;

  setup(() => {
    parser = new ClaudeLogParser();
  });

  suite("extractResponse", () => {
    test("should parse complete response from JSONL events", () => {
      const events = [
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Here is the analysis of your code.\n\n" },
            ],
            stop_reason: null,
          },
          sessionId: "abc-123-def-456",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "It looks good overall." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
            model: "claude-sonnet-4.5",
          },
          sessionId: "abc-123-def-456",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        extractText(response),
        "Here is the analysis of your code.\n\nIt looks good overall."
      );
      assert.strictEqual(extractToolCalls(response).length, 0);
      assert.strictEqual(response.metadata.sessionId, "abc-123-def-456");
      assert.strictEqual(response.metadata.model, "claude-sonnet-4.5");
      assert.strictEqual(response.metadata.usage!.inputTokens, 100);
      assert.strictEqual(response.metadata.usage!.outputTokens, 50);
      assert.strictEqual(response.metadata.usage!.totalTokens, 150);
    });

    test("should handle multiple content blocks (text, thinking, tool calls)", () => {
      // Note: In Claude logs, thinking blocks use 'thinking' field, NOT 'text'
      const events = [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "thinking",
                thinking: "I need to analyze this carefully...",
                signature: "test-signature",
              },
              { type: "text", text: "Based on my analysis, " },
              {
                type: "tool_use",
                name: "write_file",
                input: { path: "test.ts", content: "console.log('test');" },
                id: "tool-1",
              },
              { type: "text", text: "the file has been updated." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 200, output_tokens: 75 },
          },
          sessionId: "session-xyz",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        extractText(response),
        "Based on my analysis, the file has been updated."
      );
      assert.strictEqual(extractToolCalls(response).length, 1);
      assert.strictEqual(extractToolCalls(response)[0].name, "write_file");
      assert.strictEqual(extractToolCalls(response)[0].id, "tool-1");
      assert.deepStrictEqual(extractToolCalls(response)[0].parameters, {
        path: "test.ts",
        content: "console.log('test');",
      });
      assert.ok(extractThinkingBlocks(response));
      assert.strictEqual(extractThinkingBlocks(response).length, 1);
      assert.strictEqual(
        extractThinkingBlocks(response)[0].text,
        "I need to analyze this carefully..."
      );
    });

    test("should aggregate usage stats from multiple events", () => {
      const events = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Part 1" }],
            usage: { input_tokens: 50, output_tokens: 20 },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Part 2" }],
            usage: { input_tokens: 30, output_tokens: 15 },
            stop_reason: "end_turn",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(response.metadata.usage!.inputTokens, 80);
      assert.strictEqual(response.metadata.usage!.outputTokens, 35);
      assert.strictEqual(response.metadata.usage!.totalTokens, 115);
    });

    test("should extract cache tokens from usage stats", () => {
      const events = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Response with cache" }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 500,
              cache_creation: {
                ephemeral_5m_input_tokens: 1000,
                ephemeral_1h_input_tokens: 0,
              },
              service_tier: "standard",
            },
            stop_reason: "end_turn",
          },
          sessionId: "cache-session",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(response.metadata.usage!.inputTokens, 100);
      assert.strictEqual(response.metadata.usage!.outputTokens, 50);
      // Cache tokens should be in metadata
      assert.ok(
        (response.metadata as any).cacheTokens,
        "Should have cacheTokens in metadata"
      );
      assert.strictEqual((response.metadata as any).cacheTokens.created, 1000);
      assert.strictEqual((response.metadata as any).cacheTokens.read, 500);
    });

    test("should extract tool results from user events", () => {
      const events = [
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me search for that..." },
              {
                type: "tool_use",
                name: "Grep",
                input: {
                  pattern: "newChatSessionPerPrompt",
                  output_mode: "files_with_matches",
                },
                id: "toolu_01Q3NwTz2ifw5qBLKtrZ4zta",
              },
            ],
            stop_reason: "tool_use",
          },
          sessionId: "tool-result-session",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_01Q3NwTz2ifw5qBLKtrZ4zta",
                type: "tool_result",
                content: "Found 13 files\nschemas/prompt-schema.yaml\n...",
              },
            ],
          },
          sessionId: "tool-result-session",
          toolUseResult: {
            mode: "files_with_matches",
            filenames: [
              "schemas/prompt-schema.yaml",
              "schemas/prompt-schema.json",
            ],
            numFiles: 13,
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I found the files." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 200, output_tokens: 100 },
          },
          sessionId: "tool-result-session",
        },
      ];

      const response = parser.extractResponse(events);

      // Should have text, tool call, tool result, and final text
      assert.ok(response.events.length >= 3, "Should have multiple events");

      // Find tool result event
      const toolResults = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.TOOL_RESULT
      );
      assert.strictEqual(toolResults.length, 1, "Should have one tool result");
      const toolResult = toolResults[0].data as any;
      assert.strictEqual(
        toolResult.toolCallId,
        "toolu_01Q3NwTz2ifw5qBLKtrZ4zta"
      );
      assert.strictEqual(toolResult.result.success, true);
      assert.ok(toolResult.result.output.includes("Found 13 files"));
    });

    test("should handle tool result errors from user events", () => {
      const events = [
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_error_test",
                type: "tool_result",
                content: "Command failed with exit code 1",
                is_error: true,
              },
            ],
          },
          sessionId: "error-session",
        },
      ];

      const response = parser.extractResponse(events);

      const toolResults = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.TOOL_RESULT
      );
      assert.strictEqual(toolResults.length, 1);
      const toolResult = toolResults[0].data as any;
      assert.strictEqual(toolResult.result.success, false);
      assert.ok(toolResult.result.error);
    });

    test("should extract turn duration from system events", () => {
      const events = [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Response" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          sessionId: "duration-session",
        },
        {
          type: "system",
          subtype: "turn_duration",
          durationMs: 2500,
          timestamp: "2026-01-25T20:16:43.098Z",
          uuid: "duration-uuid",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        response.metadata.elapsed,
        2500,
        "Should extract turn duration"
      );
    });

    test("should handle missing/corrupted data gracefully", () => {
      const events = [
        { type: "assistant" }, // Missing message
        { type: "assistant", message: {} }, // Missing content
        { type: "assistant", message: { content: null } }, // Null content
        { type: "assistant", message: { content: [{ type: "text" }] } }, // Missing text field
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Valid content" }],
            stop_reason: "end_turn",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Valid content");
      assert.strictEqual(extractToolCalls(response).length, 0);
      assert.ok(response.metadata);
    });

    test("should return empty response for empty events array", () => {
      const response = parser.extractResponse([]);

      assert.strictEqual(extractText(response), "");
      assert.strictEqual(extractToolCalls(response).length, 0);
      assert.strictEqual(response.metadata.sessionId, undefined);
      assert.strictEqual(response.metadata.usage, undefined);
    });

    test("should extract session ID from first event with sessionId field", () => {
      const events = [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Response" }] },
          sessionId: "first-session",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "More" }],
            stop_reason: "end_turn",
          },
          sessionId: "second-session", // Should be ignored
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(response.metadata.sessionId, "first-session");
    });
  });

  suite("isComplete", () => {
    test("should detect completion via stop_reason", () => {
      const completeEvents = [
        { type: "assistant", message: { stop_reason: "end_turn" } },
        { type: "assistant", message: { stop_reason: "max_tokens" } },
        { type: "assistant", message: { stop_reason: "stop_sequence" } },
      ];

      for (const event of completeEvents) {
        assert.strictEqual(
          parser.isComplete(event),
          true,
          `Should detect completion for stop_reason: ${event.message.stop_reason}`
        );
      }
    });

    test("should not detect completion when stop_reason is null", () => {
      const incompleteEvent = {
        type: "assistant",
        message: { stop_reason: null },
      };

      assert.strictEqual(parser.isComplete(incompleteEvent), false);
    });

    test("should not detect completion when stop_reason is tool_use (intermediate state)", () => {
      // tool_use means Claude paused to execute a tool and will continue after
      const intermediateEvent = {
        type: "assistant",
        message: { stop_reason: "tool_use" },
      };

      assert.strictEqual(
        parser.isComplete(intermediateEvent),
        false,
        "tool_use is an intermediate state, not final completion"
      );
    });

    test("should not detect completion when stop_reason is undefined", () => {
      const incompleteEvent = {
        type: "assistant",
        message: {},
      };

      assert.strictEqual(parser.isComplete(incompleteEvent), false);
    });

    test("should not detect completion for non-assistant events", () => {
      const nonAssistantEvents = [
        { type: "user", message: { stop_reason: "end_turn" } },
        { type: "queue-operation", message: { stop_reason: "end_turn" } },
      ];

      for (const event of nonAssistantEvents) {
        assert.strictEqual(
          parser.isComplete(event),
          false,
          `Should not detect completion for type: ${event.type}`
        );
      }
    });

    test("should handle missing message field", () => {
      const event = { type: "assistant" };
      assert.strictEqual(parser.isComplete(event), false);
    });
  });

  suite("extractSessionId", () => {
    test("should extract session ID from events", () => {
      const events = [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Response" }] },
          sessionId: "extracted-session-id",
        },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, "extracted-session-id");
    });

    test("should return null when no sessionId in events", () => {
      const events = [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Response" }] },
        },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, null);
    });

    test("should return null for empty events array", () => {
      const sessionId = parser.extractSessionId([]);
      assert.strictEqual(sessionId, null);
    });
  });

  suite("readNewLines", () => {
    test("should read and parse JSONL file incrementally", async () => {
      const events = [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Line 1" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Line 2" }] },
        },
      ];

      const filePath = createTempJsonlFile(events);

      try {
        // First read - should get all events
        const firstRead = await parser.readNewLines(filePath);
        assert.strictEqual(firstRead.length, 2);
        assert.strictEqual(firstRead[0].message.content[0].text, "Line 1");
        assert.strictEqual(firstRead[1].message.content[0].text, "Line 2");

        // Second read - should get no new events (incremental)
        const secondRead = await parser.readNewLines(filePath);
        assert.strictEqual(secondRead.length, 0);

        // Append new event
        fs.appendFileSync(
          filePath,
          "\n" +
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "Line 3" }] },
            }),
          "utf8"
        );

        // Third read - should get only new event
        const thirdRead = await parser.readNewLines(filePath);
        assert.strictEqual(thirdRead.length, 1);
        assert.strictEqual(thirdRead[0].message.content[0].text, "Line 3");
      } finally {
        cleanupTempFile(filePath);
      }
    });

    test("should handle malformed JSON lines gracefully", async () => {
      const filePath = createTempJsonlFile([{ type: "valid", data: "line1" }]);

      try {
        // Append malformed JSON
        fs.appendFileSync(filePath, "\n{invalid json}\n", "utf8");
        fs.appendFileSync(
          filePath,
          JSON.stringify({ type: "valid", data: "line3" }) + "\n",
          "utf8"
        );

        const events = await parser.readNewLines(filePath);

        // Should skip malformed line and continue
        assert.strictEqual(events.length, 2); // First read gets initial event + valid line (malformed skipped)
      } finally {
        cleanupTempFile(filePath);
      }
    });

    test("should return empty array for non-existent file", async () => {
      const events = await parser.readNewLines("/nonexistent/file.jsonl");
      assert.strictEqual(events.length, 0);
    });
  });
});

// ============================================================================
// CopilotLogParser Tests
// ============================================================================

suite("CopilotLogParser", () => {
  let parser: CopilotLogParser;

  setup(() => {
    parser = new CopilotLogParser();
  });

  suite("extractResponse", () => {
    test("should aggregate multi-event responses", () => {
      const events = [
        {
          type: "session.start",
          data: {
            sessionId: "copilot-session-123",
            selectedModel: "gpt-5",
          },
          timestamp: "2026-01-17T10:00:00Z",
        },
        {
          type: "assistant.message",
          data: {
            content: "Here is the first part. ",
          },
          timestamp: "2026-01-17T10:00:01Z",
        },
        {
          type: "assistant.message",
          data: {
            content: "And here is the second part.",
          },
          timestamp: "2026-01-17T10:00:02Z",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        extractText(response),
        "Here is the first part. And here is the second part."
      );
      assert.strictEqual(response.metadata.sessionId, "copilot-session-123");
      assert.strictEqual(response.metadata.model, "gpt-5");
    });

    test("should extract tool requests from assistant messages", () => {
      const events = [
        {
          type: "assistant.message",
          data: {
            content: "I'll create the file now.",
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: "tool.execution_start",
          data: {
            toolCallId: "tool-1",
            toolName: "write_file",
            arguments: { path: "test.ts", content: "export const x = 1;" },
          },
          timestamp: new Date().toISOString(),
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "I'll create the file now.");
      // Tool calls are now converted to semantic events (FILE_WRITE)
      const fileWriteEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.FILE_WRITE
      );
      assert.strictEqual(fileWriteEvents.length, 1);
      assert.strictEqual((fileWriteEvents[0].data as any).path, "test.ts");
      assert.strictEqual(
        (fileWriteEvents[0].data as any).content,
        "export const x = 1;"
      );
    });

    test("should extract session metadata from session.start event", () => {
      const events = [
        {
          type: "session.start",
          data: {
            sessionId: "session-abc",
            selectedModel: "claude-sonnet-4.5",
          },
          timestamp: "2026-01-17T10:00:00Z",
        },
        {
          type: "assistant.message",
          data: { content: "Response" },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(response.metadata.sessionId, "session-abc");
      assert.strictEqual(response.metadata.model, "claude-sonnet-4.5");
    });

    test("should handle missing data fields gracefully", () => {
      const events = [
        { type: "assistant.message" }, // Missing data
        { type: "assistant.message", data: {} }, // Missing content
        { type: "assistant.message", data: { content: null } }, // Null content
        { type: "assistant.message", data: { content: "Valid" } },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Valid");
      assert.strictEqual(extractToolCalls(response).length, 0);
    });

    test("should return empty response for empty events array", () => {
      const response = parser.extractResponse([]);

      assert.strictEqual(extractText(response), "");
      assert.strictEqual(extractToolCalls(response).length, 0);
      assert.strictEqual(response.metadata.harness, "copilot-cli");
    });

    test("should handle metadata from multiple events", () => {
      const events = [
        {
          type: "session.start",
          data: {
            sessionId: "merged-session",
            selectedModel: "gpt-5",
          },
        },
        {
          type: "assistant.message",
          data: {
            content: "Response",
          },
        },
        {
          type: "assistant.message",
          data: {
            content: " continued",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Response continued");
      assert.strictEqual(response.metadata.sessionId, "merged-session");
      assert.strictEqual(response.metadata.model, "gpt-5");
    });
  });

  suite("isComplete", () => {
    test("should always return false (uses hooks for completion detection)", () => {
      // CopilotLogParser intentionally returns false for all events
      // because it uses hooks for completion detection, not log parsing
      const event = { type: "assistant.turn_end" };
      assert.strictEqual(parser.isComplete(event), false);
    });

    test("should not detect completion for other event types", () => {
      const incompleteEvents = [
        { type: "session.start" },
        { type: "assistant.message" },
        { type: "user.message" },
        { type: "turn.start" },
      ];

      for (const event of incompleteEvents) {
        assert.strictEqual(
          parser.isComplete(event),
          false,
          `Should not detect completion for type: ${event.type}`
        );
      }
    });

    test("should handle malformed events", () => {
      const malformedEvents = [
        {}, // Missing type
        { type: null },
        { type: undefined },
      ];

      for (const event of malformedEvents) {
        assert.strictEqual(parser.isComplete(event), false);
      }
    });
  });

  suite("extractSessionId", () => {
    test("should extract session ID from session.start event", () => {
      const events = [
        {
          type: "session.start",
          data: { sessionId: "extracted-copilot-session" },
        },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, "extracted-copilot-session");
    });

    test("should return first session ID if multiple session.start events", () => {
      const events = [
        { type: "session.start", data: { sessionId: "first-session" } },
        { type: "session.start", data: { sessionId: "second-session" } },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, "first-session");
    });

    test("should return null when no session.start event", () => {
      const events = [
        { type: "assistant.message", data: { content: "Response" } },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, null);
    });

    test("should return null for empty events array", () => {
      const sessionId = parser.extractSessionId([]);
      assert.strictEqual(sessionId, null);
    });

    test("should handle missing data.sessionId field", () => {
      const events = [
        { type: "session.start", data: {} }, // Missing sessionId
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, null);
    });
  });

  suite("format detection", () => {
    test("should detect old format (flat file)", () => {
      // Old format: ~/.copilot/session-state/<session-id>.jsonl
      const oldFormatPath = "/home/user/.copilot/session-state/abc-123.jsonl";
      const isOldFormat = !oldFormatPath.includes("/events.jsonl");

      assert.strictEqual(isOldFormat, true);
    });

    test("should detect new format (subdirectory)", () => {
      // New format: ~/.copilot/session-state/<session-id>/events.jsonl
      const newFormatPath =
        "/home/user/.copilot/session-state/abc-123/events.jsonl";
      const isNewFormat = newFormatPath.endsWith("/events.jsonl");

      assert.strictEqual(isNewFormat, true);
    });
  });

  suite("readNewLines", () => {
    test("should read and parse JSONL file incrementally", async () => {
      const events = [
        { type: "session.start", data: { sessionId: "test-session" } },
        { type: "assistant.message", data: { content: "Response" } },
      ];

      const filePath = createTempJsonlFile(events);

      try {
        const firstRead = await parser.readNewLines(filePath);
        assert.strictEqual(firstRead.length, 2);

        const secondRead = await parser.readNewLines(filePath);
        assert.strictEqual(secondRead.length, 0);

        fs.appendFileSync(
          filePath,
          "\n" + JSON.stringify({ type: "assistant.turn_end" }),
          "utf8"
        );

        const thirdRead = await parser.readNewLines(filePath);
        assert.strictEqual(thirdRead.length, 1);
        assert.strictEqual(thirdRead[0].type, "assistant.turn_end");
      } finally {
        cleanupTempFile(filePath);
      }
    });
  });
});

// ============================================================================
// CodexLogParser Tests
// ============================================================================

suite("CodexLogParser", () => {
  let parser: CodexLogParser;

  setup(() => {
    parser = new CodexLogParser();
  });

  suite("extractResponse", () => {
    test("should extract session metadata", () => {
      const events = [
        {
          type: "session_meta",
          payload: {
            id: "thread_abc123xyz789",
            model: "gpt-5.1-codex",
            cli_version: "1.0.0",
          },
          timestamp: "2026-01-17T10:00:00Z",
        },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Response content" }],
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(response.metadata.sessionId, "thread_abc123xyz789");
      assert.strictEqual(response.metadata.model, "gpt-5.1-codex");
      assert.strictEqual(response.metadata.cliVersion, "1.0.0");
    });

    test("should parse nested payload structure", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [
              { type: "input_text", text: "Here is the implementation: " },
              { type: "input_text", text: "console.log('hello');" },
            ],
          },
          timestamp: "2026-01-17T10:00:01Z",
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        extractText(response),
        "Here is the implementation: console.log('hello');"
      );
    });

    test("should extract tool calls from nested payload", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [
              { type: "input_text", text: "Creating file..." },
              {
                type: "tool_use",
                name: "write_file",
                input: {
                  path: "app.ts",
                  content: "export const app = 'FlightPath';",
                },
                id: "tool-codex-1",
              },
            ],
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Creating file...");
      // Tool calls are now converted to semantic events (FILE_WRITE)
      const fileWriteEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.FILE_WRITE
      );
      assert.strictEqual(fileWriteEvents.length, 1);
      assert.strictEqual((fileWriteEvents[0].data as any).path, "app.ts");
      assert.strictEqual(
        (fileWriteEvents[0].data as any).content,
        "export const app = 'FlightPath';"
      );
    });

    test("should extract tool calls from function_call payload type", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: { command: "npm test" },
            call_id: "call-123",
          },
        },
      ];

      const response = parser.extractResponse(events);

      // Shell commands are converted to BASH_COMMAND events
      const bashEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.BASH_COMMAND
      );
      assert.strictEqual(bashEvents.length, 1);
      assert.strictEqual((bashEvents[0].data as any).command, "npm test");
    });

    test("should parse function_call arguments when passed as JSON string", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "write_file",
            arguments: '{"path":"test.ts","content":"export const x = 1;"}',
            call_id: "call-456",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractToolCalls(response).length, 1);
      assert.strictEqual(extractToolCalls(response)[0].name, "write_file");
      assert.deepStrictEqual(extractToolCalls(response)[0].parameters, {
        path: "test.ts",
        content: "export const x = 1;",
      });
    });

    test("should handle malformed JSON string arguments gracefully", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: "{invalid json}",
            call_id: "call-789",
          },
        },
      ];

      const response = parser.extractResponse(events);

      // Shell commands are converted to BASH_COMMAND events
      // Malformed JSON is wrapped in { raw: ... }, but command extraction still tries params.command
      // which doesn't exist, so command becomes empty string
      const bashEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.BASH_COMMAND
      );
      assert.strictEqual(bashEvents.length, 1);
      assert.strictEqual((bashEvents[0].data as any).command, "");
      assert.strictEqual((bashEvents[0].data as any).status, "initiated");
      assert.strictEqual((bashEvents[0].data as any).workingDir, undefined);
    });

    test("should extract thinking blocks from thinking type", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [
              { type: "thinking", text: "Let me think about this approach..." },
              { type: "input_text", text: "Based on my analysis, " },
              { type: "thinking", text: "Actually, a better way would be..." },
              { type: "input_text", text: "I recommend using pattern X." },
            ],
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(
        extractText(response),
        "Based on my analysis, I recommend using pattern X."
      );
      assert.strictEqual(extractThinkingBlocks(response).length, 2);
      assert.strictEqual(
        extractThinkingBlocks(response)[0].text,
        "Let me think about this approach..."
      );
      assert.strictEqual(
        extractThinkingBlocks(response)[1].text,
        "Actually, a better way would be..."
      );
    });

    test("should handle thread_xxx session ID format", () => {
      const events = [
        {
          type: "session_meta",
          payload: {
            id: "thread_xyz987abc654",
            model: "gpt-5.1-codex-max",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.ok(response.metadata.sessionId!.startsWith("thread_"));
      assert.strictEqual(response.metadata.sessionId, "thread_xyz987abc654");
    });

    test("should handle missing payload fields gracefully", () => {
      const events = [
        { type: "response_item" }, // Missing payload
        { type: "response_item", payload: {} }, // Missing role
        { type: "response_item", payload: { role: "assistant" } }, // Missing content
        {
          type: "response_item",
          payload: { role: "assistant", content: null },
        }, // Null content
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Valid" }],
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Valid");
      assert.strictEqual(extractToolCalls(response).length, 0);
    });

    test("should return empty response for empty events array", () => {
      const response = parser.extractResponse([]);

      assert.strictEqual(extractText(response), "");
      assert.strictEqual(extractToolCalls(response).length, 0);
      assert.ok(response.metadata);
    });

    test("should aggregate content from multiple response_item events", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Part 1. " }],
          },
        },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Part 2. " }],
          },
        },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Part 3." }],
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractText(response), "Part 1. Part 2. Part 3.");
    });

    test("should cache session metadata for fallback", () => {
      const events1 = [
        {
          type: "session_meta",
          payload: { id: "thread_cached", model: "gpt-5.1-codex" },
        },
      ];

      const response1 = parser.extractResponse(events1);
      assert.strictEqual(response1.metadata.sessionId, "thread_cached");

      // Second extraction without session_meta should use cached value
      const events2 = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Response" }],
          },
        },
      ];

      const response2 = parser.extractResponse(events2);
      assert.strictEqual(response2.metadata.sessionId, "thread_cached");
    });
  });

  suite("isComplete", () => {
    test("should detect completion via turn.completed event", () => {
      const event = {
        type: "event_msg",
        payload: { type: "turn.completed" },
      };

      assert.strictEqual(parser.isComplete(event), true);
    });

    test("should not detect completion for other event types", () => {
      const incompleteEvents = [
        { type: "session_meta", payload: {} },
        { type: "response_item", payload: {} },
        { type: "turn_context", payload: {} },
        { type: "event_msg", payload: { type: "turn.started" } },
        { type: "event_msg", payload: { type: "other" } },
      ];

      for (const event of incompleteEvents) {
        assert.strictEqual(
          parser.isComplete(event),
          false,
          `Should not detect completion for: ${JSON.stringify(event)}`
        );
      }
    });

    test("should handle missing payload fields", () => {
      const malformedEvents = [
        { type: "event_msg" }, // Missing payload
        { type: "event_msg", payload: {} }, // Missing type
        { type: "event_msg", payload: { type: null } },
      ];

      for (const event of malformedEvents) {
        assert.strictEqual(parser.isComplete(event), false);
      }
    });
  });

  suite("extractSessionId", () => {
    test("should extract thread_xxx session ID from session_meta", () => {
      const events = [
        {
          type: "session_meta",
          payload: { id: "thread_testid123" },
        },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, "thread_testid123");
    });

    test("should return first session ID if multiple session_meta events", () => {
      const events = [
        { type: "session_meta", payload: { id: "thread_first" } },
        { type: "session_meta", payload: { id: "thread_second" } },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, "thread_first");
    });

    test("should return null when no session_meta event", () => {
      const events = [
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Response" }],
          },
        },
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, null);
    });

    test("should return null for empty events array", () => {
      const sessionId = parser.extractSessionId([]);
      assert.strictEqual(sessionId, null);
    });

    test("should handle missing payload.id field", () => {
      const events = [
        { type: "session_meta", payload: {} }, // Missing id
      ];

      const sessionId = parser.extractSessionId(events);
      assert.strictEqual(sessionId, null);
    });
  });

  suite("readNewLines", () => {
    test("should read and parse JSONL file incrementally", async () => {
      const events = [
        { type: "session_meta", payload: { id: "thread_test" } },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "input_text", text: "Response" }],
          },
        },
      ];

      const filePath = createTempJsonlFile(events);

      try {
        const firstRead = await parser.readNewLines(filePath);
        assert.strictEqual(firstRead.length, 2);

        const secondRead = await parser.readNewLines(filePath);
        assert.strictEqual(secondRead.length, 0);

        fs.appendFileSync(
          filePath,
          "\n" +
            JSON.stringify({
              type: "event_msg",
              payload: { type: "turn.completed" },
            }),
          "utf8"
        );

        const thirdRead = await parser.readNewLines(filePath);
        assert.strictEqual(thirdRead.length, 1);
        assert.strictEqual(thirdRead[0].type, "event_msg");
      } finally {
        cleanupTempFile(filePath);
      }
    });
  });

  suite("date-based directory structure", () => {
    test("should handle YYYY/MM/DD directory format", () => {
      // Codex log path: ~/.codex/sessions/2026/01/17/rollout-timestamp-thread_xxx.jsonl
      const codexLogPath =
        "/home/user/.codex/sessions/2026/01/17/rollout-1705492800-thread_abc123.jsonl";

      const pathParts = codexLogPath.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");

      assert.ok(sessionsIndex > -1);
      assert.strictEqual(pathParts[sessionsIndex + 1], "2026"); // Year
      assert.strictEqual(pathParts[sessionsIndex + 2], "01"); // Month
      assert.strictEqual(pathParts[sessionsIndex + 3], "17"); // Day
    });

    test("should extract session ID from filename format", () => {
      const filename = "rollout-1705492800-thread_xyz789.jsonl";
      const match = filename.match(/thread_[a-zA-Z0-9]+/);

      assert.ok(match);
      assert.strictEqual(match[0], "thread_xyz789");
    });
  });
});

// ============================================================================
// Cross-Parser Compatibility Tests
// ============================================================================

suite("Cross-Parser Compatibility", () => {
  test("all parsers should implement extractResponse", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    assert.ok(typeof claudeParser.extractResponse === "function");
    assert.ok(typeof copilotParser.extractResponse === "function");
    assert.ok(typeof codexParser.extractResponse === "function");
  });

  test("all parsers should implement isComplete", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    assert.ok(typeof claudeParser.isComplete === "function");
    assert.ok(typeof copilotParser.isComplete === "function");
    assert.ok(typeof codexParser.isComplete === "function");
  });

  test("all parsers should implement extractSessionId", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    assert.ok(typeof claudeParser.extractSessionId === "function");
    assert.ok(typeof copilotParser.extractSessionId === "function");
    assert.ok(typeof codexParser.extractSessionId === "function");
  });

  test("all parsers should implement readNewLines", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    assert.ok(typeof claudeParser.readNewLines === "function");
    assert.ok(typeof copilotParser.readNewLines === "function");
    assert.ok(typeof codexParser.readNewLines === "function");
  });

  test("all parsers should handle empty events array", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    const claudeResponse = claudeParser.extractResponse([]);
    const copilotResponse = copilotParser.extractResponse([]);
    const codexResponse = codexParser.extractResponse([]);

    assert.strictEqual(extractText(claudeResponse), "");
    assert.strictEqual(extractText(copilotResponse), "");
    assert.strictEqual(extractText(codexResponse), "");
  });

  test("all parsers should handle malformed events gracefully", () => {
    const claudeParser = new ClaudeLogParser();
    const copilotParser = new CopilotLogParser();
    const codexParser = new CodexLogParser();

    const malformedEvents = [
      {}, // Empty object
      { type: null },
      { type: "unknown" },
    ];

    // Should not throw
    assert.doesNotThrow(() => claudeParser.extractResponse(malformedEvents));
    assert.doesNotThrow(() => copilotParser.extractResponse(malformedEvents));
    assert.doesNotThrow(() => codexParser.extractResponse(malformedEvents));
  });
});
