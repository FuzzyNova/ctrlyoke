import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent } from "../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import {
  describeActivityForSpeech,
  findSettledSpeechBoundary,
  toSpeechText,
} from "../../utils/speechText";

suite("speechText", () => {
  suite("toSpeechText", () => {
    test("replaces fenced code with its line count", () => {
      const markdown = [
        "Run this:",
        "",
        "```ts",
        "const a = 1;",
        "const b = 2;",
        "```",
        "",
        "Done.",
      ].join("\n");
      assert.strictEqual(
        toSpeechText(markdown),
        "Run this:\n\nCode block, 2 lines, omitted.\n\nDone."
      );
    });

    test("an unterminated fence still counts its lines", () => {
      assert.strictEqual(
        toSpeechText("~~~\nonly line"),
        "Code block, 1 line, omitted."
      );
    });

    test("reads a table as its row count", () => {
      const markdown = [
        "| Name | Value |",
        "| --- | --- |",
        "| a | 1 |",
        "| b | 2 |",
        "| c | 3 |",
        "After.",
      ].join("\n");
      assert.strictEqual(toSpeechText(markdown), "Table with 3 rows.\nAfter.");
    });

    test("drops headings, bullets, quotes, emphasis and inline code marks", () => {
      const markdown = [
        "## Summary ##",
        "- **Fixed** the `validateToken` check",
        "* _also_ cleaned ~~old~~ code",
        "> quoted note",
        "---",
        "snake_case_name stays",
      ].join("\n");
      assert.strictEqual(
        toSpeechText(markdown),
        [
          "Summary",
          "Fixed the validateToken check",
          "also cleaned old code",
          "quoted note",
          "",
          "snake_case_name stays",
        ].join("\n")
      );
    });

    test("keeps link text, shortens URLs to their host", () => {
      assert.strictEqual(
        toSpeechText(
          "See [the docs](https://ctrlyoke.dev/docs/x) or https://github.com/a/b/pull/1 and ![diagram](img.png)."
        ),
        "See the docs or github.com and diagram."
      );
    });

    test("reads absolute paths as their file name and leaves relative ones", () => {
      assert.strictEqual(
        toSpeechText(
          "Edited C:\\dev\\repo\\src\\a.ts, /home/me/repo/b.ts and src/c.ts (`/tmp/x/d.log`)."
        ),
        "Edited a.ts, b.ts and src/c.ts (d.log)."
      );
    });

    test("strips HTML tags and collapses blank lines", () => {
      assert.strictEqual(
        toSpeechText(
          "<details>\n<summary>More</summary>\n\n\n\nBody</details>"
        ),
        "More\n\nBody"
      );
    });
  });

  suite("findSettledSpeechBoundary", () => {
    test("ends after the last blank line", () => {
      const text = "First paragraph.\n\nSecond, still stream";
      assert.strictEqual(
        text.slice(0, findSettledSpeechBoundary(text)),
        "First paragraph.\n\n"
      );
    });

    test("is 0 while no paragraph is complete", () => {
      assert.strictEqual(findSettledSpeechBoundary("Still typing"), 0);
      assert.strictEqual(findSettledSpeechBoundary(""), 0);
    });

    test("ignores blank lines inside an open code fence", () => {
      const text = "Intro.\n\n```\ncode\n\nmore code\n";
      assert.strictEqual(
        text.slice(0, findSettledSpeechBoundary(text)),
        "Intro.\n\n"
      );
      const closed = `${text}\`\`\`\n\nAfter`;
      assert.strictEqual(
        closed.slice(0, findSettledSpeechBoundary(closed)),
        `${text}\`\`\`\n\n`
      );
    });
  });

  suite("describeActivityForSpeech", () => {
    test("counts distinct changed and deleted files and commands", () => {
      const events = [
        { type: CLI_EVENT_TYPES.FILE_EDIT, data: { path: "src/a.ts" } },
        { type: CLI_EVENT_TYPES.FILE_EDIT, data: { path: "src\\A.ts" } },
        {
          type: CLI_EVENT_TYPES.FILE_WRITE,
          data: { path: "src/b.ts", content: "" },
        },
        { type: CLI_EVENT_TYPES.FILE_DELETE, data: { path: "old.ts" } },
        { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { command: "npm test" } },
        { type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } },
      ] as CliEvent[];
      assert.strictEqual(
        describeActivityForSpeech(events),
        "Changed 2 files, deleted 1 file, ran 1 command."
      );
    });

    test("is empty for a text-only turn", () => {
      assert.strictEqual(
        describeActivityForSpeech([
          { type: CLI_EVENT_TYPES.TEXT, data: { text: "hi" } },
        ]),
        ""
      );
    });
  });
});
