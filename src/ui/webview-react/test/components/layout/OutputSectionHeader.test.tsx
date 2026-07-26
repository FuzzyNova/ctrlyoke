import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OutputSectionHeader,
  type OutputSectionHeaderProps,
} from "@components/layout/output-section/OutputSectionHeader";

function renderHeader(overrides: Partial<OutputSectionHeaderProps> = {}): void {
  const noop = vi.fn();
  render(
    <OutputSectionHeader
      activeOutputTab="terminal"
      activeTerminalSession={null}
      anyDiffCollapsed={false}
      hasOutput={false}
      isExecutionActive={true}
      isHeaderNarrow={false}
      isHeaderVeryNarrow={false}
      isTerminalCompact={false}
      refCallback={noop}
      showTerminalTab={true}
      terminalCanCloseActiveSession={false}
      terminalExecutionRunLabel={null}
      terminalFontSize={14}
      terminalSessionActive={true}
      useCompactLabels={false}
      workflowRedoEntries={[]}
      workflowUndoEntries={[]}
      onCollapseAllDiffs={noop}
      onExpandAllDiffs={noop}
      onExport={noop}
      onNewTerminal={noop}
      onOutputFontSizeChange={noop}
      onSelectOutputTab={noop}
      onSelectTerminalTab={noop}
      onTerminalFontSizeChange={noop}
      onTerminalSessionClose={noop}
      onToggleCollapse={noop}
      onWorkflowRedo={noop}
      onWorkflowUndo={noop}
      outputFontSize={14}
      {...overrides}
    />
  );
}

describe("OutputSectionHeader terminal execution identity", () => {
  it("shows the live run identity in the terminal tab", () => {
    renderHeader({ terminalExecutionRunLabel: "Live Run 1042" });

    expect(
      screen.getByRole("button", {
        name: "Terminal · Live Run 1042",
      })
    ).toHaveTextContent("Terminal· Live Run 1042");
  });

  it("keeps the execution identity accessible in narrow headers", () => {
    renderHeader({
      isHeaderNarrow: true,
      terminalExecutionRunLabel: "Live Run 1042",
    });

    expect(
      screen.getByRole("button", {
        name: "Terminal · Live Run 1042",
      })
    ).toHaveAttribute("title", "Terminal · Live Run 1042");
  });

  it("keeps the ordinary terminal label when viewed and executing runs match", () => {
    renderHeader();

    expect(
      screen.getByRole("button", { name: "Terminal" })
    ).not.toHaveAttribute("title");
  });
});
