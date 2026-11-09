import * as assert from "assert";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import {
  deriveStepStatusesFromRuntime,
  getResumableTerminalFailedGroup,
  isGroupMemberRetried,
  isUnstartedRun,
  isUnstartedRunFile,
} from "../../utils/StepStatusDerivation";

suite("isUnstartedRun", () => {
  const unstarted = {
    executionState: EXECUTION_STATES.IDLE,
    currentIndex: 0,
    finalStepStatus: null,
    steps: [{ _runtime: {} }, {}],
  };

  test("treats identity-only step runtime as unstarted", () => {
    // The real seeded shape: `ensureStepIds` stores each stepId in `_runtime`.
    const seededSteps = [
      { _runtime: { stepId: "a" } },
      { _runtime: { stepId: "b" } },
    ];
    assert.strictEqual(
      isUnstartedRunFile({
        _runtime: { executionState: EXECUTION_STATES.IDLE, currentIndex: 0 },
        steps: seededSteps,
      }),
      true
    );
    assert.strictEqual(isUnstartedRun(unstarted), true);
  });

  test("any execution evidence means started", () => {
    for (const change of [
      { executionState: EXECUTION_STATES.COMPLETED },
      { currentIndex: 1 },
      { finalStepStatus: STEP_STATUS.COMPLETED },
      { steps: [{ _runtime: { startedAt: 1 } }] },
      { steps: [{ _runtime: { completedAt: 1 } }] },
    ]) {
      assert.strictEqual(
        isUnstartedRun({ ...unstarted, ...change }),
        false,
        JSON.stringify(change)
      );
    }
  });
});

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

  test("does not mark appended pending steps in flight during final-step execution", () => {
    const statuses = deriveStepStatusesFromRuntime(
      [
        { _runtime: { completedAt: 1 } },
        { _runtime: { completedAt: 2 } },
        {},
        {},
      ],
      2,
      EXECUTION_STATES.RUNNING,
      STEP_STATUS.RUNNING,
      FINAL_STEP_PHASES.FINAL_STEP
    );

    assert.deepStrictEqual(statuses, [
      STEP_STATUS.COMPLETED,
      STEP_STATUS.COMPLETED,
      STEP_STATUS.PENDING,
      STEP_STATUS.PENDING,
    ]);
  });

  test("keeps a started parallel member in flight during final-step execution", () => {
    const statuses = deriveStepStatusesFromRuntime(
      [{ _runtime: { startedAt: 3 } }, {}],
      0,
      EXECUTION_STATES.RUNNING,
      STEP_STATUS.RUNNING,
      FINAL_STEP_PHASES.FINAL_STEP
    );

    assert.deepStrictEqual(statuses, [
      STEP_STATUS.RUNNING,
      STEP_STATUS.PENDING,
    ]);
  });

  test("keeps the current step in flight while pausing or cancelling", () => {
    // Pause lets the in-flight step finish before the run pauses, and cancel
    // waits for its process to exit, so the step is still executing.
    const steps = [
      { _runtime: { completedAt: 1 } },
      { _runtime: { startedAt: 2 } },
      {},
    ];

    for (const state of [
      EXECUTION_STATES.PAUSING,
      EXECUTION_STATES.CANCELLING,
    ]) {
      assert.deepStrictEqual(
        deriveStepStatusesFromRuntime(steps, 1, state),
        [STEP_STATUS.COMPLETED, STEP_STATUS.RUNNING, STEP_STATUS.PENDING],
        state
      );
    }
  });

  test("paints every claimed-but-unsettled parallel member in flight", () => {
    // currentIndex stays pinned at the group's startIndex until the join, so a
    // positional rule would report members 1 and 2 as PENDING while workers
    // are executing them.
    const statuses = deriveStepStatusesFromRuntime(
      [
        { _runtime: { startedAt: 1, completedAt: 2 } },
        { _runtime: { startedAt: 3 } },
        { _runtime: { startedAt: 4 } },
        {},
      ],
      0,
      EXECUTION_STATES.RUNNING
    );

    assert.deepStrictEqual(statuses, [
      STEP_STATUS.COMPLETED,
      STEP_STATUS.RUNNING,
      STEP_STATUS.RUNNING,
      STEP_STATUS.PENDING,
    ]);
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

suite("failed parallel group recovery", () => {
  const group = { startIndex: 1, endIndex: 3 };
  const settled = (terminalStatus: string, terminalFailure?: boolean) => ({
    _runtime: {
      startedAt: 1,
      completedAt: 2,
      terminalStatus,
      ...(terminalFailure === undefined ? {} : { terminalFailure }),
    },
  });

  test("finds the group a terminal member failure ended the run in", () => {
    const steps = [
      settled(STEP_STATUS.COMPLETED),
      settled(STEP_STATUS.FAILED),
      settled(STEP_STATUS.CANCELLED),
      settled(STEP_STATUS.COMPLETED),
    ] as never[];
    const state = {
      executionState: EXECUTION_STATES.ERROR,
      currentIndex: 4,
      steps,
      parallelGroups: [group],
    };

    assert.strictEqual(getResumableTerminalFailedGroup(state), group);
    assert.strictEqual(
      getResumableTerminalFailedGroup({ ...state, currentIndex: 3 }),
      undefined
    );
    assert.strictEqual(
      getResumableTerminalFailedGroup({
        ...state,
        executionState: EXECUTION_STATES.COMPLETED,
      }),
      undefined
    );
  });

  test("ignores a group whose only failure let the workflow continue", () => {
    const steps = [
      settled(STEP_STATUS.COMPLETED),
      settled(STEP_STATUS.FAILED, false),
      settled(STEP_STATUS.COMPLETED),
      settled(STEP_STATUS.COMPLETED),
    ] as never[];

    assert.strictEqual(
      getResumableTerminalFailedGroup({
        executionState: EXECUTION_STATES.ERROR,
        currentIndex: 4,
        steps,
        parallelGroups: [group],
      }),
      undefined
    );
  });

  test("retries every member that did not succeed", () => {
    assert.strictEqual(
      isGroupMemberRetried(settled(STEP_STATUS.FAILED) as never),
      true
    );
    assert.strictEqual(
      isGroupMemberRetried(settled(STEP_STATUS.CANCELLED) as never),
      true
    );
    assert.strictEqual(
      isGroupMemberRetried({ _runtime: { startedAt: 1 } }),
      true
    );
    assert.strictEqual(
      isGroupMemberRetried(settled(STEP_STATUS.COMPLETED) as never),
      false
    );
    assert.strictEqual(
      isGroupMemberRetried(settled(STEP_STATUS.SKIPPED) as never),
      false
    );
  });
});
