import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptQueue } from "../../core/PromptQueue";
import type { ConditionEvaluationSummary } from "../../types/CtrlYokeTypes";
import {
  CONDITION_ACTIONS,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";

const summary: ConditionEvaluationSummary = {
  passed: false,
  action: CONDITION_ACTIONS.SKIP_PROMPT,
  script: "check.js",
  actual: "1",
  stdout: "out",
  stderr: "err",
  exitCode: 1,
  durationMs: 4,
  error: "failed",
};

suite("PromptQueue condition summaries", () => {
  test("keeps queue result mutation behind narrow recording methods", () => {
    const queue = new PromptQueue();
    queue.loadPrompts({ steps: [{ prompt: "step" }] });

    queue.recordPreConditionSummary(0, summary);
    queue.recordEndConditionSummary(0, { ...summary, action: undefined });

    const result = queue.getState().results[0];
    assert.deepStrictEqual(result.preCondition, summary);
    assert.strictEqual(result.endCondition?.passed, false);
    assert.strictEqual(result.endConditionResult, false);
    assert.strictEqual(result.scriptOutput, "out");
  });

  test("records both condition kinds on final-step runtime", () => {
    const queue = new PromptQueue();

    queue.recordFinalStepPreConditionSummary(summary);
    queue.recordFinalStepEndConditionSummary({ ...summary, passed: true });

    assert.deepStrictEqual(queue.getFinalStepRuntime(), {
      phase: FINAL_STEP_PHASES.FINAL_STEP,
      loopCount: 0,
      preCondition: summary,
      endCondition: { ...summary, passed: true },
    });
  });

  test("reads condition summaries for queue and final-step targets", () => {
    const queue = new PromptQueue();
    queue.loadPrompts({ steps: [{ prompt: "step" }] });
    const queuePreCondition = { ...summary, expected: "0" };
    const queueEndCondition = {
      ...summary,
      passed: true,
      compareSource: "stdout" as const,
    };
    queue.recordPreConditionSummary(0, queuePreCondition);
    queue.recordEndConditionSummary(0, queueEndCondition);

    assert.deepStrictEqual(
      queue.getPreConditionSummary({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 0,
      }),
      queuePreCondition
    );
    assert.deepStrictEqual(
      queue.getEndConditionSummary({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 0,
      }),
      queueEndCondition
    );
    assert.strictEqual(
      queue.getPreConditionSummary({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 1,
      }),
      undefined
    );

    queue.recordFinalStepPreConditionSummary(queuePreCondition);
    queue.recordFinalStepEndConditionSummary(queueEndCondition);
    assert.deepStrictEqual(
      queue.getPreConditionSummary({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: 0,
      }),
      queuePreCondition
    );
    assert.deepStrictEqual(
      queue.getEndConditionSummary({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: 0,
      }),
      queueEndCondition
    );
  });
});
