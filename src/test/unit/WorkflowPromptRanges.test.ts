import * as assert from "assert";
import { suite, test } from "mocha";
import { parse as parseYaml } from "yaml";
import { getWorkflowTextSpans } from "../../completions/WorkflowPromptRanges";
import type { WorkflowTextSpan } from "../../completions/WorkflowTextDecoding";
import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES as ROLE,
  WORKFLOW_OBJECT_KINDS as OBJECT,
} from "../../types/DashboardConstants";
import { findCodeRanges } from "../../utils/FileReferenceParser";

const { WORKFLOW_YAML, WORKFLOW_JSON, PROMPT_MARKDOWN } = CTRLYOKE_FILE_KINDS;

/** Every decoded character that is not produced by an escape or a fold maps to itself. */
function assertMapsBack(
  source: string,
  span: WorkflowTextSpan,
  needle: string
) {
  const index = span.text.indexOf(needle);
  assert.ok(index >= 0, `${needle} not in ${JSON.stringify(span.text)}`);
  const start = span.toSourceOffset(index);
  assert.strictEqual(source.slice(start, start + needle.length), needle);
}

suite("WorkflowPromptRanges: YAML", () => {
  test("finds every prompt field with its path and object kind", () => {
    const text = [
      "prompt: root",
      "steps:",
      "  - parallel:",
      "      - prompt: p1",
      "      - prompt: p2",
      "  - prompt: s",
      "    name: not a prompt",
      "    endCondition:",
      "      script: echo hi",
      "      retryPrompt: retry",
      "      passRetryPrompt: pass",
      "finalStep:",
      "  prompt: fin",
      "vars:",
      "  prompt: a var, not a prompt",
      "",
    ].join("\n");
    const spans = getWorkflowTextSpans(text, WORKFLOW_YAML);
    assert.deepStrictEqual(
      spans.map((span) => [span.path, span.objectKind, span.text]),
      [
        [["prompt"], OBJECT.WORKFLOW_ROOT, "root"],
        [["steps", 0, "parallel", 0, "prompt"], OBJECT.PROMPT_STEP, "p1"],
        [["steps", 0, "parallel", 1, "prompt"], OBJECT.PROMPT_STEP, "p2"],
        [["steps", 1, "prompt"], OBJECT.PROMPT_STEP, "s"],
        [
          ["steps", 1, "endCondition", "retryPrompt"],
          OBJECT.END_CONDITION,
          "retry",
        ],
        [
          ["steps", 1, "endCondition", "passRetryPrompt"],
          OBJECT.END_CONDITION,
          "pass",
        ],
        [["finalStep", "prompt"], OBJECT.PROMPT_STEP, "fin"],
      ]
    );
    const scripts = getWorkflowTextSpans(text, WORKFLOW_YAML, ROLE.SCRIPT_TEXT);
    assert.deepStrictEqual(
      scripts.map((span) => span.text),
      ["echo hi"]
    );
  });

  test("decodes every scalar style exactly as the parser does", () => {
    const fixtures = [
      "prompt: |\n  Line one\n    indented\n\n  ```ts\n  x\n  ```\nname: a\n",
      "prompt: |-\n  a\n  b\n\n",
      "prompt: |+\n  a\n\n\nname: x\n",
      "prompt: >\n  one\n  two\n\n  three\n    more\n  four\n",
      "prompt: >-\n  one\n  two\n",
      "prompt: |2\n    two extra\n  base\n",
      "prompt: first line\n  second   line\n\n  third\n",
      "prompt: 'it''s @src/a.ts'\n",
      "prompt: 'a\n  b\n\n  c'\n",
      'prompt: "a\\"b \\n c \\u00e9 \\x41\\\n   joined \\t end  "\n',
      "prompt: |\r\n  crlf `@a.ts`\r\n  y\r\n",
      "prompt: |\n",
    ];
    for (const text of fixtures) {
      const [span] = getWorkflowTextSpans(text, WORKFLOW_YAML);
      const expected = (parseYaml(text) as { prompt: string }).prompt ?? "";
      assert.ok(span, JSON.stringify(text));
      assert.strictEqual(span.text, expected, JSON.stringify(text));
      assert.ok(span.exact, JSON.stringify(text));
    }
  });

  test("a block body is dedented, so a fence inside it is a code range", () => {
    // In the raw file the fence is indented six spaces, past CommonMark's three.
    const text =
      "steps:\n  - prompt: |\n      Read this:\n      ```\n      @src/app.ts\n      ```\n      then `@src/b.ts` and @src/c.ts\n";
    const [span] = getWorkflowTextSpans(text, WORKFLOW_YAML);
    const codeRanges = findCodeRanges(span.text);
    const inCode = (needle: string) => {
      const index = span.text.indexOf(needle);
      return codeRanges.some(
        (range) => index >= range.from && index < range.to
      );
    };
    assert.ok(inCode("@src/app.ts"));
    assert.ok(inCode("@src/b.ts"));
    assert.ok(!inCode("@src/c.ts"));
    for (const needle of ["@src/app.ts", "@src/b.ts", "@src/c.ts"]) {
      assertMapsBack(text, span, needle);
    }
  });

  test("offsets map back through CRLF, folding and escapes", () => {
    const crlf =
      "steps:\r\n  - retryPrompt: x\r\n    prompt: >\r\n      one\r\n      two @x.ts\r\n";
    const [folded] = getWorkflowTextSpans(crlf, WORKFLOW_YAML);
    assert.strictEqual(folded.text, "one two @x.ts\n");
    assertMapsBack(crlf, folded, "@x.ts");

    const quoted = 'prompt: "say \\"hi\\" to @a.ts"\n';
    const [span] = getWorkflowTextSpans(quoted, WORKFLOW_YAML);
    assert.strictEqual(span.text, 'say "hi" to @a.ts');
    assertMapsBack(quoted, span, "@a.ts");
    // An escaped character maps to its backslash.
    assert.strictEqual(
      quoted[span.toSourceOffset(span.text.indexOf('"'))],
      "\\"
    );
    // One past the end maps to the end of the content.
    assert.strictEqual(
      span.toSourceOffset(span.text.length),
      span.sourceRange.end
    );
  });

  test("a document that does not parse yields what it can without throwing", () => {
    assert.deepStrictEqual(getWorkflowTextSpans("", WORKFLOW_YAML), []);
    assert.doesNotThrow(() =>
      getWorkflowTextSpans("steps:\n  - prompt: [unclosed\n", WORKFLOW_YAML)
    );
  });
});

