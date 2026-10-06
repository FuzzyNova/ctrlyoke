import React, { memo, Profiler, useLayoutEffect, useRef } from "react";
import { OUTPUT_TABS, type OutputTab } from "@root/types/DashboardConstants";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  OutputRow,
  RunSummaryBanner,
  WorkspaceWorktreeOwnershipBanner,
} from "@components/output";
import {
  DEFAULT_BASH_OUTPUT_EXPANSION_STATE,
  type BashOutputExpansionSection,
  type BashOutputExpansionState,
} from "@components/output/BashOutput";
import type { OutputRowFileUndoRequest } from "@components/output/OutputRow";
import type { RunBannerData } from "@components/output/RunSummaryBanner";
import type { WorkspaceWorktreeOwnership } from "@root/types/CtrlYokeTypes";
import {
  OutputMinimap,
  type MinimapStep,
} from "@components/output/OutputMinimap";
import type {
  CliHeaderRow,
  OutputRenderRow,
  ParallelGroupHeaderRow,
  StructuredEventRow,
} from "@utils/outputRows";
import type { OutputFindMatch, RowFindDecoration } from "@utils/outputFind";
import { getTargetKey } from "@utils/outputProjection";
import type { ToolCallExpansionSection } from "@utils/toolCallLayout";
import {
  OutputScrollSeekPlaceholder,
  shouldRenderScrollSeekPlaceholder,
} from "./OutputScrollSeekPlaceholder";
import { OUTPUT_STICKY_TOP_CSS_VAR } from "@components/output/outputStyles";
import { Icon } from "../../shared/Icon";

