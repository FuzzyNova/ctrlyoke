import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  ChatSessionParser,
  RESPONSE_MODEL_STATE,
} from "../core/harness/chat/ChatSessionParser";
import { CLI_EVENT_TYPES } from "../types/DashboardConstants";

suite("ChatSessionParser Tests", () => {
  let parser: ChatSessionParser;
  let tempDir: string;

  setup(() => {
    parser = new ChatSessionParser();
    // Create temp directory for test session files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-test-"));
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

      assert.strictEqual(
        ChatSessionParser.isSessionComplete(sessionFile),
        true
      );
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

      assert.strictEqual(
        ChatSessionParser.isSessionComplete(sessionFile),
        false
      );
    });

    test("should handle malformed files", () => {
      const filePath = path.join(tempDir, "malformed-complete.json");
      fs.writeFileSync(filePath, "invalid json");

      assert.strictEqual(ChatSessionParser.isSessionComplete(filePath), false);
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

      assert.strictEqual(ChatSessionParser.getRequestCount(sessionFile), 2);
    });

    test("should return 0 for non-existent file", () => {
      assert.strictEqual(
        ChatSessionParser.getRequestCount("/nonexistent/file.json"),
        0
      );
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

  suite("JSONL replay", () => {
    /** Writes raw patch-log lines (each already an object) as a .jsonl session file. */
    function createMockJsonlFile(sessionId: string, patches: any[]): string {
      const filePath = path.join(tempDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        filePath,
        patches.map((p) => JSON.stringify(p)).join("\n") + "\n"
      );
      return filePath;
    }

    test("should replay a well-formed log starting with a kind:0 Initial entry", () => {
      const sessionFile = createMockJsonlFile("test-jsonl-basic", [
        { kind: 0, v: { version: 3, sessionId: "test-jsonl-basic", requests: [] } },
        {
          kind: 2,
          k: ["requests"],
          v: [
            {
              requestId: "req-1",
              message: { text: "Hello" },
              response: [{ value: "Hi there!" }],
              modelId: "copilot/claude-sonnet-4.5",
              result: { timings: { totalElapsed: 1000 } },
            },
          ],
        },
      ]);

      const output = parser.extractResponse(sessionFile);

      assert.strictEqual(output.events.length, 1);
      assert.deepStrictEqual(output.events[0].data, { text: "Hi there!" });
    });

    test("should replay a log missing its Initial entry (session trimmed out from under a live ChatModel)", () => {
      // Real-world case: VS Code's session trimming deletes the backing file
      // while an in-memory ChatModel still holds a diff baseline, so the next
      // write recreates the file starting directly with Set/Push entries and
      // no kind:0 line. This must still parse instead of returning null.
      const sessionFile = createMockJsonlFile("test-jsonl-no-initial", [
        { kind: 1, k: ["customTitle"], v: "Follow instructions in prompt file" },
        {
          kind: 2,
          k: ["requests"],
          v: [
            {
              requestId: "req-1",
              message: {
                text: "Follow instructions in background-test-1.prompt.md",
              },
              response: [{ value: "Done." }],
              modelId: "copilot/claude-sonnet-4.5",
              modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
              result: { timings: { totalElapsed: 500 } },
            },
          ],
        },
      ]);

      const session = ChatSessionParser.parseSessionFile(sessionFile);
      assert.ok(session, "session should parse even without an Initial entry");
      assert.strictEqual(session!.requests.length, 1);
      assert.strictEqual(
        session!.requests[0].message.text,
        "Follow instructions in background-test-1.prompt.md"
      );

      const output = parser.extractResponse(sessionFile);
      assert.strictEqual(output.events.length, 1);
      assert.deepStrictEqual(output.events[0].data, { text: "Done." });

      assert.strictEqual(ChatSessionParser.isSessionComplete(sessionFile), true);
    });

    test("should apply a delete (kind:3) patch", () => {
      const sessionFile = createMockJsonlFile("test-jsonl-delete", [
        {
          kind: 0,
          v: {
            version: 3,
            sessionId: "test-jsonl-delete",
            requests: [
              {
                requestId: "req-1",
                message: { text: "Test" },
                response: [{ value: "Response" }],
                modelId: "copilot/claude-sonnet-4.5",
                followups: [{ message: "stale followup" }],
                result: { timings: { totalElapsed: 1000 } },
              },
            ],
          },
        },
        { kind: 3, k: ["requests", 0, "followups"] },
      ]);

      const session = ChatSessionParser.parseSessionFile(sessionFile);
      assert.ok(session);
      assert.strictEqual((session!.requests[0] as any).followups, undefined);
    });

    test("isSessionComplete should use modelState when present, without requiring totalElapsed", () => {
      const cancelled = createMockJsonlFile("test-jsonl-cancelled", [
        {
          kind: 0,
          v: {
            version: 3,
            sessionId: "test-jsonl-cancelled",
            requests: [
              {
                requestId: "req-1",
                message: { text: "Test" },
                response: [{ value: "Partial..." }],
                modelId: "copilot/claude-sonnet-4.5",
                modelState: { value: RESPONSE_MODEL_STATE.CANCELLED },
                result: { timings: { totalElapsed: 0 } },
              },
            ],
          },
        },
      ]);

      assert.strictEqual(ChatSessionParser.isSessionComplete(cancelled), true);

      const pending = createMockJsonlFile("test-jsonl-pending", [
        {
          kind: 0,
          v: {
            version: 3,
            sessionId: "test-jsonl-pending",
            requests: [
              {
                requestId: "req-1",
                message: { text: "Test" },
                response: [],
                modelId: "copilot/claude-sonnet-4.5",
                modelState: { value: RESPONSE_MODEL_STATE.PENDING },
                result: { timings: { totalElapsed: 0 } },
              },
            ],
          },
        },
      ]);

      assert.strictEqual(ChatSessionParser.isSessionComplete(pending), false);
    });
  });

  suite("hasPendingBackgroundWork", () => {
    function makeRequest(toolCallRounds: any[]): any {
      return {
        requestId: "req-1",
        message: { text: "Test" },
        response: [],
        modelId: "copilot/claude-sonnet-4.5",
        modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
        result: {
          timings: { totalElapsed: 1000 },
          metadata: { toolCallRounds },
        },
      };
    }

    test("should return true when the last tool-call round launched an async task", () => {
      const request = makeRequest([
        {
          response: "",
          toolCalls: [
            {
              name: "run_in_terminal",
              arguments: JSON.stringify({
                command: "Start-Sleep -Seconds 60",
                mode: "async",
              }),
              id: "call-1",
            },
          ],
        },
      ]);

      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(request),
        true
      );
    });

    test("should return false when the last tool-call round has no async launch", () => {
      const request = makeRequest([
        {
          response: "",
          toolCalls: [
            {
              name: "run_in_terminal",
              arguments: JSON.stringify({
                command: "echo hi",
                mode: "sync",
              }),
              id: "call-1",
            },
          ],
        },
      ]);

      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(request),
        false
      );
    });

    test("should return false when there are no tool-call rounds", () => {
      const request = makeRequest([]);
      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(request),
        false
      );
    });

    test("should return false when only an earlier round launched async work (already superseded)", () => {
      const request = makeRequest([
        {
          response: "",
          toolCalls: [
            {
              name: "run_in_terminal",
              arguments: JSON.stringify({ command: "sleep 60", mode: "async" }),
              id: "call-1",
            },
          ],
        },
        {
          response: "",
          toolCalls: [
            {
              name: "read_file",
              arguments: JSON.stringify({ filePath: "a.ts" }),
              id: "call-2",
            },
          ],
        },
      ]);

      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(request),
        false
      );
    });

    test("should ignore malformed tool call arguments instead of throwing", () => {
      const request = makeRequest([
        {
          response: "",
          toolCalls: [
            { name: "run_in_terminal", arguments: "{not json", id: "call-1" },
          ],
        },
      ]);

      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(request),
        false
      );
    });
  });

  suite("Copilot Chat background-task auto-resume (end to end)", () => {
    /**
     * Reproduces the real "background-test-1" session shape (verified against a
     * live VS Code session on disk): request[0] launches an async terminal task
     * and ends its turn before the task finishes; request[1] is VS Code's
     * auto-resumed `isSystemInitiated` follow-up once the task completes.
     */
    function createBackgroundResumeSession(
      sessionId: string,
      includeResumeRequest: boolean
    ): string {
      const requests: any[] = [
        {
          requestId: "req-0",
          message: {
            text: "Follow instructions in background-test-1.prompt.md",
          },
          response: [{ value: "Starting the background task..." }],
          modelId: "copilot/claude-sonnet-4.5",
          modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
          result: {
            timings: { totalElapsed: 45312, firstProgress: 22106 },
            metadata: {
              toolCallRounds: [
                {
                  response: "",
                  toolCalls: [
                    {
                      name: "run_in_terminal",
                      arguments: JSON.stringify({
                        command: "Start-Sleep -Seconds 60",
                        mode: "async",
                      }),
                      id: "call-1",
                    },
                  ],
                },
              ],
            },
          },
        },
      ];

      if (includeResumeRequest) {
        requests.push({
          requestId: "req-1",
          isSystemInitiated: true,
          systemInitiatedLabel: "`Start-Sleep -Seconds 60` completed",
          message: {
            text: "[Terminal notification: command completed.]",
          },
          response: [{ value: "Task completed." }],
          modelId: "copilot/claude-sonnet-4.5",
          modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
          result: { timings: { totalElapsed: 10400 } },
        });
      }

      return createMockSessionFile(sessionId, requests);
    }

    test("isSessionComplete alone is fooled by the turn-ending pause (documents why the monitor needs hasPendingBackgroundWork too)", () => {
      const sessionFile = createBackgroundResumeSession(
        "test-bg-only-launch",
        false
      );
      // The launch request itself is legitimately "complete" by timings/modelState —
      // this is exactly why ChatSessionMonitor layers hasPendingBackgroundWork on
      // top instead of trusting isSessionComplete alone.
      assert.strictEqual(ChatSessionParser.isSessionComplete(sessionFile), true);
    });

    test("hasPendingBackgroundWork flags the launch request before the resume arrives", () => {
      const sessionFile = createBackgroundResumeSession(
        "test-bg-pending",
        false
      );
      const session = ChatSessionParser.parseSessionFile(sessionFile)!;
      const lastRequest = session.requests[session.requests.length - 1];

      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(lastRequest),
        true
      );
    });

    test("hasPendingBackgroundWork clears once the isSystemInitiated resume request lands", () => {
      const sessionFile = createBackgroundResumeSession(
        "test-bg-resumed",
        true
      );
      const session = ChatSessionParser.parseSessionFile(sessionFile)!;

      assert.strictEqual(session.requests.length, 2);
      assert.strictEqual((session.requests[1] as any).isSystemInitiated, true);

      const lastRequest = session.requests[session.requests.length - 1];
      assert.strictEqual(ChatSessionParser.isSessionComplete(sessionFile), true);
      assert.strictEqual(
        ChatSessionParser.hasPendingBackgroundWork(lastRequest),
        false
      );
    });
  });

  suite("collectFollowUpActivity", () => {
    function completeRequest(text: string, extra: Record<string, any> = {}) {
      return {
        requestId: `req-${text}`,
        message: { text },
        response: [{ value: `Reply to: ${text}` }],
        modelId: "copilot/claude-sonnet-4.5",
        modelState: { value: RESPONSE_MODEL_STATE.COMPLETE },
        result: { timings: { totalElapsed: 1000 } },
        ...extra,
      };
    }

    function incompleteRequest(text: string) {
      return {
        requestId: `req-${text}`,
        message: { text },
        response: [],
        modelId: "copilot/claude-sonnet-4.5",
      };
    }

    function asyncLaunchExtra() {
      return {
        result: {
          timings: { totalElapsed: 1000 },
          metadata: {
            toolCallRounds: [
              {
                response: "",
                toolCalls: [
                  {
                    name: "run_in_terminal",
                    arguments: JSON.stringify({
                      command: "Start-Sleep -Seconds 60",
                      mode: "async",
                    }),
                    id: "call-1",
                  },
                ],
              },
            ],
          },
        },
      };
    }

    test("merges the launch request and its isSystemInitiated resume, no steer", () => {
      const sessionFile = createMockSessionFile("test-collect-resume", [
        completeRequest("Follow instructions in background-test.prompt.md", asyncLaunchExtra()),
        { ...completeRequest("[Terminal notification: completed.]"), isSystemInitiated: true },
      ]);

      const result = parser.collectFollowUpActivity(sessionFile, -1, 0);

      const texts = result.events.map((e) => (e.data as any).text);
      assert.deepStrictEqual(texts, [
        "Reply to: Follow instructions in background-test.prompt.md",
        "Reply to: [Terminal notification: completed.]",
      ]);
      assert.ok(
        !result.events.some((e) => e.type === CLI_EVENT_TYPES.USER_STEER)
      );
      assert.strictEqual(result.lastResponseIndex, 1);
      assert.strictEqual(result.steerSeenThroughIndex, 0);
    });

    test("emits a user-steer event for a genuine non-isSystemInitiated follow-up, then its response", () => {
      const sessionFile = createMockSessionFile("test-collect-steer", [
        completeRequest("Follow instructions in prompt.md"),
        completeRequest("please also check the login flow"),
      ]);

      const result = parser.collectFollowUpActivity(sessionFile, -1, 0);

      assert.strictEqual(result.events.length, 3);
      assert.strictEqual(
        (result.events[0].data as any).text,
        "Reply to: Follow instructions in prompt.md"
      );
      assert.strictEqual(result.events[1].type, CLI_EVENT_TYPES.USER_STEER);
      assert.strictEqual(
        (result.events[1].data as any).text,
        "please also check the login flow"
      );
      assert.strictEqual(
        (result.events[2].data as any).text,
        "Reply to: please also check the login flow"
      );
      assert.strictEqual(result.lastResponseIndex, 1);
      assert.strictEqual(result.steerSeenThroughIndex, 1);
    });

    test("surfaces a steer immediately even while its response is still in progress, without re-emitting it later", () => {
      const sessionFile = createMockSessionFile("test-collect-steer-pending", [
        completeRequest("Follow instructions in prompt.md"),
        incompleteRequest("one more thing before you finish"),
      ]);

      const first = parser.collectFollowUpActivity(sessionFile, -1, 0);
      assert.strictEqual(first.events.length, 2); // req0 response + steer, no req1 response yet
      assert.strictEqual(first.events[1].type, CLI_EVENT_TYPES.USER_STEER);
      assert.strictEqual(first.lastResponseIndex, 0);
      assert.strictEqual(first.steerSeenThroughIndex, 1);

      // Re-poll with the same cursors while still incomplete — no duplicate steer.
      const second = parser.collectFollowUpActivity(
        sessionFile,
        first.lastResponseIndex,
        first.steerSeenThroughIndex
      );
      assert.strictEqual(second.events.length, 0);
      assert.strictEqual(second.lastResponseIndex, 0);
      assert.strictEqual(second.steerSeenThroughIndex, 1);
    });

    test("extracts a request's own content even when it itself has pending background work, and keeps walking to a further resume", () => {
      const sessionFile = createMockSessionFile("test-collect-chained", [
        completeRequest("Follow instructions in prompt.md", asyncLaunchExtra()),
        {
          ...completeRequest("[Terminal notification: first task completed.]", asyncLaunchExtra()),
          isSystemInitiated: true,
        },
        {
          ...completeRequest("[Terminal notification: second task completed.]"),
          isSystemInitiated: true,
        },
      ]);

      const result = parser.collectFollowUpActivity(sessionFile, -1, 0);

      const texts = result.events.map((e) => (e.data as any).text);
      assert.deepStrictEqual(texts, [
        "Reply to: Follow instructions in prompt.md",
        "Reply to: [Terminal notification: first task completed.]",
        "Reply to: [Terminal notification: second task completed.]",
      ]);
      assert.strictEqual(result.lastResponseIndex, 2);
    });

    test("skips a whitespace-only follow-up message without emitting a steer event", () => {
      const sessionFile = createMockSessionFile("test-collect-empty-steer", [
        completeRequest("Follow instructions in prompt.md"),
        completeRequest("   "),
      ]);

      const result = parser.collectFollowUpActivity(sessionFile, -1, 0);

      assert.ok(
        !result.events.some((e) => e.type === CLI_EVENT_TYPES.USER_STEER)
      );
      assert.strictEqual(result.steerSeenThroughIndex, 1);
      assert.strictEqual(result.lastResponseIndex, 1);
    });
  });
});
