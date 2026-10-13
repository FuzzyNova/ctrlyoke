import * as assert from "assert";
import { suite, test } from "mocha";
import { extractTextFromEvents } from "../../core/harness/shared/CliResponseTextExtractor";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

function output(events: UniversalCliOutput["events"]): UniversalCliOutput {
  return { events, metadata: {} };
}

suite("CliResponseTextExtractor", () => {
  test("keeps text and non-empty thinking summaries", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "", redacted: true, reasoningTokens: 453 },
        },
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "Useful answer" } },
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "**Counting primes**", redacted: true },
        },
      ])
    );

    assert.strictEqual(
      result,
      "Useful answer\n[Thinking]\n**Counting primes**\n[/Thinking]"
    );
  });

  test("keeps plain thinking blocks", () => {
    const result = extractTextFromEvents(
      output([
        {
          type: CLI_EVENT_TYPES.THINKING,
          data: { text: "Checking the lifecycle" },
        },
      ])
    );

    assert.strictEqual(
      result,
      "\n[Thinking]\nChecking the lifecycle\n[/Thinking]"
    );
  });

  test("always emits one-line file operation annotations", () => {
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
        {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          data: {
            path: "src/new.ts",
            content: "new content",
          },
        },
        {
          type: CLI_EVENT_TYPES.FILE_DELETE,
          data: { path: "src/old.ts" },
        },
      ])
    );

    assert.strictEqual(
      result,
      "\n[Edited: src/example.ts (+1, -1)]\n[Created: src/new.ts]\n[Deleted: src/old.ts]"
    );
    assert.ok(!result.includes("```diff"));
    assert.ok(!result.includes("+new"));
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
      ])
    );

    assert.strictEqual(
      result,
      "Committing.\n\nCommitted.\n[Deleted: old.ts]\n\nDone."
    );
  });
});
