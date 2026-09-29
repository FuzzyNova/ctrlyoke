import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FinalStepFooter } from "@components/prompts/FinalStepFooter";
import { FINAL_STEP_PHASES } from "@/types/messages";
import type { CliOutput, WorkflowStep } from "@store/workflowStore";

function buildProps() {
  return {
    finalStep: { prompt: "Final prompt" } as WorkflowStep,
    status: null,
    loopCount: 1,
    phase: FINAL_STEP_PHASES.FINAL_STEP,
    isExpanded: false,
    isSelected: false,
    isReadOnly: true,
    isDisabled: false,
    onSelect: vi.fn(),
    onToggleExpanded: vi.fn(),
    onToggleEnabled: vi.fn(),
  };
}

describe("FinalStepFooter", () => {
  it("shows the full loop label at regular widths", () => {
    render(<FinalStepFooter {...buildProps()} />);

    expect(screen.getByText("Loop 2")).toBeInTheDocument();
  });

  it("uses a numeric loop badge with final-step context in its tooltip when narrow", () => {
    render(<FinalStepFooter {...buildProps()} isNarrow />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("Loop 2")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Final step" })
    ).toBeInTheDocument();
  });

  it("activates the final-step row from Space", () => {
    const props = buildProps();
    props.isReadOnly = false;

    render(<FinalStepFooter {...props} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Final step" }), {
      key: " ",
    });

    expect(props.onSelect).toHaveBeenCalledOnce();
  });

  it("activates the expanded final-step row from Space", () => {
    const props = buildProps();
    props.isReadOnly = false;
    props.isExpanded = true;

    render(<FinalStepFooter {...props} />);

    fireEvent.keyDown(
      screen.getAllByRole("button", { name: "Final step" })[0],
      { key: " " }
    );

    expect(props.onSelect).toHaveBeenCalledOnce();
  });

  it("shows the context window bar in expanded details from the latest output", () => {
    const props = { ...buildProps(), isExpanded: true };

    render(
      <FinalStepFooter
        {...props}
        latestOutput={
          {
            tokens: { contextWindowUsed: 50_000, contextWindowSize: 200_000 },
          } as CliOutput
        }
      />
    );

    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("falls back to runtime metadata for the context window bar", () => {
    const props = {
      ...buildProps(),
      isExpanded: true,
      finalStep: {
        prompt: "Final prompt",
        _runtime: { contextWindowUsed: 150_000, contextWindowSize: 200_000 },
      } as WorkflowStep,
    };

    render(<FinalStepFooter {...props} />);

    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("omits the context window bar without context data", () => {
    const { container } = render(
      <FinalStepFooter {...buildProps()} isExpanded />
    );

    expect(
      container.querySelector("[data-context-window-bar]")
    ).not.toBeInTheDocument();
  });
});
