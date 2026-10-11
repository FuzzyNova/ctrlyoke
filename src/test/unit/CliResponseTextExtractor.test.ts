import * as assert from "assert";
import { suite, test } from "mocha";
import { extractTextFromEvents } from "../../core/harness/shared/CliResponseTextExtractor";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

function output(events: UniversalCliOutput["events"]): UniversalCliOutput {
  return { events, metadata: {} };
}

suite("CliResponseTextExtractor", () => {
  test("omits redacted reasoning that has no summary", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "", redacted: true, reasoningTokens: 453 },
        },
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "Useful answer" } },
      ]),
      { includeFullDiffs: false }
    );

    assert.strictEqual(result, "Useful answer");
  });

  test("keeps the summary of redacted reasoning", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "**Counting primes**", redacted: true },
        },
      ]),
      { includeFullDiffs: false }
    );

    assert.strictEqual(
      result,
      "\n[Thinking]\n**Counting primes**\n[/Thinking]"
    );
  });

  test("keeps plain thinking blocks", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "Checking the lifecycle" },
        },
      ]),
      { includeFullDiffs: false }
    );

    assert.strictEqual(
      result,
      "\n[Thinking]\nChecking the lifecycle\n[/Thinking]"
    );
  });

  test("includes a full structured patch when enabled", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          data: {
            path: "src/example.ts",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const oldValue = 1;", "+const newValue = 2;"],
              },
            ],
          },
        },
      ]),
      { includeFullDiffs: true }
    );

    assert.ok(result.includes("[Edited: src/example.ts]"));
    assert.ok(result.includes("--- a/src/example.ts"));
    assert.ok(result.includes("@@ -1,1 +1,1 @@"));
    assert.ok(result.includes("+const newValue = 2;"));
  });

  test("uses the compact edit summary when full diffs are disabled", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.FILE_EDIT,
          data: {
            path: "src/example.ts",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-old", "+new"],
              },
            ],
          },
        },
      ]),
      { includeFullDiffs: false }
    );

    assert.strictEqual(result, "\n[Edited: src/example.ts (+1, -1)]");
  });

  test("separates consecutive text messages with a paragraph break", () => {
    const result = extractTextFromEvents(
      output([
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "Committing." } },
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "Committed." } },
        {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          data: { path: "old.ts" },
        },
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "Done." } },
      ]),
      { includeFullDiffs: false }
    );

    assert.strictEqual(
      result,
      "Committing.\n\nCommitted.\n[Deleted: old.ts]\n\nDone."
    );
  });
});
