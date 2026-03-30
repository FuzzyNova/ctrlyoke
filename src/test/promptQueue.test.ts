import * as assert from "assert";
import * as vscode from "vscode";
import { PromptQueue } from "../flightpath/PromptQueue";
import { EXECUTION_STATES, STEP_STATUS } from "../types/DashboardConstants";
import { PromptItem, PromptFile } from "../types/FlightPathTypes";

/**
 * Helper to wrap prompts array into PromptFile for tests
 */
function createPromptFile(prompts: PromptItem[]): PromptFile {
  return { prompts };
}

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
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.prompts.length, 3);
    });

    test("should create corresponding results for each prompt", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.results.length, 3);
      state.results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should reset currentIndex on load", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 0);
    });

    test("should keep status as IDLE after loading", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should clear completedIndices on new load", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const state = queue.getState();
      assert.strictEqual(state.completedIndices.size, 0);
    });
  });

  suite("State Transitions - start()", () => {
    test("should transition IDLE -> RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });

    test("should not change state if already RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.stop();
      assert.strictEqual(queue.getState().stopped, true);
      await queue.start();
      assert.strictEqual(queue.getState().stopped, false);
    });
  });

  suite("State Transitions - pause()", () => {
    test("should transition RUNNING -> PAUSED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.pause();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.PAUSED);
    });

    test("should record pause timestamp", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      const beforePause = Date.now();
      queue.pause();
      const state = queue.getState();
      assert.ok(state.pausedTime);
      assert.ok(state.pausedTime >= beforePause);
    });

    test("should not change state if not RUNNING", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      // Currently IDLE, not RUNNING
      queue.pause();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });
  });

  suite("State Transitions - resume()", () => {
    test("should transition PAUSED -> RUNNING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.pause();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
      await queue.resume();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.RUNNING);
    });

    test("should calculate paused duration", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.pause();

      // Wait a small amount to measure pause duration
      // Use 100ms sleep with >= 50ms assertion to tolerate timer inaccuracy
      await new Promise((resolve) => setTimeout(resolve, 100));

      await queue.resume();
      const state = queue.getState();
      assert.ok(
        state.totalPausedDuration >= 50,
        `Expected totalPausedDuration >= 50ms but got ${state.totalPausedDuration}ms`
      );
    });

    test("should clear pausedTime after resume", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.pause();
      assert.ok(queue.getState().pausedTime);
      await queue.resume();
      assert.strictEqual(queue.getState().pausedTime, undefined);
    });

    test("should not change state if not PAUSED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      // Currently RUNNING, not PAUSED
      await queue.resume();
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.RUNNING);
    });
  });

  suite("State Transitions - stop()", () => {
    test("should transition to CANCELLING, then STOPPED after confirmedStopped", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.stop();
      let state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.CANCELLING);

      // After confirmedStopped(), should transition to STOPPED
      await queue.confirmedStopped();
      state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.STOPPED);
    });

    test("should advance currentIndex past cancelled prompt after confirmedStopped", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      // Simulate moving forward past first prompt
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getState().currentIndex, 1);

      // Stop while on second prompt
      await queue.markCurrentAsSent();
      queue.stop();
      await queue.confirmedStopped();

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 2); // Advanced past cancelled prompt
      assert.ok(state.completedIndices.size >= 2); // Both prompts recorded
      // First prompt completed, second prompt cancelled
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
      assert.strictEqual(state.results[1].status, STEP_STATUS.CANCELLED);
    });

    test("should mark SENT prompts as CANCELLED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.stop();
      assert.strictEqual(queue.getState().stopped, true);
    });

    test("should not mark PENDING prompts as CANCELLED", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      await queue.restart();
      assert.strictEqual(queue.getState().currentIndex, 0);
    });

    test("should reset all results to PENDING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      await queue.restart();
      queue.getState().results.forEach((result) => {
        assert.strictEqual(result.status, STEP_STATUS.PENDING);
      });
    });

    test("should clear completedIndices", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.ok(queue.getState().completedIndices.size > 0);
      await queue.restart();
      assert.strictEqual(queue.getState().completedIndices.size, 0);
    });

    test("should reset execution time tracking", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await queue.restart();
      const state = queue.getState();
      assert.strictEqual(state.totalExecutionTime, 0);
      assert.strictEqual(state.totalPausedDuration, 0);
    });

    test("should keep prompts loaded", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.restart();
      assert.strictEqual(queue.getState().prompts.length, 3);
    });

    test("should reset to IDLE status", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.restart();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.IDLE);
    });

    test("should update working file without completedPrompts after restart", async () => {
      // Create a temporary working file
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        // Skip test if no workspace (test environment limitation)
        return;
      }

      queue.loadPrompts(createPromptFile(samplePrompts));
      const workingFilePath = await queue.createWorkingFile(
        "test.flightpath.json",
        samplePrompts,
        workspaceFolder.uri.fsPath
      );

      // Complete some prompts
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();

      // Verify completedIndices has entries
      assert.ok(queue.getState().completedIndices.size > 0);

      // Restart should clear completedIndices AND update working file
      await queue.restart();
      assert.strictEqual(queue.getState().completedIndices.size, 0);

      // Read working file to verify completedPrompts is not present (new format)
      const workingFile = await queue.readWorkingFile(workingFilePath);
      assert.ok(
        workingFile._runtime,
        "Working file should have _runtime section"
      );
      assert.strictEqual(
        (workingFile._runtime as any).completedPrompts,
        undefined,
        "Working file should not have completedPrompts array"
      );

      // Cleanup
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(workingFilePath));
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  suite("clear()", () => {
    test("should call stop() and transition to CANCELLING", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      queue.clear();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.CANCELLING);
    });

    test("should empty prompts array", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.clear();
      assert.strictEqual(queue.getState().prompts.length, 0);
    });

    test("should empty results array", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.clear();
      assert.strictEqual(queue.getState().results.length, 0);
    });
  });

  suite("Prompt Navigation", () => {
    test("hasNext() should return true when prompts remain", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.hasNext(), true);
    });

    test("hasNext() should return false at end of queue", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.hasNext(), false);
    });

    test("hasNext() should return false when queue is empty", () => {
      assert.strictEqual(queue.hasNext(), false);
    });

    test("getCurrentPrompt() should return current prompt", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const current = queue.getCurrentPrompt();
      assert.ok(current);
      assert.strictEqual(current.prompt, "First prompt");
    });

    test("getCurrentPrompt() should return null at end of queue", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.SENT);
    });

    test("should update result timestamp", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      const before = new Date();
      await queue.markCurrentAsSent();
      const state = queue.getState();
      assert.ok(state.results[0].timestamp >= before);
    });

    test("should not modify if no next prompt", async () => {
      queue.loadPrompts(createPromptFile([{ prompt: "Only one" }]));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.COMPLETED);
    });

    test("should add prompt identity to completedIndices", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const state = queue.getState();
      assert.ok(state.completedIndices.size > 0);
    });

    test("should increment currentIndex", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      assert.strictEqual(queue.getState().currentIndex, 0);
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getState().currentIndex, 1);
    });

    test("should reset retry count", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCurrentAsFailed("Test error");
      const state = queue.getState();
      assert.strictEqual(state.results[0].status, STEP_STATUS.FAILED);
    });

    test("should set error message on result", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCurrentAsFailed("Test error message");
      const state = queue.getState();
      assert.strictEqual(state.results[0].error, "Test error message");
    });

    test("should transition status to ERROR", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCurrentAsFailed("Test error");
      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.ERROR);
    });

    test("should advance currentIndex past the failed prompt", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.getState().currentIndex, 0);
      queue.markCurrentAsFailed("Test error");
      assert.strictEqual(queue.getState().currentIndex, 1);
    });

    test("should record terminalStatus as failed on the prompt runtime", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCurrentAsFailed("Test error");
      const prompt = queue.getState().prompts[0];
      assert.strictEqual(prompt._runtime?.terminalStatus, "failed");
    });
  });

  suite("Retry Functionality", () => {
    test("incrementRetryCount() should increment counter", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("incrementRetryCount() should update result retryCount", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      const state = queue.getState();
      assert.strictEqual(state.results[0].retryCount, 2);
    });

    test("resetRetryCount() should set counter to zero", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      queue.incrementRetryCount();
      queue.resetRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 0);
    });

    test("getCurrentRetryCount() should return current count", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.incrementRetryCount();
      assert.strictEqual(queue.getCurrentRetryCount(), 1);
    });

    test("canRetry() should return false when no retryPrompt", () => {
      const prompt: PromptItem = {
        prompt: "Test",
        endCondition: { script: "test.py", returns: "true" },
      };
      queue.loadPrompts(createPromptFile([prompt]));
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
      queue.loadPrompts(createPromptFile([prompt]));
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
      queue.loadPrompts(createPromptFile([prompt]));
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
      queue.loadPrompts(createPromptFile([prompt]));
      // Increment many times
      for (let i = 0; i < 100; i++) {
        queue.incrementRetryCount();
      }
      assert.strictEqual(queue.canRetry(prompt), true);
    });
  });

  suite("Progress Tracking", () => {
    test("getProgress() should return correct total", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const progress = queue.getProgress();
      assert.strictEqual(progress.total, 3);
    });

    test("getProgress() should return correct current", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      const progress = queue.getProgress();
      assert.strictEqual(progress.current, 1);
    });

    test("getProgress() should calculate percentage correctly", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      await queue.start();
      await queue.markCurrentAsSent();
      await queue.completeCurrentAndMoveNext();
      assert.strictEqual(queue.getCompletedCount(), 1);
    });

    test("getFailedCount() should count failed prompts", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCurrentAsFailed("Error");
      assert.strictEqual(queue.getFailedCount(), 1);
    });
  });

  suite("Execution Time Tracking", () => {
    test("startExecutionTimer() should set startTime", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.startExecutionTimer();
      const state = queue.getState();
      assert.ok(state.startTime);
      assert.ok(state.startTime > 0);
    });

    test("getActiveExecutionTime() should return elapsed time", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.startExecutionTimer();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const elapsed = queue.getActiveExecutionTime();
      assert.ok(elapsed >= 50);
    });

    test("getActiveExecutionTime() should exclude paused duration", async () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
    });

    test("should emit state change on start", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      const disposable = queue.onDidChangeState((state) => {
        if (state.status === EXECUTION_STATES.RUNNING) {
          disposable.dispose();
          done();
        }
      });
      queue.start();
    });

    test("should emit state change on pause", (done) => {
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
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
      queue.loadPrompts(createPromptFile(samplePrompts));
      const stats = queue.getQueueExtensionStats();
      assert.strictEqual(stats.queueExtensions, 0);
      assert.strictEqual(stats.currentSize, 3);
      assert.strictEqual(stats.lastReloadTime, undefined);
    });
  });

  suite("Mark Complete/Error Methods", () => {
    test("markCompleted() should set status to COMPLETED", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markCompleted();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    });

    test("markErrored() should set status to ERROR", () => {
      queue.loadPrompts(createPromptFile(samplePrompts));
      queue.markErrored();
      assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    });
  });

  suite("setStartPosition", () => {
    test("should be a no-op when toIndex equals currentIndex", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 2;
      await queue.setStartPosition(2);
      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 2);
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
    });

    test("should rewind: strip _runtime and reset results to PENDING for prompts at/after toIndex", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 3;
      (queue as any).state.prompts[0]._runtime = {
        startedAt: 100,
        completedAt: 200,
      };
      (queue as any).state.prompts[1]._runtime = {
        startedAt: 300,
        completedAt: 400,
      };
      (queue as any).state.prompts[2]._runtime = {
        startedAt: 500,
        completedAt: 600,
      };
      (queue as any).state.results[0].status = STEP_STATUS.COMPLETED;
      (queue as any).state.results[1].status = STEP_STATUS.COMPLETED;
      (queue as any).state.results[2].status = STEP_STATUS.COMPLETED;
      (queue as any).state.completedIndices = new Set(["0", "1", "2"]);

      await queue.setStartPosition(1);

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 1);
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
      assert.strictEqual(state.stopped, false);
      assert.ok(
        state.prompts[0]._runtime?.completedAt !== undefined,
        "prompts[0]._runtime should be preserved"
      );
      assert.strictEqual(
        state.prompts[1]._runtime,
        undefined,
        "prompts[1]._runtime should be stripped"
      );
      assert.strictEqual(
        state.prompts[2]._runtime,
        undefined,
        "prompts[2]._runtime should be stripped"
      );
      assert.strictEqual(
        state.results[0].status,
        STEP_STATUS.COMPLETED,
        "results[0] should be unchanged"
      );
      assert.strictEqual(
        state.results[1].status,
        STEP_STATUS.PENDING,
        "results[1] should be reset to PENDING"
      );
      assert.strictEqual(
        state.results[2].status,
        STEP_STATUS.PENDING,
        "results[2] should be reset to PENDING"
      );
      assert.strictEqual(state.completedIndices.size, 1);
      assert.ok(state.completedIndices.has("0"));
    });

    test("should skip-ahead: mark prompts currentIndex..toIndex-1 as SKIPPED in results", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 1;
      (queue as any).state.completedIndices = new Set(["0"]);
      (queue as any).state.results[0].status = STEP_STATUS.COMPLETED;

      await queue.setStartPosition(3);

      const state = queue.getState();
      assert.strictEqual(state.currentIndex, 3);
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
      assert.strictEqual(state.stopped, false);
      assert.strictEqual(state.results[1].status, STEP_STATUS.SKIPPED);
      assert.strictEqual(state.results[2].status, STEP_STATUS.SKIPPED);
      assert.strictEqual(
        state.results[3].status,
        STEP_STATUS.PENDING,
        "results[3] should not be skipped"
      );
      assert.ok(
        state.prompts[1]._runtime?.completedAt !== undefined,
        "prompts[1]._runtime.completedAt should be set"
      );
      assert.ok(
        state.prompts[2]._runtime?.completedAt !== undefined,
        "prompts[2]._runtime.completedAt should be set"
      );
      assert.ok(state.completedIndices.has("0"));
      assert.ok(state.completedIndices.has("1"));
      assert.ok(state.completedIndices.has("2"));
      assert.strictEqual(state.completedIndices.size, 3);
    });

    test("should rebuild completedIndices correctly for rewind", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 3;
      (queue as any).state.completedIndices = new Set(["0", "1", "2"]);

      await queue.setStartPosition(1);

      const state = queue.getState();
      assert.strictEqual(state.completedIndices.size, 1);
      assert.ok(state.completedIndices.has("0"));
      assert.strictEqual(state.completedIndices.has("1"), false);
      assert.strictEqual(state.completedIndices.has("2"), false);
    });

    test("should set status to IDLE and stopped to false after position change", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 2;
      (queue as any).state.status = EXECUTION_STATES.STOPPED;
      (queue as any).state.stopped = true;

      await queue.setStartPosition(0);

      const state = queue.getState();
      assert.strictEqual(state.status, EXECUTION_STATES.IDLE);
      assert.strictEqual(state.stopped, false);
    });
  });

  suite("reorderPendingPrompts", () => {
    test("should keep done-prefix unchanged and reorder pending section", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 2;

      // Pending slice is [p2, p3, p4] at slice positions [0, 1, 2].
      // Move slice[2]=p4 to front: [2, 0, 1]
      await queue.reorderPendingPrompts([2, 0, 1]);

      const state = queue.getState();
      assert.strictEqual(state.prompts[0].prompt, "p0");
      assert.strictEqual(state.prompts[1].prompt, "p1");
      assert.strictEqual(state.prompts[2].prompt, "p4");
      assert.strictEqual(state.prompts[3].prompt, "p2");
      assert.strictEqual(state.prompts[4].prompt, "p3");
    });

    test("should reorder results in sync with prompts", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
        { prompt: "p3" },
        { prompt: "p4" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 2;

      // Pending slice is [p2, p3, p4] at slice positions [0, 1, 2].
      // Move slice[2]=p4 to front: [2, 0, 1]
      await queue.reorderPendingPrompts([2, 0, 1]);

      const state = queue.getState();
      assert.strictEqual(state.results[0].prompt, "p0");
      assert.strictEqual(state.results[1].prompt, "p1");
      assert.strictEqual(state.results[2].prompt, "p4");
      assert.strictEqual(state.results[3].prompt, "p2");
      assert.strictEqual(state.results[4].prompt, "p3");
    });

    test("should produce correct order after successive reorders", async () => {
      const prompts: PromptItem[] = [
        { prompt: "p0" },
        { prompt: "p1" },
        { prompt: "p2" },
      ];
      queue.loadPrompts(createPromptFile(prompts));
      (queue as any).state.currentIndex = 0;

      // First reorder: move p0 to last → [1, 2, 0]
      await queue.reorderPendingPrompts([1, 2, 0]);
      let state = queue.getState();
      assert.strictEqual(state.prompts[0].prompt, "p1");
      assert.strictEqual(state.prompts[1].prompt, "p2");
      assert.strictEqual(state.prompts[2].prompt, "p0");

      // Second reorder: move the new first (p1) to last → [1, 2, 0]
      // Current pending slice: [p1, p2, p0]; move slice[0]=p1 to end
      await queue.reorderPendingPrompts([1, 2, 0]);
      state = queue.getState();
      assert.strictEqual(state.prompts[0].prompt, "p2");
      assert.strictEqual(state.prompts[1].prompt, "p0");
      assert.strictEqual(state.prompts[2].prompt, "p1");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("mergeDiskPrompts — session ID preservation", () => {
    test("should preserve in-memory _runtime.sessionId when MCP appends a new prompt", () => {
      // Simulate: prompt[0] ran, session ID set in memory but not yet persisted to disk
      queue.loadPrompts(createPromptFile([{ prompt: "prompt-0" }]));
      (queue as any).state.prompts[0]._runtime = {
        harness: "copilot-cli",
        model: "claude-sonnet-4.5",
        sessionId: "b52bceab-9c03-49b3-8324-4220292e9acb",
        startedAt: 1000,
        completedAt: 2000,
      };

      // Disk has both prompt-0 (without _runtime — not written yet) and a new MCP prompt
      const diskPrompts: PromptItem[] = [
        { prompt: "prompt-0" }, // matches memory, but no _runtime on disk copy
        { prompt: "prompt-1-mcp" }, // new from MCP
      ];

      (queue as any).mergeDiskPrompts(diskPrompts);

      const state = queue.getState();
      assert.strictEqual(
        state.prompts.length,
        2,
        "should have 2 prompts after merge"
      );
      assert.strictEqual(
        state.prompts[0]._runtime?.sessionId,
        "b52bceab-9c03-49b3-8324-4220292e9acb",
        "session ID must be preserved from memory, not lost to disk replacement"
      );
      assert.strictEqual(
        state.prompts[1]._runtime,
        undefined,
        "new MCP prompt should have no _runtime"
      );
    });
  });
});
