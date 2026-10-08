import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getWorkflowLocation,
  parseWorkflowDocumentRoot,
} from "../../completions/WorkflowDocumentLocation";
import {
  getWorkflowFileCompletions,
  type WorkflowFileCompletions,
  type WorkflowModelOption,
  type WorkflowValueDataSource,
} from "../../completions/WorkflowFileCompletionCore";
import { getWorkflowPropertySnippet } from "../../completions/WorkflowPropertySnippets";
import {
  CTRLYOKE_FILE_KINDS,
  HARNESS_IDS,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
} from "../../types/DashboardConstants";
import { escapeJsonStringFragment } from "../../utils/JsonStringEscape";

const { WORKFLOW_YAML, WORKFLOW_JSON, PROMPT_MARKDOWN } = CTRLYOKE_FILE_KINDS;

class StubData implements WorkflowValueDataSource {
  modelRequests: string[] = [];
  constructor(
    private readonly models: Record<string, WorkflowModelOption[]> = {
      [HARNESS_IDS.CLAUDE_CLI]: [{ id: "claude-sonnet", label: "Sonnet" }],
      [HARNESS_IDS.CODEX_CLI]: [{ id: "gpt-codex" }],
    },
    private readonly defaultHarness: string | null = HARNESS_IDS.CODEX_CLI
  ) {}
  getModels(harness: string): readonly WorkflowModelOption[] {
    this.modelRequests.push(harness);
    return this.models[harness] ?? [];
  }
  getAgents(): readonly string[] {
    return ["reviewer"];
  }
  getSkills(): readonly string[] {
    return ["alpha", "beta"];
  }
  getMcpServers(): readonly string[] {
    return ["github"];
  }
  getSecretNames(): readonly string[] {
    return ["API_TOKEN"];
  }
  getDefaultHarness(): string | undefined {
    return this.defaultHarness ?? undefined;
  }
}

/** `§` marks the cursor. */
function complete(
  marked: string,
  kind: CtrlYokeFileKind = WORKFLOW_YAML,
  data: WorkflowValueDataSource = new StubData()
): WorkflowFileCompletions & { text: string } {
  const offset = marked.indexOf("§");
  assert.ok(offset >= 0, "fixture needs a § cursor marker");
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  const result = getWorkflowFileCompletions({
    text,
    offset,
    location: getWorkflowLocation(text, offset, kind),
    documentRoot: parseWorkflowDocumentRoot(text, kind),
    data,
  });
  return { ...result, text };
}

const labels = (result: WorkflowFileCompletions): string[] =>
  result.items.map((item) => item.label);

