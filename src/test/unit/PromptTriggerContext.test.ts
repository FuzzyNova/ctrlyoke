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

  test("treats JSON-style character escapes as boundaries only when enabled", () => {
    for (const [text, trigger, query] of [
      ['  "prompt": "Fix this.\\n@src', "@", "src"],
      ['  "prompt": "Fix this.\\t#sym:', "#", "sym:"],
      ['  "prompt": "x \\n/skill:', "/", "skill:"],
      ['  - prompt: "Fix this.\\n@src', "@", "src"],
      ['  - prompt: "Fix this.\\t~diff', "~", "diff"],
      ['  - prompt: "Fix this.\\r$preCondition:', "$", "preCondition:"],
      ['  - prompt: "Fix this.\\f!API', "!", "API"],
    ] as const) {
      assert.deepStrictEqual(findPromptTriggerContext(text, undefined, true), {
        trigger,
        query,
        index: text.lastIndexOf(trigger),
      });
    }
    assert.strictEqual(
      findPromptTriggerContext(
        '"prompt": "Fix this.\\\\n@src',
        undefined,
        true
      ),
      null
    );
    // Non-control escapes decode to the character the runtime parser sees:
    // `\@`, `/@` and `A@` do not start a reference, `"@` and `\n@` do.
    for (const blocked of [
      '"prompt": "a \\\\@src',
      '"prompt": "a \\/@src',
      '"prompt": "a \\u0041@src',
      '"prompt": "a \\u0041#sym',
    ]) {
      assert.strictEqual(
        findPromptTriggerContext(blocked, undefined, true),
        null,
        blocked
      );
    }
    assert.strictEqual(
      findPromptTriggerContext('"prompt": "a \\"@src', undefined, true)
        ?.trigger,
      "@"
    );
    assert.strictEqual(
      findPromptTriggerContext('"prompt": "a \\\\\\n@src', undefined, true)
        ?.trigger,
      "@"
    );
    assert.strictEqual(
      findPromptTriggerContext('"prompt": "a\\u0020@src', undefined, true)
        ?.trigger,
      "@"
    );
    assert.strictEqual(
      findPromptTriggerContext(
        "- prompt: 'Fix this.\\n@src'",
        undefined,
        false
      ),
      null
    );
    assert.strictEqual(
      findPromptTriggerContext("- prompt: |\n  Fix this.\\n@src"),
      null
    );
    // Without the explicit string-style flag, raw markdown is unchanged.
    assert.strictEqual(findPromptTriggerContext("Fix this.\\n@src"), null);
  });

  test("uses the rightmost trigger at a word start", () => {
    assert.strictEqual(triggerOf("@src/a.ts #sym"), "#");
    assert.strictEqual(triggerOf("#sym:A @src"), "@");
    assert.strictEqual(triggerOf("@src/lib"), "@");
    assert.strictEqual(triggerOf("name@example.com"), undefined);
    assert.strictEqual(triggerOf("plain text"), undefined);
  });
});
