import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { OutputPane } from "@components/layout/output-section/OutputPane";
import { OUTPUT_STICKY_TOP_CSS_VAR } from "@components/output/outputStyles";
import { EXECUTION_STATES, OUTPUT_TABS } from "@root/types/DashboardConstants";

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