suite("WorkflowFileCompletionCore: keys", () => {
  test("a prompt step offers prompt keys, minus those present and forbidden", () => {
    const result = complete("steps:\n  - prompt: hi\n    §\n");
    const keys = labels(result);
    assert.ok(keys.includes("harness"));
    assert.ok(keys.includes("endCondition"));
    assert.ok(!keys.includes("prompt"), "already present");
    assert.ok(!keys.includes("script"), "a script step key");
    assert.ok(!keys.includes("worktree"), "forbidden on a step");
    assert.ok(!keys.includes("maxSteps"), "forbidden on a step");
  });

  test("a script step offers script keys only", () => {
    const keys = labels(complete("steps:\n  - type: script\n    §\n"));
    assert.ok(keys.includes("script"));
    assert.ok(keys.includes("compareSource"));
    assert.ok(!keys.includes("prompt"));
  });

  test("a new empty step item offers prompt, script and parallel keys", () => {
    const keys = labels(complete("steps:\n  - §\n"));
    assert.ok(keys.includes("prompt"));
    assert.ok(keys.includes("script"));
    assert.ok(keys.includes("parallel"), "a group is a valid item");
  });

  test("a new item in a parallel group does not offer nested parallel", () => {
    const keys = labels(complete("steps:\n  - parallel:\n      - §\n"));
    assert.ok(keys.includes("prompt"));
    assert.ok(keys.includes("script"));
    assert.ok(!keys.includes("parallel"), "groups cannot nest");
  });

  test("a step with a name but no prompt or script is still undecided", () => {
    const keys = labels(complete("steps:\n  - name: x\n    §\n"));
    assert.ok(keys.includes("prompt"));
    assert.ok(keys.includes("script"));
    assert.ok(!keys.includes("name"));
  });

  test("a step that already chose a prompt does not offer script keys", () => {
    const keys = labels(complete("steps:\n  - prompt: hi\n    §\n"));
    assert.ok(!keys.includes("compareSource"));
  });

  test("the root of a multi-step workflow hides single-step keys", () => {
    const keys = labels(complete("steps:\n  - prompt: hi\n§\n"));
    assert.ok(keys.includes("finalStep"));
    assert.ok(keys.includes("worktree"));
    assert.ok(!keys.includes("steps"), "already present");
    assert.ok(!keys.includes("prompt"));
    assert.ok(!keys.includes("script"));
    assert.ok(!keys.includes("compareSource"));
  });

  test("the root of a single-step prompt workflow hides steps", () => {
    const keys = labels(complete("prompt: hi\n§\n"));
    assert.ok(keys.includes("harness"));
    assert.ok(!keys.includes("steps"));
    assert.ok(!keys.includes("finalStep"));
    assert.ok(!keys.includes("compareSource"));
  });

  test("the root of a single-step script workflow hides steps and prompt", () => {
    const keys = labels(complete("type: script\n§\n"));
    assert.ok(keys.includes("script"));
    assert.ok(keys.includes("worktree"));
    assert.ok(!keys.includes("steps"));
    assert.ok(!keys.includes("prompt"));
    // rootScriptStep rejects prompt-only keys (unevaluatedProperties: false).
    for (const key of ["harness", "model", "agent", "sessionId"]) {
      assert.ok(!keys.includes(key), `script root must not offer ${key}`);
    }
  });

  test("a removed key (returns) is never offered", () => {
    assert.ok(
      !labels(complete("steps:\n  - type: script\n    §\n")).includes("returns")
    );
  });

  test("completing an existing key replaces only the key, keeping its colon", () => {
    const yaml = complete("steps:\n  - prompt: hi\n    harn§ess: claude-cli\n");
    assert.strictEqual(
      yaml.items.find((item) => item.label === "harness")?.insertText,
      "harness"
    );
    const json = complete(
      '{ "steps": [ { "prompt": "x", "harn§ess": "claude-cli" } ] }',
      WORKFLOW_JSON
    );
    assert.strictEqual(
      json.items.find((item) => item.label === "harness")?.insertText,
      '"harness"'
    );
  });

  test("an empty root offers both shapes", () => {
    const keys = labels(complete("§\n"));
    for (const key of ["prompt", "script", "steps", "finalStep"]) {
      assert.ok(keys.includes(key), key);
    }
  });

  test("the first key under a new nested object comes from that object", () => {
    const keys = labels(
      complete("steps:\n  - prompt: hi\n    endCondition:\n      §\n")
    );
    assert.ok(keys.includes("retryPrompt"));
    assert.ok(keys.includes("onFail"));
    assert.ok(!keys.includes("harness"));
  });

  test("key items re-indent multi-line inserts to the key's column", () => {
    const result = complete("steps:\n  - prompt: hi\n    sk§\n");
    const skills = result.items.find((item) => item.label === "skills");
    assert.strictEqual(skills?.insertText, "skills:\n      - ");
    assert.strictEqual(
      result.text.slice(result.replaceRange.start, result.replaceRange.end),
      "sk"
    );
  });

  test("a key after a dash is indented past the dash", () => {
    const result = complete("steps:\n  - sk§\n");
    const skills = result.items.find((item) => item.label === "skills");
    assert.strictEqual(skills?.insertText, "skills:\n      - ");
  });

  test("hooks insert a list item with its required keys", () => {
    const result = complete("steps:\n  - prompt: hi\n    §\n");
    const hooks = result.items.find((item) => item.label === "hooks");
    assert.strictEqual(
      hooks?.insertText,
      "hooks:\n      - event: stop\n        command: "
    );
  });

  test("onPass details come from the owning object's actions", () => {
    const detailOf = (marked: string) =>
      complete(marked).items.find((item) => item.label === "onPass")?.detail;
    assert.strictEqual(
      detailOf("steps:\n  - prompt: hi\n    endCondition:\n      §\n"),
      "continue | retry | stopWorkflow"
    );
    assert.strictEqual(
      detailOf("steps:\n  - prompt: hi\n    preCondition:\n      §\n"),
      "continue | skipPrompt | stopWorkflow"
    );
    assert.strictEqual(
      detailOf("steps:\n  - type: script\n    §\n"),
      "continue | stopWorkflow"
    );
  });

  test("script means a different thing in each object", () => {
    const detail = (kind: WorkflowObjectKindKey) =>
      getWorkflowPropertySnippet(WORKFLOW_OBJECT_KINDS[kind], "script").detail;
    assert.notStrictEqual(detail("END_CONDITION"), detail("PRE_CONDITION"));
    assert.notStrictEqual(detail("END_CONDITION"), detail("SCRIPT_STEP"));
  });

  test("documentation prefers the schema's description", () => {
    const agent = complete("steps:\n  - prompt: hi\n    §\n").items.find(
      (item) => item.label === "agent"
    );
    assert.ok(agent?.documentation?.includes("agent name"));
  });

  test("JSON keys insert a quoted key and replace any quotes already typed", () => {
    const open = complete(
      '{ "steps": [ { "prompt": "x", § } ] }',
      WORKFLOW_JSON
    );
    assert.strictEqual(
      open.items.find((item) => item.label === "harness")?.insertText,
      '"harness": '
    );
    const quoted = complete(
      '{ "steps": [ { "prompt": "x", "ha§" } ] }',
      WORKFLOW_JSON
    );
    assert.strictEqual(
      quoted.items.find((item) => item.label === "harness")?.insertText,
      '"harness": '
    );
    assert.strictEqual(
      quoted.text.slice(quoted.replaceRange.start, quoted.replaceRange.end),
      '"ha"'
    );
  });

  test(".prompt.md frontmatter offers schemaVersion", () => {
    const keys = labels(complete("---\n§\n---\nBody", PROMPT_MARKDOWN));
    assert.deepStrictEqual(keys, ["schemaVersion"]);
  });

  test("prompt text, script text and comments get no items", () => {
    assert.deepStrictEqual(
      complete("steps:\n  - prompt: |\n      Fix §it\n").items,
      []
    );
    assert.deepStrictEqual(
      complete("steps:\n  - prompt: hi # note §\n").items,
      []
    );
  });
});

