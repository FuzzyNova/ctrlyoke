/**
 * Tests for non-temporal workflowStore behaviour.
 * Temporal (undo/redo) behaviour is covered in workflowStore.temporal.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "@store/workflowStore";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "@/types/messages";
import type { PromptStep, CliOutput } from "@/types/messages";
import type {
  WorkflowOutputHistory,
  OrderedHistoryEntry,
} from "@root/types/OutputHistoryTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function store() {
  return useWorkflowStore.getState();
}

function makePrompt(overrides: Partial<PromptStep> = {}): PromptStep {
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
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });

    expect(store().fileName).toBe("test.flightpath.yaml");
    expect(store().workflowName).toBe("My Workflow");
    expect(store().steps).toHaveLength(2);
    expect((store().steps[0] as any).prompt).toBe("Step 1");
  });

  it("sets totalSteps to prompts length", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      steps: [makePrompt(), makePrompt(), makePrompt()],
    });
    expect(store().totalSteps).toBe(3);
  });

  it("defaults all prompts to PENDING status", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      steps: [makePrompt(), makePrompt()],
    });
    for (const p of store().steps) {
      expect((p as any).status).toBe(STEP_STATUS.PENDING);
    }
  });

  it("applies results status to prompts", () => {
    store().loadWorkflow({
      fileName: "wf.flightpath.yaml",
      steps: [makePrompt(), makePrompt()],
      results: [{ status: STEP_STATUS.COMPLETED }, {}],
    });
    expect((store().steps[0] as any).status).toBe(STEP_STATUS.COMPLETED);
    expect((store().steps[1] as any).status).toBe(STEP_STATUS.PENDING);
  });

  it("clears runtime state (liveOrderedEntries, retryStates, etc.)", () => {
    // Populate some runtime state first
    store().loadWorkflow({ fileName: "a.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput(),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().setRetryState(0, 1, 3);

    // Load new workflow — runtime state should clear
    store().loadWorkflow({ fileName: "b.yaml", steps: [makePrompt()] });
    expect(store().liveOrderedEntries).toEqual([]);
    expect(store().retryStates).toEqual({});
  });

  it("sets executionState to IDLE by default", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
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
      steps: [makePrompt(), makePrompt(), makePrompt()],
    });

    store().setStepStatus(1, STEP_STATUS.COMPLETED);

    expect((store().steps[0] as any).status).toBe(STEP_STATUS.PENDING);
    expect((store().steps[1] as any).status).toBe(STEP_STATUS.COMPLETED);
    expect((store().steps[2] as any).status).toBe(STEP_STATUS.PENDING);
  });

  it("sets status to RUNNING for the active step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().setStepStatus(0, STEP_STATUS.RUNNING);
    expect((store().steps[0] as any).status).toBe(STEP_STATUS.RUNNING);
  });
});

// ---------------------------------------------------------------------------
// appendLiveEntry (cli)
// ---------------------------------------------------------------------------

describe("appendLiveEntry (cli)", () => {
  it("appends the first cli entry for a step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "first" }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    expect(store().getStepOutputs(0)).toHaveLength(1);
    expect(store().getStepOutputs(0)[0].response).toBe("first");
  });

  it("replaces a streaming entry for the same attemptIndex", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "streaming", isStreaming: true }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "final", isStreaming: false }),
      timestampMs: Date.now(),
      sequence: 2,
    });
    // Final replaces streaming entry
    expect(store().getStepOutputs(0)).toHaveLength(1);
    expect(store().getStepOutputs(0)[0].response).toBe("final");
  });

  it("appends entries for different steps independently", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt(), makePrompt()],
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "step0" }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "step1" }),
      timestampMs: Date.now(),
      sequence: 2,
    });
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
// appendLiveEntry (status)
// ---------------------------------------------------------------------------

describe("appendLiveEntry (status)", () => {
  it("appends status entries", () => {
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      statusMessage: {
        message: "Starting...",
        severity: "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      statusMessage: {
        message: "Retrying...",
        severity: "warning",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 2,
    });
    const statusEntries = store().liveOrderedEntries.filter(
      (e) => e.kind === "status" && (e as any).target.stepIndex === 0
    );
    expect(statusEntries).toHaveLength(2);
    expect((statusEntries[0] as any).statusMessage.message).toBe("Starting...");
    expect((statusEntries[0] as any).statusMessage.severity).toBe("info");
    expect((statusEntries[1] as any).statusMessage.severity).toBe("warning");
  });

  it("does not mix entries between steps", () => {
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      statusMessage: {
        message: "step0 msg",
        severity: "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
      statusMessage: {
        message: "step1 msg",
        severity: "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 2,
    });
    const step0 = store().liveOrderedEntries.filter(
      (e) => e.kind === "status" && (e as any).target.stepIndex === 0
    );
    const step1 = store().liveOrderedEntries.filter(
      (e) => e.kind === "status" && (e as any).target.stepIndex === 1
    );
    expect(step0).toHaveLength(1);
    expect(step1).toHaveLength(1);
  });

  it("clearLiveEntries removes all entries", () => {
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      statusMessage: {
        message: "msg1",
        severity: "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.STATUS,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      statusMessage: {
        message: "msg2",
        severity: "info",
        timestamp: Date.now(),
      },
      timestampMs: Date.now(),
      sequence: 2,
    });
    store().clearLiveEntries();
    expect(store().liveOrderedEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadHistoryRun
// ---------------------------------------------------------------------------

describe("loadHistoryRun", () => {
  it("stores canonical ordered history entries", () => {
    const orderedEntries: OrderedHistoryEntry[] = [
      {
        kind: OUTPUT_HISTORY_KINDS.STATUS,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        statusMessage: {
          message: "history status",
          severity: "info",
          timestamp: 110,
        },
        timestampMs: 110,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 0,
        cliOutput: makeOutput({
          response: "history output",
          timestampMs: 120,
        }),
        timestampMs: 120,
        sequence: 2,
      },
    ];
    const history: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId: "wf-history",
      runId: 3,
      startedAt: 100,
      completedAt: 150,
      executionState: EXECUTION_STATES.COMPLETED,
      promptOutputs: {},
      orderedEntries,
    };

    store().loadHistoryRun(history, 4, 1);

    expect(store().historyOutputs?.orderedEntries).toEqual(orderedEntries);
    expect(store().historyOutputs?.promptOutputs).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Computed selectors
// ---------------------------------------------------------------------------

describe("getCurrentPrompt", () => {
  it("returns the prompt at currentStep", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [
        makePrompt({ prompt: "first" }),
        makePrompt({ prompt: "second" }),
      ],
    });
    store().setCurrentStep(1);
    expect((store().getCurrentPrompt() as any)?.prompt).toBe("second");
  });

  it("returns null when prompts are empty", () => {
    expect(store().getCurrentPrompt()).toBeNull();
  });
});

describe("getPromptByIndex", () => {
  it("returns prompt at given index", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt({ prompt: "zero" }), makePrompt({ prompt: "one" })],
    });
    expect((store().getPromptByIndex(1) as any)?.prompt).toBe("one");
  });

  it("returns null for out-of-range index", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    expect(store().getPromptByIndex(99)).toBeNull();
  });
});

describe("getCompletedCount", () => {
  it("counts only completed prompts", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt(), makePrompt(), makePrompt()],
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
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

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
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().setStepStatus(0, STEP_STATUS.FAILED);
    expect(store().isStepFailed(0)).toBe(true);
  });

  it("returns false for non-failed step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    expect(store().isStepFailed(0)).toBe(false);
  });
});

describe("getLatestOutput", () => {
  it("returns last output for a step", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "first" }),
      timestampMs: Date.now(),
      sequence: 1,
    });
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
      steps: [makePrompt()],
    });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput(),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store().setRetryState(0, 1, 3);

    store().resetWorkflow();

    expect(store().fileName).toBeNull();
    expect(store().workflowName).toBeNull();
    expect(store().steps).toHaveLength(0);
    expect(store().liveOrderedEntries).toEqual([]);
    expect(store().retryStates).toEqual({});
    expect(store().executionState).toBe(EXECUTION_STATES.IDLE);
  });
});