suite("WorkflowPromptRanges: JSON", () => {
  test("decodes escapes and maps offsets back", () => {
    const text =
      '{"steps":[{"prompt":"a \\"b\\"\\n`@x.ts` \\u0041","endCondition":{"script":"s","retryPrompt":"r"}}],"finalStep":{"prompt":"f"}}';
    const spans = getWorkflowTextSpans(text, WORKFLOW_JSON);
    assert.deepStrictEqual(
      spans.map((span) => [span.path, span.text]),
      [
        [["steps", 0, "prompt"], 'a "b"\n`@x.ts` A'],
        [["steps", 0, "endCondition", "retryPrompt"], "r"],
        [["finalStep", "prompt"], "f"],
      ]
    );
    assert.ok(spans.every((span) => span.exact));
    assertMapsBack(text, spans[0], "@x.ts");
    // `\n` decodes to one character that maps to its backslash.
    const newline = spans[0].text.indexOf("\n");
    assert.strictEqual(
      text.slice(
        spans[0].toSourceOffset(newline),
        spans[0].toSourceOffset(newline) + 2
      ),
      "\\n"
    );
  });

  test("strings inside lists are not prompts", () => {
    const text = '{"steps":[{"prompt":"p","skills":["prompt"]}]}';
    assert.deepStrictEqual(
      getWorkflowTextSpans(text, WORKFLOW_JSON).map((span) => span.text),
      ["p"]
    );
  });
});

suite("WorkflowPromptRanges: .prompt.md", () => {
  test("the body after the frontmatter, trimmed as the loader trims it", () => {
    const text = "\uFEFF---\nschemaVersion: 1\n---\n\n  Hello `@a.ts`\n\n";
    const [span] = getWorkflowTextSpans(text, PROMPT_MARKDOWN);
    assert.strictEqual(span.text, "Hello `@a.ts`");
    assert.strictEqual(span.objectKind, OBJECT.PROMPT_FILE_BODY);
    assertMapsBack(text, span, "@a.ts");
    assert.deepStrictEqual(
      getWorkflowTextSpans(text, PROMPT_MARKDOWN, ROLE.SCRIPT_TEXT),
      []
    );
  });
});