type WorkflowObjectKindKey = keyof typeof WORKFLOW_OBJECT_KINDS;

suite("WorkflowFileCompletionCore: values", () => {
  test("enum values come from the outline, marking the default", () => {
    const result = complete("steps:\n  - prompt: hi\n    executionMode: §\n");
    assert.deepStrictEqual(labels(result), ["interactive", "headless"]);
  });

  test("a boolean key offers true and false", () => {
    assert.deepStrictEqual(
      labels(complete("steps:\n  - prompt: hi\n    resumeSession: §\n")),
      ["true", "false"]
    );
  });

  test("harness offers every harness", () => {
    assert.deepStrictEqual(
      labels(complete("steps:\n  - prompt: hi\n    harness: §\n")).sort(),
      Object.values(HARNESS_IDS).sort()
    );
  });

  test("model comes from the step's own harness", () => {
    const data = new StubData();
    const result = complete(
      "harness: codex-cli\nsteps:\n  - prompt: hi\n    harness: claude-cli\n    model: §\n",
      WORKFLOW_YAML,
      data
    );
    assert.deepStrictEqual(labels(result), ["none", "claude-sonnet"]);
    assert.deepStrictEqual(data.modelRequests, [HARNESS_IDS.CLAUDE_CLI]);
  });

  test("model falls back to the workflow harness, then the default harness", () => {
    const workflow = complete(
      "harness: claude-cli\nsteps:\n  - prompt: hi\n    model: §\n"
    );
    assert.deepStrictEqual(labels(workflow), ["none", "claude-sonnet"]);
    const fallback = complete("steps:\n  - prompt: hi\n    model: §\n");
    assert.deepStrictEqual(labels(fallback), ["none", "gpt-codex"]);
  });

  test("model offers no list when no harness resolves", () => {
    const data = new StubData({}, null);
    const result = complete(
      "steps:\n  - prompt: hi\n    model: §\n",
      WORKFLOW_YAML,
      data
    );
    assert.deepStrictEqual(labels(result), ["none"]);
    assert.deepStrictEqual(data.modelRequests, []);
  });

  test("model works in JSON, escaped inside the string", () => {
    const result = complete(
      '{ "harness": "claude-cli", "prompt": "x", "model": "§" }',
      WORKFLOW_JSON
    );
    assert.deepStrictEqual(labels(result), ["none", "claude-sonnet"]);
    assert.strictEqual(
      result.items.find((item) => item.label === "claude-sonnet")?.insertText,
      "claude-sonnet"
    );
  });

  test("a JSON value outside a string is inserted quoted", () => {
    const result = complete(
      '{ "prompt": "x", "executionMode": § }',
      WORKFLOW_JSON
    );
    assert.strictEqual(
      result.items.find((item) => item.label === "headless")?.insertText,
      '"headless"'
    );
  });

  test("agents are offered for agent", () => {
    assert.deepStrictEqual(
      labels(complete("steps:\n  - prompt: hi\n    agent: §\n")),
      ["reviewer"]
    );
  });

  test("skills are offered per list item, minus those already listed", () => {
    const result = complete(
      "steps:\n  - prompt: hi\n    skills:\n      - alpha\n      - §\n"
    );
    assert.deepStrictEqual(labels(result), ["beta"]);
    const flow = complete("steps:\n  - prompt: hi\n    skills: [alpha, §]\n");
    assert.deepStrictEqual(labels(flow), ["beta"]);
  });

  test("mcpServers always includes the built-in ctrlyoke server", () => {
    const result = complete(
      "steps:\n  - prompt: hi\n    mcpServers:\n      - §\n"
    );
    assert.deepStrictEqual(labels(result), ["ctrlyoke", "github"]);
  });

  test("secrets come from the registry", () => {
    const result = complete(
      "steps:\n  - prompt: hi\n    secrets:\n      - §\n"
    );
    assert.deepStrictEqual(labels(result), ["API_TOKEN"]);
  });

  test("priorContext offers keywords and earlier steps, numbered from the document", () => {
    const result = complete(
      "steps:\n  - name: Plan\n    prompt: a\n  - prompt: b\n  - prompt: c\n    priorContext: §\n"
    );
    const keywords = [
      "all",
      "previous",
      "none",
      "finalStepAll",
      "finalStepPrevious",
    ];
    for (const keyword of keywords)
      assert.ok(labels(result).includes(keyword), keyword);
    const first = result.items.find((item) => item.label === "[1]");
    assert.strictEqual(first?.insertText, "[1]");
    assert.strictEqual(first?.detail, "Plan");
    assert.ok(labels(result).includes("[2]"));
    assert.ok(!labels(result).includes("[3]"), "a step cannot point at itself");
  });

  test("a priorContext array item offers step numbers", () => {
    const result = complete(
      "steps:\n  - prompt: a\n  - prompt: b\n    priorContext: [1, §]\n"
    );
    assert.deepStrictEqual(labels(result), []);
    const block = complete(
      "steps:\n  - prompt: a\n  - prompt: b\n  - prompt: c\n    priorContext:\n      - §\n"
    );
    assert.deepStrictEqual(labels(block), ["1", "2"]);
  });

  test("step numbers count parallel members after flattening", () => {
    const result = complete(
      "steps:\n  - prompt: a\n  - parallel:\n      - prompt: b\n      - prompt: c\n  - prompt: d\n    priorContext:\n      - §\n"
    );
    assert.deepStrictEqual(labels(result), ["1", "2", "3"]);
  });

  test("a parallel member cannot point at its own group", () => {
    const result = complete(
      "steps:\n  - prompt: a\n  - parallel:\n      - prompt: b\n      - prompt: c\n        priorContext:\n          - §\n"
    );
    assert.deepStrictEqual(labels(result), ["1"]);
  });

  test("sessionId offers finalStep when one exists, plus earlier step numbers", () => {
    const result = complete(
      "steps:\n  - prompt: a\n  - prompt: b\n    sessionId: §\nfinalStep:\n  prompt: z\n"
    );
    assert.deepStrictEqual(labels(result), ["finalStep", "1"]);
    const none = complete(
      "steps:\n  - prompt: a\n  - prompt: b\n    sessionId: §\n"
    );
    assert.deepStrictEqual(labels(none), ["1"]);
  });

  test("sessionId skips script steps, which have no session", () => {
    const result = complete(
      "steps:\n  - type: script\n    script: x\n  - prompt: a\n  - prompt: b\n    sessionId: §\n"
    );
    assert.deepStrictEqual(labels(result), ["2"]);
  });

  test("the final step can reference every queue step", () => {
    const result = complete(
      "steps:\n  - prompt: a\n  - prompt: b\nfinalStep:\n  prompt: z\n  sessionId: §\n"
    );
    assert.deepStrictEqual(labels(result), ["finalStep", "1", "2"]);
  });

  test("numbers are not offered inside a quoted scalar", () => {
    const result = complete(
      'steps:\n  - prompt: a\n  - prompt: b\n    sessionId: "§"\n'
    );
    assert.deepStrictEqual(labels(result), []);
    const priorContext = complete(
      'steps:\n  - prompt: a\n  - prompt: b\n    priorContext: "§"\n'
    );
    assert.ok(
      !labels(priorContext).includes("[1]"),
      "a [N] array inside a string would become text"
    );
  });

  test("values with YAML-special text are quoted; quoted scalars are escaped", () => {
    const data = new StubData({
      [HARNESS_IDS.CLAUDE_CLI]: [{ id: "a: b" }, { id: "yes" }, { id: 'q"x' }],
    });
    const plain = complete(
      "harness: claude-cli\nsteps:\n  - prompt: hi\n    model: §\n",
      WORKFLOW_YAML,
      data
    );
    const insert = (label: string) =>
      plain.items.find((item) => item.label === label)?.insertText;
    assert.strictEqual(insert("a: b"), '"a: b"');
    assert.strictEqual(insert("yes"), '"yes"');
    assert.strictEqual(insert("none"), "none");
    const reserved = complete(
      "steps:\n  - prompt: hi\n    mcpServers:\n      - §\n",
      WORKFLOW_YAML,
      new (class extends StubData {
        override getMcpServers(): readonly string[] {
          return ["@scope/srv", ".inf"];
        }
      })()
    );
    const reservedInsert = (label: string) =>
      reserved.items.find((item) => item.label === label)?.insertText;
    assert.strictEqual(reservedInsert("@scope/srv"), '"@scope/srv"');
    assert.strictEqual(reservedInsert(".inf"), '".inf"');
    const double = complete(
      'harness: claude-cli\nsteps:\n  - prompt: hi\n    model: "§"\n',
      WORKFLOW_YAML,
      data
    );
    assert.strictEqual(
      double.items.find((item) => item.label === 'q"x')?.insertText,
      'q\\"x'
    );
  });

  test("the replace range covers the partial value", () => {
    const result = complete("steps:\n  - prompt: hi\n    harness: cla§\n");
    assert.strictEqual(
      result.text.slice(result.replaceRange.start, result.replaceRange.end),
      "cla"
    );
    const empty = complete("steps:\n  - prompt: hi\n    harness: §\n");
    assert.strictEqual(empty.replaceRange.start, empty.replaceRange.end);
  });

  test("keys with no value list offer nothing", () => {
    assert.deepStrictEqual(complete("steps:\n  - name: §\n").items, []);
  });
});

suite("escapeJsonStringFragment", () => {
  test("escapes quotes, backslashes and line breaks", () => {
    assert.strictEqual(escapeJsonStringFragment('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  });
});
