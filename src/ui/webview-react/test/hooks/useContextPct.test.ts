import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useContextPct } from "@hooks/useContextPct";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  EXECUTION_PHASES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
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

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useUiStore.setState({ isViewingHistory: false });
});

describe("useContextPct", () => {
  it("reports the prompt attempt's usage even after an end condition runs", () => {
    const store = useWorkflowStore.getState();
    store.loadWorkflow({
      fileName: "wf.ctrlyoke.yaml",
      steps: [{ prompt: "implement" }],
      executionState: EXECUTION_STATES.COMPLETED,
    });
    store.setStepStatus(0, STEP_STATUS.COMPLETED);
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      cliOutput: makeOutput({
        tokens: {
          prompt: 452418,
          completion: 12954,
          contextWindowUsed: 41983,
          contextWindowSize: 200000,
        },
      }),
      timestampMs: Date.now(),
      sequence: 1,
    });
    store.appendLiveEntry({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      attemptIndex: 0,
      phase: EXECUTION_PHASES.END_CONDITION,
      cliOutput: makeOutput({ response: "npm test output" }),
      timestampMs: Date.now(),
      sequence: 2,
    });

    const { result } = renderHook(() => useContextPct());
    expect(result.current(0)).toBe(21);
  });
});
