import * as assert from "assert";
import { suite, test } from "mocha";
import { buildPriorContextXmlFromItems } from "../../core/HarnessIntegration";
import { PRIOR_CONTEXT_ITEM_TYPES } from "../../types/DashboardConstants";
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
