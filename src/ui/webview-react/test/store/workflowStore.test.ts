/**
 * Tests for non-temporal workflowStore behaviour.
 * Temporal (undo/redo) behaviour is covered in workflowStore.temporal.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflowStore } from "@store/workflowStore";
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  STEP_STATUS,
  FINAL_STEP_PHASES,
  OPERATION_STATUS,
  OUTPUT_HISTORY_KINDS,
  EXECUTION_PHASES,
  getStreamingChunkKey,
} from "@/types/messages";
import type { PromptStep, CliOutput } from "@/types/messages";
import type {
  WorkflowOutputHistory,
  OrderedHistoryEntry,
  OrderedCliHistoryEntry,
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
      fileName: "test.ctrlyoke.yaml",
      workflowName: "My Workflow",
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });

    expect(store().fileName).toBe("test.ctrlyoke.yaml");
    expect(store().workflowName).toBe("My Workflow");
    expect(store().steps).toHaveLength(2);
    expect((store().steps[0] as any).prompt).toBe("Step 1");
  });

  it("sets totalSteps to prompts length", () => {
    store().loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [makePrompt(), makePrompt(), makePrompt()],
    });
    expect(store().totalSteps).toBe(3);
  });

  it("defaults all prompts to PENDING status", () => {
    store().loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [makePrompt(), makePrompt()],
    });
    for (const p of store().steps) {
      expect((p as any).status).toBe(STEP_STATUS.PENDING);
    }
  });

  it("applies results status to prompts", () => {
    store().loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
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

  it("tracks active step indices independently of the group join index", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt(), makePrompt(), makePrompt()],
      currentStep: 0,
      activeStepIndices: [2, 1],
    });

    expect(store().currentStep).toBe(0);
    expect(store().activeStepIndices).toEqual([2, 1]);

    store().setActiveStepIndices([1]);
    expect(store().activeStepIndices).toEqual([1]);
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
    expect(
      store().streamingChunks[getStreamingChunkKey(0)]
    ).toBe("Hello World");
  });

  it("does not affect other steps", () => {
    store().appendStreamingChunk(0, "step0");
    store().appendStreamingChunk(1, "step1");
    expect(store().streamingChunks[getStreamingChunkKey(0)]).toBe("step0");
    expect(store().streamingChunks[getStreamingChunkKey(1)]).toBe("step1");
  });

  it("keeps condition phases isolated for the same step", () => {
    store().appendStreamingChunk(0, "pre", EXECUTION_PHASES.PRE_CONDITION);
    store().appendStreamingChunk(0, "end", EXECUTION_PHASES.END_CONDITION);

    expect(
      store().streamingChunks[
        getStreamingChunkKey(0, EXECUTION_PHASES.PRE_CONDITION)
      ]
    ).toBe("pre");
    expect(
      store().streamingChunks[
        getStreamingChunkKey(0, EXECUTION_PHASES.END_CONDITION)
      ]
    ).toBe("end");
  });
});

describe("clearStreamingChunk", () => {
  it("resets the chunk to empty string", () => {
    store().appendStreamingChunk(0, "text");
    store().clearStreamingChunk(0);
    expect(store().streamingChunks[getStreamingChunkKey(0)]).toBe("");
  });

  it("keeps same-target attempts in separate full streaming keys", () => {
    store().appendStreamingChunk(0, "first", undefined, 0, 0);
    store().appendStreamingChunk(0, "retry", undefined, 0, 1);

    expect(
      store().streamingChunks[getStreamingChunkKey(0, undefined, 0, 0)]
    ).toBe("first");
    expect(
      store().streamingChunks[getStreamingChunkKey(0, undefined, 0, 1)]
    ).toBe("retry");
    expect(
      getStreamingChunkKey(0, undefined, 0, 0)
    ).not.toBe(getStreamingChunkKey(0, undefined, 0, 1));
  });
});

describe("appendStreamingEvents", () => {
  it("collapses duplicate tool lifecycle events into one semantic event", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    store().appendStreamingEvents(0, [
      {
        type: CLI_EVENT_TYPES.FILE_READ,
        data: {
          path: "src/example.ts",
          status: OPERATION_STATUS.INITIATED,
        },
      },
      {
        type: CLI_EVENT_TYPES.TOOL_RESULT,
        data: {
          toolCallId: "read-1",
          result: { success: true, output: "contents" },
        },
      },
    ]);

    store().appendStreamingEvents(0, [
      {
        type: CLI_EVENT_TYPES.FILE_READ,
        data: {
          path: "src/example.ts",
          content: "contents",
          status: OPERATION_STATUS.COMPLETED,
          success: true,
        },
      },
    ]);

    const entry = store().liveOrderedEntries.find(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    );

    const events =
      entry && "cliOutput" in entry
        ? entry.cliOutput.structured?.events
        : undefined;
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      type: CLI_EVENT_TYPES.FILE_READ,
      data: {
        path: "src/example.ts",
        content: "contents",
        status: OPERATION_STATUS.COMPLETED,
        success: true,
      },
    });
  });

  it("keeps separate streaming entries for different runIndex values", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    store().appendStreamingEvents(
      0,
      [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "original run" } }],
      0,
      0
    );
    store().appendStreamingEvents(
      0,
      [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "rerun" } }],
      0,
      1
    );

    const entries = store().liveOrderedEntries.filter(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    );

    expect(entries).toHaveLength(2);
    expect(entries).toMatchObject([
      { runIndex: 0, attemptIndex: 0 },
      { runIndex: 1, attemptIndex: 0 },
    ]);
  });

  it("does not merge prompt events into a pre-condition entry sharing the same attempt", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    // A failed pre-condition gate for step 0 leaves a CLI entry with the same
    // (target, runIndex, attemptIndex) as the prompt that follows it.
    const preConditionEntry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      phase: EXECUTION_PHASES.PRE_CONDITION,
      cliOutput: makeOutput({ prompt: "npm test", response: "1 failing" }),
      timestampMs: Date.now(),
      sequence: 0,
    };
    store().appendLiveEntry(preConditionEntry);

    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "fixing the test" } },
    ]);

    const entries = store().liveOrderedEntries.filter(
      (item): item is OrderedCliHistoryEntry =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI
    );

    expect(entries).toHaveLength(2);
    const [preCondition, prompt] = entries;
    expect(preCondition.phase).toBe(EXECUTION_PHASES.PRE_CONDITION);
    expect(preCondition.cliOutput.structured?.events).toBeUndefined();
    expect(prompt.phase ?? EXECUTION_PHASES.PROMPT).toBe(
      EXECUTION_PHASES.PROMPT
    );
    expect(prompt.cliOutput.structured?.events).toMatchObject([
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "fixing the test" } },
    ]);
  });

  it("merges post-completion follow-up activity into the completed entry instead of creating a new one", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    const completedEntry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        structured: {
          events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } }],
          metadata: {},
        },
      }),
      timestampMs: Date.now(),
      sequence: 0,
    };
    store().appendLiveEntry(completedEntry);

    // Simulate SessionActivityWatcher forwarding a follow-up typed after completion.
    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "one more thing" } },
    ]);

    const matches = store().liveOrderedEntries.filter(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    );
    expect(matches).toHaveLength(1);

    const events = (matches[0] as OrderedCliHistoryEntry).cliOutput.structured
      ?.events;
    expect(events?.map((e) => e.type)).toEqual([
      CLI_EVENT_TYPES.TEXT,
      CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
      CLI_EVENT_TYPES.USER_STEER,
    ]);
  });

  it("updates the rendered history snapshot when follow-up activity arrives for a retired run", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    const completedEntry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        structured: {
          events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } }],
          metadata: {},
        },
      }),
      timestampMs: Date.now(),
      sequence: 0,
    };
    useWorkflowStore.setState({
      liveOrderedEntries: [],
      historyOutputs: {
        orderedEntries: [completedEntry],
        promptOutputs: {},
        runMetadata: {
          runId: 1,
          startedAt: Date.now() - 1000,
          executionState: EXECUTION_STATES.COMPLETED,
        },
      },
    });

    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "one more thing" } },
    ]);

    const historyEntry = store().historyOutputs
      ?.orderedEntries[0] as OrderedCliHistoryEntry;
    expect(
      historyEntry.cliOutput.structured?.events.map((event) => event.type)
    ).toEqual([
      CLI_EVENT_TYPES.TEXT,
      CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
      CLI_EVENT_TYPES.USER_STEER,
    ]);
    expect(
      (store().liveOrderedEntries[0] as OrderedCliHistoryEntry).cliOutput
        .structured?.events
    ).toEqual(historyEntry.cliOutput.structured?.events);
  });

  it("updates a retired run's final-step history snapshot with follow-up activity", () => {
    const completedEntry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        structured: {
          events: [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "final" } }],
          metadata: {},
        },
      }),
      timestampMs: Date.now(),
      sequence: 0,
    };
    useWorkflowStore.setState({
      liveOrderedEntries: [],
      historyOutputs: {
        orderedEntries: [completedEntry],
        promptOutputs: {},
        finalStepOutputs: {},
        runMetadata: {
          runId: 1,
          startedAt: Date.now() - 1000,
          executionState: EXECUTION_STATES.COMPLETED,
        },
      },
    });

    store().appendFinalStepStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "follow-up" } },
    ]);

    const historyEntry = store().historyOutputs
      ?.orderedEntries[0] as OrderedCliHistoryEntry;
    expect(
      historyEntry.cliOutput.structured?.events.map((event) => event.type)
    ).toEqual([
      CLI_EVENT_TYPES.TEXT,
      CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
      CLI_EVENT_TYPES.TEXT,
    ]);
  });

  it("inserts the follow-up divider only once across multiple resumed batches", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        structured: { events: [], metadata: {} },
      }),
      timestampMs: Date.now(),
      sequence: 0,
    });

    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "first" } },
    ]);
    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "second" } },
    ]);

    const entry = store().liveOrderedEntries.find(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    ) as OrderedCliHistoryEntry;

    const dividerCount = entry.cliOutput.structured?.events.filter(
      (e) => e.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
    ).length;
    expect(dividerCount).toBe(1);
  });

  it("refreshes tokens from a CONTEXT_WINDOW_SYNC marker without rendering it as a row", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        tokens: { prompt: 10, completion: 5 },
        structured: { events: [], metadata: {} },
      }),
      timestampMs: Date.now(),
      sequence: 0,
    });

    store().appendStreamingEvents(0, [
      {
        type: CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC,
        data: { used: 4000, size: 200000 },
      },
    ]);

    const entry = store().liveOrderedEntries.find(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    ) as OrderedCliHistoryEntry;

    expect(entry.cliOutput.tokens).toMatchObject({
      prompt: 10,
      completion: 5,
      contextWindowUsed: 4000,
      contextWindowSize: 200000,
    });
    expect(entry.cliOutput.structured?.events).toHaveLength(0);
  });

  it("refreshes elapsed time when follow-up activity is merged into a completed entry", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    const startedAt = Date.now() - 5000;
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({
        elapsed: 5,
        timestampMs: startedAt,
        structured: { events: [], metadata: {} },
      }),
      timestampMs: startedAt,
      sequence: 0,
    });

    store().appendStreamingEvents(0, [
      { type: CLI_EVENT_TYPES.USER_STEER, data: { text: "still here?" } },
    ]);

    const entry = store().liveOrderedEntries.find(
      (item) =>
        item.kind === OUTPUT_HISTORY_KINDS.CLI &&
        "target" in item &&
        item.target.kind === FINAL_STEP_PHASES.QUEUE &&
        item.target.stepIndex === 0
    ) as OrderedCliHistoryEntry;

    expect(entry.cliOutput.elapsed).toBeGreaterThanOrEqual(5);
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
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        (e as any).target.stepIndex === 0
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
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        (e as any).target.stepIndex === 0
    );
    const step1 = store().liveOrderedEntries.filter(
      (e) =>
        e.kind === OUTPUT_HISTORY_KINDS.STATUS &&
        (e as any).target.stepIndex === 1
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

    store().loadHistoryRun(history);

    expect(store().historyOutputs?.orderedEntries).toEqual(orderedEntries);
    expect(store().historyOutputs?.promptOutputs).toEqual({});
  });
});

describe("hydrateLiveRunHistory", () => {
  it("seeds the complete live timeline and overlays a matching buffered attempt", () => {
    const persistedEntry: OrderedCliHistoryEntry = {
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      runIndex: 0,
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "persisted" }),
      timestampMs: 120,
      sequence: 4,
    };
    const history: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId: "wf-live-history",
      runId: 3,
      startedAt: 100,
      executionState: EXECUTION_STATES.RUNNING,
      promptOutputs: {
        0: {
          workspaceSnapshot: {
            capturedAt: 125,
            strategy: "filesystem",
            changedFiles: [],
          },
          undoRecord: {
            appliedAt: 130,
            restoredFiles: ["src/example.ts"],
            redoInstructions: [],
          },
        },
      },
      orderedEntries: [persistedEntry],
    };

    store().hydrateLiveRunHistory(history);

    expect(store().historyOutputs).toBeNull();
    expect(store().liveOrderedEntries).toEqual([persistedEntry]);
    expect(store().liveSequence).toBe(5);
    expect(store().workspaceSnapshots[0]).toEqual({
      capturedAt: 125,
      strategy: "filesystem",
      changedFiles: [],
    });
    expect(store().undoRecords["queue-0"]?.appliedAt).toBe(130);

    store().appendLiveEntry({
      ...persistedEntry,
      cliOutput: makeOutput({ response: "buffered replacement" }),
      timestampMs: 140,
      sequence: store().liveSequence,
    });

    expect(store().liveOrderedEntries).toHaveLength(1);
    expect(
      (store().liveOrderedEntries[0] as OrderedCliHistoryEntry).cliOutput
        .response
    ).toBe("buffered replacement");
    expect(store().liveOrderedEntries[0]?.sequence).toBe(4);
    expect(store().liveSequence).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Snapshot replay structural sharing
// ---------------------------------------------------------------------------

describe("snapshot replay structural sharing", () => {
  it("preserves the steps array identity when a replayed loadWorkflow delivers identical steps", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });
    const firstSteps = store().steps;

    // Same content, freshly parsed objects — as a RUN_VIEW_LOADED replay sends.
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });

    expect(store().steps).toBe(firstSteps);
  });

  it("reuses unchanged step objects when only one step changed", () => {
    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2" }),
      ],
    });
    const firstSteps = store().steps;

    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [
        makePrompt({ prompt: "Step 1" }),
        makePrompt({ prompt: "Step 2 (edited)" }),
      ],
    });

    expect(store().steps).not.toBe(firstSteps);
    expect(store().steps[0]).toBe(firstSteps[0]);
    expect((store().steps[1] as any).prompt).toBe("Step 2 (edited)");
  });

  it("keeps live output and runtime state on a preserveLiveOutput replay", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ timestampMs: 100 }),
      timestampMs: 100,
      sequence: 1,
    });
    const entries = store().liveOrderedEntries;
    expect(entries).toHaveLength(1);
    const sequence = store().liveSequence;

    store().loadWorkflow({
      fileName: "wf.yaml",
      steps: [makePrompt()],
      preserveLiveOutput: true,
    });

    expect(store().liveOrderedEntries).toBe(entries);
    expect(store().liveSequence).toBe(sequence);
  });

  it("still clears live output on a load without preserveLiveOutput", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });
    store().appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ timestampMs: 100 }),
      timestampMs: 100,
      sequence: 1,
    });

    store().loadWorkflow({ fileName: "other.yaml", steps: [makePrompt()] });

    expect(store().liveOrderedEntries).toEqual([]);
    expect(store().liveSequence).toBe(0);
  });

  it("preserves liveOrderedEntries identity when hydrateLiveRunHistory re-delivers the same timeline", () => {
    const makeHistory = (): WorkflowOutputHistory => ({
      schemaVersion: "1.1.0",
      workflowId: "wf-rehydrate",
      runId: 3,
      startedAt: 100,
      executionState: EXECUTION_STATES.RUNNING,
      promptOutputs: {},
      orderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: makeOutput({ response: "persisted", timestampMs: 120 }),
          timestampMs: 120,
          sequence: 4,
        },
      ],
    });

    store().hydrateLiveRunHistory(makeHistory());
    const entries = store().liveOrderedEntries;
    expect(entries).toHaveLength(1);

    store().hydrateLiveRunHistory(makeHistory());

    expect(store().liveOrderedEntries).toBe(entries);
  });

  it("preserves historyOutputs identity when loadHistoryRun re-delivers the same run", () => {
    const makeHistory = (): WorkflowOutputHistory => ({
      schemaVersion: "1.1.0",
      workflowId: "wf-history-replay",
      runId: 3,
      startedAt: 100,
      completedAt: 150,
      executionState: EXECUTION_STATES.COMPLETED,
      promptOutputs: {},
      orderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          attemptIndex: 0,
          cliOutput: makeOutput({ response: "done", timestampMs: 120 }),
          timestampMs: 120,
          sequence: 2,
        },
      ],
    });

    store().loadHistoryRun(makeHistory());
    const historyOutputs = store().historyOutputs;
    expect(historyOutputs).not.toBeNull();

    store().loadHistoryRun(makeHistory());

    expect(store().historyOutputs).toBe(historyOutputs);
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

describe("isWorkflowRunning / isWorkflowActive / isWorkflowPaused / isWorkflowIdle / isWorkflowComplete", () => {
  it("reflects execution state correctly", () => {
    store().loadWorkflow({ fileName: "wf.yaml", steps: [makePrompt()] });

    expect(store().isWorkflowIdle()).toBe(true);
    expect(store().isWorkflowRunning()).toBe(false);
    expect(store().isWorkflowActive()).toBe(false);

    store().setExecutionState(EXECUTION_STATES.RUNNING);
    expect(store().isWorkflowRunning()).toBe(true);
    expect(store().isWorkflowActive()).toBe(true);
    expect(store().isWorkflowIdle()).toBe(false);

    store().setExecutionState(EXECUTION_STATES.PAUSING);
    expect(store().isWorkflowRunning()).toBe(true);
    expect(store().isWorkflowActive()).toBe(true);

    store().setExecutionState(EXECUTION_STATES.PAUSED);
    expect(store().isWorkflowPaused()).toBe(true);
    expect(store().isWorkflowRunning()).toBe(false);
    expect(store().isWorkflowActive()).toBe(true);

    store().setExecutionState(EXECUTION_STATES.COMPLETED);
    expect(store().isWorkflowComplete()).toBe(true);
    expect(store().isWorkflowActive()).toBe(false);
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
