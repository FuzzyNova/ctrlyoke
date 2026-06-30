import * as assert from "assert";
import { OpenCodeResponseParser } from "../../core/harness/opencode/OpenCodeResponseParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

suite("OpenCodeResponseParser", () => {
  suite("parse", () => {
    test("should parse text, tool events, session ID, and token usage", () => {
      const parser = new OpenCodeResponseParser(() => 200000);
      const stdout = [
        JSON.stringify({
          type: "text",
          sessionID: "ses_test123",
          timestamp: 1000,
          part: { text: "Hello from OpenCode." },
        }),
        JSON.stringify({
          type: "tool_use",
          sessionID: "ses_test123",
          timestamp: 1001,
          part: {
            tool: "write",
            state: {
              status: "completed",
              input: {
                filePath: "src/test.ts",
                content: "export const value = 1;",
              },
            },
          },
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test123",
          part: {
            reason: "stop",
            tokens: {
              input: 120,
              output: 30,
              total: 170,
              cache: { read: 20 },
            },
          },
        }),
      ].join("\n");

      const result = parser.parse(stdout, "", 0);
      const textEvents = result.events.filter(
        (event) => event.type === CLI_EVENT_TYPES.TEXT
      );
      const fileWriteEvents = result.events.filter(
        (event) => event.type === CLI_EVENT_TYPES.FILE_WRITE
      );

      assert.strictEqual(result.metadata.sessionId, "ses_test123");
      assert.strictEqual(textEvents.length, 1);
      assert.strictEqual(
        (textEvents[0].data as any)?.text,
        "Hello from OpenCode."
      );
      assert.strictEqual(fileWriteEvents.length, 1);
      assert.strictEqual((fileWriteEvents[0].data as any)?.path, "src/test.ts");
      assert.strictEqual(result.metadata.usage?.inputTokens, 120);
      assert.strictEqual(result.metadata.usage?.outputTokens, 30);
      assert.strictEqual(result.metadata.usage?.totalTokens, 150);
      assert.strictEqual(result.metadata.usage?.cachedInputTokens, 20);
      assert.strictEqual(result.metadata.usage?.contextWindowUsedTokens, 170);
      assert.strictEqual(result.metadata.usage?.contextWindowSize, 200000);
    });

    test("should skip non-JSON lines and keep valid events", () => {
      const parser = new OpenCodeResponseParser();
      const stdout = [
        "non-json banner line",
        JSON.stringify({
          type: "text",
          sessionID: "ses_test456",
          part: { text: "Valid output" },
        }),
      ].join("\n");

      const result = parser.parse(stdout, "", 0);

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.metadata.sessionId, "ses_test456");
    });
  });

  suite("processStreamingChunk", () => {
    test("should buffer partial JSONL lines across chunks", () => {
      const parser = new OpenCodeResponseParser();
      const streamState = new Map<string, any>();

      const first = parser.processStreamingChunk(
        '{"type":"text","sessionID":"ses_stream","part":{"text":"Hel',
        streamState
      );
      const second = parser.processStreamingChunk('lo"}}\n', streamState);

      assert.strictEqual(first, undefined);
      assert.ok(Array.isArray(second));
      assert.strictEqual(second?.length, 1);
      assert.strictEqual(second?.[0].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual((second?.[0].data as any)?.text, "Hello");
      assert.strictEqual(streamState.get("sessionId"), "ses_stream");
    });
  });

  suite("extractSessionId", () => {
    test("should extract the first session ID from output", () => {
      const parser = new OpenCodeResponseParser();
      const output = [
        JSON.stringify({ type: "step_start", sessionID: "ses_first" }),
        JSON.stringify({ type: "text", sessionID: "ses_second" }),
      ].join("\n");

      assert.strictEqual(parser.extractSessionId(output), "ses_first");
    });
  });

  suite("parseTokenCounts", () => {
    test("should aggregate step_finish token counts", () => {
      const parser = new OpenCodeResponseParser();
      const output = [
        JSON.stringify({
          type: "step_finish",
          part: { tokens: { input: 50, output: 10 } },
        }),
        JSON.stringify({
          type: "step_finish",
          part: { tokens: { input: 20, output: 5 } },
        }),
      ].join("\n");

      const result = parser.parseTokenCounts(output);

      assert.strictEqual(result?.prompt, 70);
      assert.strictEqual(result?.completion, 15);
    });
  });
});
