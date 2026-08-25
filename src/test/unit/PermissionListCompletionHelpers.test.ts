import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getPermissionListCompletions,
  parsePermissionCompletionContext,
} from "../../completions/PermissionListCompletionHelpers";
import { COPILOT_TO_CLAUDE_MAP } from "../../core/harness/shared/CliToolPermissionMapper";

suite("PermissionListCompletionHelpers", () => {
  test("finds the current line and replacement start", () => {
    const text = "read\n  she\nwrite";
    const context = parsePermissionCompletionContext(text, 10);

    assert.strictEqual(context.line, "  she");
    assert.strictEqual(context.beforeCursor, "she");
    assert.strictEqual(context.lineStart, 5);
    assert.strictEqual(context.replacementStart, 7);
  });

  test("sources bare tool names from the canonical permission map", () => {
    const items = getPermissionListCompletions("", 0);
    const labels = new Set(items.map((item) => item.label));

    for (const toolName of Object.keys(COPILOT_TO_CLAUDE_MAP)) {
      assert.ok(labels.has(toolName), `missing ${toolName}`);
    }
  });

  test("filters candidates to the current line's typed prefix", () => {
    const items = getPermissionListCompletions(
      "read\nshell(gi\nwrite",
      "read\nshell(gi".length
    );

    assert.deepStrictEqual(
      items.map((item) => item.label),
      ["shell(git:*)"]
    );
    assert.strictEqual(items[0].insertText, "shell(git:*");
  });

  test("offers curated shell and bash argument starters", () => {
    const items = getPermissionListCompletions("bash(n", 6);
    const labels = items.map((item) => item.label);

    assert.deepStrictEqual(labels, ["bash(npm:*)", "bash(npx:*)"]);
    assert.ok(items.every((item) => !item.insertText.endsWith(")")));
  });
});
