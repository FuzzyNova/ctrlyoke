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
  actualSource: "exitCode",
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
});
