import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravityResponseParser } from "../../core/harness/antigravity/AntigravityResponseParser";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
} from "../../types/DashboardConstants";

suite("AntigravityResponseParser", () => {
  suite("parse", () => {
    test("prefers stdout text when present", () => {
      const parser = new AntigravityResponseParser();

      const result = parser.parse("hello from agy\n", "stderr text", 0);

      assert.strictEqual(result.metadata.harness, HARNESS_IDS.ANTIGRAVITY_CLI);
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].type, CLI_EVENT_TYPES.TEXT);
      assert.strictEqual((result.events[0].data as { text: string }).text, "hello from agy");
    });

    test("falls back to stderr when stdout is empty", () => {
      const parser = new AntigravityResponseParser();

      const result = parser.parse("", "stderr only\n", 0);

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual((result.events[0].data as { text: string }).text, "stderr only");
    });

    test("emits a generic message for non-zero exit without output", () => {
      const parser = new AntigravityResponseParser();

      const result = parser.parse("", "", 1);

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(
        (result.events[0].data as { text: string }).text,
        "Antigravity CLI exited without output"
      );
    });
  });

  suite("processStreamingChunk", () => {
    test("passes through non-empty chunks", () => {
      const parser = new AntigravityResponseParser();

      assert.strictEqual(
        parser.processStreamingChunk("stream chunk", new Map()),
        "stream chunk"
      );
      assert.strictEqual(parser.processStreamingChunk("", new Map()), undefined);
    });
  });
});
