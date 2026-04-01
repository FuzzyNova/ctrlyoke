/**
 * Tests for non-temporal workflowStore behaviour.
 * Temporal (undo/redo) behaviour is covered in workflowStore.temporal.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "@store/workflowStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import type { PromptItem, CliOutput } from "@/types/messages";
import type { WorkflowOutputHistory } from "@root/types/OutputHistoryTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function store() {
  return useWorkflowStore.getState();
}

function makePrompt(overrides: Partial<PromptItem> = {}): PromptItem {
  return { prompt: "hello world", ...overrides };
}

function makeOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return {
    prompt: "hello",
    response: "world",
    elapsed: 100,
    timestampMs: Date.now(),
    attemptIndex: 0,
    isStreaming: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  store().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
});

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

describe("loadWorkflow", () => {
  it("sets fileName, workflowName, and prompts", () => {
    store().loadWorkflow({
      fileName: "test.flightpath.yaml",
      workflowName: "My Workflow",
      prompts: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });

    expect(store().fileName).toBe("test.flightpath.yaml");
    expect(store().workflowName).toBe("My Workflow");
    expect(store().prompts).toHaveLength(2);
    expect(store().prompts[0].prompt).toBe("Step 1");
  });

  it("sets totalSteps to prompts length", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      prompts: [makePrompt(), makePrompt(), makePrompt()],
    });
    expect(store().totalSteps).toBe(3);
  });

  it("defaults all prompts to PENDING status", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      prompts: [makePrompt(), makePrompt()],
    });
    for (const p of store().prompts) {
      expect(p.status).toBe(STEP_STATUS.PENDING);
    }
  });

  it("applies results status to prompts", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      prompts: [makePrompt(), makePrompt()],
      results: [{ status: STEP_STATUS.COMPLETED }, {}],
    });
    expect(store().prompts[0].status).toBe(STEP_STATUS.COMPLETED);
    expect(store().prompts[1].status).toBe(STEP_STATUS.PENDING);
  });

  it("clears runtime state (cliOutputs, retryStates, etc.)", () => {
    // Populate some runtime state first
    store().loadWorkflow({ fileName: "a.yaml", prompts: [makePrompt()] });
    store().addCliOutput(0, makeOutput());
    store().setRetryState(0, 1, 3);

    // Load new workflow — runtime state should clear
    store().loadWorkflow({ fileName: "b.yaml", prompts: [makePrompt()] });
    expect(store().cliOutputs).toEqual({});
    expect(store().retryStates).toEqual({});
  });

  it("sets executionState to IDLE by default", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    expect(store().executionState).toBe(EXECUTION_STATES.IDLE);
  });
});

// ---------------------------------------------------------------------------
// setStepStatus
// ---------------------------------------------------------------------------

describe("setStepStatus", () => {
  it("updates only the targeted prompt", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      prompts: [makePrompt(), makePrompt(), makePrompt()],
    });

    store().setStepStatus(1, STEP_STATUS.COMPLETED);

    expect(store().prompts[0].status).toBe(STEP_STATUS.PENDING);
    expect(store().prompts[1].status).toBe(STEP_STATUS.COMPLETED);
    expect(store().prompts[2].status).toBe(STEP_STATUS.PENDING);
  });

  it("sets status to RUNNING for the active step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    store().setStepStatus(0, STEP_STATUS.RUNNING);
    expect(store().prompts[0].status).toBe(STEP_STATUS.RUNNING);
  });
});

// ---------------------------------------------------------------------------
// addCliOutput
// ---------------------------------------------------------------------------

describe("addCliOutput", () => {
  it("appends the first output for a step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    store().addCliOutput(0, makeOutput({ response: "first" }));
    expect(store().getStepOutputs(0)).toHaveLength(1);
    expect(store().getStepOutputs(0)[0].response).toBe("first");
  });

  it("replaces output for attemptIndex 0 (no retry state)", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    store().addCliOutput(0, makeOutput({ response: "first", attemptIndex: 0 }));
    store().addCliOutput(
      0,
      makeOutput({ response: "second", attemptIndex: 0 })
    );
    // Second write replaces first
    expect(store().getStepOutputs(0)).toHaveLength(1);
    expect(store().getStepOutputs(0)[0].response).toBe("second");
  });

  it("appends outputs for different steps independently", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      prompts: [makePrompt(), makePrompt()],
    });
    store().addCliOutput(0, makeOutput({ response: "step0" }));
    store().addCliOutput(1, makeOutput({ response: "step1" }));
    expect(store().getStepOutputs(0)[0].response).toBe("step0");
    expect(store().getStepOutputs(1)[0].response).toBe("step1");
  });
});

// ---------------------------------------------------------------------------
// appendStreamingChunk / clearStreamingChunk
// ---------------------------------------------------------------------------

describe("appendStreamingChunk", () => {
  it("concatenates chunks for a step", () => {
    store().appendStreamingChunk(0, "Hello");
    store().appendStreamingChunk(0, " World");
    expect(store().streamingChunks[0]).toBe("Hello World");
  });

  it("does not affect other steps", () => {
    store().appendStreamingChunk(0, "step0");
    store().appendStreamingChunk(1, "step1");
    expect(store().streamingChunks[0]).toBe("step0");
    expect(store().streamingChunks[1]).toBe("step1");
  });
});

describe("clearStreamingChunk", () => {
  it("resets the chunk to empty string", () => {
    store().appendStreamingChunk(0, "text");
    store().clearStreamingChunk(0);
    expect(store().streamingChunks[0]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Retry state
// ---------------------------------------------------------------------------

describe("setRetryState", () => {
  it("stores retry state for a step", () => {
    store().setRetryState(2, 1, 3);
    expect(store().retryStates[2]).toEqual({ currentRetry: 1, maxRetries: 3 });
  });
});

describe("clearRetryState", () => {
  it("removes retry state for a step", () => {
    store().setRetryState(0, 1, 3);
    store().clearRetryState(0);
    expect(store().retryStates[0]).toBeUndefined();
  });

  it("does not affect other steps", () => {
    store().setRetryState(0, 1, 3);
    store().setRetryState(1, 2, 3);
    store().clearRetryState(0);
    expect(store().retryStates[1]).toEqual({ currentRetry: 2, maxRetries: 3 });
  });
});

// ---------------------------------------------------------------------------
// addStatusMessage
// ---------------------------------------------------------------------------

describe("addStatusMessage", () => {
  it("appends status messages for a step", () => {
    store().addStatusMessage(0, "Starting...");
    store().addStatusMessage(0, "Retrying...", "warning");
    expect(store().statusMessages[0]).toHaveLength(2);
    expect(store().statusMessages[0][0].message).toBe("Starting...");
    expect(store().statusMessages[0][0].severity).toBe("info");
    expect(store().statusMessages[0][1].severity).toBe("warning");
  });

  it("does not mix messages between steps", () => {
    store().addStatusMessage(0, "step0 msg");
    store().addStatusMessage(1, "step1 msg");
    expect(store().statusMessages[0]).toHaveLength(1);
    expect(store().statusMessages[1]).toHaveLength(1);
  });
});

describe("clearStatusMessages", () => {
  it("removes all messages for a step", () => {
    store().addStatusMessage(0, "msg1");
    store().addStatusMessage(0, "msg2");
    store().clearStatusMessages(0);
    expect(store().statusMessages[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadHistoryRun
// ---------------------------------------------------------------------------

describe("loadHistoryRun", () => {
  it("stores canonical ordered history entries when present", () => {
    const history: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId: "wf-history",
      runId: 3,
      startedAt: 100,
      completedAt: 150,
      executionState: EXECUTION_STATES.COMPLETED,
      runStepCount: 1,
      promptOutputs: {
        0: {
          cliOutputs: [
            makeOutput({ response: "history output", timestampMs: 120 }),
          ],
          statusMessages: [
            { message: "history status", severity: "info", timestamp: 110 },
          ],
        },
      },
      orderedEntries: [
        {
          kind: "status",
          target: { kind: "queue", stepIndex: 0 },
          statusMessage: {
            message: "history status",
            severity: "info",
            timestamp: 110,
          },
          timestampMs: 110,
          sequence: 1,
        },
        {
          kind: "cli",
          target: { kind: "queue", stepIndex: 0 },
          attemptIndex: 0,
          cliOutput: makeOutput({
            response: "history output",
            timestampMs: 120,
          }),
          timestampMs: 120,
          sequence: 2,
        },
      ],
      outputTimeline: [
        {
          key: "queue:0",
          target: { kind: "queue", stepIndex: 0 },
          firstOutputAt: 110,
        },
      ],
    };

    store().loadHistoryRun(history, 4, 1);

    expect(store().historyOutputs?.orderedEntries).toEqual(
      history.orderedEntries
    );
    expect(store().historyOutputs?.outputTimeline).toEqual(
      history.outputTimeline
    );
    expect(store().historyOutputs?.steps[0]?.cliOutputs[0]?.response).toBe(
      "history output"
    );
  });

  it("keeps legacy histories compatible when ordered entries are absent", () => {
    const history: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId: "wf-legacy-history",
      runId: 1,
      startedAt: 100,
      completedAt: 140,
      executionState: EXECUTION_STATES.COMPLETED,
      runStepCount: 1,
      promptOutputs: {
        0: {
          cliOutputs: [
            makeOutput({ response: "legacy output", timestampMs: 120 }),
          ],
          statusMessages: [],
        },
      },
    };

    store().loadHistoryRun(history, 1, 0);

    expect(store().historyOutputs?.orderedEntries).toBeUndefined();
    expect(store().historyOutputs?.outputTimeline).toBeUndefined();
    expect(store().historyOutputs?.steps[0]?.cliOutputs[0]?.response).toBe(
      "legacy output"
    );
  });
});

// ---------------------------------------------------------------------------
// Computed selectors
// ---------------------------------------------------------------------------

describe("getCurrentPrompt", () => {
  it("returns the prompt at currentStep", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      prompts: [
        makePrompt({ prompt: "first" }),
        makePrompt({ prompt: "second" }),
      ],
    });
    store().setCurrentStep(1);
    expect(store().getCurrentPrompt()?.prompt).toBe("second");
  });

  it("returns null when prompts are empty", () => {
    expect(store().getCurrentPrompt()).toBeNull();
  });
});

describe("getPromptByIndex", () => {
  it("returns prompt at given index", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      prompts: [makePrompt({ prompt: "zero" }), makePrompt({ prompt: "one" })],
    });
    expect(store().getPromptByIndex(1)?.prompt).toBe("one");
  });

  it("returns null for out-of-range index", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    expect(store().getPromptByIndex(99)).toBeNull();
  });
});

describe("getCompletedCount", () => {
  it("counts only completed prompts", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      prompts: [makePrompt(), makePrompt(), makePrompt()],
      results: [
        { status: STEP_STATUS.COMPLETED },
        { status: STEP_STATUS.COMPLETED },
        { status: STEP_STATUS.PENDING },
      ],
    });
    expect(store().getCompletedCount()).toBe(2);
  });
});

describe("isWorkflowRunning / isWorkflowPaused / isWorkflowIdle / isWorkflowComplete", () => {
  it("reflects execution state correctly", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });

    expect(store().isWorkflowIdle()).toBe(true);
    expect(store().isWorkflowRunning()).toBe(false);

    store().setExecutionState(EXECUTION_STATES.RUNNING);
    expect(store().isWorkflowRunning()).toBe(true);
    expect(store().isWorkflowIdle()).toBe(false);

    store().setExecutionState(EXECUTION_STATES.PAUSED);
    expect(store().isWorkflowPaused()).toBe(true);

    store().setExecutionState(EXECUTION_STATES.COMPLETED);
    expect(store().isWorkflowComplete()).toBe(true);
  });
});

describe("isStepFailed", () => {
  it("returns true for a failed step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    store().setStepStatus(0, STEP_STATUS.FAILED);
    expect(store().isStepFailed(0)).toBe(true);
  });

  it("returns false for non-failed step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    expect(store().isStepFailed(0)).toBe(false);
  });
});

describe("getLatestOutput", () => {
  it("returns last output for a step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", prompts: [makePrompt()] });
    store().addCliOutput(0, makeOutput({ response: "first" }));
    // The second write replaces (no retry state) — so only one entry
    expect(store().getLatestOutput(0)?.response).toBe("first");
  });

  it("returns null when no outputs", () => {
    expect(store().getLatestOutput(99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetWorkflow
// ---------------------------------------------------------------------------

describe("resetWorkflow", () => {
  it("clears all state back to initial values", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      workflowName: "Test",
      prompts: [makePrompt()],
    });
    store().addCliOutput(0, makeOutput());
    store().setRetryState(0, 1, 3);

    store().resetWorkflow();

    expect(store().fileName).toBeNull();
    expect(store().workflowName).toBeNull();
    expect(store().prompts).toHaveLength(0);
    expect(store().cliOutputs).toEqual({});
    expect(store().retryStates).toEqual({});
    expect(store().executionState).toBe(EXECUTION_STATES.IDLE);
  });
});
