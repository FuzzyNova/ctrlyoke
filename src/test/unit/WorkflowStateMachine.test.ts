import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowStateMachine } from "../../core/WorkflowStateMachine";
import type { WorkflowStopReason } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  GUARDRAIL_STOP_CODES,
  WORKFLOW_ATTEMPT_COMMANDS,
  WORKFLOW_ATTEMPT_STATUS,
} from "../../types/DashboardConstants";

suite("WorkflowStateMachine", () => {
  test("records guardrail reasons and clears them on continue or restart", () => {
    const runtime = new WorkflowStateMachine();
    const stopReason = {
      code: GUARDRAIL_STOP_CODES.QUEUE_SIZE_LIMIT,
      threshold: 10,
      observed: 11,
      unit: "steps" as const,
      message: "Step limit reached",
    };
    let failedTransitionReason: WorkflowStopReason | undefined;
    runtime.onDidTransition((transition) => {
      if (transition.current.status === EXECUTION_STATES.ERROR) {
        failedTransitionReason = transition.current.stopReason;
      }
    });

    runtime.startExecution();
    runtime.fail(stopReason);
    assert.deepStrictEqual(runtime.getSnapshot().stopReason, stopReason);
    assert.deepStrictEqual(failedTransitionReason, stopReason);

    runtime.restore({
      ...runtime.getSnapshot(),
      status: EXECUTION_STATES.STOPPED,
      stopped: true,
    });
    assert.strictEqual(runtime.resume(), true);
    assert.strictEqual(runtime.getSnapshot().stopReason, undefined);

    runtime.fail(stopReason);
    runtime.reset();
    assert.strictEqual(runtime.getSnapshot().stopReason, undefined);
  });

  test("cancellations and ordinary failures do not carry a guardrail code", () => {
    const cancelled = new WorkflowStateMachine();
    cancelled.startExecution();
    cancelled.requestStop();
    cancelled.confirmStopped();
    assert.strictEqual(cancelled.getSnapshot().stopReason, undefined);

    const failed = new WorkflowStateMachine();
    failed.startExecution();
    failed.fail();
    assert.strictEqual(failed.getSnapshot().stopReason, undefined);
  });

  test("a later reasonless fail keeps the recorded guardrail reason", () => {
    const runtime = new WorkflowStateMachine();
    const stopReason = {
      code: GUARDRAIL_STOP_CODES.WORKFLOW_TIME_LIMIT,
      threshold: 1,
      observed: 2,
      unit: "seconds" as const,
      message: "Workflow stopped",
    };
    runtime.startExecution();
    runtime.fail(stopReason);

    assert.strictEqual(runtime.fail(), false);
    assert.deepStrictEqual(runtime.getSnapshot().stopReason, stopReason);
  });

  test("emits ordered runtime transitions with previous and current snapshots", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<{
      command: string;
      from: string;
      to: string;
      stopped: boolean;
    }> = [];

    runtime.onDidTransition((transition) => {
      transitions.push({
        command: transition.command,
        from: transition.previous.status,
        to: transition.current.status,
        stopped: transition.current.stopped,
      });
    });

    assert.strictEqual(runtime.startExecution(), true);
    assert.strictEqual(runtime.pause(), true);
    assert.strictEqual(runtime.confirmPaused(), true);
    assert.strictEqual(runtime.resume(), true);
    assert.strictEqual(runtime.requestStop(), true);
    assert.strictEqual(runtime.confirmStopped(), true);

    assert.deepStrictEqual(transitions, [
      {
        command: "startExecution",
        from: EXECUTION_STATES.IDLE,
        to: EXECUTION_STATES.RUNNING,
        stopped: false,
      },
      {
        command: "pause",
        from: EXECUTION_STATES.RUNNING,
        to: EXECUTION_STATES.PAUSING,
        stopped: false,
      },
      {
        command: "confirmPaused",
        from: EXECUTION_STATES.PAUSING,
        to: EXECUTION_STATES.PAUSED,
        stopped: false,
      },
      {
        command: "resume",
        from: EXECUTION_STATES.PAUSED,
        to: EXECUTION_STATES.RUNNING,
        stopped: false,
      },
      {
        command: "requestStop",
        from: EXECUTION_STATES.RUNNING,
        to: EXECUTION_STATES.CANCELLING,
        stopped: true,
      },
      {
        command: "confirmStopped",
        from: EXECUTION_STATES.CANCELLING,
        to: EXECUTION_STATES.STOPPED,
        stopped: true,
      },
    ]);
  });

  test("cancelPause transitions PAUSING → RUNNING", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<{ command: string; from: string; to: string }> =
      [];

    runtime.onDidTransition((t) => {
      transitions.push({
        command: t.command,
        from: t.previous.status,
        to: t.current.status,
      });
    });

    assert.strictEqual(runtime.startExecution(), true);
    assert.strictEqual(runtime.pause(), true);
    assert.strictEqual(runtime.cancelPause(), true);

    assert.deepStrictEqual(transitions, [
      {
        command: "startExecution",
        from: EXECUTION_STATES.IDLE,
        to: EXECUTION_STATES.RUNNING,
      },
      {
        command: "pause",
        from: EXECUTION_STATES.RUNNING,
        to: EXECUTION_STATES.PAUSING,
      },
      {
        command: "cancelPause",
        from: EXECUTION_STATES.PAUSING,
        to: EXECUTION_STATES.RUNNING,
      },
    ]);
  });

  test("cancelPause is no-op when not in PAUSING state", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<string> = [];
    runtime.onDidTransition((t) => transitions.push(t.command));

    // No-op from IDLE
    assert.strictEqual(runtime.cancelPause(), false);
    assert.deepStrictEqual(transitions, []);

    // No-op from PAUSED (already confirmed)
    runtime.startExecution();
    runtime.pause();
    runtime.confirmPaused();
    transitions.length = 0;
    assert.strictEqual(runtime.cancelPause(), false);
    assert.deepStrictEqual(transitions, []);
  });

  test("emits ordered attempt transitions and preserves retry metadata", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<{
      command: string;
      attemptIndex: number;
      status: string;
      retryCount?: number;
      maxRetries?: number;
    }> = [];
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 };

    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        attemptIndex: transition.current.attemptIndex,
        status: transition.current.status,
        retryCount: transition.current.retryCount,
        maxRetries: transition.current.maxRetries,
      });
    });

    runtime.beginAttempt(target, 0, 100);
    runtime.scheduleRetry(target, 1, 1, 2, 200);
    runtime.beginAttempt(target, 1, 250);
    runtime.completeAttempt(target, 1, 400);

    assert.deepStrictEqual(transitions, [
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.BEGIN,
        attemptIndex: 0,
        status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
        retryCount: undefined,
        maxRetries: undefined,
      },
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY,
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.RETRYING,
        retryCount: 1,
        maxRetries: 2,
      },
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.BEGIN,
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
        retryCount: 1,
        maxRetries: 2,
      },
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.COMPLETE,
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.COMPLETED,
        retryCount: 1,
        maxRetries: 2,
      },
    ]);
  });

  test("auto-cancels the active attempt when stop is requested", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<{ command: string; status: string }> = [];
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 };

    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        status: transition.current.status,
      });
    });

    runtime.startExecution();
    runtime.beginAttempt(target, 0, 100);

    assert.strictEqual(runtime.requestStop(), true);
    assert.deepStrictEqual(runtime.getActiveAttempts(), []);

    assert.deepStrictEqual(transitions, [
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.BEGIN,
        status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
      },
      {
        command: WORKFLOW_ATTEMPT_COMMANDS.CANCEL,
        status: WORKFLOW_ATTEMPT_STATUS.CANCELLED,
      },
    ]);
  });

  test("tracks and cancels all active attempts", () => {
    const runtime = new WorkflowStateMachine();
    const firstTarget = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 };
    const secondTarget = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 };

    runtime.startExecution();
    runtime.beginAttempt(firstTarget, 0, 100);
    runtime.beginAttempt(secondTarget, 0, 200);

    assert.deepStrictEqual(
      runtime.getActiveAttempts().map((attempt) => attempt.target),
      [firstTarget, secondTarget]
    );

    const cancelled = runtime.cancelActiveAttempts("Stopped", 300);
    assert.deepStrictEqual(
      cancelled.map((attempt) => attempt.target),
      [firstTarget, secondTarget]
    );
    assert.deepStrictEqual(runtime.getActiveAttempts(), []);
    assert.strictEqual(
      runtime.getAttempt(firstTarget)?.status,
      WORKFLOW_ATTEMPT_STATUS.CANCELLED
    );
    assert.strictEqual(
      runtime.getAttempt(secondTarget)?.status,
      WORKFLOW_ATTEMPT_STATUS.CANCELLED
    );
  });

  test("supports pause and resume only from valid runtime states", () => {
    const runtime = new WorkflowStateMachine();

    assert.strictEqual(runtime.pause(), false);
    assert.strictEqual(runtime.resume(), false);

    assert.strictEqual(runtime.startExecution(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.RUNNING);

    assert.strictEqual(runtime.pause(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.PAUSING);
    assert.strictEqual(runtime.pausedTime, undefined); // pausedTime not set until confirmPaused

    assert.strictEqual(runtime.confirmPaused(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.PAUSED);
    assert.ok(runtime.pausedTime !== undefined);

    assert.strictEqual(runtime.resume(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.RUNNING);
    assert.strictEqual(runtime.pausedTime, undefined);
    assert.strictEqual(runtime.stopped, false);
  });

  test("reopens a completed workflow for continuation", () => {
    const runtime = new WorkflowStateMachine();

    runtime.complete();
    assert.strictEqual(runtime.status, EXECUTION_STATES.COMPLETED);

    assert.strictEqual(runtime.reopenForContinuation(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.STOPPED);
    assert.strictEqual(runtime.stopped, true);
  });

  test("preserves original timer start across pause and resume", async () => {
    const runtime = new WorkflowStateMachine();

    runtime.startExecution();
    assert.strictEqual(runtime.startExecutionTimer(), true);
    const originalStartTime = runtime.startTime;
    assert.ok(originalStartTime !== undefined);

    await new Promise((resolve) => setTimeout(resolve, 25));
    runtime.pause();
    runtime.confirmPaused();
    await new Promise((resolve) => setTimeout(resolve, 60));
    runtime.resume();

    assert.strictEqual(runtime.startExecutionTimer(), false);
    assert.strictEqual(runtime.startTime, originalStartTime);
    assert.ok(runtime.totalPausedDuration >= 40);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const activeExecutionTime = runtime.getActiveExecutionTime();
    assert.ok(
      activeExecutionTime < 120,
      `Expected paused time to be excluded, got ${activeExecutionTime}ms`
    );
  });

  test("restores a persisted paused timer without counting paused wall time", async () => {
    const runtime = new WorkflowStateMachine();
    const now = Date.now();
    runtime.restore({
      status: EXECUTION_STATES.PAUSED,
      stopped: false,
      startTime: now - 1_000,
      pausedTime: now - 400,
      totalPausedDuration: 100,
    });

    const frozenTime = runtime.getActiveExecutionTime();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      Math.abs(runtime.getActiveExecutionTime() - frozenTime) < 10,
      "paused execution time should remain frozen after restoration"
    );

    runtime.resume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(runtime.getActiveExecutionTime() >= frozenTime + 15);

    runtime.complete();
    const completedTime = runtime.getActiveExecutionTime();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      Math.abs(runtime.getActiveExecutionTime() - completedTime) < 10,
      "completed execution time should remain frozen"
    );
  });

  test("excludes the dormant gap when a completed run is continued days later", async () => {
    const runtime = new WorkflowStateMachine();
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // A run that executed for five minutes and completed three days ago — the
    // shape an append-to-completed continuation restores before re-running.
    runtime.restore({
      status: EXECUTION_STATES.COMPLETED,
      stopped: false,
      startTime: now - threeDaysMs - 300_000,
      totalPausedDuration: 0,
      executionEndTime: now - threeDaysMs,
    });

    const completedTime = runtime.getActiveExecutionTime();
    assert.ok(
      Math.abs(completedTime - 300_000) < 1_000,
      `Expected the frozen duration to be the 5min it ran, got ${completedTime}ms`
    );

    runtime.startExecution();

    // startTime is already set, so the timer is never re-based on continuation.
    assert.strictEqual(runtime.startExecutionTimer(), false);

    const resumedTime = runtime.getActiveExecutionTime();
    assert.ok(
      Math.abs(resumedTime - completedTime) < 1_000,
      `Expected elapsed time to be continuous across the continuation, got ${resumedTime}ms`
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      runtime.getActiveExecutionTime() > resumedTime,
      "the timer should advance again once running"
    );
  });

  test("excludes the dormant gap when a stopped run is resumed later", async () => {
    const runtime = new WorkflowStateMachine();
    const now = Date.now();

    runtime.restore({
      status: EXECUTION_STATES.STOPPED,
      stopped: true,
      startTime: now - 90_000,
      totalPausedDuration: 0,
      executionEndTime: now - 60_000,
    });

    const stoppedTime = runtime.getActiveExecutionTime();
    assert.ok(Math.abs(stoppedTime - 30_000) < 1_000);

    runtime.resume();

    const resumedTime = runtime.getActiveExecutionTime();
    assert.ok(
      Math.abs(resumedTime - stoppedTime) < 1_000,
      `Expected the stopped interval to be excluded, got ${resumedTime}ms`
    );
  });

  test("tracks the prompt-phase start separately from the whole-step attempt start", () => {
    const runtime = new WorkflowStateMachine();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    // The attempt opens at the pre-condition gate...
    runtime.beginAttempt(target, 0, 100);
    assert.strictEqual(runtime.getAttempt(target)?.promptStartedAt, undefined);

    // ...and the prompt only starts once the gate has finished.
    assert.strictEqual(runtime.markPromptStarted(target, 500), 500);
    assert.strictEqual(runtime.getAttempt(target)?.startedAt, 100);
    assert.strictEqual(runtime.getAttempt(target)?.promptStartedAt, 500);

    // Terminal transitions for the same attempt keep both timestamps.
    runtime.completeAttempt(target, 0, 900);
    assert.strictEqual(runtime.getAttempt(target)?.startedAt, 100);
    assert.strictEqual(runtime.getAttempt(target)?.promptStartedAt, 500);

    // A fresh attempt has no prompt-phase start until its prompt begins.
    runtime.beginAttempt(target, 1, 1_000);
    assert.strictEqual(runtime.getAttempt(target)?.promptStartedAt, undefined);
    runtime.failAttempt(target, 1, "boom", 1_100);
    assert.strictEqual(runtime.getAttempt(target)?.promptStartedAt, undefined);
  });

  test("markPromptStarted is a no-op when no attempt is open", () => {
    const runtime = new WorkflowStateMachine();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;

    assert.strictEqual(runtime.markPromptStarted(target, 42), 42);
    assert.strictEqual(runtime.getAttempt(target), undefined);
  });

  test("confirms stop only after a stop request", () => {
    const runtime = new WorkflowStateMachine();

    assert.strictEqual(runtime.confirmStopped(), false);

    runtime.startExecution();
    assert.strictEqual(runtime.requestStop(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.CANCELLING);
    assert.strictEqual(runtime.stopped, true);

    assert.strictEqual(runtime.confirmStopped(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.STOPPED);
    assert.strictEqual(runtime.stopped, true);
  });
});
