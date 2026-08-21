import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ModelPricingEditor } from "@components/shared/ModelPricingEditor";
import { HARNESS_IDS } from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";

describe("ModelPricingEditor", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      modelOptions: {
        ...useSettingsStore.getState().modelOptions,
        [HARNESS_IDS.CLAUDE_CLI]: [
          { value: "sonnet", label: "Sonnet" },
          { value: "gpt-4.1", label: "GPT-4.1" },
        ],
      },
    });
  });

  it("renders existing overrides, including model IDs containing dots", () => {
    render(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
          },
        }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("gpt-4.1")).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Input rate for gpt-4.1" })
    ).toHaveValue(2);
  });

  it("flags an override whose required rates are both still zero", () => {
    const { rerender } = render(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            "gpt-4.1": { inputPerMTok: 0, outputPerMTok: 0 },
          },
        }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/prices the model at \$0/)).toBeInTheDocument();

    rerender(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            "gpt-4.1": { inputPerMTok: 0, outputPerMTok: 8 },
          },
        }}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText(/prices the model at \$0/)).toBeNull();
  });

  it("adds a harness and a freeform model", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function ControlledEditor() {
      const [value, setValue] = useState({});
      return (
        <ModelPricingEditor
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<ControlledEditor />);

    await user.click(
      screen.getByRole("button", { name: "Choose harness to add" })
    );
    await user.click(screen.getByRole("button", { name: "Claude Code" }));
    await user.click(screen.getByRole("button", { name: "Add harness" }));

    const modelInput = screen.getByRole("textbox", {
      name: "Model ID for Claude Code",
    });
    await user.type(modelInput, "custom.model");
    await user.click(screen.getByRole("button", { name: "Add model" }));

    expect(onChange).toHaveBeenLastCalledWith({
      [HARNESS_IDS.CLAUDE_CLI]: {
        "custom.model": { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    expect(screen.getByText("custom.model")).toBeInTheDocument();
  });

  it("edits a rate through the whole-object change payload", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
          },
        }}
        onChange={(value) => onUpdate("modelPricing", value)}
      />
    );

    const input = screen.getByRole("spinbutton", {
      name: "Input rate for gpt-4.1",
    });
    await user.clear(input);
    await user.type(input, "12.5");
    await user.tab();

    expect(onUpdate).toHaveBeenLastCalledWith("modelPricing", {
      [HARNESS_IDS.CLAUDE_CLI]: {
        "gpt-4.1": { inputPerMTok: 12.5, outputPerMTok: 8 },
      },
    });
  });

  it("removes a model and removes its harness when the last model is removed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = {
      [HARNESS_IDS.CLAUDE_CLI]: {
        first: { inputPerMTok: 1, outputPerMTok: 2 },
        second: { inputPerMTok: 3, outputPerMTok: 4 },
      },
    };
    const { rerender } = render(
      <ModelPricingEditor value={value} onChange={onChange} />
    );

    await user.click(
      screen.getByRole("button", { name: "Remove model first" })
    );
    expect(onChange).toHaveBeenLastCalledWith({
      [HARNESS_IDS.CLAUDE_CLI]: {
        second: { inputPerMTok: 3, outputPerMTok: 4 },
      },
    });

    rerender(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            second: { inputPerMTok: 3, outputPerMTok: 4 },
          },
        }}
        onChange={onChange}
      />
    );
    await user.click(
      screen.getByRole("button", { name: "Remove model second" })
    );

    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("removes a harness and preserves dotted model IDs as one key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelPricingEditor
        value={{
          [HARNESS_IDS.CLAUDE_CLI]: {
            "gpt-4.1": { inputPerMTok: 1, outputPerMTok: 2 },
          },
        }}
        onChange={onChange}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Remove Claude Code pricing overrides",
      })
    );
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