interface OutputPaneProps {
  activeOutputTab: OutputTab;
  bashExpansionState: ReadonlyMap<string, BashOutputExpansionState>;
  contentHeight: number;
  hasOutput: boolean;
  isExecutionActive: boolean;
  isNavigationTargetVirtualized: boolean;
  isOutputCollapsed: boolean;
  isOutputScrollSeeking: boolean;
  isOutputVirtualized: boolean;
  findBar?: React.ReactNode;
  findDecorations?: Map<string, RowFindDecoration>;
  findQuery?: string;
  findCaseSensitive?: boolean;
  atomicContextReferences: boolean;
  minimapSteps: MinimapStep[];
  nonVirtualRows: OutputRenderRow[];
  nonVirtualSpacerHeight: number;
  outputRef: React.RefCallback<HTMLDivElement>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  renderedScrollSeekIndices: ReadonlySet<number>;
  rows: OutputRenderRow[];
  showVirtualizationOverlay: boolean;
  virtualRows: VirtualItem[];
  virtualizedTotalSize: number;
  measureRowElement: React.RefCallback<HTMLDivElement>;
  measureStaticRowElement: React.RefCallback<HTMLDivElement>;
  /** Run identity/status/totals for whichever run is displayed; absent when there's no run to show (e.g. a fresh draft). */
  runBanner?: RunBannerData;
  workspaceWorktreeOwnership?: WorkspaceWorktreeOwnership;
  isRunBannerPinned: boolean;
  onToggleRunBannerPinned: () => void;
  /** True while browsing history and a different run is executing live. */
  showBackToLive: boolean;
  onBackToLive: () => void;
  onBashExpansionChange: (
    rowKey: string,
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
  onScriptVerdictExpansionChange: (rowKey: string, expanded: boolean) => void;
  onScriptOutputExpansionChange: (
    rowKey: string,
    toggleKey: string,
    expanded: boolean
  ) => void;
  onAttemptGroupToggle: (groupKey: string) => void;
  onContextMenuOpen: (
    x: number,
    y: number,
    scrollContainer: HTMLDivElement
  ) => void;
  onDiffCollapsedChange: (
    rowKey: string,
    diffKey: string,
    collapsed: boolean
  ) => void;
  onDiffGapExpand: (
    rowKey: string,
    diffKey: string,
    gapIndex: number,
    nextExpandedToLine: number
  ) => void;
  onFileUndo: (
    row: StructuredEventRow,
    request: OutputRowFileUndoRequest
  ) => void;
  onMinimapStepClick: (step: MinimapStep) => void;
  /** Target keys of hidden steps that have produced output since being hidden. */
  hiddenActivityTargetKeys: ReadonlySet<string>;
  onMinimapStepToggle: (step: MinimapStep) => void;
  onMinimapStepSolo: (step: MinimapStep) => void;
  onOutputProfilerRender: React.ProfilerOnRenderCallback;
  onPromptView: (row: CliHeaderRow | ParallelGroupHeaderRow) => void;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onTouchCancel: React.TouchEventHandler<HTMLDivElement>;
  onTouchEnd: React.TouchEventHandler<HTMLDivElement>;
  onTouchMove: React.TouchEventHandler<HTMLDivElement>;
  onTouchStart: React.TouchEventHandler<HTMLDivElement>;
  onToolCallExpansionChange: (
    rowKey: string,
    section: ToolCallExpansionSection,
    expanded: boolean
  ) => void;
  onWheel: React.WheelEventHandler<HTMLDivElement>;
  activeMatch?: OutputFindMatch | null;
}

function renderOutputRow(
  row: OutputRenderRow,
  props: Pick<
    OutputPaneProps,
    | "bashExpansionState"
    | "findDecorations"
    | "findQuery"
    | "findCaseSensitive"
    | "atomicContextReferences"
    | "isExecutionActive"
    | "onBashExpansionChange"
    | "onScriptVerdictExpansionChange"
    | "onScriptOutputExpansionChange"
    | "onAttemptGroupToggle"
    | "onDiffCollapsedChange"
    | "onDiffGapExpand"
    | "onFileUndo"
    | "onPromptView"
    | "onToolCallExpansionChange"
    | "activeMatch"
    | "hiddenActivityTargetKeys"
  >
): React.ReactNode {
  return (
    <OutputRow
      row={row}
      findDecorations={props.findDecorations?.get(row.key)}
      findQuery={props.findQuery}
      findCaseSensitive={props.findCaseSensitive}
      atomicContextReferences={props.atomicContextReferences}
      activeFindMatch={
        props.activeMatch?.rowKey === row.key ? props.activeMatch : null
      }
      isExecutionActive={props.isExecutionActive}
      onPromptView={props.onPromptView}
      onFileUndo={props.onFileUndo}
      onDiffCollapsedChange={props.onDiffCollapsedChange}
      onDiffGapExpand={props.onDiffGapExpand}
      onToolCallExpansionChange={props.onToolCallExpansionChange}
      bashExpansion={
        props.bashExpansionState.get(row.key) ??
        DEFAULT_BASH_OUTPUT_EXPANSION_STATE
      }
      onBashExpansionChange={props.onBashExpansionChange}
      onScriptVerdictExpansionChange={props.onScriptVerdictExpansionChange}
      onScriptOutputExpansionChange={props.onScriptOutputExpansionChange}
      onAttemptGroupToggle={props.onAttemptGroupToggle}
      hasHiddenActivity={props.hiddenActivityTargetKeys.has(
        getTargetKey(row.target)
      )}
    />
  );
}

const OutputPaneComponent: React.FC<OutputPaneProps> = (props) => {
  const {
    activeOutputTab,
    contentHeight,
    hasOutput,
    isNavigationTargetVirtualized,
    isOutputCollapsed,
    isOutputScrollSeeking,
    isOutputVirtualized,
    findBar,
    minimapSteps,
    nonVirtualRows,
    nonVirtualSpacerHeight,
    outputRef,
    scrollContainerRef,
    renderedScrollSeekIndices,
    rows,
    showVirtualizationOverlay,
    virtualRows,
    virtualizedTotalSize,
    measureRowElement,
    measureStaticRowElement,
    runBanner,
    workspaceWorktreeOwnership,
    isRunBannerPinned,
    onToggleRunBannerPinned,
    showBackToLive,
    onBackToLive,
    onContextMenuOpen,
    onMinimapStepClick,
    onMinimapStepToggle,
    onMinimapStepSolo,
    onOutputProfilerRender,
    onScroll,
    onTouchCancel,
    onTouchEnd,
    onTouchMove,
    onTouchStart,
    onWheel,
  } = props;

  // Sticky section toggles must stop below a pinned banner, whose height
  // changes with its content (worktree buttons, wrapping on narrow panes).
  const runBannerRef = useRef<HTMLDivElement>(null);
  const hasRunBanner = runBanner !== undefined;
  useLayoutEffect(() => {
    const scrollElement = scrollContainerRef.current;
    const banner = runBannerRef.current;
    if (!scrollElement) return;
    if (!isRunBannerPinned || !hasRunBanner || !banner) {
      scrollElement.style.removeProperty(OUTPUT_STICKY_TOP_CSS_VAR);
      return;
    }
    const applyOffset = () =>
      scrollElement.style.setProperty(
        OUTPUT_STICKY_TOP_CSS_VAR,
        `${banner.offsetHeight}px`
      );
    applyOffset();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyOffset);
    observer.observe(banner);
    return () => observer.disconnect();
  }, [hasRunBanner, isRunBannerPinned, scrollContainerRef]);

