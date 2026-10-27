import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { OutputPane } from "@components/layout/output-section/OutputPane";
import { OUTPUT_STICKY_TOP_CSS_VAR } from "@components/output/outputStyles";
import {
  EXECUTION_STATES,
  OUTPUT_ROW_KINDS,
  OUTPUT_TABS,
} from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { useUiStore } from "@store/uiStore";
import { getTargetKey } from "@utils/outputProjection";
import type { OutputRenderRow } from "@utils/outputRows";

type OutputPaneProps = ComponentProps<typeof OutputPane>;

function buildProps(
  scrollContainerRef: React.RefObject<HTMLDivElement | null>,
  overrides: Partial<OutputPaneProps> = {}
): OutputPaneProps {
  return {
    activeOutputTab: OUTPUT_TABS.OUTPUT,
    bashExpansionState: new Map(),
    contentHeight: 0,
    hasOutput: false,
    isExecutionActive: false,
    isNavigationTargetVirtualized: false,
    isOutputCollapsed: false,
    isOutputScrollSeeking: false,
    isOutputVirtualized: false,
    atomicContextReferences: false,
    minimapSteps: [],
    nonVirtualRows: [],
    nonVirtualSpacerHeight: 0,
    outputRef: (element) => {
      scrollContainerRef.current = element;
    },
    scrollContainerRef,
    renderedScrollSeekIndices: new Set(),
    rows: [],
    showVirtualizationOverlay: false,
    virtualRows: [],
    virtualizedTotalSize: 0,
    measureRowElement: () => {},
    measureStaticRowElement: () => {},
    runBanner: {
      runId: 1,
      startedAt: 0,
      executionState: EXECUTION_STATES.COMPLETED,
    },
    isRunBannerPinned: false,
    onToggleRunBannerPinned: vi.fn(),
    isStepHeaderPinned: true,
    rowStarts: [],
    showBackToLive: false,
    onBackToLive: vi.fn(),
    onBashExpansionChange: vi.fn(),
    onScriptVerdictExpansionChange: vi.fn(),
    onScriptOutputExpansionChange: vi.fn(),
    onAttemptGroupToggle: vi.fn(),
    onContextMenuOpen: vi.fn(),
    onDiffCollapsedChange: vi.fn(),
    onDiffGapExpand: vi.fn(),
    onFileUndo: vi.fn(),
    onMinimapStepClick: vi.fn(),
    hiddenActivityTargetKeys: new Set(),
    onMinimapStepToggle: vi.fn(),
    onMinimapStepSolo: vi.fn(),
    onOutputProfilerRender: vi.fn(),
    onPromptView: vi.fn(),
    onScroll: vi.fn(),
    onTouchCancel: vi.fn(),
    onTouchEnd: vi.fn(),
    onTouchMove: vi.fn(),
    onTouchStart: vi.fn(),
    onToolCallExpansionChange: vi.fn(),
    onUserInputCapture: vi.fn(),
    onWheel: vi.fn(),
    ...overrides,
  };
}

describe("OutputPane sticky offset", () => {
  it("offsets sticky content by the pinned banner and clears it when unpinned", () => {
    const scrollContainerRef: { current: HTMLDivElement | null } = {
      current: null,
    };
    const { rerender } = render(
      <OutputPane
        {...buildProps(scrollContainerRef, { isRunBannerPinned: true })}
      />
    );
    const scrollElement = scrollContainerRef.current!;
    // jsdom has no layout, so the measured banner height is 0px — what this
    // pins is that the variable is published while pinned at all.
    expect(
      scrollElement.style.getPropertyValue(OUTPUT_STICKY_TOP_CSS_VAR)
    ).toBe("0px");

    rerender(
      <OutputPane
        {...buildProps(scrollContainerRef, { isRunBannerPinned: false })}
      />
    );
    expect(
      scrollElement.style.getPropertyValue(OUTPUT_STICKY_TOP_CSS_VAR)
    ).toBe("");
  });
});

