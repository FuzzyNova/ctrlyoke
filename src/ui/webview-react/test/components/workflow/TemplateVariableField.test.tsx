import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateVariableField } from "@components/workflow/TemplateVariableField";
import type { TemplateVariable } from "@store/uiStore";

const change = vi.fn();
const browse = vi.fn();
const commit = vi.fn();

function renderField(
  variable: TemplateVariable,
  pairedModels: TemplateVariable[] = []
) {
  return render(
    <TemplateVariableField
      variable={variable}
      value="value"
      values={{ model: "opus" }}
      onChange={change}
      onCommit={commit}
      pairedModels={pairedModels}
      modelOptions={{ "claude-cli": [{ value: "opus", label: "Opus" }] }}
      harnessStatus={{}}
      onBrowse={browse}
    />
  );
}

describe("TemplateVariableField", () => {
  afterEach(() => {
    cleanup();
    change.mockClear();
    browse.mockClear();
    commit.mockClear();
  });

  it("renders text and unpaired model variables as text inputs", () => {
    const { rerender } = renderField({ name: "topic", type: "text" });
    expect(screen.getByRole("textbox", { name: "topic" })).toBeTruthy();

    rerender(
      <TemplateVariableField
        variable={{ name: "model", type: "model" }}
        value="opus"
        onChange={change}
      />
    );
    expect(screen.getByRole("textbox", { name: "model" })).toBeTruthy();
  });

  it.each([
    ["file", "Browse for file"],
    ["directory", "Browse for folder"],
  ] as const)("renders %s variables with Browse", (type, title) => {
    renderField({ name: "path", type });
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    expect(browse).toHaveBeenCalledWith(
      expect.objectContaining({ name: "path" })
    );
    expect(screen.getByTitle(title)).toBeTruthy();
  });

  it("renders select options and reports changes immediately", () => {
    renderField({ name: "choice", type: "select", options: ["one", "two"] });
    fireEvent.change(screen.getByRole("combobox", { name: "choice" }), {
      target: { value: "two" },
    });
    expect(change).toHaveBeenCalledWith("choice", "two");
    expect(commit).toHaveBeenCalledWith("choice", "two");
  });

  it("commits text on blur and Enter when requested", () => {
    render(
      <TemplateVariableField
        variable={{ name: "topic", type: "text" }}
        value="draft"
        onChange={change}
        onCommit={commit}
        commitTextOnBlur
      />
    );
    const input = screen.getByRole("textbox", { name: "topic" });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenNthCalledWith(1, "topic", "draft");
    expect(commit).toHaveBeenNthCalledWith(2, "topic", "draft");
  });

  it("renders a harness and its paired model in one row", () => {
    renderField({ name: "harness", type: "harness" }, [
      { name: "model", type: "model", harness: "harness" },
    ]);
    expect(screen.getByRole("button", { name: /harness/i })).toBeTruthy();
    expect(document.getElementById("var-model")).toBeTruthy();
    expect(document.getElementById("var-model")?.textContent).toContain("opus");
  });
});