  const handleCopyCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const chips = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[data-atomic-reference-copy-text]"
      )
    );
    const selectedChips = chips.filter((chip) => {
      try {
        return range.intersectsNode(chip);
      } catch {
        return false;
      }
    });
    if (selectedChips.length === 0) return;

    const fragment = range.cloneContents();
    fragment
      .querySelectorAll<HTMLElement>("[data-atomic-reference-copy-text]")
      .forEach((chip) => {
        chip.replaceWith(
          document.createTextNode(
            chip.getAttribute("data-atomic-reference-copy-text") ??
              chip.textContent ??
              ""
          )
        );
      });
    event.clipboardData.setData("text/plain", fragment.textContent ?? "");
    event.preventDefault();
  };

  return (
    <div
      aria-hidden={activeOutputTab !== OUTPUT_TABS.OUTPUT || isOutputCollapsed}
      className={`absolute inset-0 flex flex-row min-h-0 ${
        isOutputCollapsed
          ? "hidden"
          : activeOutputTab === OUTPUT_TABS.OUTPUT
            ? ""
            : "invisible pointer-events-none"
      }`}
    >
      {findBar}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={outputRef}
        id="output-content"
        className="font-mono text-(length:--cy-output-font-size-sm) min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
        style={{ overflowAnchor: "none" }}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onCopyCapture={handleCopyCapture}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenuOpen(e.clientX, e.clientY, e.currentTarget);
        }}
      >
        {workspaceWorktreeOwnership && (
          <WorkspaceWorktreeOwnershipBanner
            ownership={workspaceWorktreeOwnership}
          />
        )}
        {runBanner && (
          <RunSummaryBanner
            runId={runBanner.runId}
            startedAt={runBanner.startedAt}
            executionState={runBanner.executionState}
            tokenTotals={runBanner.tokenTotals}
            worktree={runBanner.worktree}
            address={runBanner.address}
            isPinned={isRunBannerPinned}
            onTogglePinned={onToggleRunBannerPinned}
            containerRef={runBannerRef}
            showBackToLive={showBackToLive}
            onBackToLive={onBackToLive}
          />
        )}
        {!hasOutput ? (
          <p className="text-center text-description-fg italic p-(--spacing-lg)">
            Output will appear here during execution
          </p>
        ) : (
          <Profiler
            id={isOutputVirtualized ? "OutputVirtualRows" : "OutputRows"}
            onRender={onOutputProfilerRender}
          >
            {isOutputVirtualized ? (
              <div
                data-output-row-container
                style={{
                  height: `${virtualizedTotalSize}px`,
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualRows.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;

                  const renderScrollSeekPlaceholder =
                    isOutputScrollSeeking &&
                    !isNavigationTargetVirtualized &&
                    !renderedScrollSeekIndices.has(virtualRow.index) &&
                    shouldRenderScrollSeekPlaceholder(row);

                  return (
                    <div
                      key={virtualRow.key}
                      ref={
                        renderScrollSeekPlaceholder
                          ? undefined
                          : measureRowElement
                      }
                      data-index={virtualRow.index}
                      data-row-key={row.key}
                      className="flow-root"
                      style={{
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: "100%",
                      }}
                    >
                      {renderScrollSeekPlaceholder ? (
                        <OutputScrollSeekPlaceholder
                          row={row}
                          height={virtualRow.size}
                        />
                      ) : (
                        renderOutputRow(row, props)
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div data-output-row-container>
                {nonVirtualRows.map((row, rowIndex) => (
                  <div
                    key={row.key}
                    ref={measureStaticRowElement}
                    data-index={rowIndex}
                    data-row-key={row.key}
                    className="flow-root"
                  >
                    {renderOutputRow(row, props)}
                  </div>
                ))}
                {nonVirtualSpacerHeight > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ height: `${nonVirtualSpacerHeight}px` }}
                  />
                )}
              </div>
            )}
          </Profiler>
        )}
      </div>

      {showVirtualizationOverlay && (
        <div className="pointer-events-none absolute inset-y-0 left-0 right-(--cy-output-minimap-width) flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-sm border border-widget-border bg-editor-bg/90 px-3 py-1.5 text-xs text-description-fg shadow-xs backdrop-blur-[1px]">
            <Icon name="loading" className="codicon-modifier-spin" />
            <span>Rendering output…</span>
          </div>
        </div>
      )}

      {hasOutput && (
        <Profiler id="OutputMinimap" onRender={onOutputProfilerRender}>
          <OutputMinimap
            steps={minimapSteps}
            scrollContainerRef={scrollContainerRef}
            contentHeight={contentHeight}
            onStepClick={onMinimapStepClick}
            onStepToggle={onMinimapStepToggle}
            onStepSolo={onMinimapStepSolo}
          />
        </Profiler>
      )}
    </div>
  );
};

export const OutputPane = memo(OutputPaneComponent);
