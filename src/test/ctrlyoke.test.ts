import * as assert from "assert";
import { PromptFileParser } from "../core/PromptFileParser";
import { PromptQueue } from "../core/PromptQueue";
import { ValidationUtils } from "../utils/ValidationUtils";
import { EXECUTION_STATES } from "../types/DashboardConstants";
import { PromptFile } from "../types/CtrlYokeTypes";

/**
 * Helper to wrap prompts array into PromptFile for tests
 */
function createPromptFile(prompts: any[]): PromptFile {
  return { steps: prompts };
}

suite("ctrlyoke Core Tests", () => {
  test("PromptFileParser should be instantiable", () => {
    const parser = new PromptFileParser();
    assert.ok(parser);
  });

  test("PromptQueue should be instantiable", () => {
    const queue = new PromptQueue();
    assert.ok(queue);
  });

  test("PromptQueue should start with idle state", () => {
    const queue = new PromptQueue();
    const state = queue.getState();
    assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    assert.strictEqual(state.currentIndex, 0);
    assert.strictEqual(state.steps.length, 0);
    assert.strictEqual(state.results.length, 0);
  });

  test("ValidationUtils should validate prompt items correctly", () => {
    const validPrompt = {
      prompt: "Test prompt",
      endCondition: {
        script: "test.py",
        expected: "true",
      },
    };

    const result = ValidationUtils.validatePromptStep(validPrompt);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  test("ValidationUtils should catch invalid prompt items", () => {
    const invalidPrompt = {
      // Missing required 'prompt' field
      endCondition: {
        script: "test.py",
        expected: "true",
      },
    };

    const result = ValidationUtils.validatePromptStep(invalidPrompt);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  test("ValidationUtils should validate script paths", () => {
    const validPath = "test.py";
    const result = ValidationUtils.validateScriptPath(validPath);
    assert.strictEqual(result.valid, true);

    const invalidPath = "../../../dangerous.sh";
    const invalidResult = ValidationUtils.validateScriptPath(invalidPath);
    assert.strictEqual(invalidResult.valid, false);
  });

  test("PromptQueue should load prompts correctly", () => {
    const queue = new PromptQueue();
    const steps = [{ prompt: "First prompt" }, { prompt: "Second prompt" }];

    queue.loadPrompts(createPromptFile(steps));
    const state = queue.getState();

    assert.strictEqual(state.steps.length, 2);
    assert.strictEqual(state.results.length, 2);
    assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
  });

  test("PromptQueue should track progress correctly", () => {
    const queue = new PromptQueue();
    const steps = [
      { prompt: "First prompt" },
      { prompt: "Second prompt" },
      { prompt: "Third prompt" },
    ];

    queue.loadPrompts(createPromptFile(steps));
    const progress = queue.getProgress();

    assert.strictEqual(progress.total, 3);
    assert.strictEqual(progress.current, 0);
    assert.strictEqual(progress.percentage, 0);
  });
});
