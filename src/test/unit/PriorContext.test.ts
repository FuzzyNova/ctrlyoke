import * as assert from "assert";
import { suite, test } from "mocha";
import { buildPriorContextXmlFromItems } from "../../core/HarnessIntegration";
import type { ScriptVerdict } from "../../types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  PRIOR_CONTEXT_ITEM_TYPES,
  SCRIPT_OPERATORS,
  SCRIPT_VERDICT_OUTCOMES,
} from "../../types/DashboardConstants";
import { inlinePriorContextRefToPriorContext } from "../../utils/PriorContextMerge";

suite("prior-context XML", () => {
  test("formats queue, script, and final-loop values supplied by the resolver", () => {
    const xml = buildPriorContextXmlFromItems([
      { index: 0, name: "plan", prompt: "plan it", text: "answer" },
      {
        index: 1,
        name: "test",
        text: "pass\n0",
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
      { index: 0, prompt: "plan it", text: "answer" },
      { index: 1, text: "3 failing\n1", scriptOutput },
    ]);

    assert.strictEqual(
      xml,
      '<priorContext>\n<step index="1">\n<prompt>\nplan it\n</prompt>\n<response>\nanswer\n</response>\n</step>\n<step index="2" type="script">\n<command>\nnpm test\n</command>\n<stdout>\n3 failing\n</stdout>\n<exitCode>1</exitCode>\n</step>\n</priorContext>'
    );
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
