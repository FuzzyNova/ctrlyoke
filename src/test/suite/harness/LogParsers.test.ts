import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ClaudeLogParser } from "../../../core/harness/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../../core/harness/copilot/CopilotLogParser";
import { CodexLogParser } from "../../../core/harness/codex/CodexLogParser";
import { OpenCodeLogParser } from "../../../core/harness/opencode/OpenCodeLogParser";
import {
  UniversalCliOutput,
  ToolCall,
  ThinkingBlock,
  TextData,
  FileWriteData,
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { BaseCliEvent } from "../../../core/harness/shared/interfaces/ILogParser";

/**
 * Comprehensive unit tests for CLI log parser implementations
 *
 * Tests all three harness log parsers:
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-test-"));
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
      // write_file is now classified as FILE_WRITE semantic event (not generic TOOL_CALL)
      const fileWriteEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.FILE_WRITE
      );
      assert.strictEqual(fileWriteEvents.length, 1);
      assert.strictEqual(
        (fileWriteEvents[0].data as FileWriteData).path,
        "test.ts"
      );
      assert.strictEqual(
        (fileWriteEvents[0].data as FileWriteData).content,
        "console.log('test');"
      );
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
                content: "Found 13 files\nschemas/workflow-schema.yaml\n...",
              },
            ],
          },
          sessionId: "tool-result-session",
          toolUseResult: {
            mode: "files_with_matches",
            filenames: [
              "schemas/workflow-schema.yaml",
              "schemas/workflow-schema.json",
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

      const response = parser.extractResponse(events as BaseCliEvent[]);

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

  suite("background work tracking", () => {
    test("should track confirmed asynchronous Agent launches until notification", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_async_agent",
              name: "Agent",
              input: {
                description: "Research the implementation",
                subagent_type: "Explore",
              },
            },
          ],
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), false);

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_async_agent",
              content: [
                {
                  type: "text",
                  text: "Async agent launched successfully.\nThe agent is working in the background.",
                },
              ],
            },
          ],
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification><tool-use-id>toolu_async_agent</tool-use-id></task-notification>",
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: { content: [], stop_reason: "end_turn" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should ignore synchronous and failed Agent launches", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_sync_agent",
              name: "Agent",
              input: {
                description: "Run synchronously",
                run_in_background: false,
              },
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_sync_agent",
              content: "Synchronous agent result",
            },
          ],
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), false);

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_failed_agent",
              name: "Agent",
              input: {
                description: "Attempt an async launch",
              },
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_failed_agent",
              is_error: true,
              content: "Agent launch failed",
            },
          ],
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should clear pending background work from string task notifications", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_background_1",
              name: "Bash",
              input: {
                command: "sleep 60",
                run_in_background: true,
              },
            },
          ],
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n" +
            "<task-id>abc123</task-id>\n" +
            "<tool-use-id>toolu_background_1</tool-use-id>\n" +
            "<status>completed</status>\n" +
            "</task-notification>",
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: { content: [], stop_reason: "end_turn" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should keep background work pending while its notification is only queued", () => {
      const notification =
        "<task-notification><tool-use-id>toolu_background_queue</tool-use-id></task-notification>";

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_background_queue",
              name: "Bash",
              input: { run_in_background: true },
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "queue-operation",
        operation: "enqueue",
        content: notification,
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      // Queue bookkeeping can be written immediately before the current turn's
      // Stop. Only the subsequently delivered user event may release the hold.
      parser.trackBackgroundWorkState({
        type: "queue-operation",
        operation: "dequeue",
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content: notification,
        },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: { content: [], stop_reason: "end_turn" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should clear pending background work from attachment notifications", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_background_attachment",
              name: "Bash",
              input: { run_in_background: true },
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "attachment",
        attachment: {
          prompt:
            "<task-notification><tool-use-id>toolu_background_attachment</tool-use-id></task-notification>",
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: { content: [], stop_reason: "end_turn" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should track concurrent PowerShell, Bash, and Monitor work through the resumed turn", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_powershell",
              name: "PowerShell",
              input: { run_in_background: true },
            },
          ],
          stop_reason: "tool_use",
        },
      });

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_monitor",
              name: "Monitor",
              input: { persistent: false },
            },
          ],
          stop_reason: "tool_use",
        },
      });
      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_monitor",
              content:
                "Monitor started (task monitor-1, timeout 900000ms). You will be notified on each event.",
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_bash",
              name: "Bash",
              input: { run_in_background: true },
            },
          ],
          stop_reason: "tool_use",
        },
      });

      for (const toolUseId of [
        "toolu_powershell",
        "toolu_bash",
        "toolu_monitor",
      ]) {
        parser.trackBackgroundWorkState({
          type: "user",
          message: {
            content:
              `<task-notification><tool-use-id>${toolUseId}</tool-use-id>` +
              "</task-notification>",
          },
        });
      }

      // Delivery clears all task IDs, but it also schedules an auto-resumed
      // turn, so the Stop preceding these notifications is still not final.
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: { content: [], stop_reason: "tool_use" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Tests pass." }],
          stop_reason: "end_turn",
        },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("should keep pending background work for unmatched notifications", () => {
      parser.trackBackgroundWorkState({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_background_2",
              name: "Bash",
              input: { run_in_background: true },
            },
          ],
        },
      });

      parser.trackBackgroundWorkState({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification><tool-use-id>toolu_other</tool-use-id></task-notification>",
        },
      });

      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
    });
  });

  suite("classifyUserEvent", () => {
    test("should classify string task notifications as resume signals", () => {
      const classification = parser.classifyUserEvent(
        {
          type: "user",
          message: {
            role: "user",
            content:
              "<task-notification><tool-use-id>toolu_1</tool-use-id></task-notification>",
          },
        },
        {}
      );

      assert.strictEqual(classification, "resume-signal");
    });

    test("should classify string dispatched prompts as injected prompts", () => {
      const classification = parser.classifyUserEvent(
        {
          type: "user",
          message: {
            role: "user",
            content: "Use these file references @C:\\dev\\ctrlyoke\\file.ts",
          },
        },
        {
          dispatchedPromptText:
            "Use these file references @C:\\dev\\ctrlyoke\\file.ts",
        }
      );

      assert.strictEqual(classification, "injected-prompt");
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
        assert.strictEqual(
          (firstRead[0] as any).message.content[0].text,
          "Line 1"
        );
        assert.strictEqual(
          (firstRead[1] as any).message.content[0].text,
          "Line 2"
        );

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
        assert.strictEqual(
          (thirdRead[0] as any).message.content[0].text,
          "Line 3"
        );
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

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

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

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

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

    test("should extract file paths from apply_patch tool events", () => {
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/first.ts",
        "@@",
        "-old",
        "+new",
        "*** Update File: src/second.ts",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n");

      const events = [
        {
          type: "tool.execution_start",
          data: {
            toolCallId: "tool-1",
            toolName: "apply_patch",
            arguments: patch,
          },
          timestamp: "2026-01-17T10:00:01Z",
        },
        {
          type: "tool.execution_complete",
          data: {
            toolCallId: "tool-1",
            success: true,
            result: {
              detailedContent: patch,
            },
          },
          timestamp: "2026-01-17T10:00:02Z",
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );
      const fileEditEvents = response.events.filter(
        (event) => event.type === CLI_EVENT_TYPES.FILE_EDIT
      );

      assert.strictEqual(fileEditEvents.length, 4);
      assert.deepStrictEqual(
        fileEditEvents.map((event) => (event.data as any).path),
        ["src/first.ts", "src/second.ts", "src/first.ts", "src/second.ts"]
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

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

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

    test("should extract context window usage from session.shutdown currentTokens (Copilot CLI 1.0.x+)", () => {
      // session.truncation was removed entirely in Copilot CLI 1.0.x — session.shutdown's
      // currentTokens is now the only context window signal available.
      const events = [
        {
          type: "session.start",
          data: { sessionId: "shutdown-session", selectedModel: "gpt-5.4" },
        },
        {
          type: "assistant.message",
          data: { content: "Done" },
        },
        {
          type: "session.shutdown",
          data: {
            shutdownType: "routine",
            currentModel: "gpt-5.4",
            currentTokens: 95987,
            systemTokens: 15141,
            conversationTokens: 72058,
            toolDefinitionsTokens: 8785,
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      assert.strictEqual(
        response.metadata.usage?.contextWindowUsedTokens,
        95987
      );
      // No tokenLimit in session.shutdown — falls back to the known model context window.
      assert.ok((response.metadata.usage?.contextWindowSize ?? 0) > 0);
    });

    test("should let a trailing session.shutdown override earlier session.truncation values", () => {
      // Real chronology: session.truncation (if emitted at all) fires mid-session on earlier
      // turns, and session.shutdown always fires last at process exit.
      const events = [
        {
          type: "session.truncation",
          data: {
            postTruncationTokensInMessages: 5000,
            tokenLimit: 128000,
          },
        },
        {
          type: "session.shutdown",
          data: { currentTokens: 9000 },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      assert.strictEqual(
        response.metadata.usage?.contextWindowUsedTokens,
        9000
      );
    });
  });

  suite("extractLiveContextWindow", () => {
    test("should extract from session.truncation events", () => {
      const event = {
        type: "session.truncation",
        data: { postTruncationTokensInMessages: 42000, tokenLimit: 128000 },
      } as unknown as BaseCliEvent;

      const result = parser.extractLiveContextWindow(event, "gpt-5.4");

      assert.deepStrictEqual(result, { used: 42000, size: 128000 });
    });

    test("should extract from session.shutdown events (Copilot CLI 1.0.x+)", () => {
      const event = {
        type: "session.shutdown",
        data: { currentTokens: 95987 },
      } as unknown as BaseCliEvent;

      const result = parser.extractLiveContextWindow(event, "gpt-5.4");

      assert.ok(result !== null);
      assert.strictEqual(result?.used, 95987);
      assert.ok(result!.size > 0);
    });

    test("should return null for events with no context window data", () => {
      const event = {
        type: "assistant.message",
        data: { content: "hello" },
      } as unknown as BaseCliEvent;

      assert.strictEqual(
        parser.extractLiveContextWindow(event, "gpt-5.4"),
        null
      );
    });
  });

  suite("OTel context window tracking", () => {
    test("should return null when no OTel file path is set", async () => {
      const result = await parser.pollOtelContextWindow("gpt-5.4");
      assert.strictEqual(result, null);
      assert.strictEqual(parser.getFinalOtelUsage(), null);
    });

    test("should extract context window usage from chat spans", async () => {
      const otelLines = [
        { type: "span", name: "invoke_agent", attributes: {} },
        {
          type: "span",
          name: "chat gpt-5.4",
          attributes: {
            "gen_ai.usage.input_tokens": 18689,
            "gen_ai.usage.output_tokens": 42,
            "gen_ai.response.model": "gpt-5.4",
          },
        },
      ];
      const filePath = createTempJsonlFile(otelLines);

      try {
        parser.setOtelFilePath(filePath);
        const result = await parser.pollOtelContextWindow("gpt-5.4");

        assert.ok(result !== null);
        assert.strictEqual(result?.used, 18689);
        assert.ok(result!.size > 0);

        const final = parser.getFinalOtelUsage();
        assert.strictEqual(final?.contextWindowUsedTokens, 18689);
        assert.strictEqual(final?.outputTokens, 42);
      } finally {
        cleanupTempFile(filePath);
      }
    });

    test("should track the latest input and cumulative output tokens across multiple chat spans", async () => {
      const otelLines = [
        {
          type: "span",
          name: "chat gpt-5.4",
          attributes: {
            "gen_ai.usage.input_tokens": 18719,
            "gen_ai.usage.output_tokens": 147,
          },
        },
        { type: "span", name: "execute_tool powershell", attributes: {} },
        {
          type: "span",
          name: "chat gpt-5.4",
          attributes: {
            "gen_ai.usage.input_tokens": 18894,
            "gen_ai.usage.output_tokens": 53,
          },
        },
      ];
      const filePath = createTempJsonlFile(otelLines);

      try {
        parser.setOtelFilePath(filePath);
        const result = await parser.pollOtelContextWindow("gpt-5.4");

        // "used" reflects the latest turn's context size, not a sum across turns.
        assert.strictEqual(result?.used, 18894);

        const final = parser.getFinalOtelUsage();
        assert.strictEqual(final?.contextWindowUsedTokens, 18894);
        // "outputTokens" accumulates across every chat span in this invocation.
        assert.strictEqual(final?.outputTokens, 200);
      } finally {
        cleanupTempFile(filePath);
      }
    });

    test("should return null on a second poll when no new spans were written", async () => {
      const filePath = createTempJsonlFile([
        {
          type: "span",
          name: "chat gpt-5.4",
          attributes: {
            "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 10,
          },
        },
      ]);

      try {
        parser.setOtelFilePath(filePath);
        const first = await parser.pollOtelContextWindow("gpt-5.4");
        assert.ok(first !== null);

        const second = await parser.pollOtelContextWindow("gpt-5.4");
        assert.strictEqual(second, null);
      } finally {
        cleanupTempFile(filePath);
      }
    });

    test("should reset all state when the OTel path is cleared (parser instance reuse across prompts)", async () => {
      const filePath = createTempJsonlFile([
        {
          type: "span",
          name: "chat gpt-5.4",
          attributes: {
            "gen_ai.usage.input_tokens": 5000,
            "gen_ai.usage.output_tokens": 20,
          },
        },
      ]);

      try {
        parser.setOtelFilePath(filePath);
        await parser.pollOtelContextWindow("gpt-5.4");
        assert.ok(parser.getFinalOtelUsage() !== null);

        // Simulate the next prompt execution with no OTel path available.
        parser.setOtelFilePath(undefined);
        assert.strictEqual(await parser.pollOtelContextWindow("gpt-5.4"), null);
        assert.strictEqual(parser.getFinalOtelUsage(), null);
      } finally {
        cleanupTempFile(filePath);
      }
    });
  });

  suite("background work tracking", () => {
    const asyncLaunch = (shellId: string): BaseCliEvent => ({
      type: "tool.execution_complete",
      data: {
        toolTelemetry: { properties: { executionMode: "async" } },
        result: {
          content: `<command started in background with shellId: ${shellId}>`,
        },
      },
    });

    const notification = (
      type: "shell_completed" | "shell_failed",
      shellId: string
    ): BaseCliEvent => ({
      type: "system.notification",
      data: {
        kind: { type, shellId, exitCode: type === "shell_failed" ? 1 : 0 },
      },
    });

    test("holds one completed shell through its resumed turn and rejects the stale Stop", () => {
      parser.trackBackgroundWorkState(asyncLaunch("shell-1"));
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState(notification("shell_completed", "shell-1"));
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      // A turn_end from an unrelated turn cannot release the notification latch.
      parser.trackBackgroundWorkState({ type: "assistant.turn_end" });
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState({ type: "assistant.turn_start" });
      parser.trackBackgroundWorkState({ type: "assistant.turn_end" });

      // The Stop that caused catch-up is stale even though it saw the whole
      // resumed turn. The next Stop is the real completion signal.
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("tracks overlapping shells independently and keeps failure notifications equivalent", () => {
      parser.trackBackgroundWorkState(asyncLaunch("shell-1"));
      parser.trackBackgroundWorkState(asyncLaunch("shell-2"));
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      parser.trackBackgroundWorkState(notification("shell_completed", "shell-1"));
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);

      // The second shell is still pending, so its failure cannot release the
      // hold prematurely even after the first notification was consumed.
      parser.trackBackgroundWorkState(notification("shell_failed", "shell-2"));
      parser.trackBackgroundWorkState({ type: "assistant.turn_start" });
      parser.trackBackgroundWorkState({ type: "assistant.turn_end" });
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
    });

    test("resets tracking at a new session boundary", () => {
      parser.trackBackgroundWorkState(asyncLaunch("old-shell"));
      assert.strictEqual(parser.hasPendingBackgroundWork(), true);
      parser.trackBackgroundWorkState({
        type: "session.start",
        data: { sessionId: "new-session" },
      });
      assert.strictEqual(parser.hasPendingBackgroundWork(), false);
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
        assert.strictEqual(
          parser.isComplete(event as unknown as BaseCliEvent),
          false
        );
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

  suite("classifyUserEvent", () => {
    test("should ignore user-role response items containing injected project context", () => {
      const event = {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>...</INSTRUCTIONS>",
            },
            {
              type: "input_text",
              text: "<environment_context><cwd>/workspace</cwd></environment_context>",
            },
          ],
        },
      } as unknown as BaseCliEvent;

      assert.strictEqual(parser.classifyUserEvent(event, {}), "other");
      assert.strictEqual(parser.extractUserSteerText(event), undefined);
    });

    test("should classify the event_msg echo of the dispatched prompt as injected", () => {
      const event = {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Please update src/app.ts",
        },
      } as unknown as BaseCliEvent;

      assert.strictEqual(
        parser.classifyUserEvent(event, {
          dispatchedPromptText: "Please update src/app.ts",
        }),
        "injected-prompt"
      );
    });

    test("should classify an unmatched event_msg user message as a human steer", () => {
      const event = {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Also update the tests",
        },
      } as unknown as BaseCliEvent;

      assert.strictEqual(
        parser.classifyUserEvent(event, {
          dispatchedPromptText: "Please update src/app.ts",
        }),
        "human-steer"
      );
      assert.strictEqual(
        parser.extractUserSteerText(event),
        "Also update the tests"
      );
    });
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

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

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

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

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
                  content: "export const app = 'ctrlyoke';",
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
        "export const app = 'ctrlyoke';"
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
            name: "custom_tool",
            arguments: '{"path":"test.ts","content":"export const x = 1;"}',
            call_id: "call-456",
          },
        },
      ];

      const response = parser.extractResponse(events);

      assert.strictEqual(extractToolCalls(response).length, 1);
      assert.strictEqual(extractToolCalls(response)[0].name, "custom_tool");
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

    test("should correct apply_patch diff line numbers from patch_apply_end", () => {
      // Codex apply_patch payloads use bare `@@` markers (no line numbers), so the
      // INITIATED hunk defaults to oldStart/newStart = 1. The follow-up
      // patch_apply_end event carries a real unified diff with correct offsets.
      const events = [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-patch-1",
            input:
              "*** Begin Patch\n" +
              "*** Update File: c:\\dev\\ctrlyoke\\package.json\n" +
              "@@\n" +
              "       ],\n" +
              '+      "scm/historyItem/context": [],\n' +
              '       "scm/title": [\n' +
              "*** End Patch",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "call-patch-1",
            success: true,
            changes: {
              "c:\\dev\\ctrlyoke\\package.json": {
                type: "update",
                unified_diff:
                  "@@ -482,2 +482,3 @@\n" +
                  "       ],\n" +
                  '+      "scm/historyItem/context": [],\n' +
                  '       "scm/title": [\n',
              },
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-patch-1",
            output: "Success. Updated the following files:\nM package.json",
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      const fileEditEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.FILE_EDIT
      );
      assert.ok(fileEditEvents.length > 0, "expected FILE_EDIT events");
      // Every emitted FILE_EDIT hunk (INITIATED and COMPLETED) must carry the
      // corrected offset (482), not the line-number-less default (1).
      for (const editEvent of fileEditEvents) {
        const hunks = (editEvent.data as any).structuredPatch as
          | Array<{ oldStart: number; newStart: number }>
          | undefined;
        assert.ok(hunks && hunks.length > 0, "expected structuredPatch hunks");
        assert.strictEqual(hunks[0].oldStart, 482);
        assert.strictEqual(hunks[0].newStart, 482);
      }
    });

    test("should unwrap exec shell_command into BASH_COMMAND (gpt-5.x format)", () => {
      // Newer Codex models wrap every action in a single `exec` custom tool whose
      // input is a JS snippet driving sandbox helpers. The output is an array of
      // {type, text} parts (not a string) carrying an `Exit code:` / `Output:` body.
      const events = [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_exec_shell",
            input:
              'const r = await tools.shell_command({"command":"npm test",' +
              '"workdir":"C:\\\\dev\\\\ctrlyoke","timeout_ms":10000}); text(r)\n',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_exec_shell",
            output: [
              {
                type: "input_text",
                text: "Script completed\nWall time 1s\nOutput:\n",
              },
              {
                type: "input_text",
                text: "Exit code: 0\nWall time: 1s\nOutput:\nall tests passed\n",
              },
            ],
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      // No event should remain an opaque generic tool call named "exec".
      const execToolCalls = response.events.filter(
        (e) =>
          e.type === CLI_EVENT_TYPES.TOOL_CALL &&
          (e.data as { name?: string }).name === "exec"
      );
      assert.strictEqual(
        execToolCalls.length,
        0,
        "exec must be unwrapped, not rendered as a generic tool call"
      );

      const bashEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.BASH_COMMAND
      );
      assert.ok(
        bashEvents.length >= 2,
        "expected INITIATED + COMPLETED bash events"
      );
      assert.strictEqual(
        (bashEvents[0].data as { command?: string }).command,
        "npm test"
      );
      const completed = bashEvents.find(
        (e) => (e.data as { output?: string }).output
      );
      assert.ok(completed, "expected a completed bash event with output");
      const data = completed!.data as { output: string; exitCode?: number };
      assert.strictEqual(data.exitCode, 0);
      // Output should be stripped of the Codex shell wrapper preamble.
      assert.strictEqual(data.output, "all tests passed\n");
    });

    test("should unwrap exec apply_patch into FILE_EDIT (gpt-5.x format)", () => {
      // exec apply_patch: the patch is a JS string literal (escaped \n / \\) and the
      // patch_apply_end event uses a separate `exec-<uuid>` call_id that does NOT
      // match the tool call_id — correlation must fall back to file-path matching.
      const events = [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_exec_patch",
            input:
              'const patch = "*** Begin Patch\\n' +
              "*** Update File: src/foo.ts\\n" +
              "@@\\n" +
              " context\\n" +
              "-old line\\n" +
              '+new line\\n*** End Patch";\n' +
              "text(await tools.apply_patch(patch));",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "exec-70bd704a-1978-4cab-a8f4-aab7736f4b58",
            success: true,
            changes: {
              "src/foo.ts": {
                type: "update",
                unified_diff:
                  "@@ -120,3 +120,3 @@\n context\n-old line\n+new line\n",
              },
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_exec_patch",
            output: [
              {
                type: "input_text",
                text: "Success. Updated the following files:\nM src/foo.ts\n",
              },
            ],
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      const execToolCalls = response.events.filter(
        (e) =>
          e.type === CLI_EVENT_TYPES.TOOL_CALL &&
          (e.data as { name?: string }).name === "exec"
      );
      assert.strictEqual(execToolCalls.length, 0, "exec must be unwrapped");

      const fileEditEvents = response.events.filter(
        (e) => e.type === CLI_EVENT_TYPES.FILE_EDIT
      );
      assert.ok(fileEditEvents.length > 0, "expected FILE_EDIT events");
      assert.strictEqual(
        (fileEditEvents[0].data as { path?: string }).path,
        "src/foo.ts"
      );
      // patch_apply_end offsets (120) must be applied despite the mismatched
      // exec-<uuid> call_id, via path-based correlation.
      for (const editEvent of fileEditEvents) {
        const hunks = (editEvent.data as any).structuredPatch as
          | Array<{ oldStart: number; newStart: number }>
          | undefined;
        assert.ok(hunks && hunks.length > 0, "expected structuredPatch hunks");
        assert.strictEqual(hunks[0].oldStart, 120);
        assert.strictEqual(hunks[0].newStart, 120);
      }
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

    test("should not duplicate text when event_msg agent_message precedes response_item output_text", () => {
      const events = [
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Duplicate candidate",
          },
          timestamp: "2026-01-17T10:00:01Z",
        },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "output_text", text: "Duplicate candidate" }],
          },
          timestamp: "2026-01-17T10:00:02Z",
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );
      const textEvents = response.events.filter(
        (event) => event.type === CLI_EVENT_TYPES.TEXT
      );

      assert.strictEqual(extractText(response), "Duplicate candidate");
      assert.strictEqual(textEvents.length, 1);
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

    test("should use last token total for context window usage", () => {
      const events = [
        {
          timestamp: "2026-04-14T15:53:22.453Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 5191984,
                cached_input_tokens: 5032192,
                output_tokens: 14864,
                reasoning_output_tokens: 6001,
                total_tokens: 5206848,
              },
              last_token_usage: {
                input_tokens: 154273,
                cached_input_tokens: 153984,
                output_tokens: 770,
                reasoning_output_tokens: 309,
                total_tokens: 155043,
              },
              model_context_window: 258400,
            },
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      assert.strictEqual(
        response.metadata.usage?.contextWindowUsedTokens,
        155043
      );
      assert.strictEqual(response.metadata.usage?.contextWindowSize, 258400);
      assert.strictEqual(response.metadata.usage?.inputTokens, 5191984);
      assert.strictEqual(response.metadata.usage?.outputTokens, 14864);
      assert.strictEqual(response.metadata.usage?.cachedInputTokens, 5032192);
      assert.strictEqual(response.metadata.usage?.reasoningOutputTokens, 6001);
    });
    test("should fall back to the Codex 5.6 context window when token_count omits it", () => {
      const events = [
        {
          type: "session_meta",
          payload: {
            id: "thread_5_6",
            model: "gpt-5.6-terra",
            cli_version: "1.0.0",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 4000,
                cached_input_tokens: 3000,
                output_tokens: 200,
                reasoning_output_tokens: 50,
              },
              last_token_usage: {
                total_tokens: 3200,
              },
            },
          },
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );

      assert.strictEqual(response.metadata.usage?.contextWindowSize, 1_050_000);
    });

    test("should emit one file edit per file for multi-file apply_patch calls", () => {
      const patchInput = [
        "*** Begin Patch",
        "*** Update File: src/one.ts",
        "@@",
        "-old one",
        "+new one",
        "*** Update File: src/two.ts",
        "@@",
        "-old two",
        "+new two",
        "*** End Patch",
      ].join("\n");

      const events = [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-multi-edit",
            input: patchInput,
          },
          timestamp: "2026-04-29T23:28:40.994Z",
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-multi-edit",
            output: JSON.stringify({
              output: "Success",
              metadata: { exit_code: 0, duration_seconds: 0.1 },
            }),
          },
          timestamp: "2026-04-29T23:28:41.787Z",
        },
      ];

      const response = parser.extractResponse(
        events as unknown as BaseCliEvent[]
      );
      const fileEditEvents = response.events.filter(
        (event) => event.type === CLI_EVENT_TYPES.FILE_EDIT
      );
      const completedFileEditEvents = fileEditEvents.filter(
        (event) => (event.data as any).status === "completed"
      );

      assert.strictEqual(fileEditEvents.length, 4);
      assert.deepStrictEqual(
        completedFileEditEvents.map((event) => (event.data as any).path),
        ["src/one.ts", "src/two.ts"]
      );
      assert.deepStrictEqual(
        completedFileEditEvents.map((event) => (event.data as any).status),
        ["completed", "completed"]
      );
      assert.ok(
        (completedFileEditEvents[0].data as any).structuredPatch?.length
      );
      assert.ok(
        (completedFileEditEvents[1].data as any).structuredPatch?.length
      );
    });
  });

  suite("extractStructuredEventsFromEvent", () => {
    test("should ignore event_msg agent_message when the same text arrives in response_item", () => {
      const eventMsgEvents = parser.extractStructuredEventsFromEvent({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Duplicate candidate",
        },
        timestamp: "2026-01-17T10:00:01Z",
      } as unknown as BaseCliEvent);
      const responseItemEvents = parser.extractStructuredEventsFromEvent({
        type: "response_item",
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: "Duplicate candidate" }],
        },
        timestamp: "2026-01-17T10:00:02Z",
      } as unknown as BaseCliEvent);

      const textEvents = responseItemEvents.filter(
        (event) => event.type === CLI_EVENT_TYPES.TEXT
      );

      assert.deepStrictEqual(eventMsgEvents, []);
      assert.strictEqual(textEvents.length, 1);
      assert.strictEqual(
        (textEvents[0].data as TextData).text,
        "Duplicate candidate"
      );
    });

    test("should stream one file edit per file for multi-file apply_patch calls", () => {
      const patchInput = [
        "*** Begin Patch",
        "*** Update File: src/one.ts",
        "@@",
        "-old one",
        "+new one",
        "*** Update File: src/two.ts",
        "@@",
        "-old two",
        "+new two",
        "*** End Patch",
      ].join("\n");

      const initiatedEvents = parser.extractStructuredEventsFromEvent({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-stream-multi-edit",
          input: patchInput,
        },
        timestamp: "2026-04-29T23:28:40.994Z",
      } as unknown as BaseCliEvent);
      const completedEvents = parser.extractStructuredEventsFromEvent({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-stream-multi-edit",
          output: JSON.stringify({
            output: "Success",
            metadata: { exit_code: 0, duration_seconds: 0.1 },
          }),
        },
        timestamp: "2026-04-29T23:28:41.787Z",
      } as unknown as BaseCliEvent);

      assert.strictEqual(initiatedEvents.length, 2);
      assert.deepStrictEqual(
        initiatedEvents.map((event) => (event.data as any).path),
        ["src/one.ts", "src/two.ts"]
      );
      assert.deepStrictEqual(
        completedEvents.map((event) => (event.data as any).path),
        ["src/one.ts", "src/two.ts"]
      );
      assert.deepStrictEqual(
        completedEvents.map((event) => (event.data as any).status),
        ["completed", "completed"]
      );
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

  suite("extractLiveContextWindow", () => {
    test("should fall back to the resolved Codex 5.6 context window", () => {
      const event = {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 98765,
            },
          },
        },
      } as unknown as BaseCliEvent;

      const result = parser.extractLiveContextWindow(event, "gpt-5.6-luna");

      assert.deepStrictEqual(result, { used: 98765, size: 1_050_000 });
    });
  });

  test("should derive Codex log token context window size from a 5.6 session model", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ctrlyoke-codex-log-")
    );
    const logPath = path.join(tempDir, "rollout-test.jsonl");

    try {
      const lines = [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_5_6",
            model: "gpt-5.6-sol",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 80,
                reasoning_output_tokens: 10,
              },
              last_token_usage: {
                total_tokens: 900,
              },
            },
          },
        }),
      ].join("\n");

      fs.writeFileSync(logPath, lines, "utf8");

      const usage = CodexLogParser.extractTokenUsageFromLogFile(logPath);

      assert.strictEqual(usage?.contextWindowSize, 1_050_000);
      assert.strictEqual(usage?.contextWindowUsedTokens, 900);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
// OpenCodeLogParser Tests
// ============================================================================

suite("OpenCodeLogParser", () => {
  let parser: OpenCodeLogParser;

  setup(() => {
    parser = new OpenCodeLogParser();
  });

  suite("getFinalEventsOnCompletion", () => {
    test("should return no additional events by default for file-backed parsers", async () => {
      const copilotParser = new CopilotLogParser();
      const finalEvents =
        await copilotParser.getFinalEventsOnCompletion("ignored-log-path");

      assert.deepStrictEqual(finalEvents, []);
    });

    test("should call fetchNewEvents with the session ID for OpenCode", async () => {
      // Cast via any to access private members for testing purposes.
      const parserWithInternals = parser as any as {
        seenPartIds: Set<string>;
        fetchNewEvents: (sessionId: string) => Promise<BaseCliEvent[]>;
      };

      parserWithInternals.seenPartIds.add("part-1");

      let fetchCalledWith: string | undefined;
      parserWithInternals.fetchNewEvents = async (sessionId: string) => {
        fetchCalledWith = sessionId;
        return [
          {
            type: "text",
            sessionID: sessionId,
            timestamp: Date.now(),
            part: { text: "final response" },
          },
        ];
      };

      const finalEvents =
        await parser.getFinalEventsOnCompletion("ses_test_final");

      assert.strictEqual(fetchCalledWith, "ses_test_final");
      assert.strictEqual(finalEvents.length, 1);
      assert.strictEqual(finalEvents[0].type, "text");
    });
  });

  suite("export command execution", () => {
    test("uses the injected OpenCode export runner instead of a shell command", async () => {
      let requestedSessionId: string | undefined;
      const parserWithExportRunner = new OpenCodeLogParser(
        () => undefined,
        async (sessionId) => {
          requestedSessionId = sessionId;
          return JSON.stringify({
            info: { id: sessionId },
            messages: [],
          });
        }
      );

      const events =
        await parserWithExportRunner.readNewLines("ses_export_test");

      assert.strictEqual(requestedSessionId, "ses_export_test");
      assert.deepStrictEqual(events, []);
    });
  });

  suite("extractNewEventsFromExport — part completion gating", () => {
    function makeExport(parts: object[]): object {
      return {
        info: { id: "ses_test" },
        messages: [
          {
            info: { role: "assistant", time: { created: 1000 } },
            parts,
          },
        ],
      };
    }

    function callExtractNewEvents(
      p: OpenCodeLogParser,
      exportData: object
    ): BaseCliEvent[] {
      return (p as any).extractNewEventsFromExport(exportData);
    }

    test("should skip tool parts with pending status and not add to seenPartIds", () => {
      const exportData = makeExport([
        {
          type: "tool",
          id: "prt_pending_tool",
          sessionID: "ses_test",
          messageID: "msg_1",
          tool: "read",
          callID: "call_1",
          state: { status: "pending", input: {}, output: "" },
        },
      ]);

      const events = callExtractNewEvents(parser, exportData);

      assert.strictEqual(
        events.length,
        0,
        "pending tool should not emit an event"
      );
      assert.ok(
        !(parser as any).seenPartIds.has("prt_pending_tool"),
        "pending tool ID should NOT be in seenPartIds"
      );
    });

    test("should emit tool parts with completed status and add to seenPartIds", () => {
      const exportData = makeExport([
        {
          type: "tool",
          id: "prt_completed_tool",
          sessionID: "ses_test",
          messageID: "msg_1",
          tool: "read",
          callID: "call_1",
          state: {
            status: "completed",
            input: { filePath: "/some/file.ts" },
            output: "file contents",
            time: { start: 1001, end: 1005 },
          },
        },
      ]);

      const events = callExtractNewEvents(parser, exportData);

      assert.strictEqual(
        events.length,
        1,
        "completed tool should emit an event"
      );
      assert.strictEqual(events[0].type, "tool_use");
      assert.ok(
        (parser as any).seenPartIds.has("prt_completed_tool"),
        "completed tool ID should be in seenPartIds"
      );
    });

    test("should pick up a tool part on the next poll once it transitions to completed", () => {
      const pendingExport = makeExport([
        {
          type: "tool",
          id: "prt_transitioning",
          sessionID: "ses_test",
          messageID: "msg_1",
          tool: "write",
          callID: "call_2",
          state: { status: "pending", input: {}, output: "" },
        },
      ]);
      const completedExport = makeExport([
        {
          type: "tool",
          id: "prt_transitioning",
          sessionID: "ses_test",
          messageID: "msg_1",
          tool: "write",
          callID: "call_2",
          state: {
            status: "completed",
            input: { filePath: "/some/output.ts" },
            output: "",
            time: { start: 2000, end: 2010 },
          },
        },
      ]);

      const firstPoll = callExtractNewEvents(parser, pendingExport);
      assert.strictEqual(firstPoll.length, 0, "pending: no event emitted");

      const secondPoll = callExtractNewEvents(parser, completedExport);
      assert.strictEqual(
        secondPoll.length,
        1,
        "completed: event emitted on next poll"
      );
      assert.strictEqual(secondPoll[0].type, "tool_use");
    });

    test("should skip text parts without time.end and emit once time.end is present", () => {
      const inProgressExport = makeExport([
        {
          type: "text",
          id: "prt_text_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          text: "partial...",
          time: { start: 3000 },
        },
      ]);
      const finalExport = makeExport([
        {
          type: "text",
          id: "prt_text_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          text: "Full response text.",
          time: { start: 3000, end: 3100 },
        },
      ]);

      const firstPoll = callExtractNewEvents(parser, inProgressExport);
      assert.strictEqual(
        firstPoll.length,
        0,
        "in-progress text: no event emitted"
      );

      const secondPoll = callExtractNewEvents(parser, finalExport);
      assert.strictEqual(secondPoll.length, 1, "finalized text: event emitted");
      assert.strictEqual(secondPoll[0].type, "text");
      assert.strictEqual(
        (secondPoll[0] as any).part?.text,
        "Full response text."
      );
    });

    test("should skip reasoning parts without time.end and emit once time.end is present", () => {
      const inProgressExport = makeExport([
        {
          type: "reasoning",
          id: "prt_reasoning_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          text: "thinking...",
          time: { start: 4000 },
        },
      ]);
      const finalExport = makeExport([
        {
          type: "reasoning",
          id: "prt_reasoning_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          text: "I should read the file first.",
          time: { start: 4000, end: 4500 },
        },
      ]);

      const firstPoll = callExtractNewEvents(parser, inProgressExport);
      assert.strictEqual(
        firstPoll.length,
        0,
        "in-progress reasoning: no event emitted"
      );

      const secondPoll = callExtractNewEvents(parser, finalExport);
      assert.strictEqual(
        secondPoll.length,
        1,
        "finalized reasoning: event emitted"
      );
      assert.strictEqual(secondPoll[0].type, "thinking");
      assert.strictEqual(
        (secondPoll[0] as any).part?.text,
        "I should read the file first."
      );
    });
  });

  suite("extractResponse — thinking events", () => {
    test("should include thinking events from reasoning parts in cliEvents", () => {
      const events: BaseCliEvent[] = [
        {
          type: "thinking",
          sessionID: "ses_test",
          timestamp: 1000,
          part: { text: "I need to analyze the file." },
        } as any,
        {
          type: "text",
          sessionID: "ses_test",
          timestamp: 2000,
          part: { text: "Here is the analysis." },
        } as any,
      ];

      const result = parser.extractResponse(events);
      const thinkingEvents = result.events.filter((e) => e.type === "thinking");
      const textEvents = result.events.filter((e) => e.type === "text");

      assert.strictEqual(thinkingEvents.length, 1);
      assert.strictEqual(
        (thinkingEvents[0].data as any).text,
        "I need to analyze the file."
      );
      assert.strictEqual(textEvents.length, 1);
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
    ] as BaseCliEvent[];

    // Should not throw
    assert.doesNotThrow(() => claudeParser.extractResponse(malformedEvents));
    assert.doesNotThrow(() => copilotParser.extractResponse(malformedEvents));
    assert.doesNotThrow(() => codexParser.extractResponse(malformedEvents));
  });
});
