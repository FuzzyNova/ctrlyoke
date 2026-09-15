import * as assert from "assert";
import { EXECUTION_STATES, STEP_STATUS } from "../../types/DashboardConstants";
import { deriveStepStatusesFromRuntime } from "../../utils/StepStatusDerivation";

suite("StepStatusDerivation", () => {
  test("reads each step's own terminal status rather than its position", () => {
    // `commitStepOutcomeAndAdvance` advances currentIndex past a step even when
    // that step's outcome stopped the workflow, so index 3 here is the failure
    // and index 4 never ran — despite currentIndex sitting at 4.
    const statuses = deriveStepStatusesFromRuntime(
      [
        { _runtime: { completedAt: 1, terminalStatus: STEP_STATUS.COMPLETED } },
        { _runtime: { completedAt: 2, terminalStatus: STEP_STATUS.CANCELLED } },
        { _runtime: { completedAt: 3, terminalStatus: STEP_STATUS.SKIPPED } },
        { _runtime: { completedAt: 4, terminalStatus: STEP_STATUS.FAILED } },
        {},
      ],
      4,
      EXECUTION_STATES.ERROR
    );

    assert.deepStrictEqual(statuses, [
      STEP_STATUS.COMPLETED,
      STEP_STATUS.CANCELLED,
      STEP_STATUS.SKIPPED,
      STEP_STATUS.FAILED,
      STEP_STATUS.PENDING,
    ]);
  });

  test("treats a settled step with no recorded terminal status as completed", () => {
    const statuses = deriveStepStatusesFromRuntime(
      [{ _runtime: { completedAt: 1 } }],
      1,
      EXECUTION_STATES.COMPLETED
    );

    assert.deepStrictEqual(statuses, [STEP_STATUS.COMPLETED]);
  });

  test("marks only the current step in flight, and only while running", () => {
    const steps = [{ _runtime: { completedAt: 1 } }, {}, {}];

    assert.deepStrictEqual(
      deriveStepStatusesFromRuntime(steps, 1, EXECUTION_STATES.RUNNING),
      [STEP_STATUS.COMPLETED, STEP_STATUS.RUNNING, STEP_STATUS.PENDING]
    );
    // A paused/stopped run has no in-flight step to paint.
    assert.deepStrictEqual(
      deriveStepStatusesFromRuntime(steps, 1, EXECUTION_STATES.PAUSED),
      [STEP_STATUS.COMPLETED, STEP_STATUS.PENDING, STEP_STATUS.PENDING]
    );
  });

  test("honours the caller's in-flight status", () => {
    // The addressed run-view snapshot paints the in-flight step SENT, while the
    // live external-run push paints it RUNNING.
    assert.deepStrictEqual(
      deriveStepStatusesFromRuntime(
        [{}],
        0,
        EXECUTION_STATES.RUNNING,
        STEP_STATUS.SENT
      ),
      [STEP_STATUS.SENT]
    );
  });
});
