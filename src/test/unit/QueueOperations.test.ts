import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptQueue } from "../../core/PromptQueue";
import {
  getQueueStatus,
  appendToQueue,
} from "../../core/QueueOperations";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
} from "../../types/DashboardConstants";

async function requestQueueStop(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().requestStop()) {
    return;
  }

  queue.markInFlightPromptCancelled();
  await queue.commitRuntimeTransition({ persist: false });
}

suite("QueueOperations", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("getQueueStatus — workflow name extraction", () => {
    test("extracts name from timestamped .flightpath.json path", () => {
      const queue = new PromptQueue();
      const status = getQueueStatus(
        queue,
        "/workspace/.ctrlyoke/.queue/my-workflow-2024-12-23T15-30-00.flightpath.json"
      );
      assert.strictEqual(status.metadata.workflowName, "my-workflow");
    });

    test("extracts multi-segment name", () => {
      const queue = new PromptQueue();
      const status = getQueueStatus(
        queue,
        "C:\\Users\\dev\\.ctrlyoke\\.queue\\build-and-test-2025-01-01T00-00-00.flightpath.json"
      );
      assert.strictEqual(status.metadata.workflowName, "build-and-test");
    });

    test("returns null workflowName when no file path provided", () => {
      const queue = new PromptQueue();
      const status = getQueueStatus(queue);
      assert.strictEqual(status.metadata.workflowName, null);
    });

    test("returns null workflowName when working file path is empty string in state", () => {
      const queue = new PromptQueue();
      // No workingFilePath in state or arg
      const status = getQueueStatus(queue, undefined);
      assert.strictEqual(status.metadata.workflowName, null);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("getQueueStatus — metadata structure", () => {
    test("returns correct metadata for fresh empty queue", () => {
      const queue = new PromptQueue();
      const status = getQueueStatus(queue);
      assert.strictEqual(status.metadata.currentIndex, 0);
      assert.strictEqual(status.metadata.totalSteps, 0);
      assert.strictEqual(status.metadata.completedSteps, 0);
      assert.strictEqual(status.metadata.executionState, "idle");
      assert.ok("workingFile" in status.metadata);
      assert.ok(Array.isArray(status.steps));
    });

    test("prompts array length matches queue size", () => {
      const queue = new PromptQueue();
      const status = getQueueStatus(queue);
      assert.strictEqual(status.steps.length, status.metadata.totalSteps);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("appendToQueue — validation", () => {
    test("returns success response when queue is idle", async () => {
      const queue = new PromptQueue();
      const response = await appendToQueue(queue, {
        steps: [{ prompt: "do something" }],
        position: QUEUE_POSITION.END,
        source: "test",
      });
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.stepsAdded, 1);
      assert.strictEqual(response.newQueueSize, 1);
    });

    test("appending multiple prompts at END increments queue accordingly", async () => {
      const queue = new PromptQueue();
      const response = await appendToQueue(queue, {
        steps: [
          { prompt: "step 1" },
          { prompt: "step 2" },
          { prompt: "step 3" },
        ],
        position: QUEUE_POSITION.END,
        source: "test",
      });
      assert.strictEqual(response.stepsAdded, 3);
      assert.strictEqual(response.newQueueSize, 3);
    });

    test("reopens a completed workflow through the runtime before appending", async () => {
      const queue = new PromptQueue();
      queue.loadPrompts({ steps: [{ prompt: "completed-step" }] });
      queue.getRuntimeStateMachine().complete();
      await queue.commitRuntimeTransition({ persist: false });

      const response = await appendToQueue(queue, {
        steps: [{ prompt: "follow-up" }],
        position: QUEUE_POSITION.END,
        source: "test",
      });

      assert.strictEqual(response.success, true);
      assert.strictEqual(
        queue.getRuntimeStateMachine().status,
        EXECUTION_STATES.STOPPED
      );
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.STOPPED);
    });

    test("throws when queue is in cancelling state", async () => {
      const queue = new PromptQueue();
      await requestQueueStop(queue);
      await assert.rejects(
        () =>
          appendToQueue(queue, {
            steps: [{ prompt: "should fail" }],
            position: QUEUE_POSITION.END,
            source: "test",
          }),
        /cannot append/i
      );
    });
  });
});
