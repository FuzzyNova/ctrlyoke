import * as assert from "assert";
import { suite, test } from "mocha";
import { findPromptTriggerContext } from "../../completions/PromptTriggerContext";
import { escapeJsonStringFragment } from "../../utils/JsonStringEscape";

suite("findPromptTriggerContext", () => {
  const triggerOf = (text: string) => findPromptTriggerContext(text)?.trigger;

  test("opens `/` only where the runtime resolves a slash token", () => {
    assert.deepStrictEqual(findPromptTriggerContext("use /sk"), {
      trigger: "/",
      query: "sk",
      index: 4,
    });
    assert.strictEqual(triggerOf("/"), "/");
    assert.strictEqual(triggerOf("see ./"), undefined);
    assert.strictEqual(triggerOf("see ./x"), undefined);
    assert.strictEqual(triggerOf("open https://host"), undefined);
    assert.strictEqual(triggerOf("open https://host/pa"), undefined);
    assert.strictEqual(triggerOf("a:/b"), undefined);
  });

  test("opens `~` only for git change references", () => {
    assert.strictEqual(triggerOf("compare ~"), "~");
    assert.strictEqual(triggerOf("compare ~diff"), "~");
    assert.strictEqual(triggerOf("compare ~stash:1"), "~");
    assert.strictEqual(triggerOf("compare ~c056e24"), "~");
    assert.strictEqual(triggerOf("open ~/Documents"), undefined);
    assert.strictEqual(triggerOf("open ~/"), undefined);
  });

  test("accepts any `#` query without spaces or quotes", () => {
    assert.strictEqual(triggerOf("see #sym:Foo"), "#");
    assert.strictEqual(triggerOf("see #selection:src/a.ts:1-2"), "#");
    assert.strictEqual(triggerOf("see #src/über.ts"), "#");
    assert.strictEqual(triggerOf("see #src/[id].tsx"), "#");
    assert.strictEqual(triggerOf("# Heading"), undefined);
    assert.strictEqual(triggerOf('see #src/a"'), undefined);
  });

  test("keeps `@` quoted paths open across spaces, escaped or not", () => {
    assert.deepStrictEqual(findPromptTriggerContext('read @"my dir/'), {
      trigger: "@",
      query: '"my dir/',
      index: 5,
    });
    assert.deepStrictEqual(
      findPromptTriggerContext('read @\\"my dir/', escapeJsonStringFragment),
      { trigger: "@", query: '"my dir/', index: 5 }
    );
    // Without a JSON escape, the backslash is literal text, not an opener.
    assert.strictEqual(triggerOf('read @\\"my dir/'), undefined);
    assert.strictEqual(triggerOf('read @"my dir/a.ts" next'), undefined);
    assert.strictEqual(triggerOf("read @src/a.ts next"), undefined);
  });

  test("keeps the existing `$` and `!` query rules", () => {
    assert.strictEqual(triggerOf("use $preCondition:"), "$");
    assert.strictEqual(triggerOf("use !API_"), "!");
    assert.strictEqual(triggerOf("![alt](url)"), undefined);
    assert.strictEqual(triggerOf("Done!"), undefined);
  });

  test("uses the rightmost trigger at a word start", () => {
    assert.strictEqual(triggerOf("@src/a.ts #sym"), "#");
    assert.strictEqual(triggerOf("#sym:A @src"), "@");
    assert.strictEqual(triggerOf("@src/lib"), "@");
    assert.strictEqual(triggerOf("name@example.com"), undefined);
    assert.strictEqual(triggerOf("plain text"), undefined);
  });
});