describe("OutputPane focus", () => {
  // VS Code's webview copy refocuses the last focused element when focus is
  // on <body>, stealing the output selection; the pane must take focus itself.
  it("can take focus so Ctrl/Cmd+C copies the output selection", () => {
    const scrollContainerRef: { current: HTMLDivElement | null } = {
      current: null,
    };
    render(<OutputPane {...buildProps(scrollContainerRef)} />);
    const scrollElement = scrollContainerRef.current!;
    expect(scrollElement.tabIndex).toBe(-1);

    scrollElement.focus();
    expect(document.activeElement).toBe(scrollElement);
  });
});

describe("OutputPane sticky step header", () => {
  const TARGET = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
  const ROWS: OutputRenderRow[] = [
    {
      key: "header",
      rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
      target: TARGET,
      estimateSize: 40,
      groupStart: true,
      output: { elapsed: 0, isStreaming: false },
      stepIndex: 0,
      isFinalStep: false,
      stepLabel: "Step 1",
      stepName: "Make interpreter probe async",
      attemptIndex: 0,
      runIndex: 0,
    },
    {
      key: "prompt",
      rowKind: OUTPUT_ROW_KINDS.PROMPT,
      target: TARGET,
      estimateSize: 40,
      text: "Replace the synchronous probes",
    },
    {
      key: "response",
      rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
      target: TARGET,
      estimateSize: 1000,
      text: "Done.",
      rawTextOutput: false,
      animated: false,
    },
  ];

  function stubRect(element: Element, top: number, bottom: number): void {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: top, width: 400, height: bottom - top })
    );
  }

  /** Lays the pane out as if scrolled `scrollTop` px into the rows. */
  function scrollRowsTo(scrollElement: HTMLElement, scrollTop: number): void {
    stubRect(scrollElement, 0, 300);
    stubRect(
      scrollElement.querySelector("[data-output-row-container]")!,
      -scrollTop,
      1080 - scrollTop
    );
    const slot = scrollElement.querySelector(".sticky")!;
    stubRect(slot, 0, 0);
    fireEvent.scroll(scrollElement);
  }

  function renderPane(overrides: Partial<OutputPaneProps> = {}) {
    const scrollContainerRef: { current: HTMLDivElement | null } = {
      current: null,
    };
    const view = render(
      <OutputPane
        {...buildProps(scrollContainerRef, {
          hasOutput: true,
          rows: ROWS,
          nonVirtualRows: ROWS,
          rowStarts: [0, 40, 80],
          contentHeight: 1080,
          runBanner: undefined,
          ...overrides,
        })}
      />
    );
    return { ...view, scrollElement: scrollContainerRef.current! };
  }

  afterEach(() => {
    useUiStore.setState({ outputInViewTargetKeys: [] });
  });

  it("sticks the step's header and prompt once the header scrolls away", () => {
    const { scrollElement, queryByTestId, getByTestId } = renderPane();
    scrollRowsTo(scrollElement, 0);
    expect(queryByTestId("output-sticky-step")).toBeNull();

    scrollRowsTo(scrollElement, 200);
    const sticky = getByTestId("output-sticky-step");
    expect(sticky).toHaveTextContent("Make interpreter probe async");
    expect(sticky).toHaveTextContent("Replace the synchronous probes");
    expect(useUiStore.getState().outputInViewTargetKeys).toEqual([
      getTargetKey(TARGET),
    ]);

    // Scrolling back up lets the real header take its place again.
    scrollRowsTo(scrollElement, 0);
    expect(queryByTestId("output-sticky-step")).toBeNull();
  });

  it("keeps reporting the steps in view while the sticky header is unpinned", () => {
    const { scrollElement, queryByTestId } = renderPane({
      isStepHeaderPinned: false,
    });
    scrollRowsTo(scrollElement, 200);
    expect(queryByTestId("output-sticky-step")).toBeNull();
    expect(useUiStore.getState().outputInViewTargetKeys).toEqual([
      getTargetKey(TARGET),
    ]);
  });

  it("reports no steps in view while the output tab is hidden", () => {
    useUiStore.setState({ outputInViewTargetKeys: [getTargetKey(TARGET)] });
    renderPane({ activeOutputTab: OUTPUT_TABS.TERMINAL });
    expect(useUiStore.getState().outputInViewTargetKeys).toEqual([]);
  });
});
