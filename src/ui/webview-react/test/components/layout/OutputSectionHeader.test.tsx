import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OutputSectionHeader,
  type OutputSectionHeaderProps,
} from "@components/layout/output-section/OutputSectionHeader";

function renderHeader(overrides: Partial<OutputSectionHeaderProps> = {}) {
  const noop = vi.fn();
  return render(
    <OutputSectionHeader
      activeOutputTab="terminal"
      activeTerminalSession={null}
      anyDiffCollapsed={false}
      hasOutput={false}
      isFindOpen={false}
      isExecutionActive={true}
      isFullscreen={false}
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
      onToggleFind={noop}
      onNewTerminal={noop}
      onOutputFontSizeChange={noop}
      onSelectOutputTab={noop}
      onSelectTerminalTab={noop}
      onTerminalFontSizeChange={noop}
      onTerminalSessionClose={noop}
      onToggleCollapse={noop}
      onToggleFullscreen={noop}
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

describe("OutputSectionHeader tab icons", () => {
  it("uses large icons in narrow headers and small icons otherwise", () => {
    const narrowHeader = renderHeader({ isHeaderNarrow: true });

    expect(narrowHeader.container.querySelector(".codicon-output")).toHaveClass(
      "codicon-lg"
    );
    expect(
      narrowHeader.container.querySelector(".codicon-terminal")
    ).toHaveClass("codicon-lg");

    narrowHeader.unmount();
    const wideHeader = renderHeader();

    expect(wideHeader.container.querySelector(".codicon-output")).toHaveClass(
      "codicon-sm"
    );
    expect(wideHeader.container.querySelector(".codicon-terminal")).toHaveClass(
      "codicon-sm"
    );
  });
});

describe("OutputSectionHeader find action", () => {
  it("toggles a highlighted find action from the output tab only", () => {
    const onToggleFind = vi.fn();
    const { rerender } = renderHeader({
      activeOutputTab: "output",
      isFindOpen: true,
      onToggleFind,
    });

    const findButton = screen.getByRole("button", { name: "Find in output" });
    expect(findButton).toHaveAttribute("aria-pressed", "true");
    expect(findButton).toHaveClass("text-widget-highlight-fg");

    fireEvent.click(findButton);
    expect(onToggleFind).toHaveBeenCalledOnce();

    rerender(
      <OutputSectionHeader
        activeOutputTab="terminal"
        activeTerminalSession={null}
        anyDiffCollapsed={false}
        hasOutput={false}
        isFindOpen={false}
        isExecutionActive={true}
        isFullscreen={false}
        isHeaderNarrow={false}
        isHeaderVeryNarrow={false}
        isTerminalCompact={false}
        refCallback={vi.fn()}
        showTerminalTab
        terminalCanCloseActiveSession={false}
        terminalExecutionRunLabel={null}
        terminalFontSize={14}
        terminalSessionActive
        useCompactLabels={false}
        workflowRedoEntries={[]}
        workflowUndoEntries={[]}
        onCollapseAllDiffs={vi.fn()}
        onExpandAllDiffs={vi.fn()}
        onExport={vi.fn()}
        onToggleFind={onToggleFind}
        onNewTerminal={vi.fn()}
        onOutputFontSizeChange={vi.fn()}
        onSelectOutputTab={vi.fn()}
        onSelectTerminalTab={vi.fn()}
        onTerminalFontSizeChange={vi.fn()}
        onTerminalSessionClose={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onWorkflowRedo={vi.fn()}
        onWorkflowUndo={vi.fn()}
        outputFontSize={14}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Find in output" })
    ).not.toBeInTheDocument();
  });
});

describe("OutputSectionHeader fullscreen action", () => {
  it("highlights the fullscreen toggle while active", () => {
    renderHeader({ isFullscreen: true });

    const fullscreenButton = screen.getByRole("button", {
      name: "Exit full screen",
    });

    expect(fullscreenButton).toHaveClass("text-widget-highlight-fg");
    expect(fullscreenButton).toHaveAttribute("aria-pressed", "true");
  });

  it("routes fullscreen toggle clicks to the callback", () => {
    const onToggleFullscreen = vi.fn();
    renderHeader({ onToggleFullscreen });

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });
});
