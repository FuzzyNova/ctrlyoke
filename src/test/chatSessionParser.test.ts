import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ChatSessionParser } from "../flightpath/chat/ChatSessionParser";
import { CLI_EVENT_TYPES } from "../types/CliOutputTypes";

suite("ChatSessionParser Tests", () => {
  let parser: ChatSessionParser;
  let tempDir: string;

  setup(() => {
    parser = new ChatSessionParser();
    // Create temp directory for test session files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flightpath-test-"));
  });

  teardown(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to create a mock session file
   */
  function createMockSessionFile(sessionId: string, requests: any[]): string {
    const sessionFile = {
      version: 3,
      sessionId,
      requests,
      creationDate: Date.now(),
      lastMessageDate: Date.now(),
    };

    const filePath = path.join(tempDir, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sessionFile, null, 2));
    return filePath;
  }

  suite("extractResponse - Basic Functionality", () => {
    test("should extract simple text response", () => {
      const sessionFile = createMockSessionFile("test-simple", [
        {
          requestId: "req-1",
          message: { text: "Hello" },
          response: [
            {
              value: "Hi there!",
              supportThemeIcons: false,
              supportHtml: false,
            },
          ],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 1000 },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 1);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.deepStrictEqual(output.events[0].data, { text: "Hi there!" });
      assert.strictEqual(output.metadata.model, "claude-sonnet-4.5");
      assert.strictEqual(output.metadata.harness, "copilot-chat");
    });

    test("should extract thinking blocks", () => {
      const sessionFile = createMockSessionFile("test-thinking", [
        {
          requestId: "req-1",
          message: { text: "Explain this" },
          response: [
            {
              kind: "thinking",
              value: "Let me analyze this code...",
              id: "think-1",
            },
            {
              value: "Here's the explanation.",
            },
          ],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 2000 },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 2);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.THINKING);
      assert.deepStrictEqual(output.events[0].data, {
        text: "Let me analyze this code...",
      });
      assert.strictEqual(output.events[1].type, CLI_EVENT_TYPES.TEXT);
    });

    test("should skip encrypted thinking blocks", () => {
      const encryptedThinking =
        "fApshhj0S4BvSMtflmU7qThS0cjdOA10dM6hFTwRxU66i6zcU3fR5uAUGbz5qMci28nkPEl42sCSZ0kGMXM29o2AKjwhgHvQjM11VRIqGoOffHbmaryw68VKvBw/od1HlKpmGI";

      const sessionFile = createMockSessionFile("test-encrypted", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [
            {
              kind: "thinking",
              value: encryptedThinking,
              id: "think-1",
            },
            {
              value: "Response text",
            },
          ],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 1000 },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      // Should only have text event, thinking should be filtered out
      assert.strictEqual(output.events.length, 1);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.TEXT);
    });

    test("should extract tool calls", () => {
      const sessionFile = createMockSessionFile("test-tool-calls", [
        {
          requestId: "req-1",
          message: { text: "Get changed files" },
          response: [
            {
              kind: "toolInvocationSerialized",
              toolId: "copilot_getChangedFiles",
              toolCallId: "tool-1",
              invocationMessage: {
                value: "Reading changed files",
              },
              isComplete: true,
            },
          ],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 1500 },
            metadata: {
              toolCallRounds: [
                {
                  response: "Getting files...",
                  toolCalls: [
                    {
                      name: "get_changed_files",
                      arguments: '{"sourceControlState": ["unstaged"]}',
                      id: "tool-1",
                    },
                  ],
                },
              ],
            },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 1);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.TOOL_CALL);
      assert.ok(output.events[0].data);
      assert.strictEqual(
        (output.events[0].data as any).name,
        "copilot_getChangedFiles"
      );
      assert.deepStrictEqual((output.events[0].data as any).parameters, {
        sourceControlState: ["unstaged"],
      });
    });
  });

  suite("extractResponse - Error Handling", () => {
    test("should handle cancelled requests", () => {
      const sessionFile = createMockSessionFile("test-cancelled", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [{ value: "Starting..." }],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 500 },
            errorDetails: {
              code: "canceled",
              message: "Canceled",
            },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      // Error message added as text event
      assert.ok(output.events.length > 0);
      const errorEvent = output.events.find(
        (e) =>
          e.type === CLI_EVENT_TYPES.TEXT &&
          (e.data as any).text.includes("Error")
      );
      assert.ok(errorEvent, "Should have error event");
    });

    test("should handle malformed JSON", () => {
      const filePath = path.join(tempDir, "malformed.json");
      fs.writeFileSync(filePath, "{ invalid json }");

      const output = parser.extractResponse(filePath);

      assert.strictEqual(output.events.length, 1);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.ok(
        (output.events[0].data as any).text.includes("Failed to parse")
      );
    });

    test("should handle empty requests array", () => {
      const sessionFile = createMockSessionFile("test-empty", []);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 0);
      assert.strictEqual(output.metadata.harness, "copilot-chat");
    });

    test("should handle non-existent file", () => {
      const output = parser.extractResponse(
        path.join(tempDir, "nonexistent.json")
      );

      assert.strictEqual(output.events.length, 1);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.ok(
        (output.events[0].data as any).text.includes("Failed to parse")
      );
    });
  });

  suite("extractResponse - Request Index", () => {
    test("should extract last request by default", () => {
      const sessionFile = createMockSessionFile("test-multi-requests", [
        {
          requestId: "req-1",
          message: { text: "First" },
          response: [{ value: "First response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1000 } },
        },
        {
          requestId: "req-2",
          message: { text: "Second" },
          response: [{ value: "Second response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1500 } },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 1);
      assert.deepStrictEqual(output.events[0].data, {
        text: "Second response",
      });
    });

    test("should extract specific request by index", () => {
      const sessionFile = createMockSessionFile("test-indexed", [
        {
          requestId: "req-1",
          message: { text: "First" },
          response: [{ value: "First response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1000 } },
        },
        {
          requestId: "req-2",
          message: { text: "Second" },
          response: [{ value: "Second response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1500 } },
        },
      ]);

      const output = parser.extractResponse(sessionFile, 0);

      assert.strictEqual(output.events.length, 1);
      assert.deepStrictEqual(output.events[0].data, { text: "First response" });
    });
  });

  suite("extractSessionId", () => {
    test("should extract session ID from path", () => {
      const sessionId = parser.extractSessionId("/path/to/abc-123-def.json");
      assert.strictEqual(sessionId, "abc-123-def");
    });

    test("should handle Windows paths", () => {
      const sessionId = parser.extractSessionId(
        "C:\\Users\\test\\abc-123-def.json"
      );
      assert.strictEqual(sessionId, "abc-123-def");
    });
  });

  suite("isValidSessionFile", () => {
    test("should return true for valid file", () => {
      const sessionFile = createMockSessionFile("test-valid", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [{ value: "Response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1000 } },
        },
      ]);

      assert.strictEqual(parser.isValidSessionFile(sessionFile), true);
    });

    test("should return false for non-existent file", () => {
      assert.strictEqual(
        parser.isValidSessionFile("/nonexistent/file.json"),
        false
      );
    });
  });

  suite("isSessionComplete", () => {
    test("should return true for completed session", () => {
      const sessionFile = createMockSessionFile("test-complete", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [{ value: "Response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1000 } },
        },
      ]);

      assert.strictEqual(parser.isSessionComplete(sessionFile), true);
    });

    test("should return false for incomplete session", () => {
      const sessionFile = createMockSessionFile("test-incomplete", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [{ value: "Response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 0 } }, // Not complete
        },
      ]);

      assert.strictEqual(parser.isSessionComplete(sessionFile), false);
    });

    test("should handle malformed files", () => {
      const filePath = path.join(tempDir, "malformed-complete.json");
      fs.writeFileSync(filePath, "invalid json");

      assert.strictEqual(parser.isSessionComplete(filePath), false);
    });
  });

  suite("getRequestCount", () => {
    test("should return correct request count", () => {
      const sessionFile = createMockSessionFile("test-count", [
        {
          requestId: "req-1",
          message: { text: "First" },
          response: [{ value: "First response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1000 } },
        },
        {
          requestId: "req-2",
          message: { text: "Second" },
          response: [{ value: "Second response" }],
          modelId: "copilot/claude-sonnet-4.5",
          result: { timings: { totalElapsed: 1500 } },
        },
      ]);

      assert.strictEqual(parser.getRequestCount(sessionFile), 2);
    });

    test("should return 0 for non-existent file", () => {
      assert.strictEqual(parser.getRequestCount("/nonexistent/file.json"), 0);
    });
  });

  suite("Complex Response Scenarios", () => {
    test("should handle response with multiple event types", () => {
      const sessionFile = createMockSessionFile("test-complex", [
        {
          requestId: "req-1",
          message: { text: "Complex task" },
          response: [
            { kind: "mcpServersStarting", didStartServerIds: [] },
            {
              kind: "thinking",
              value: "Planning the approach...",
              id: "think-1",
            },
            { value: "Let me start by analyzing." },
            {
              kind: "toolInvocationSerialized",
              toolId: "readFile",
              toolCallId: "tool-1",
              invocationMessage: { value: "Reading file" },
            },
            { value: "Based on the file, here's my conclusion." },
          ],
          modelId: "copilot/claude-sonnet-4.5",
          result: {
            timings: { totalElapsed: 3000, firstProgress: 500 },
            metadata: {
              toolCallRounds: [
                {
                  response: "Analyzing...",
                  toolCalls: [
                    {
                      name: "readFile",
                      arguments: '{"path": "test.ts"}',
                      id: "tool-1",
                    },
                  ],
                },
              ],
            },
          },
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      // Should have: thinking, text, tool_call, text (4 events)
      assert.strictEqual(output.events.length, 4);
      assert.strictEqual(output.events[0].type, CLI_EVENT_TYPES.THINKING);
      assert.strictEqual(output.events[1].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual(output.events[2].type, CLI_EVENT_TYPES.TOOL_CALL);
      assert.strictEqual(output.events[3].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual(output.metadata.elapsed, 3000);
    });

    test("should normalize model IDs", () => {
      const sessionFile = createMockSessionFile("test-model", [
        {
          requestId: "req-1",
          message: { text: "Test" },
          response: [{ value: "Response" }],
          modelId: "copilot/gpt-5",
          result: { timings: { totalElapsed: 1000 } },
        },
      ]);

      const output = parser.extractResponse(sessionFile);
      assert.strictEqual(output.metadata.model, "gpt-5");
    });
  });
});
