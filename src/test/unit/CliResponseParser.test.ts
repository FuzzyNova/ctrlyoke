import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CliResponseParser,
  CliUsage,
} from "../../flightpath/harness/shared/CliResponseParser";

suite("CliResponseParser", () => {
  suite("extractJsonObjectsFromStream", () => {
    test("parses a single JSON object", () => {
      const data = '{"type":"system","message":"hello"}';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(remainder, "");
    });

    test("parses concatenated JSON objects (stream-json format)", () => {
      const data =
        '{"type":"system","id":"1"}{"type":"assistant","text":"hi"}{"type":"result","ok":true}';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 3);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(objects[1].type, "assistant");
      assert.strictEqual(objects[2].type, "result");
      assert.strictEqual(remainder, "");
    });

    test("returns remainder when last object is incomplete", () => {
      const data = '{"type":"system"}{"type":"partial"';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(remainder, '{"type":"partial"');
    });

    test("returns empty array and full string as remainder for empty input", () => {
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream("");
      assert.strictEqual(objects.length, 0);
      assert.strictEqual(remainder, "");
    });

    test("handles nested JSON objects correctly", () => {
      const data = '{"outer":{"inner":"value"},"count":1}';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.deepStrictEqual(objects[0].outer, { inner: "value" });
      assert.strictEqual(remainder, "");
    });

    test("handles JSON with escaped quotes inside strings", () => {
      const data = '{"message":"say \\"hello\\""}';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].message, 'say "hello"');
      assert.strictEqual(remainder, "");
    });

    test("skips non-JSON content before first brace and returns remainder", () => {
      const data = 'some prefix text{"type":"event"}';
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "event");
      assert.strictEqual(remainder, "");
    });

    test("returns empty results for input with no JSON", () => {
      const data = "no json here at all";
      const { objects, remainder } =
        CliResponseParser.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 0);
    });
  });

  suite("parseJsonLines", () => {
    test("parses single JSONL line", () => {
      const data = '{"type":"thread.started","id":"abc"}';
      const objects = CliResponseParser.parseJsonLines(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "thread.started");
    });

    test("parses multiple JSONL lines", () => {
      const data = [
        '{"type":"thread.started","id":"1"}',
        '{"type":"item.completed","text":"done"}',
        '{"type":"turn.completed","ok":true}',
      ].join("\n");
      const objects = CliResponseParser.parseJsonLines(data);
      assert.strictEqual(objects.length, 3);
      assert.strictEqual(objects[0].type, "thread.started");
      assert.strictEqual(objects[1].type, "item.completed");
      assert.strictEqual(objects[2].type, "turn.completed");
    });

    test("skips empty lines", () => {
      const data = '{"type":"a"}\n\n{"type":"b"}\n';
      const objects = CliResponseParser.parseJsonLines(data);
      assert.strictEqual(objects.length, 2);
    });

    test("skips non-JSON lines without throwing", () => {
      const data = '{"type":"a"}\nnot json\n{"type":"b"}';
      const objects = CliResponseParser.parseJsonLines(data);
      assert.strictEqual(objects.length, 2);
      assert.strictEqual(objects[0].type, "a");
      assert.strictEqual(objects[1].type, "b");
    });

    test("returns empty array for empty string", () => {
      const objects = CliResponseParser.parseJsonLines("");
      assert.strictEqual(objects.length, 0);
    });

    test("returns empty array for whitespace-only input", () => {
      const objects = CliResponseParser.parseJsonLines("   \n   \n");
      assert.strictEqual(objects.length, 0);
    });
  });

  suite("extractUsageStats", () => {
    test("returns undefined when no usage field", () => {
      const result = CliResponseParser.extractUsageStats({ type: "result" });
      assert.strictEqual(result, undefined);
    });

    test("extracts input_tokens and output_tokens", () => {
      const json = { usage: { input_tokens: 100, output_tokens: 50 } };
      const result = CliResponseParser.extractUsageStats(json);
      assert.ok(result);
      assert.strictEqual(result!.input_tokens, 100);
      assert.strictEqual(result!.output_tokens, 50);
    });

    test("uses provided total_tokens when present", () => {
      const json = {
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 200 },
      };
      const result = CliResponseParser.extractUsageStats(json);
      assert.ok(result);
      assert.strictEqual(result!.total_tokens, 200);
    });

    test("computes total_tokens as sum when not provided", () => {
      const json = { usage: { input_tokens: 100, output_tokens: 50 } };
      const result = CliResponseParser.extractUsageStats(json);
      assert.ok(result);
      assert.strictEqual(result!.total_tokens, 150);
    });
  });

  suite("extractSessionId", () => {
    test("extracts session_id field (Claude format)", () => {
      const json = { session_id: "session-abc-123" };
      const result = CliResponseParser.extractSessionId(json);
      assert.strictEqual(result, "session-abc-123");
    });

    test("extracts thread_id field (Codex format)", () => {
      const json = { thread_id: "thread-xyz-456" };
      const result = CliResponseParser.extractSessionId(json);
      assert.strictEqual(result, "thread-xyz-456");
    });

    test("returns session_id when both fields present (session_id takes precedence)", () => {
      const json = { session_id: "session-first", thread_id: "thread-second" };
      const result = CliResponseParser.extractSessionId(json);
      assert.strictEqual(result, "session-first");
    });

    test("returns undefined when neither field present", () => {
      const json = { type: "result", content: "text" };
      const result = CliResponseParser.extractSessionId(json);
      assert.strictEqual(result, undefined);
    });
  });

  suite("formatStatistics", () => {
    test("returns empty string for undefined usage", () => {
      const result = CliResponseParser.formatStatistics(undefined);
      assert.strictEqual(result, "");
    });

    test("formats usage without model", () => {
      const usage: CliUsage = {
        input_tokens: 1234,
        output_tokens: 5678,
        total_tokens: 6912,
      };
      const result = CliResponseParser.formatStatistics(usage);
      assert.strictEqual(
        result,
        "Usage: 1234 input + 5678 output = 6912 tokens"
      );
    });

    test("includes model name when provided", () => {
      const usage: CliUsage = {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
      };
      const result = CliResponseParser.formatStatistics(
        usage,
        "claude-sonnet-4.5"
      );
      assert.strictEqual(
        result,
        "Usage: 100 input + 200 output = 300 tokens | Model: claude-sonnet-4.5"
      );
    });

    test("computes total from sum when total_tokens not provided", () => {
      const usage: CliUsage = { input_tokens: 400, output_tokens: 600 };
      const result = CliResponseParser.formatStatistics(usage);
      assert.ok(result.includes("= 1000 tokens"));
    });
  });
});
