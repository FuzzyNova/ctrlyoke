import * as assert from "assert";
import { PromptQueue } from "../flightpath/PromptQueue";
import { EXECUTION_STATES, STEP_STATUS } from "../types/DashboardConstants";
import { PromptItem } from "../types/FlightPathTypes";

suite("PromptQueue State Machine Tests", () => {
  let queue: PromptQueue;
  const samplePrompts: PromptItem[] = [
    { prompt: "First prompt" },
    { prompt: "Second prompt" },
    { prompt: "Third prompt" },
  ];

  setup(() => {
    queue = new PromptQueue();
  });

  suite("Initialization", () => {
    test("should start with idle state", () => {
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should start with empty prompts and results", () => {
      const state = queue.getState();
      assert.strictEqual(state.prompts.length, 0);
      assert.strictEqual(state.results.length, 0);
    });

    test("should start with currentIndex at 0", () => {
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 0);
    });

    test("should have stopped set to false initially", () => {
      const state = queue.getState();
      assert.strictEqual(state.stopped, false);
    });
  });

  suite("loadPrompts", () => {
    test("should load prompts correctly", () => {
      queue.loadPrompts(samplePrompts);
      const state = queue.getState();
      assert.strictEqual(state.prompts.length, 3);
    });

    test("should create corresponding results for each prompt", () => {
      queue.loadPrompts(samplePrompts);
      const state = queue.getState();
      assert.strictEqual(state.results.length, 3);
      state.results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should reset currentIndex on load", () => {
      queue.loadPrompts(samplePrompts);
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 0);
    });

    test("should keep status as IDLE after loading", () => {
      queue.loadPrompts(samplePrompts);
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should clear completedIds on new load", () => {
      queue.loadPrompts(samplePrompts);
      const state = queue.getState();
      assert.strictEqual(state.completedIds.size, 0);
    });
  });

  suite("State Transitions - start()", () => {
    test("should transition IDLE -> RUNNING", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });

    test("should not change state if already RUNNING", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.start(); // Call again
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });

    test("should not throw if no prompts loaded (shows warning)", async () => {
      // This should not throw, just show a warning
      await queue.start();
      const state = queue.getState();
      // Status should remain IDLE since there are no prompts
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should clear stopped flag on start", async () => {
      queue.loadPrompts(samplePrompts);
      queue.stop();
      assert.strictEqual(queue.getState().stopped, true);
      await queue.start();
      assert.strictEqual(queue.getState().stopped, false);
    });
  });

  suite("State Transitions - pause()", () => {
    test("should transition RUNNING -> PAUSED", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.pause();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.PAUSED);
    });

    test("should record pause timestamp", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      const beforePause = Date.now();
      queue.pause();
      const state = queue.getState();
      assert.ok(state.pausedTime);
      assert.ok(state.pausedTime >= beforePause);
    });

    test("should not change state if not RUNNING", () => {
      queue.loadPrompts(samplePrompts);
      // Currently IDLE, not RUNNING
      queue.pause();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });
  });

  suite("State Transitions - resume()", () => {
    test("should transition PAUSED -> RUNNING", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.pause();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
      await queue.resume();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.RUNNING);
    });

    test("should calculate paused duration", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.pause();

      // Wait a small amount to measure pause duration
      await new Promise((resolve) => setTimeout(resolve, 50));

      await queue.resume();
      const state = queue.getState();
      assert.ok(state.totalPausedDuration >= 50);
    });

    test("should clear pausedTime after resume", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.pause();
      assert.ok(queue.getState().pausedTime);
      await queue.resume();
      assert.strictEqual(queue.getState().pausedTime, undefined);
    });

    test("should not change state if not PAUSED", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      // Currently RUNNING, not PAUSED
      await queue.resume();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });
  });

  suite("State Transitions - stop()", () => {
    test("should transition to CANCELLING, then IDLE after confirmedStopped", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.stop();
      let state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.CANCELLING);

      // After confirmedStopped(), should transition to IDLE
      queue.confirmedStopped();
      state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should reset currentIndex to 0 after confirmedStopped", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      // Simulate moving forward
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getState().currentIndex, 1);
      queue.stop();
      // confirmedStopped() resets currentIndex
      queue.confirmedStopped();
      assert.strictEqual(queue.getState().currentIndex, 0);
    });

    test("should mark SENT prompts as CANCELLED", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SENT);
      queue.stop();
      assert.strictEqual(
        queue.getState().results[0].status,
        STEP_STATUS.CANCELLED
      );
    });

    test("should set stopped flag", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.stop();
      assert.strictEqual(queue.getState().stopped, true);
    });

    test("should not mark PENDING prompts as CANCELLED", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.stop();
      // First prompt was PENDING (no markCurrentAsSent called), should remain PENDING
      // Actually stop marks SENT as CANCELLED, PENDING stays PENDING
      // But currentIndex is reset, so we check result[1] which was never touched
      assert.strictEqual(
        queue.getState().results[1].status,
        STEP_STATUS.PENDING
      );
    });
  });

  suite("restart()", () => {
    test("should reset currentIndex to 0", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      queue.restart();
      assert.strictEqual(queue.getState().currentIndex, 0);
    });

    test("should reset all results to PENDING", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      queue.restart();
      queue.getState().results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should clear completedIds", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.ok(queue.getState().completedIds.size > 0);
      queue.restart();
      assert.strictEqual(queue.getState().completedIds.size, 0);
    });

    test("should reset execution time tracking", async () => {
      queue.loadPrompts(samplePrompts);
      queue.startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 10));
      queue.restart();
      const state = queue.getState();
      assert.strictEqual(state.totalExecutionTime, 0);
      assert.strictEqual(state.totalPausedDuration, 0);
    });

    test("should keep prompts loaded", () => {
      queue.loadPrompts(samplePrompts);
      queue.restart();
      assert.strictEqual(queue.getState().prompts.length, 3);
    });

    test("should reset to IDLE status", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.restart();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.IDLE);
    });
  });

  suite("clear()", () => {
    test("should call stop() and transition to CANCELLING", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.clear();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.CANCELLING);
    });

    test("should empty prompts array", () => {
      queue.loadPrompts(samplePrompts);
      queue.clear();
      assert.strictEqual(queue.getState().prompts.length, 0);
    });

    test("should empty results array", () => {
      queue.loadPrompts(samplePrompts);
      queue.clear();
      assert.strictEqual(queue.getState().results.length, 0);
    });
  });

  suite("Prompt Navigation", () => {
    test("hasNext() should return true when prompts remain", () => {
      queue.loadPrompts(samplePrompts);
      assert.strictEqual(queue.hasNext(), true);
    });

    test("hasNext() should return false at end of queue", async () => {
      queue.loadPrompts([{ prompt: "Only one" }]);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.hasNext(), false);
    });

    test("hasNext() should return false when queue is empty", () => {
      assert.strictEqual(queue.hasNext(), false);
    });

    test("getCurrentPrompt() should return current prompt", () => {
      queue.loadPrompts(samplePrompts);
      const current = queue.getCurrentPrompt();
      assert.ok(current);
      assert.strictEqual(current.prompt, "First prompt");
    });

    test("getCurrentPrompt() should return null at end of queue", async () => {
      queue.loadPrompts([{ prompt: "Only one" }]);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getCurrentPrompt(), null);
    });

    test("getCurrentPrompt() should return null when queue is empty", () => {
      assert.strictEqual(queue.getCurrentPrompt(), null);
    });
  });

  suite("markCurrentAsSent()", () => {
    test("should update result status to SENT", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.SENT);
    });

    test("should update result timestamp", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      const before = new Date();
      await queue.markCurrentAsSent();
      const state = queue.getState();
      assert.ok(state.results[0].timestamp >= before);
    });

    test("should not modify if no next prompt", async () => {
      queue.loadPrompts([{ prompt: "Only one" }]);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      // Now at end of queue
      await queue.markCurrentAsSent();
      // Should not throw or cause issues
      assert.strictEqual(queue.hasNext(), false);
    });
  });

  suite("completeCurrentAndMoveNext()", () => {
    test("should mark result as COMPLETED", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
    });

    test("should add prompt identity to completedIds", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const state = queue.getState();
      assert.ok(state.completedIds.size > 0);
    });

    test("should increment currentIndex", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      assert.strictEqual(queue.getState().currentIndex, 0);
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getState().currentIndex, 1);
    });

    test("should reset retry count", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 2);
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
    });
  });

  suite("markCurrentAsFailed()", () => {
    test("should mark result as FAILED", () => {
      queue.loadPrompts(samplePrompts);
      queue.markCurrentAsFailed("Test error");
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.FAILED);
    });

    test("should set error message on result", () => {
      queue.loadPrompts(samplePrompts);
      queue.markCurrentAsFailed("Test error message");
      const state = queue.getState();
      assert.strictEqual(state.results[0].error, "Test error message");
    });

    test("should transition status to ERROR", () => {
      queue.loadPrompts(samplePrompts);
      queue.markCurrentAsFailed("Test error");
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.ERROR);
    });
  });

  suite("Retry Functionality", () => {
    test("incrementRetryCount() should increment counter", () => {
      queue.loadPrompts(samplePrompts);
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("incrementRetryCount() should update result retryCount", () => {
      queue.loadPrompts(samplePrompts);
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      const state = queue.getState();
      assert.strictEqual(state.results[0].retryCount, 2);
    });

    test("resetRetryCount() should set counter to zero", () => {
      queue.loadPrompts(samplePrompts);
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      queue.resetRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
    });

    test("getCurrentRetryCount() should return current count", () => {
      queue.loadPrompts(samplePrompts);
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("canRetry() should return false when no retryPrompt", () => {
      const prompt: PromptItem = {
        prompt: "Test",
        endCondition: { script: "test.py", returns: "true" },
      };
      queue.loadPrompts([prompt]);
      assert.strictEqual(queue.canRetry(prompt), false);
    });

    test("canRetry() should return true when retries remain", () => {
      const prompt: PromptItem = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          returns: "true",
          maxRetries: 3,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts([prompt]);
      assert.strictEqual(queue.canRetry(prompt), true);
    });

    test("canRetry() should return false when maxRetries exhausted", () => {
      const prompt: PromptItem = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          returns: "true",
          maxRetries: 2,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts([prompt]);
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      assert.strictEqual(queue.canRetry(prompt), false);
    });

    test("canRetry() should always return true for unlimited retries (-1)", () => {
      const prompt: PromptItem = {
        prompt: "Test",
        endCondition: {
          script: "test.py",
          returns: "true",
          maxRetries: -1,
          retryPrompt: "Try again",
        },
      };
      queue.loadPrompts([prompt]);
      // Increment many times
      for (let i = 0; i < 100; i++) {
        queue.incrementRetryCount();
      }
      assert.strictEqual(queue.canRetry(prompt), true);
    });
  });

  suite("Progress Tracking", () => {
    test("getProgress() should return correct total", () => {
      queue.loadPrompts(samplePrompts);
      const progress = queue.getProgress();
      assert.strictEqual(progress.total, 3);
    });

    test("getProgress() should return correct current", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const progress = queue.getProgress();
      assert.strictEqual(progress.current, 1);
    });

    test("getProgress() should calculate percentage correctly", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const progress = queue.getProgress();
      assert.strictEqual(progress.percentage, 33); // 1/3 = 33%
    });

    test("getProgress() should handle empty queue", () => {
      const progress = queue.getProgress();
      assert.strictEqual(progress.total, 0);
      assert.strictEqual(progress.current, 0);
      assert.strictEqual(progress.percentage, 0);
    });

    test("getCompletedCount() should count completed prompts", async () => {
      queue.loadPrompts(samplePrompts);
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getCompletedCount(), 1);
    });

    test("getFailedCount() should count failed prompts", () => {
      queue.loadPrompts(samplePrompts);
      queue.markCurrentAsFailed("Error");
      assert.strictEqual(queue.getFailedCount(), 1);
    });
  });

  suite("Execution Time Tracking", () => {
    test("startExecutionTimer() should set startTime", () => {
      queue.loadPrompts(samplePrompts);
      queue.startExecutionTimer();
      const state = queue.getState();
      assert.ok(state.startTime);
      assert.ok(state.startTime > 0);
    });

    test("getActiveExecutionTime() should return elapsed time", async () => {
      queue.loadPrompts(samplePrompts);
      queue.startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const elapsed = queue.getActiveExecutionTime();
      assert.ok(elapsed >= 50);
    });

    test("getActiveExecutionTime() should exclude paused duration", async () => {
      queue.loadPrompts(samplePrompts);
      queue.startExecutionTimer();
      await queue.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      queue.pause();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await queue.resume();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const active = queue.getActiveExecutionTime();
      // Should be roughly 40ms (20 + 20), not 140ms (20 + 100 + 20)
      assert.ok(active < 100, `Expected < 100ms but got ${active}ms`);
    });

    test("getActiveExecutionTime() should return 0 if not started", () => {
      queue.loadPrompts(samplePrompts);
      assert.strictEqual(queue.getActiveExecutionTime(), 0);
    });
  });

  suite("Event Emission", () => {
    test("should emit state change on loadPrompts", (done) => {
      const disposable = queue.onDidChangeState((state) => {
        assert.strictEqual(state.prompts.length, 3);
        disposable.dispose();
        done();
      });
      queue.loadPrompts(samplePrompts);
    });

    test("should emit state change on start", (done) => {
      queue.loadPrompts(samplePrompts);
      const disposable = queue.onDidChangeState((state) => {
        if (state.status === EXECUTION_STATES.RUNNING) {
          disposable.dispose();
          done();
        }
      });
      queue.start();
    });

    test("should emit state change on pause", (done) => {
      queue.loadPrompts(samplePrompts);
      queue.start().then(() => {
        const disposable = queue.onDidChangeState((state) => {
          if (state.status === EXECUTION_STATES.PAUSED) {
            disposable.dispose();
            done();
          }
        });
        queue.pause();
      });
    });

    test("should emit state change on resume", (done) => {
      queue.loadPrompts(samplePrompts);
      queue.start().then(() => {
        queue.pause();
        // Wait a tick for pause event to fire
        setTimeout(() => {
          const disposable = queue.onDidChangeState((state) => {
            if (state.status === EXECUTION_STATES.RUNNING) {
              disposable.dispose();
              done();
            }
          });
          queue.resume();
        }, 10);
      });
    });

    test("should emit state change on stop", (done) => {
      queue.loadPrompts(samplePrompts);
      queue.start().then(() => {
        const disposable = queue.onDidChangeState((state) => {
          if (state.status === EXECUTION_STATES.CANCELLING && state.stopped) {
            disposable.dispose();
            done();
          }
        });
        queue.stop();
      });
    });
  });

  suite("Queue Extension Stats", () => {
    test("getQueueExtensionStats() should return initial stats", () => {
      queue.loadPrompts(samplePrompts);
      const stats = queue.getQueueExtensionStats();
      assert.strictEqual(stats.queueExtensions, 0);
      assert.strictEqual(stats.currentSize, 3);
      assert.strictEqual(stats.lastReloadTime, undefined);
    });
  });

  suite("Mark Complete/Error Methods", () => {
    test("markCompleted() should set status to COMPLETED", () => {
      queue.loadPrompts(samplePrompts);
      queue.markCompleted();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    });

    test("markErrored() should set status to ERROR", () => {
      queue.loadPrompts(samplePrompts);
      queue.markErrored();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    });
  });
});
