import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusLineFormatEditor } from "@components/settings/stats/StatusLineFormatEditor";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_FIELD_IDS,
  STATUS_LINE_FORMAT_PROVIDERS,
  type StatusLineSegment,
} from "@root/utils/StatuslineFormat";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
} from "@root/types/DashboardConstants";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";

function renderEditor(format: StatusLineSegment[]) {
  const onCommit = vi.fn<(nextFormat: StatusLineSegment[]) => void>();
  render(<StatusLineFormatEditor format={format} onCommit={onCommit} />);
  return onCommit;
}

describe("StatusLineFormatEditor", () => {
  it("includes a field through the registry checkbox and removes it via the delete button", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Remove segment 1" })
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

  it("renders a drag handle and delete button for every segment", () => {
    renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "field", field: STATUS_LINE_FIELD_IDS.MODEL },
      { type: "literal", text: "·" },
    ]);

    for (const index of [1, 2, 3]) {
      expect(
        screen.getByRole("button", {
          name: `Drag to reorder segment ${index}`,
        })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Remove segment ${index}` })
      ).toBeInTheDocument();
    }
  });

  it("removes a literal segment via its delete button", async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
      { type: "literal", text: "·" },
    ]);

    await user.click(screen.getByRole("button", { name: "Remove segment 2" }));
    expect(onCommit).toHaveBeenLastCalledWith([
      { type: "field", field: STATUS_LINE_FIELD_IDS.BRAND },
    ]);
    expect(onCommit).toHaveBeenCalledTimes(1);
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

  it("renders colored segments instead of raw ANSI escape bytes in the preview", () => {
    render(
      <StatusLineFormatEditor
        format={[
          {
            type: "field",
            field: STATUS_LINE_FIELD_IDS.CONTEXT,
            color: undefined,
          },
          { type: "literal", text: "·", color: "magenta" },
        ]}
        onCommit={vi.fn()}
      />
    );

    const preview = screen.getByText(/ctx \(40%\)/);
    expect(preview.textContent).not.toMatch(/\[\d+m/);
    // Context defaults to the cyan neutral band color when no explicit color is set.
    expect(preview).toHaveStyle({ color: "#29b8db" });

    const dot = screen.getByText("·");
    expect(dot.textContent).not.toMatch(/\[\d+m/);
    expect(dot).toHaveStyle({ color: "#bc3fbc" });
  });

  it("keeps representative fields visible when quota comes from a cached snapshot", () => {
    const snapshot: HarnessUsageSnapshot = {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      updatedAt: Date.now(),
      quota: {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
        staleAfterMs: 60_000,
        windows: [
          {
            id: "five-hour",
            kind: "rolling",
            label: "5h",
            percentUsed: 33,
            unit: HARNESS_USAGE_UNITS.PERCENT,
            confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
          },
        ],
      },
      observed: {},
    };

    render(
      <StatusLineFormatEditor
        provider={STATUS_LINE_FORMAT_PROVIDERS.CLAUDE}
        format={[
          { type: "field", field: STATUS_LINE_FIELD_IDS.VERSION },
          { type: "field", field: STATUS_LINE_FIELD_IDS.CWD },
          { type: "field", field: STATUS_LINE_FIELD_IDS.SESSION_ID },
          { type: "field", field: STATUS_LINE_FIELD_IDS.BRANCH },
          { type: "field", field: STATUS_LINE_FIELD_IDS.USAGE },
        ]}
        snapshot={snapshot}
        onCommit={vi.fn()}
      />
    );

    expect(
      screen.getByText(/preview project preview- feature\/statusline/)
    ).toBeInTheDocument();
    expect(screen.getByText(/rate 33%/)).toBeInTheDocument();
  });
});
