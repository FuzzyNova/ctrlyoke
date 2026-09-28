import * as assert from "assert";
import { suite, test } from "mocha";
import { CliParseUtils } from "../../core/harness/shared/CliParseUtils";

suite("CliParseUtils", () => {
  suite("extractJsonObjectsFromStream", () => {
    test("parses a single JSON object", () => {
      const data = '{"type":"system","message":"hello"}';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(remainder, "");
    });

    test("parses concatenated JSON objects (stream-json format)", () => {
      const data =
        '{"type":"system","id":"1"}{"type":"assistant","text":"hi"}{"type":"result","ok":true}';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 3);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(objects[1].type, "assistant");
      assert.strictEqual(objects[2].type, "result");
      assert.strictEqual(remainder, "");
    });

    test("returns remainder when last object is incomplete", () => {
      const data = '{"type":"system"}{"type":"partial"';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "system");
      assert.strictEqual(remainder, '{"type":"partial"');
    });

    test("returns empty array and full string as remainder for empty input", () => {
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream("");
      assert.strictEqual(objects.length, 0);
      assert.strictEqual(remainder, "");
    });

    test("handles nested JSON objects correctly", () => {
      const data = '{"outer":{"inner":"value"},"count":1}';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.deepStrictEqual(objects[0].outer, { inner: "value" });
      assert.strictEqual(remainder, "");
    });

    test("handles JSON with escaped quotes inside strings", () => {
      const data = '{"message":"say \\"hello\\""}';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].message, 'say "hello"');
      assert.strictEqual(remainder, "");
    });

    test("skips non-JSON content before first brace and returns remainder", () => {
      const data = 'some prefix text{"type":"event"}';
      const { objects, remainder } =
        CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "event");
      assert.strictEqual(remainder, "");
    });

    test("returns empty results for input with no JSON", () => {
      const data = "no json here at all";
      const { objects } = CliParseUtils.extractJsonObjectsFromStream(data);
      assert.strictEqual(objects.length, 0);
    });
  });

  suite("parseJsonLines", () => {
    test("parses single JSONL line", () => {
      const data = '{"type":"thread.started","id":"abc"}';
      const objects = CliParseUtils.parseJsonLines(data);
      assert.strictEqual(objects.length, 1);
      assert.strictEqual(objects[0].type, "thread.started");
    });

    test("parses multiple JSONL lines", () => {
      const data = [
        '{"type":"thread.started","id":"1"}',
        '{"type":"item.completed","text":"done"}',
        '{"type":"turn.completed","ok":true}',
      ].join("\n");
      const objects = CliParseUtils.parseJsonLines(data);
      assert.strictEqual(objects.length, 3);
      assert.strictEqual(objects[0].type, "thread.started");
      assert.strictEqual(objects[1].type, "item.completed");
      assert.strictEqual(objects[2].type, "turn.completed");
    });

    test("skips empty lines", () => {
      const data = '{"type":"a"}\n\n{"type":"b"}\n';
      const objects = CliParseUtils.parseJsonLines(data);
      assert.strictEqual(objects.length, 2);
    });

    test("skips non-JSON lines without throwing", () => {
      const data = '{"type":"a"}\nnot json\n{"type":"b"}';
      const objects = CliParseUtils.parseJsonLines(data);
      assert.strictEqual(objects.length, 2);
      assert.strictEqual(objects[0].type, "a");
      assert.strictEqual(objects[1].type, "b");
    });

    test("returns empty array for empty string", () => {
      const objects = CliParseUtils.parseJsonLines("");
      assert.strictEqual(objects.length, 0);
    });

    test("returns empty array for whitespace-only input", () => {
      const objects = CliParseUtils.parseJsonLines("   \n   \n");
      assert.strictEqual(objects.length, 0);
    });
  });
});
