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

  it("commits text on Enter, and on blur only after an edit", () => {
    const field = (value: string) => (
      <TemplateVariableField
        variable={{ name: "topic", type: "text" }}
        value={value}
        onChange={change}
        onCommit={commit}
        commitTextOnBlur
      />
    );
    const { rerender } = render(field("draft"));
    const input = screen.getByRole("textbox", { name: "topic" });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(commit).not.toHaveBeenCalled();

    fireEvent.focus(input);
    rerender(field("edited"));
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith("topic", "edited");

    commit.mockClear();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("topic", "edited");
  });

  it("renders a harness and its paired model in one row", () => {
    renderField({ name: "harness", type: "harness" }, [
      { name: "model", type: "model", harness: "harness" },
    ]);
    expect(screen.getByRole("button", { name: /harness/i })).toBeTruthy();
    expect(document.getElementById("var-model")).toBeTruthy();
    expect(document.getElementById("var-model")?.textContent).toContain("opus");
  });

  it("puts a field's label action on its label row, outside the label", () => {
    render(
      <TemplateVariableField
        variable={{ name: "topic", type: "text" }}
        value=""
        onChange={change}
        labelAction={<button type="button">Save as default</button>}
      />
    );
    const action = screen.getByRole("button", { name: "Save as default" });
    const label = document.querySelector('label[for="var-topic"]');
    expect(label?.contains(action)).toBe(false);
    expect(label?.parentElement?.contains(action)).toBe(true);
  });

  it("groups a paired harness and model in a box whose border carries the action", () => {
    render(
      <TemplateVariableField
        variable={{ name: "harness", type: "harness" }}
        value="claude-cli"
        values={{ model: "opus" }}
        onChange={change}
        pairedModels={[{ name: "model", type: "model", harness: "harness" }]}
        labelAction={<button type="button">Save as default</button>}
      />
    );
    const group = screen.getByRole("group", { name: "harness and model" });
    expect(group.querySelector("#var-harness")).toBeTruthy();
    expect(group.querySelector("#var-model")).toBeTruthy();
    const legend = group.querySelector("legend");
    expect(legend?.textContent).toBe("Save as default");
    expect(
      screen.getAllByRole("button", { name: "Save as default" })
    ).toHaveLength(1);
  });
});
