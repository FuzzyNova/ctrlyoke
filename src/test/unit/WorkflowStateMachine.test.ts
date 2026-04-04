import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowStateMachine } from "../../flightpath/WorkflowStateMachine";
import {
  EXECUTION_STATES,
  WORKFLOW_ATTEMPT_STATUS,
} from "../../types/DashboardConstants";

suite("WorkflowStateMachine", () => {
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

  test("emits ordered attempt transitions and preserves retry metadata", () => {
    const runtime = new WorkflowStateMachine();
    const transitions: Array<{
      command: string;
      attemptIndex: number;
      status: string;
      retryCount?: number;
      maxRetries?: number;
    }> = [];
    const target = { kind: "queue" as const, stepIndex: 1 };

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
        command: "beginAttempt",
        attemptIndex: 0,
        status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
        retryCount: undefined,
        maxRetries: undefined,
      },
      {
        command: "scheduleRetry",
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.RETRYING,
        retryCount: 1,
        maxRetries: 2,
      },
      {
        command: "beginAttempt",
        attemptIndex: 1,
        status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
        retryCount: 1,
        maxRetries: 2,
      },
      {
        command: "completeAttempt",
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
    const target = { kind: "queue" as const, stepIndex: 0 };

    runtime.onDidAttemptTransition((transition) => {
      transitions.push({
        command: transition.command,
        status: transition.current.status,
      });
    });

    runtime.startExecution();
    runtime.beginAttempt(target, 0, 100);

    assert.strictEqual(runtime.requestStop(), true);
    assert.strictEqual(runtime.getActiveAttempt(), undefined);

    assert.deepStrictEqual(transitions, [
      { command: "beginAttempt", status: WORKFLOW_ATTEMPT_STATUS.RUNNING },
      { command: "cancelAttempt", status: WORKFLOW_ATTEMPT_STATUS.CANCELLED },
    ]);
  });

  test("supports pause and resume only from valid runtime states", () => {
    const runtime = new WorkflowStateMachine();

    assert.strictEqual(runtime.pause(), false);
    assert.strictEqual(runtime.resume(), false);

    assert.strictEqual(runtime.startExecution(), true);
    assert.strictEqual(runtime.status, EXECUTION_STATES.RUNNING);

    assert.strictEqual(runtime.pause(), true);
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
