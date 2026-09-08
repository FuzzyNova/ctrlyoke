import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useFinalStepLatestOutput,
  useLatestStepOutput,
} from "@hooks/useLatestStepOutput";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "@/types/messages";
import type { CliOutput } from "@/types/messages";

function makeOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return {
    prompt: "hello",
    response: "world",
    elapsed: 12.5,
    timestampMs: Date.now(),
    attemptIndex: 0,
    isStreaming: false,
    ...overrides,
  };
}

const AI_TOKENS = {
  prompt: 20,
  completion: 27427,
  total: 27447,
  contextWindowUsed: 54047,
  contextWindowSize: 1000000,
};

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.setState({ isViewingHistory: false });
});

describe("useLatestStepOutput", () => {
  it("keeps the prompt output when an end-condition script runs afterwards", () => {
    const store = useWorkflowStore.getState();
    store.loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [{ prompt: "plan" }],
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({
        response: "ai output",
        elapsed: 138.4,
        tokens: AI_TOKENS,
      }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    // The end condition reports against the same stepIndex but carries no
    // tokens and its own (much shorter) duration.
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ response: "npm test output", elapsed: 0.094 }),
      timestampMs: Date.now(),
      sequence: 2,
    });

    const { result } = renderHook(() => useLatestStepOutput());
    const latest = result.current(0);

    expect(latest?.response).toBe("ai output");
    expect(latest?.elapsed).toBe(138.4);
    expect(latest?.tokens?.contextWindowSize).toBe(1000000);
  });

  it("still returns the newest prompt output across retries", () => {
    const store = useWorkflowStore.getState();
    store.loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [{ prompt: "implement" }],
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "attempt 1" }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ response: "failed check" }),
      timestampMs: Date.now(),
      sequence: 2,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 1,
      cliOutput: makeOutput({ response: "attempt 2", attemptIndex: 1 }),
      timestampMs: Date.now(),
      sequence: 3,
    });

    const { result } = renderHook(() => useLatestStepOutput());
    expect(result.current(0)?.response).toBe("attempt 2");
  });
});

describe("useFinalStepLatestOutput", () => {
  it("skips the final step's end-condition output", () => {
    const store = useWorkflowStore.getState();
    store.loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [{ prompt: "only" }],
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ response: "final ai output", tokens: AI_TOKENS }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ response: "npm test output" }),
      timestampMs: Date.now(),
      sequence: 2,
    });

    const { result } = renderHook(() => useFinalStepLatestOutput());
    expect(result.current?.response).toBe("final ai output");
    expect(result.current?.tokens?.contextWindowSize).toBe(1000000);
  });
});
