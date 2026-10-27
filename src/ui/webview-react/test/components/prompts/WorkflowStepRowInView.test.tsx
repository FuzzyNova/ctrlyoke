import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStepRowFrame } from "@components/prompts/WorkflowStepRow";
import { useUiStore } from "@store/uiStore";
import { FINAL_STEP_PHASES, STEP_STATUS } from "@/types/messages";
import { getTargetKey } from "@utils/outputProjection";

function renderFrame(index: number) {
  return render(
    <WorkflowStepRowFrame
      index={index}
      slotNumber={index + 1}
      status={STEP_STATUS.COMPLETED}
      stepColor={undefined}
      isCurrent={false}
    >
      <div>step body</div>
    </WorkflowStepRowFrame>
  );
}

describe("WorkflowStepRowFrame in-output-view marker", () => {
  afterEach(() => {
    useUiStore.setState({ outputInViewTargetKeys: [] });
  });

  it("marks the step's number while its output is in the output viewport", () => {
    renderFrame(2);
    const number = screen.getByText("3");
    expect(number).not.toHaveAttribute("data-in-output-view");

    act(() => {
      useUiStore.setState({
        outputInViewTargetKeys: [
          getTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, index: 2 }),
        ],
      });
    });
    expect(number).toHaveAttribute("data-in-output-view", "true");

    act(() => {
      useUiStore.setState({
        outputInViewTargetKeys: [
          getTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, index: 3 }),
        ],
      });
    });
    expect(number).not.toHaveAttribute("data-in-output-view");
  });

  it("ignores the final step's target, which shares the queue index space", () => {
    useUiStore.setState({
      outputInViewTargetKeys: [
        getTargetKey({ kind: FINAL_STEP_PHASES.FINAL_STEP, index: 0 }),
      ],
    });
    renderFrame(0);
    expect(screen.getByText("1")).not.toHaveAttribute("data-in-output-view");
  });
});

describe("setOutputInViewTargetKeys", () => {
  it("keeps the stored array when membership is unchanged", () => {
    useUiStore.getState().setOutputInViewTargetKeys(["queue:0", "queue:1"]);
    const stored = useUiStore.getState().outputInViewTargetKeys;
    useUiStore.getState().setOutputInViewTargetKeys(["queue:0", "queue:1"]);
    expect(useUiStore.getState().outputInViewTargetKeys).toBe(stored);
    useUiStore.getState().setOutputInViewTargetKeys([]);
  });
});
