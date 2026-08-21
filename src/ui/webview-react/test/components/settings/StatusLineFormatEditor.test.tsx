import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusLineFormatEditor } from "@components/settings/stats/StatusLineFormatEditor";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_FIELD_IDS,
  type StatusLineSegment,
} from "@root/utils/StatuslineFormat";

function renderEditor(format: StatusLineSegment[]) {
  const onCommit = vi.fn<(nextFormat: StatusLineSegment[]) => void>();
  render(<StatusLineFormatEditor format={format} onCommit={onCommit} />);
  return onCommit;
}

describe("StatusLineFormatEditor", () => {
  it("includes and excludes fields through the registry-backed checkbox", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
    ]);

    await user.click(
      screen.getByRole("checkbox", { name: "Include ctrlyoke ⚡" })
    );
    expect(onCommit).toHaveBeenLastCalledWith([]);
    expect(onCommit).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("checkbox", { name: "Include ctrlyoke ⚡" })
    );
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("moves segments and disables controls at both list boundaries", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
      { type: "literal", text: "·" },
    ]);

    expect(
      screen.getByRole("button", { name: "Move segment 1 up" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move segment 3 down" })
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Move segment 2 up" }));
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "literal", text: "·" },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: "Move segment 1 down" })
    );
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
      { type: "literal", text: "·" },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("adds a literal and caps committed custom text at 64 characters", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
    ]);

    await user.click(screen.getByRole("button", { name: "Add custom text" }));
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "literal", text: "" },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(1);

    onCommit.mockClear();
    const input = screen.getByRole("textbox", {
      name: "Custom text segment 2",
    });
    await user.type(input, "x".repeat(80));
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "literal", text: "x".repeat(64) },
    ]);
  });

  it("resets the format to a cloned shared default array in one commit", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "literal", text: "custom" },
      { type: "field", field: STATUS_LINE_FIELD_IDS.VERSION },
    ]);

    await user.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(
      DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }))
    );
  });

  it("persists a color selection for both field and literal segments", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT },
      { type: "literal", text: "|" },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Red color for segment 1" })
    );
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT, color: "red" },
      { type: "literal", text: "|" },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Blue color for segment 2" })
    );
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT, color: "red" },
      { type: "literal", text: "|", color: "blue" },
    ]);
    expect(
      screen.getByText(/explicit color overrides a field's automatic coloring/i)
    ).toBeInTheDocument();
  });

  it("shows and persists custom labels only for registry label-slot fields", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT },
    ]);

    expect(
      screen.queryByRole("textbox", { name: "Custom label for ctrlyoke ⚡" })
    ).not.toBeInTheDocument();
    const labelInput = screen.getByRole("textbox", {
      name: "Custom label for Context usage (colored band)",
    });
    await user.type(labelInput, "window");
    await user.tab();

    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "field", field: STATUS_LINE_FIELD_IDS.CONTEXT, label: "window" },
    ]);
  });

  it("renders the fixture preview and respects both percent directions", () => {
    const { rerender } = render(
      <StatusLineFormatEditor
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        onCommit={vi.fn()}
        percentDirection="used"
      />
    );

    expect(screen.getByText(/rate 41%/)).toBeInTheDocument();
    expect(screen.getByText(/representative fixture/i)).toBeInTheDocument();

    rerender(
      <StatusLineFormatEditor
        format={[{ type: "field", field: STATUS_LINE_FIELD_IDS.USAGE }]}
        onCommit={vi.fn()}
        percentDirection="remaining"
      />
    );
    expect(screen.getByText(/rate 59%/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /uses your Stats & Usage percent-direction setting \(remaining\)/i
      )
    ).toBeInTheDocument();
  });
});
