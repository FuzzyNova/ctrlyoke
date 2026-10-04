import * as assert from "assert";
import {
  ensureStepIds,
  findStepIndexById,
  resetStepRuntimeForRewind,
  validateUniqueStepIds,
} from "../../core/StepIdentity";
import { stripStepRuntime } from "../../core/WorkflowStepSanitizer";
import type { PromptStep } from "../../types/CtrlYokeTypes";

suite("StepIdentity", () => {
  test("assigns unique IDs and resolves them by current index", () => {
    const steps = ensureStepIds([{ prompt: "first" }, { prompt: "second" }]);

    const ids = steps.map((step) => step._runtime?.stepId);
    assert.ok(ids[0]);
    assert.ok(ids[1]);
    assert.notStrictEqual(ids[0], ids[1]);
    assert.strictEqual(findStepIndexById(steps, ids[1]!), 1);
    assert.strictEqual(findStepIndexById(steps, "missing"), -1);
  });

  test("preserves existing IDs while assigning only missing IDs", () => {
    const original: PromptStep = {
      prompt: "first",
      _runtime: { stepId: "stable-first" },
    };
    const steps = ensureStepIds([original, { prompt: "second" }]);

    assert.strictEqual(steps[0], original);
    assert.strictEqual(steps[0]._runtime?.stepId, "stable-first");
    assert.ok(steps[1]._runtime?.stepId);
    assert.doesNotThrow(() => validateUniqueStepIds(steps));
  });

  test("does not assign an earlier fallback ID already used by a later step", () => {
    const originalA: PromptStep = {
      prompt: "A",
      _runtime: { stepId: "step-a" },
    };
    const originalB: PromptStep = {
      prompt: "B",
      _runtime: { stepId: "step-b" },
    };

    const steps = ensureStepIds(
      [{ prompt: "new" }, originalA, originalB],
      [originalA, originalB]
    );

    assert.deepStrictEqual(steps.slice(1), [originalA, originalB]);
    assert.notStrictEqual(steps[0]._runtime?.stepId, "step-a");
    assert.strictEqual(
      new Set(steps.map((step) => step._runtime?.stepId)).size,
      3
    );
    assert.doesNotThrow(() => validateUniqueStepIds(steps));
  });

  test("rejects duplicate IDs within one run", () => {
    assert.throws(
      () =>
        ensureStepIds([
          { prompt: "first", _runtime: { stepId: "duplicate" } },
          { prompt: "second", _runtime: { stepId: "duplicate" } },
        ]),
      /Duplicate stepId "duplicate"/
    );
  });

  test("clears execution runtime during rewind while preserving identity", () => {
    const step: PromptStep = {
      prompt: "rewind me",
      _runtime: {
        stepId: "rewind-id",
        startedAt: 10,
        completedAt: 20,
        sessionId: "stale-session",
        terminalStatus: "completed",
      },
    };

    assert.deepStrictEqual(resetStepRuntimeForRewind(step), {
      prompt: "rewind me",
      _runtime: { stepId: "rewind-id" },
    });
  });

  test("strips step IDs with runtime for authored Save As output", () => {
    assert.deepStrictEqual(
      stripStepRuntime([
        {
          prompt: "authored",
          _runtime: { stepId: "run-only", startedAt: 10 },
        },
      ]),
      [{ prompt: "authored" }]
    );
  });
});
