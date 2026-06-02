import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GenericToolCallOutput } from "@components/output/ToolCallOutput";
import { buildToolCallRenderPlan } from "@utils/toolCallLayout";

describe("GenericToolCallOutput", () => {
  it("preserves uncontrolled expansion behavior by default", async () => {
    const user = userEvent.setup();
    const output = Array.from(
      { length: 12 },
      (_, index) => `line ${index + 1}`
    ).join("\n");

    render(
      <GenericToolCallOutput
        name="write_memory"
        parameters={{ subject: "output-layout", detail: "lift expansion state" }}
        result={{
          success: true,
          output,
        }}
      />
    );

    const collapsedOutput = screen.getByText(/\[show 2 more lines\]/i).parentElement;

    expect(screen.queryByText("detail: lift expansion state")).not.toBeInTheDocument();
    expect(collapsedOutput?.textContent).toContain("line 10");
    expect(collapsedOutput?.textContent).not.toContain("line 11");

    await user.click(screen.getByTitle("Show all parameters"));
    expect(screen.getByTitle("Hide parameters")).toBeInTheDocument();
    expect(
      screen.getAllByText((_, element) =>
        element?.textContent?.includes("detail: lift expansion state") ?? false
      ).length
    ).toBeGreaterThan(0);

    await user.click(screen.getByText(/\[show 2 more lines\]/i));
    const expandedOutput = screen.getByText(/\[show less\]/i).parentElement;
    expect(screen.getByText(/\[show less\]/i)).toBeInTheDocument();
    expect(expandedOutput?.textContent).toContain("line 11");
    expect(expandedOutput?.textContent).toContain("line 12");
  });

  it("emits controlled expansion intent without mutating local state", async () => {
    const user = userEvent.setup();
    const onExpansionChange = vi.fn();
    const expansion = {
      paramsExpanded: false,
      outputExpanded: false,
      errorExpanded: false,
    } as const;
    const error = Array.from(
      { length: 11 },
      (_, index) => `error ${index + 1}`
    ).join("\n");

    render(
      <GenericToolCallOutput
        name="write_memory"
        parameters={{ subject: "output-layout" }}
        result={{
          success: false,
          error,
        }}
        expansion={expansion}
        renderPlan={buildToolCallRenderPlan({
          parameters: { subject: "output-layout" },
          result: { success: false, error },
          expansion,
        })}
        onExpansionChange={onExpansionChange}
      />
    );

    const collapsedError = screen.getByText(/\[show 1 more line\]/i).parentElement;

    expect(collapsedError?.textContent).toContain("error 10");
    expect(collapsedError?.textContent).not.toContain("error 11");

    await user.click(screen.getByTitle("Show all parameters"));
    await user.click(screen.getByText(/\[show 1 more line\]/i));

    expect(onExpansionChange).toHaveBeenNthCalledWith(1, "params", true);
    expect(onExpansionChange).toHaveBeenNthCalledWith(2, "error", true);
    expect(screen.getByTitle("Show all parameters")).toBeInTheDocument();
    expect(screen.queryByText(/\[show less\]/i)).not.toBeInTheDocument();
    expect(screen.queryByText("subject: output-layout")).not.toBeInTheDocument();
    expect(collapsedError?.textContent).not.toContain("error 11");
  });
});
