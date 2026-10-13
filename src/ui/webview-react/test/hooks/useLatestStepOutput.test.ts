import { getStepOutputText } from "../../../../utils/StepOutputText";
import { StepOutputTextMode } from "../../../../types/DashboardConstants";
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

    structured: { events: [{ type: "text", data: { text: "world" } }], metadata: {} },
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
        structured: { events: [{ type: "text", data: { text: "ai output" } }], metadata: {} },
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
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "npm test output" } }], metadata: {} }, elapsed: 0.094 }),
      timestampMs: Date.now(),
      sequence: 2,
    });

    const { result } = renderHook(() => useLatestStepOutput());
    const latest = result.current(0);

    expect(getStepOutputText({ output: latest ?? undefined }, StepOutputTextMode.TRANSCRIPT)).toBe("ai output");
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
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "attempt 1" } }], metadata: {} } }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "failed check" } }], metadata: {} } }),
      timestampMs: Date.now(),
      sequence: 2,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 1,
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "attempt 2" } }], metadata: {} }, attemptIndex: 1 }),
      timestampMs: Date.now(),
      sequence: 3,
    });

    const { result } = renderHook(() => useLatestStepOutput());
    expect(getStepOutputText({ output: result.current(0) }, StepOutputTextMode.TRANSCRIPT)).toBe("attempt 2");
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
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "final ai output" } }], metadata: {} }, tokens: AI_TOKENS }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "npm test output" } }], metadata: {} } }),
      timestampMs: Date.now(),
      sequence: 2,
    });

    const { result } = renderHook(() => useFinalStepLatestOutput());
    expect(getStepOutputText({ output: result.current }, StepOutputTextMode.TRANSCRIPT)).toBe("final ai output");
    expect(result.current?.tokens?.contextWindowSize).toBe(1000000);
  });

  it("keeps the previous pass's output once a new pass starts", () => {
    const store = useWorkflowStore.getState();
    store.loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [{ prompt: "only" }],
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "pass 1 output" } }], metadata: {} }, tokens: AI_TOKENS }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    // Pass 2 is in its queue phase: the final step has not run for it yet.
    useWorkflowStore.setState({ finalStepLoopCount: 1 });

    const { result, rerender } = renderHook(() => useFinalStepLatestOutput());
    expect(getStepOutputText({ output: result.current }, StepOutputTextMode.TRANSCRIPT)).toBe("pass 1 output");
    expect(result.current?.tokens?.contextWindowSize).toBe(1000000);

    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 1 },
      attemptIndex: 0,
      cliOutput: makeOutput({ structured: { events: [{ type: "text", data: { text: "pass 2 output" } }], metadata: {} } }),
      timestampMs: Date.now(),
      sequence: 2,
    });
    rerender();
    expect(getStepOutputText({ output: result.current }, StepOutputTextMode.TRANSCRIPT)).toBe("pass 2 output");
  });
});
