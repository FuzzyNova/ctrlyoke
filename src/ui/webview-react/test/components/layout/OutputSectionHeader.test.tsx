import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      hiddenOutputCount={0}
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
      workflowChangeSummary={{
        total: 0,
        undoable: 0,
        undone: 0,
        blocked: 0,
        label: "View 0 changes",
        compactLabel: "View 0",
        title: "0 files changed",
      }}
      onCollapseAllDiffs={noop}
      onExpandAllDiffs={noop}
      onExport={noop}
      onToggleFind={noop}
      onClearHiddenOutputTargets={noop}
      onNewTerminal={noop}
      onOutputFontSizeChange={noop}
      onSelectOutputTab={noop}
      onSelectTerminalTab={noop}
      onTerminalFontSizeChange={noop}
      onTerminalSessionClose={noop}
      onToggleCollapse={noop}
      onToggleFullscreen={noop}
      onWorkflowView={noop}
      outputFontSize={14}
      {...overrides}
    />
  );
}

describe("OutputSectionHeader terminal execution identity", () => {
  it("activates the collapse control from Space", async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    renderHeader({ onToggleCollapse });

    const collapseButton = screen.getByRole("button", {
      name: "Collapse output",
    });
    collapseButton.focus();
    await user.keyboard(" ");

    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });

  it("shows the live run identity in the terminal tab", () => {
    renderHeader({ terminalExecutionRunLabel: "Live Run 1042" });

    expect(
      screen.getByRole("tab", {
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
      screen.getByRole("tab", {
        name: "Terminal · Live Run 1042",
      })
    ).toHaveAttribute("title", "Terminal · Live Run 1042");
  });

  it("keeps the ordinary terminal label when viewed and executing runs match", () => {
    renderHeader();

    expect(screen.getByRole("tab", { name: "Terminal" })).not.toHaveAttribute(
      "title"
    );
  });
});

describe("OutputSectionHeader tab icons", () => {
  it("keeps the output tab named when its text is hidden", () => {
    renderHeader({ isHeaderNarrow: true });

    expect(screen.getByRole("tab", { name: "Output" })).toBeInTheDocument();
  });

  it("exposes output tab selection through aria-selected", () => {
    renderHeader({ activeOutputTab: "output" });

    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

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

describe("OutputSectionHeader font-size controls", () => {
  it("hides output font-size controls in very narrow headers", () => {
    renderHeader({
      activeOutputTab: "output",
      isHeaderVeryNarrow: true,
    });

    expect(
      screen.queryByRole("button", { name: "Decrease font size" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Increase font size" })
    ).not.toBeInTheDocument();
  });

  it("hides terminal font-size controls in very narrow headers", () => {
    renderHeader({ isHeaderVeryNarrow: true });

    expect(
      screen.queryByRole("button", { name: "Decrease terminal font size" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Increase terminal font size" })
    ).not.toBeInTheDocument();
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
        hiddenOutputCount={0}
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
        workflowChangeSummary={{
          total: 0,
          undoable: 0,
          undone: 0,
          blocked: 0,
          label: "View 0 changes",
          compactLabel: "View 0",
          title: "0 files changed",
        }}
        onCollapseAllDiffs={vi.fn()}
        onExpandAllDiffs={vi.fn()}
        onExport={vi.fn()}
        onToggleFind={onToggleFind}
        onClearHiddenOutputTargets={vi.fn()}
        onNewTerminal={vi.fn()}
        onOutputFontSizeChange={vi.fn()}
        onSelectOutputTab={vi.fn()}
        onSelectTerminalTab={vi.fn()}
        onTerminalFontSizeChange={vi.fn()}
        onTerminalSessionClose={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onWorkflowView={vi.fn()}
        outputFontSize={14}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Find in output" })
    ).not.toBeInTheDocument();
  });
});

describe("OutputSectionHeader hidden output action", () => {
  it("shows the hidden-step escape hatch in a narrow output header", () => {
    const onClearHiddenOutputTargets = vi.fn();
    renderHeader({
      activeOutputTab: "output",
      hiddenOutputCount: 2,
      isHeaderNarrow: true,
      isHeaderVeryNarrow: true,
      onClearHiddenOutputTargets,
    });

    const button = screen.getByRole("button", {
      name: "Show all output steps (2 hidden)",
    });
    expect(button).toHaveTextContent("2 hidden · Show all");

    fireEvent.click(button);
    expect(onClearHiddenOutputTargets).toHaveBeenCalledOnce();
  });
});

describe("OutputSectionHeader workflow changes action", () => {
  const summary = {
    total: 7,
    undoable: 5,
    undone: 0,
    blocked: 2,
    label: "View 7 changes",
    compactLabel: "View 7",
    title: "7 files changed",
  } as const;

  it("uses the neutral summary label and tooltip", () => {
    const onWorkflowView = vi.fn();
    renderHeader({
      activeOutputTab: "output",
      workflowChangeSummary: summary,
      onWorkflowView,
    });

    const button = screen.getByRole("button", { name: "View 7 changes" });
    expect(button).toHaveTextContent("View 7 changes");
    expect(button).toHaveAttribute("title", "7 files changed");
    expect(button.querySelector(".codicon-diff")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onWorkflowView).toHaveBeenCalledOnce();
  });

  it("keeps the total stable while the undone count changes", () => {
    const { rerender } = renderHeader({
      activeOutputTab: "output",
      workflowChangeSummary: {
        ...summary,
        undone: 3,
        undoable: 2,
        label: "View 7 changes (3 undone)",
        title: "7 files changed · 3 undone, can be redone",
      },
    });
    expect(
      screen.getByRole("button", { name: "View 7 changes (3 undone)" })
    ).toHaveTextContent("View 7 changes (3 undone)");

    rerender(
      <OutputSectionHeader
        activeOutputTab="output"
        activeTerminalSession={null}
        anyDiffCollapsed={false}
        hasOutput={false}
        hiddenOutputCount={0}
        isFindOpen={false}
        isExecutionActive={true}
        isFullscreen={false}
        isHeaderNarrow
        isHeaderVeryNarrow={false}
        isTerminalCompact={false}
        refCallback={vi.fn()}
        showTerminalTab
        terminalCanCloseActiveSession={false}
        terminalExecutionRunLabel={null}
        terminalFontSize={14}
        terminalSessionActive
        useCompactLabels
        workflowChangeSummary={{
          ...summary,
          undone: 7,
          undoable: 0,
          blocked: 0,
          label: "View 7 changes (all undone)",
          compactLabel: "View 7",
          title: "7 files changed · 7 undone, can be redone",
        }}
        onCollapseAllDiffs={vi.fn()}
        onExpandAllDiffs={vi.fn()}
        onExport={vi.fn()}
        onToggleFind={vi.fn()}
        onClearHiddenOutputTargets={vi.fn()}
        onNewTerminal={vi.fn()}
        onOutputFontSizeChange={vi.fn()}
        onSelectOutputTab={vi.fn()}
        onSelectTerminalTab={vi.fn()}
        onTerminalFontSizeChange={vi.fn()}
        onTerminalSessionClose={vi.fn()}
        onToggleCollapse={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onWorkflowView={vi.fn()}
        outputFontSize={14}
      />
    );

    expect(screen.getByRole("button", { name: "View 7 changes (all undone)" })).toHaveTextContent("View 7");
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
