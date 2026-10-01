import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GenericToolCallOutput,
  McpToolCallOutput,
} from "@components/output/ToolCallOutput";
import { buildToolCallRenderPlan } from "@utils/toolCallLayout";
import { DEFAULT_COLLAPSED_OUTPUT_MAX_LINES } from "@utils/outputTruncation";

describe("GenericToolCallOutput", () => {
  // 12-line fixtures: enough that the collapsed preview always hides more than
  // one line (a single hidden line renders in full, with no toggle at all).
  const FIXTURE_LINES = 12;
  const HIDDEN_LINES = FIXTURE_LINES - DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;
  // The hidden-lines notice sits inside the collapsed section, so its parent
  // is the section root holding the preview text.
  const hiddenLinesNotice = new RegExp(`${HIDDEN_LINES} more lines \\(click`);
  const lastVisibleLine = DEFAULT_COLLAPSED_OUTPUT_MAX_LINES;

  it("preserves uncontrolled expansion behavior by default", async () => {
    const user = userEvent.setup();
    const output = Array.from(
      { length: FIXTURE_LINES },
      (_, index) => `line ${index + 1}`
    ).join("\n");

    render(
      <GenericToolCallOutput
        name="write_memory"
        parameters={{
          subject: "output-layout",
          detail: "lift expansion state",
        }}
        showLabel
        result={{
          success: true,
          output,
        }}
      />
    );

    const collapsedOutput = screen.getByText(hiddenLinesNotice).parentElement;

    expect(
      screen.queryByText("detail: lift expansion state")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /write_memory\(subject: output-layout, detail: lift expansion state\)\.\.\./i
      )
    ).toBeInTheDocument();
    const showParametersButton = screen.getByRole("button", {
      name: "Show all parameters",
    });
    expect(showParametersButton).toBeInTheDocument();
    expect(showParametersButton.querySelector("i")).toHaveClass(
      "codicon-unfold"
    );
    expect(collapsedOutput?.textContent).toContain(`line ${lastVisibleLine}`);
    expect(collapsedOutput?.textContent).not.toContain(
      `line ${lastVisibleLine + 1}`
    );

    await user.click(showParametersButton);
    const hideParametersButton = screen.getByRole("button", {
      name: "Hide parameters",
    });
    expect(hideParametersButton).toBeInTheDocument();
    expect(hideParametersButton.querySelector("i")).toHaveClass("codicon-fold");
    expect(
      screen.getAllByText(
        (_, element) =>
          element?.textContent?.includes("detail: lift expansion state") ??
          false
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(
        /write_memory\(subject: output-layout, detail: lift expansion state\)\.\.\./i
      )
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show full output" }));
    const expandedOutput = screen.getByRole("button", {
      name: "Hide full output",
    }).parentElement;
    expect(screen.queryByText(hiddenLinesNotice)).not.toBeInTheDocument();
    expect(expandedOutput?.textContent).toContain(
      `line ${lastVisibleLine + 1}`
    );
    expect(expandedOutput?.textContent).toContain(`line ${FIXTURE_LINES}`);
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
      { length: FIXTURE_LINES },
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

    const collapsedError = screen.getByText(hiddenLinesNotice).parentElement;

    expect(collapsedError?.textContent).toContain(`error ${lastVisibleLine}`);
    expect(collapsedError?.textContent).not.toContain(
      `error ${lastVisibleLine + 1}`
    );

    await user.click(
      screen.getByRole("button", { name: "Show all parameters" })
    );
    await user.click(screen.getByRole("button", { name: "Show full error" }));

    expect(onExpansionChange).toHaveBeenNthCalledWith(1, "params", true);
    expect(onExpansionChange).toHaveBeenNthCalledWith(2, "error", true);
    expect(
      screen.getByRole("button", { name: "Show all parameters" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Hide full error" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("subject: output-layout")
    ).not.toBeInTheDocument();
    expect(collapsedError?.textContent).not.toContain(
      `error ${lastVisibleLine + 1}`
    );
  });

  it("uses a neutral toggle label for character-truncated single-line output", () => {
    const longOutput = "x".repeat(1600);
    render(
      <GenericToolCallOutput
        name="Glob"
        result={{
          success: true,
          output: longOutput,
        }}
      />
    );

    const collapsedOutput = screen.getByText(
      /More output \(click Show full output/
    ).parentElement;

    expect(collapsedOutput?.textContent).not.toContain("x".repeat(1300));
  });

  it("uses the render plan's configured collapsed result line count", () => {
    const output = Array.from(
      { length: 8 },
      (_, index) => `line ${index + 1}`
    ).join("\n");
    const expansion = {
      paramsExpanded: false,
      outputExpanded: false,
      errorExpanded: false,
    } as const;

    render(
      <GenericToolCallOutput
        name="read_file"
        result={{ success: true, output }}
        expansion={expansion}
        renderPlan={buildToolCallRenderPlan({
          result: { success: true, output },
          expansion,
          maxResultLines: 4,
        })}
      />
    );

    expect(screen.getByText(/4 more lines \(click/)).toBeInTheDocument();
    expect(screen.queryByText("line 5")).not.toBeInTheDocument();
  });

  it("highlights find matches in the tool name, parameters, and output", () => {
    const { container } = render(
      <GenericToolCallOutput
        name="write_memory"
        parameters={{ subject: "alpha parameter" }}
        result={{ success: true, output: "alpha beta" }}
        expansion={{
          paramsExpanded: true,
          outputExpanded: false,
          errorExpanded: false,
        }}
        nameFindMatches={[{ start: 0, end: 5, active: true }]}
        paramsFindMatches={[{ start: 9, end: 14, active: false }]}
        outputFindMatches={[{ start: 0, end: 5, active: false }]}
      />
    );

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(3);
    expect(marks[0]).toHaveAttribute("data-find-active", "true");
    expect(marks[0].textContent).toBe("write");
    expect(marks[1]).not.toHaveAttribute("data-find-active");
    expect(marks[1].textContent).toBe("alpha");
    expect(marks[2]).not.toHaveAttribute("data-find-active");
    expect(marks[2].textContent).toBe("alpha");
  });

  it("highlights find matches in the tool error", () => {
    const { container } = render(
      <GenericToolCallOutput
        name="run_command"
        result={{ success: false, error: "alpha failed" }}
        errorFindMatches={[{ start: 0, end: 5, active: true }]}
      />
    );

    const mark = container.querySelector("mark");
    expect(mark).toHaveAttribute("data-find-active", "true");
    expect(mark?.textContent).toBe("alpha");
  });

  it("shows an inline ellipsis when parameters are collapsed", () => {
    render(
      <GenericToolCallOutput
        name="write_memory"
        parameters={{
          subject: "output-layout",
          detail: "lift expansion state",
        }}
      />
    );

    expect(
      screen.getByText(
        /write_memory\(subject: output-layout, detail: lift expansion state\)\.\.\./i
      )
    ).toBeInTheDocument();
  });

  it("does not append a second ellipsis when the compact parameter summary is already truncated", () => {
    render(
      <GenericToolCallOutput
        name="exec"
        parameters={{
          input: `const r = await tools.shell_command({ command: "${"x".repeat(120)}" }); text(r);`,
        }}
      />
    );

    expect(screen.getByText(/exec\(input: .*\.{3}\)$/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/exec\(input: .*\.{6}\)$/i)
    ).not.toBeInTheDocument();
  });
});

describe("McpToolCallOutput", () => {
  it("reveals the complete parameter text with one expansion click", async () => {
    const user = userEvent.setup();

    render(
      <McpToolCallOutput
        server="ctrlyoke"
        tool="append_queue"
        parameters={{
          prompt: "queue the next step",
          properties: { harness: "codex-cli" },
        }}
        showLabel
      />
    );

    expect(screen.getByText("Show parameters")).toHaveClass(
      "uppercase",
      "text-[length:var(--cy-output-font-size-xs)]"
    );
    expect(
      screen.queryByText("prompt: queue the next step")
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Show all parameters" })
    );

    expect(
      screen.getByRole("button", { name: "Hide parameters" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent ===
          'prompt: queue the next step\nproperties: {"harness":"codex-cli"}'
      )
    ).toBeInTheDocument();
  });

  it("highlights find matches in expanded parameter text", () => {
    const { container } = render(
      <McpToolCallOutput
        server="ctrlyoke"
        tool="append_queue"
        parameters={{ prompt: "mcp-params-only" }}
        expansion={{
          paramsExpanded: true,
          outputExpanded: false,
          errorExpanded: false,
        }}
        renderPlan={buildToolCallRenderPlan({
          parameters: { prompt: "mcp-params-only" },
          expansion: {
            paramsExpanded: true,
            outputExpanded: false,
            errorExpanded: false,
          },
        })}
        paramsFindMatches={[{ start: 8, end: 23, active: true }]}
      />
    );

    const mark = container.querySelector("mark");
    expect(mark).toHaveTextContent("mcp-params-only");
    expect(mark).toHaveAttribute("data-find-active", "true");
  });

  it("highlights find matches in tool output and errors", () => {
    const { container, rerender } = render(
      <McpToolCallOutput
        server="ctrlyoke"
        tool="read_resource"
        result={{ success: true, output: "alpha result" }}
        outputFindMatches={[{ start: 0, end: 5, active: true }]}
      />
    );

    let mark = container.querySelector("mark");
    expect(mark).toHaveTextContent("alpha");
    expect(mark).toHaveAttribute("data-find-active", "true");

    rerender(
      <McpToolCallOutput
        server="ctrlyoke"
        tool="read_resource"
        result={{ success: false, error: "failed alpha" }}
        errorFindMatches={[{ start: 7, end: 12, active: false }]}
      />
    );

    mark = container.querySelector("mark");
    expect(mark).toHaveTextContent("alpha");
    expect(mark).not.toHaveAttribute("data-find-active");
  });
});
