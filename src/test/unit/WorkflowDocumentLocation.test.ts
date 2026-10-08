import * as assert from "assert";
import { suite, test } from "mocha";
import {
  findRangeForPath,
  getWorkflowLocation,
  WORKFLOW_TEXT_FIELDS,
} from "../../completions/WorkflowDocumentLocation";
import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES as ROLE,
  WORKFLOW_OBJECT_KINDS as OBJECT,
  type CtrlYokeFileKind,
} from "../../types/DashboardConstants";

const { WORKFLOW_YAML, WORKFLOW_JSON, PROMPT_MARKDOWN } = CTRLYOKE_FILE_KINDS;

/** `§` marks the cursor; it is removed from the returned text. */
function cursor(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf("§");
  assert.ok(offset >= 0, "fixture needs a § cursor marker");
  return { text: marked.slice(0, offset) + marked.slice(offset + 1), offset };
}

function locate(marked: string, kind: CtrlYokeFileKind) {
  const { text, offset } = cursor(marked);
  return { text, offset, loc: getWorkflowLocation(text, offset, kind) };
}

const slice = (text: string, range?: { start: number; end: number }) =>
  range ? text.slice(range.start, range.end) : undefined;

suite("WorkflowDocumentLocation: YAML", () => {
  test("new key on a blank line inside a prompt step", () => {
    const { loc } = locate(
      "steps:\n  - prompt: hello\n    harness: claude-cli\n    §\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(loc.path, ["steps", 0]);
    assert.deepStrictEqual([...loc.siblingKeys].sort(), ["harness", "prompt"]);
  });

  test("half-typed key after a dash opens a new step", () => {
    const { loc } = locate(
      "steps:\n  - prompt: one\n  - pro§\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(loc.path, ["steps", 1, "pro"]);
    assert.strictEqual(loc.key, "pro");
  });

  test("a partial key is not counted among its own siblings", () => {
    const { loc } = locate(
      "steps:\n  - prompt: one\n    har§\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.deepStrictEqual(loc.siblingKeys, ["prompt"]);
  });

  test("script step is recognised by type or by a script without a prompt", () => {
    const typed = locate(
      "steps:\n  - type: script\n    script: ls\n    §\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(typed.objectKind, OBJECT.SCRIPT_STEP);
    const implicit = locate(
      "steps:\n  - script: ls\n    §\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(implicit.objectKind, OBJECT.SCRIPT_STEP);
  });

  test("value position after a key", () => {
    const { loc } = locate(
      "steps:\n  - prompt: one\n    harness: §\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.strictEqual(loc.key, "harness");
    assert.deepStrictEqual(loc.path, ["steps", 0, "harness"]);
  });

  test("cursor inside an existing scalar value", () => {
    const { loc, text } = locate(
      "steps:\n  - prompt: one\n    harness: cla§ude-cli\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.strictEqual(slice(text, loc.valueRange), "claude-cli");
  });

  test("prompt text in plain, quoted and block scalars", () => {
    const plain = locate("steps:\n  - prompt: do @sr§c/x.ts\n", WORKFLOW_YAML);
    assert.strictEqual(plain.loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(plain.loc.scalarStyle, "plain");
    assert.strictEqual(slice(plain.text, plain.loc.valueRange), "do @src/x.ts");

    const quoted = locate('steps:\n  - prompt: "say §hi"\n', WORKFLOW_YAML);
    assert.strictEqual(quoted.loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(quoted.loc.scalarStyle, "doubleQuoted");
    assert.strictEqual(slice(quoted.text, quoted.loc.valueRange), "say hi");

    const block = locate(
      "steps:\n  - prompt: |\n      first line\n      sec§ond line\n    harness: x\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(block.loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(block.loc.scalarStyle, "block");
    assert.deepStrictEqual(block.loc.path, ["steps", 0, "prompt"]);
    assert.strictEqual(
      slice(block.text, block.loc.valueRange)?.startsWith("      first line"),
      true
    );
  });

  test("the block scalar header and the line after the block are not text", () => {
    const header = locate(
      "steps:\n  - prompt: |§\n      body\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(header.loc.role, ROLE.VALUE);
    assert.strictEqual(header.loc.valueRange, undefined);
    const after = locate(
      "steps:\n  - prompt: |\n      body\n    §\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(after.loc.role, ROLE.KEY);
  });

  test("a new line typed inside a block scalar is prompt text", () => {
    const { loc } = locate(
      "steps:\n  - prompt: |\n      body\n      §\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    assert.deepStrictEqual(loc.path, ["steps", 0, "prompt"]);
  });

  test("retryPrompt and passRetryPrompt are prompt text; condition script is script text", () => {
    const retry = locate(
      "steps:\n  - prompt: a\n    endCondition:\n      script: test.sh\n      retryPrompt: fix §it\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(retry.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(retry.objectKind, OBJECT.END_CONDITION);
    assert.deepStrictEqual(retry.path, [
      "steps",
      0,
      "endCondition",
      "retryPrompt",
    ]);

    const passRetry = locate(
      "steps:\n  - prompt: a\n    endCondition:\n      passRetryPrompt: |\n        again §now\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(passRetry.role, ROLE.PROMPT_TEXT);

    const script = locate(
      "steps:\n  - prompt: a\n    preCondition:\n      script: ./che§ck.sh\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(script.role, ROLE.SCRIPT_TEXT);
    assert.strictEqual(script.objectKind, OBJECT.PRE_CONDITION);
  });

  test("new key under a nested object", () => {
    const { loc } = locate(
      "steps:\n  - prompt: a\n    endCondition:\n      §\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.END_CONDITION);
    assert.deepStrictEqual(loc.path, ["steps", 0, "endCondition"]);
  });

  test("parallel members, finalStep, root keys and hooks", () => {
    const member = locate(
      "steps:\n  - parallel:\n      - prompt: a\n      - prompt: b\n        har§\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(member.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(member.path, ["steps", 0, "parallel", 1, "har"]);

    const group = locate(
      "steps:\n  - parallel:\n      - prompt: a\n    fail§\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(group.objectKind, OBJECT.PARALLEL_GROUP);

    const final = locate("finalStep:\n  prompt: wrap §up\n", WORKFLOW_YAML).loc;
    assert.strictEqual(final.role, ROLE.PROMPT_TEXT);
    assert.deepStrictEqual(final.path, ["finalStep", "prompt"]);

    const root = locate("steps:\n  - prompt: a\nhar§\n", WORKFLOW_YAML).loc;
    assert.strictEqual(root.objectKind, OBJECT.WORKFLOW_ROOT);
    assert.deepStrictEqual(root.path, ["har"]);
    assert.deepStrictEqual(root.siblingKeys, ["steps"]);

    const hook = locate(
      "hooks:\n  - event: preStep\n    command: ech§o hi\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(hook.objectKind, OBJECT.HOOK);
    assert.strictEqual(hook.role, ROLE.SCRIPT_TEXT);

    const worktree = locate("worktree:\n  §\n", WORKFLOW_YAML).loc;
    assert.strictEqual(worktree.objectKind, OBJECT.WORKTREE);
  });

  test("scalar list items are values owned by the list's key", () => {
    const { loc } = locate(
      "steps:\n  - prompt: a\n    skills:\n      - one\n      - tw§o\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.strictEqual(loc.key, "skills");
    assert.deepStrictEqual(loc.path, ["steps", 0, "skills", 1]);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_STEP);
  });

  test("flow-style mappings use the parser, not the indentation scan", () => {
    const { loc } = locate(
      'steps:\n  - { prompt: "a", harness: cla§ude-cli }\n',
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.deepStrictEqual(loc.path, ["steps", 0, "harness"]);
  });

  test("comments are not locations", () => {
    const { loc } = locate(
      "steps:\n  # note §here\n  - prompt: a\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.NONE);
  });

  test("an empty or invalid document does not throw", () => {
    for (const marked of ["§", "steps: [\n  - §", ":::\n  §", "- - §\n"]) {
      assert.doesNotThrow(() => locate(marked, WORKFLOW_YAML), marked);
    }
    assert.strictEqual(
      locate("§", WORKFLOW_YAML).loc.objectKind,
      OBJECT.WORKFLOW_ROOT
    );
  });

  test("the first key typed under a new nested object is a key in that object", () => {
    // YAML reads `ret` as the plain value of `endCondition`.
    const { loc } = locate(
      "steps:\n  - prompt: x\n    endCondition:\n      ret§\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.END_CONDITION);
    assert.deepStrictEqual(loc.path, ["steps", 0, "endCondition", "ret"]);
    for (const [marked, objectKind] of [
      ["worktree:\n  mo§\nsteps: []\n", OBJECT.WORKTREE],
      ["errorBehavior:\n  on§\n", OBJECT.ERROR_BEHAVIOR],
      ["vars:\n  na§\n", OBJECT.VARS],
      ["_templateMeta:\n  na§\n", OBJECT.TEMPLATE_META],
      [
        "steps:\n  - prompt: x\n    toolPermissions:\n      mo§\n",
        OBJECT.TOOL_PERMISSIONS,
      ],
    ] as const) {
      const nested = locate(marked, WORKFLOW_YAML).loc;
      assert.strictEqual(nested.role, ROLE.KEY, marked);
      assert.strictEqual(nested.objectKind, objectKind, marked);
    }
    // A text field's value on the next line is still text, not a key.
    const text = locate("prompt:\n  Fix §it\n", WORKFLOW_YAML).loc;
    assert.strictEqual(text.role, ROLE.PROMPT_TEXT);
  });

  test("an empty new list item opens a new step", () => {
    const { loc } = locate("steps:\n  - prompt: a\n  - §\n", WORKFLOW_YAML);
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(loc.path, ["steps", 1]);
    assert.strictEqual(loc.key, undefined);
  });

  test("a new entry in a flow mapping or flow sequence", () => {
    const mapping = locate(
      'steps:\n  - { prompt: "hi", §}\n',
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(mapping.role, ROLE.KEY);
    assert.strictEqual(mapping.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(mapping.path, ["steps", 0]);
    assert.deepStrictEqual(mapping.siblingKeys, ["prompt"]);

    const sequence = locate(
      "steps:\n  - prompt: a\n    skills: [a, §]\n",
      WORKFLOW_YAML
    ).loc;
    assert.strictEqual(sequence.role, ROLE.VALUE);
    assert.strictEqual(sequence.key, "skills");
    assert.deepStrictEqual(sequence.path, ["steps", 0, "skills", 1]);
  });

  test("trailing comments and quote boundaries are not text", () => {
    for (const marked of [
      "steps:\n  - prompt: hi # a §\n",
      'steps:\n  - prompt: "x"§\n',
      'steps:\n  - prompt: "x" §\n',
      "steps:\n  - prompt: 'it''s'§\n",
      "prompt: x #§\n",
    ]) {
      const { loc } = locate(marked, WORKFLOW_YAML);
      assert.strictEqual(loc.role, ROLE.NONE, marked);
    }
    const beforeQuote = locate('prompt: §"x"\n', WORKFLOW_YAML).loc;
    assert.strictEqual(beforeQuote.role, ROLE.VALUE);
    // `#` inside quotes, or without a space before it, is still text.
    for (const marked of [
      'prompt: "a # b §',
      "prompt: issue#12 §",
      "prompt: 'it''s #§",
    ]) {
      assert.strictEqual(
        locate(marked, WORKFLOW_YAML).loc.role,
        ROLE.PROMPT_TEXT,
        marked
      );
    }
  });

  test("an unclosed quoted value starts its range after the quote", () => {
    const { text, loc } = locate('prompt: "fix §', WORKFLOW_YAML);
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(loc.scalarStyle, "doubleQuoted");
    assert.ok(slice(text, loc.valueRange)?.startsWith("fix"));
  });

  test("a single-step script workflow's root is still the root", () => {
    const { loc } = locate(
      "type: script\nscript: echo hi\nwork§\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.objectKind, OBJECT.WORKFLOW_ROOT);
    const script = locate("type: script\nscript: ec§ho\n", WORKFLOW_YAML).loc;
    assert.strictEqual(script.role, ROLE.SCRIPT_TEXT);
  });

  test("the fallback scan's block range covers the whole body", () => {
    // A new last line inside the block has no parser node.
    const { text, loc } = locate(
      "steps:\n  - prompt: |\n      first\n      §\n      third\n    name: n\n",
      WORKFLOW_YAML
    );
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    const body = slice(text, loc.valueRange) ?? "";
    assert.ok(body.includes("first") && body.includes("third"), body);
    assert.ok(!body.includes("name"), body);
  });

  test("findRangeForPath resolves scalars, keys and missing paths", () => {
    const text =
      "steps:\n  - prompt: one\n    harness: claude-cli\n    endCondition:\n      script: x\n";
    const kind = WORKFLOW_YAML;
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["steps", 0, "harness"], kind)),
      "claude-cli"
    );
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["steps", 0, "endCondition"], kind)),
      "endCondition"
    );
    // A missing key falls back to the nearest existing ancestor.
    assert.strictEqual(
      slice(
        text,
        findRangeForPath(text, ["steps", 0, "endCondition", "nope"], kind)
      ),
      "endCondition"
    );
  });
});

suite("WorkflowDocumentLocation: JSON", () => {
  test("new key inside an empty step object", () => {
    const { loc } = locate('{"steps":[{"prompt":"a",§}]}', WORKFLOW_JSON);
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_STEP);
    assert.deepStrictEqual(loc.path, ["steps", 0]);
    assert.deepStrictEqual(loc.siblingKeys, ["prompt"]);
  });

  test("a key being edited is a key and excluded from siblings", () => {
    const { loc } = locate(
      '{"steps":[{"prompt":"a","har§":1}]}',
      WORKFLOW_JSON
    );
    assert.strictEqual(loc.role, ROLE.KEY);
    assert.strictEqual(loc.key, "har");
    assert.deepStrictEqual(loc.siblingKeys, ["prompt"]);
  });

  test("value of a property with nothing typed yet", () => {
    const { loc } = locate(
      '{"steps":[{"prompt":"a","harness": §}]}',
      WORKFLOW_JSON
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.deepStrictEqual(loc.path, ["steps", 0, "harness"]);
  });

  test("prompt strings expose the content range and flag JSON escaping", () => {
    const { loc, text } = locate(
      '{"steps":[{"prompt":"see @sr§c \\"q\\""}]}',
      WORKFLOW_JSON
    );
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(loc.jsonString, true);
    assert.strictEqual(slice(text, loc.valueRange), 'see @src \\"q\\"');
  });

  test("retryPrompt, script, and list strings", () => {
    const retry = locate(
      '{"steps":[{"prompt":"a","endCondition":{"retryPrompt":"fi§x"}}]}',
      WORKFLOW_JSON
    ).loc;
    assert.strictEqual(retry.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(retry.objectKind, OBJECT.END_CONDITION);

    const script = locate(
      '{"steps":[{"type":"script","script":"l§s"}]}',
      WORKFLOW_JSON
    ).loc;
    assert.strictEqual(script.role, ROLE.SCRIPT_TEXT);
    assert.strictEqual(script.objectKind, OBJECT.SCRIPT_STEP);

    const skill = locate(
      '{"steps":[{"prompt":"a","skills":["x§"]}]}',
      WORKFLOW_JSON
    ).loc;
    assert.strictEqual(skill.role, ROLE.VALUE);
    assert.strictEqual(skill.key, "skills");
    assert.deepStrictEqual(skill.path, ["steps", 0, "skills", 0]);
  });

  test("parallel members and finalStep", () => {
    const member = locate(
      '{"steps":[{"parallel":[{"prompt":"a"},{"prompt":"b§"}]}]}',
      WORKFLOW_JSON
    ).loc;
    assert.deepStrictEqual(member.path, ["steps", 0, "parallel", 1, "prompt"]);
    assert.strictEqual(member.role, ROLE.PROMPT_TEXT);
    const final = locate('{"finalStep":{"prompt":"x§"}}', WORKFLOW_JSON).loc;
    assert.deepStrictEqual(final.path, ["finalStep", "prompt"]);
  });

  test("tolerates comments, trailing commas and broken documents", () => {
    const ok = locate(
      '{\n  // note\n  "steps": [{"prompt": "a§",},],\n}',
      WORKFLOW_JSON
    ).loc;
    assert.strictEqual(ok.role, ROLE.PROMPT_TEXT);
    for (const marked of [
      "§",
      '{"steps": [{"prompt": "unterminated§',
      '{"a": §',
      "[§",
    ]) {
      assert.doesNotThrow(() => locate(marked, WORKFLOW_JSON), marked);
    }
  });

  test("quote boundaries and comments are not text", () => {
    for (const marked of ['{"prompt": §"x"}', '{"prompt": "x"§}']) {
      const { loc } = locate(marked, WORKFLOW_JSON);
      assert.strictEqual(loc.role, ROLE.VALUE, marked);
      assert.ok(!loc.jsonString, marked);
    }
    const inside = locate('{"prompt": "§x"}', WORKFLOW_JSON).loc;
    assert.strictEqual(inside.role, ROLE.PROMPT_TEXT);
    for (const marked of [
      '{ /* hi§ */ "prompt": "x" }',
      '{ // hi§\n "prompt": "x" }',
      '{ "prompt": "x" /* open§',
    ]) {
      assert.strictEqual(
        locate(marked, WORKFLOW_JSON).loc.role,
        ROLE.NONE,
        marked
      );
    }
  });

  test("findRangeForPath clips a keyless object to its first line", () => {
    const text = '{\n  "steps": [\n    {\n      "prompt": "x"\n    }\n  ]\n}';
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["steps", 0], WORKFLOW_JSON)),
      "{"
    );
    assert.strictEqual(
      slice(text, findRangeForPath(text, [], WORKFLOW_JSON)),
      "{"
    );
  });

  test("findRangeForPath resolves scalars, collections and missing paths", () => {
    const text = '{"steps":[{"prompt":"one","endCondition":{"script":"x"}}]}';
    const kind = WORKFLOW_JSON;
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["steps", 0, "prompt"], kind)),
      '"one"'
    );
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["steps", 0, "endCondition"], kind)),
      '"endCondition"'
    );
    assert.strictEqual(
      slice(
        text,
        findRangeForPath(text, ["steps", 0, "endCondition", "nope"], kind)
      ),
      '"endCondition"'
    );
  });
});

suite("WorkflowDocumentLocation: .prompt.md", () => {
  test("everything is prompt text without frontmatter", () => {
    const { loc, text } = locate("Do the §thing\n", PROMPT_MARKDOWN);
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(loc.objectKind, OBJECT.PROMPT_FILE_BODY);
    assert.strictEqual(slice(text, loc.valueRange), text);
  });

  test("the body starts after the frontmatter", () => {
    const marked = "---\nschemaVersion: 1\n---\nBody §text\n";
    const { loc, text } = locate(marked, PROMPT_MARKDOWN);
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
    assert.strictEqual(slice(text, loc.valueRange), "Body text\n");
  });

  test("frontmatter holds keys and values only", () => {
    const key = locate("---\nschema§\n---\nBody\n", PROMPT_MARKDOWN).loc;
    assert.strictEqual(key.role, ROLE.KEY);
    assert.strictEqual(key.objectKind, OBJECT.PROMPT_FILE_FRONTMATTER);

    const { loc, text } = locate(
      "---\nschemaVersion: §1\n---\nBody\n",
      PROMPT_MARKDOWN
    );
    assert.strictEqual(loc.role, ROLE.VALUE);
    assert.strictEqual(slice(text, loc.valueRange), "1");

    const fence = locate(
      "-§--\nschemaVersion: 1\n---\nBody\n",
      PROMPT_MARKDOWN
    ).loc;
    assert.strictEqual(fence.role, ROLE.NONE);
  });

  test("a BOM and an empty frontmatter split as the loader splits them", () => {
    for (const marked of [
      "\uFEFF---\nschemaVersion: 1\n---\nBo§dy\n",
      "---\n---\nBo§dy\n",
      "\uFEFF---\n---\nBo§dy\n",
    ]) {
      const { loc, text } = locate(marked, PROMPT_MARKDOWN);
      assert.strictEqual(loc.role, ROLE.PROMPT_TEXT, JSON.stringify(marked));
      assert.strictEqual(slice(text, loc.valueRange), "Body\n");
    }
  });

  test("an unclosed frontmatter fence is plain prompt text", () => {
    const { loc } = locate("---\nnot closed §here\n", PROMPT_MARKDOWN);
    assert.strictEqual(loc.role, ROLE.PROMPT_TEXT);
  });

  test("findRangeForPath addresses the body and the frontmatter", () => {
    const text = "---\nschemaVersion: 1\n---\nBody\n";
    assert.strictEqual(
      slice(text, findRangeForPath(text, [], PROMPT_MARKDOWN)),
      "Body\n"
    );
    assert.strictEqual(
      slice(text, findRangeForPath(text, ["schemaVersion"], PROMPT_MARKDOWN)),
      "1"
    );
  });
});

suite("WORKFLOW_TEXT_FIELDS", () => {
  test("has no duplicate (objectKind, key) entries", () => {
    const seen = new Set<string>();
    for (const field of WORKFLOW_TEXT_FIELDS) {
      const id = `${field.objectKind}:${field.key}`;
      assert.ok(!seen.has(id), `duplicate ${id}`);
      seen.add(id);
    }
  });
});
