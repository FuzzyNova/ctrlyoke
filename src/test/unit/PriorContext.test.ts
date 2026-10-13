import * as assert from "assert";
import { suite, test } from "mocha";
import { buildPriorContextXmlFromItems } from "../../core/HarnessIntegration";
import type { ScriptVerdict } from "../../types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  PRIOR_CONTEXT_ITEM_TYPES,
  PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS,
  PRIOR_CONTEXT_LIMITS,
  SCRIPT_OPERATORS,
  SCRIPT_VERDICT_OUTCOMES,
} from "../../types/DashboardConstants";
import { inlinePriorContextRefToPriorContext } from "../../utils/PriorContextMerge";

suite("prior-context XML", () => {
  test("formats queue, script, and final-loop values supplied by the resolver", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        name: "plan",
        prompt: "plan it",
        text: "answer",
        detail: "full",
      },
      {
        index: 1,
        name: "test",
        text: "pass\n0",
        detail: "full",
        scriptOutput: {
          command: "npm test",
          stdout: "pass",
          stderr: "",
          exitCode: 0,
        },
      },
      {
        index: 2,
        text: "final answer",
        detail: "full",
        type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
      },
    ]);

    assert.ok(xml.includes("<priorContext>"));
    assert.ok(xml.includes("<prompt>\nplan it\n</prompt>"));
    assert.ok(xml.includes("<command>\nnpm test\n</command>"));
    assert.ok(
      xml.includes(
        `<step index="3" type="${PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP}">`
      )
    );
  });

  const verdict = (overrides: Partial<ScriptVerdict>): ScriptVerdict => ({
    compareSource: COMPARE_SOURCES.EXIT_CODE,
    operator: SCRIPT_OPERATORS.EQ,
    expected: "0",
    actual: "0",
    exitCode: 0,
    outcome: SCRIPT_VERDICT_OUTCOMES.PASSED,
    action: CONDITION_ACTIONS.CONTINUE,
    durationMs: 5,
    ...overrides,
  });
  const scriptOutput = {
    command: "npm test",
    stdout: "3 failing",
    stderr: "",
    exitCode: 1,
  };

  test("renders a script step's verdict after its exit code", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        text: "3 failing\n1",
        detail: "full",
        scriptOutput,
        scriptVerdict: verdict({
          actual: "1",
          exitCode: 1,
          outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
          action: CONDITION_ACTIONS.STOP_WORKFLOW,
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<exitCode>1</exitCode>\n<verdict outcome="failed" compareSource="exitCode" operator="eq" expected="0" actual="1"/>\n</step>'
      ),
      xml
    );
  });

  test("states the exit-code fallback when no expected value is set", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        text: "3 failing\n1",
        detail: "full",
        scriptOutput,
        scriptVerdict: verdict({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.CONTAINS,
          expected: undefined,
          actual: "3 failing",
          exitCode: 1,
          outcome: SCRIPT_VERDICT_OUTCOMES.FAILED,
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<verdict outcome="failed" compareSource="exitCode" operator="eq" expected="0" actual="1"/>'
      ),
      xml
    );
  });

  test("does not repeat a stream actual and escapes attribute values", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        text: "3 failing\n1",
        scriptOutput,
        detail: "full",
        scriptVerdict: verdict({
          compareSource: COMPARE_SOURCES.STDOUT,
          operator: SCRIPT_OPERATORS.MATCHES,
          expected: '"<0> & ok"',
          actual: "3 failing",
          outcome: SCRIPT_VERDICT_OUTCOMES.ERRORED,
          timedOut: true,
          error: "timed out\n  after 5s",
        }),
      },
    ]);

    assert.ok(
      xml.includes(
        '<verdict outcome="errored" compareSource="stdout" operator="matches" expected="&quot;&lt;0&gt; &amp; ok&quot;" timedOut="true" reason="timed out after 5s"/>'
      ),
      xml
    );
  });

  test("renders a script finalStep's verdict after its response", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        text: "ok",
        detail: "full",
        type: PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP,
        scriptVerdict: verdict({}),
      },
    ]);

    assert.ok(
      xml.includes(
        '<response>\nok\n</response>\n<verdict outcome="passed" compareSource="exitCode" operator="eq" expected="0" actual="0"/>\n</step>'
      ),
      xml
    );
  });

  test("leaves steps without a verdict unchanged", () => {
    const xml = buildPriorContextXmlFromItems([
      { index: 0, prompt: "plan it", text: "answer", detail: "full" },
      { index: 1, text: "3 failing\n1", scriptOutput, detail: "full" },
    ]);

    assert.strictEqual(
      xml,
      '<priorContext>\n<step index="1">\n<prompt>\nplan it\n</prompt>\n<response>\nanswer\n</response>\n</step>\n<step index="2" type="script">\n<command>\nnpm test\n</command>\n<stdout>\n3 failing\n</stdout>\n<exitCode>1</exitCode>\n</step>\n</priorContext>'
    );
  });

  test("renders every full transcript entry and escapes event attributes", () => {
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        detail: "full",
        transcript: [
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING,
            text: "consider",
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.EDIT,
            path: 'src/a&".ts',
            added: 2,
            removed: 1,
            diff: {
              text: "--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new\n+line",
              omitted: "end",
              omittedBytes: 22,
            },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.CREATE,
            path: "src/new.ts",
            added: 1,
            diff: { text: "+new" },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.DELETE,
            path: "src/old.ts",
            failed: true,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND,
            command: "npm test",
            exitCode: 1,
            output: { text: "failed", omitted: "start", omittedBytes: 90 },
            failed: true,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.READ,
            path: "src/a.ts",
            lineStart: 3,
            lineEnd: 8,
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TOOL,
            name: "server/tool",
            arguments: { text: '{"x":1}' },
            result: { text: "done" },
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.SEARCH,
            query: "A & B",
            results: [{ title: "Result", url: "https://example.test" }],
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.QUESTION,
            questions: [{ question: "Continue?", options: [] }],
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.USER_STEER,
            text: "Keep going",
          },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TERMINAL_OUTPUT,
            text: "crashed",
            reason: "exit & failed",
          },
        ],
        earlierAttempts: {
          count: 2,
          filesChanged: [
            { path: "src/old.ts", operation: "deleted", added: 0, removed: 0 },
          ],
        },
      },
    ]);

    for (const fragment of [
      "<thinking>\nconsider\n</thinking>",
      '<edit path="src/a&amp;&quot;.ts" added="2" removed="1" omitted="end" omittedBytes="22">',
      '<create path="src/new.ts" added="1">',
      '<delete path="src/old.ts" failed="true"/>',
      '<command exitCode="1" failed="true" omitted="start" omittedBytes="90">',
      '<read path="src/a.ts" lines="3-8"/>',
      '<tool name="server/tool">',
      '<search query="A &amp; B">',
      "<question>",
      "<userSteer>\nKeep going\n</userSteer>",
      '<terminalOutput reason="exit &amp; failed">\ncrashed\n</terminalOutput>',
      '<earlierAttempts count="2">\n<filesChanged>\nRemoved src/old.ts',
    ])
      assert.ok(xml.includes(fragment), `missing ${fragment}: ${xml}`);
  });

  test("renders summary as a bounded text projection with prompt head and net files", () => {
    const prompt = `head\n${"p".repeat(PRIOR_CONTEXT_LIMITS.PROMPT_HEAD_BYTES + 32)}`;
    const response = `${"r".repeat(PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES + 24)}\nconclusion`;
    const xml = buildPriorContextXmlFromItems([
      {
        index: 0,
        detail: "summary",
        prompt,
        transcript: [
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.THINKING,
            text: "omit thinking",
          },
          { kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.TEXT, text: response },
          {
            kind: PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS.COMMAND,
            command: "omit command",
            exitCode: 0,
            output: { text: "omit output" },
          },
        ],
        filesChanged: [
          { path: "src/added.ts", operation: "created", added: 2, removed: 0 },
        ],
      },
    ]);

    assert.ok(xml.includes('<step index="1" detail="summary">'));
    assert.ok(
      xml.includes(
        `<prompt omitted="end" omittedBytes="${Buffer.byteLength(prompt) - PRIOR_CONTEXT_LIMITS.PROMPT_HEAD_BYTES}">`
      )
    );
    assert.ok(
      xml.includes(
        `<response omitted="start" omittedBytes="${Buffer.byteLength(response) - PRIOR_CONTEXT_LIMITS.OUTPUT_TAIL_BYTES}">`
      )
    );
    assert.ok(xml.includes("conclusion"));
    assert.ok(xml.includes("Added src/added.ts +2\n"), xml);
    assert.ok(!xml.includes("omit thinking"));
    assert.ok(!xml.includes("omit command"));
  });

  test("maps inline references to the resolver's canonical context selectors", () => {
    assert.strictEqual(
      inlinePriorContextRefToPriorContext({ kind: "previous" }),
      "previous"
    );
    assert.deepStrictEqual(
      inlinePriorContextRefToPriorContext({ kind: "previous", count: 3 }),
      {
        previous: 3,
      }
    );
    assert.strictEqual(
      inlinePriorContextRefToPriorContext({ kind: "finalStep" }),
      "finalStepPrevious"
    );
    assert.deepStrictEqual(
      inlinePriorContextRefToPriorContext({ kind: "step", indices: [1, 3] }),
      [1, 3]
    );
  });
});
