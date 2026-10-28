import React, { memo, Profiler, useLayoutEffect, useRef } from "react";
import {
  OUTPUT_ROW_KINDS,
  OUTPUT_TABS,
  SELECT_ALL_SCOPE_ATTRIBUTE,
  SELECT_ALL_SCOPES,
  type OutputTab,
} from "@root/types/DashboardConstants";
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
import { useOutputViewportSteps } from "@hooks/useOutputViewportSteps";

/**
 * Cuts the sticky header's prompt/command block down to its first lines: the
 * block's top margin (it sits right under the header, see
 * `OUTPUT_STEP_LEAD_BLOCK_BASE`) and padding plus that many line boxes. The
 * edge is a hard cut; the sticky's drop shadow marks it instead of a fade,
 * which would dim the prompt itself.
 */
function stickyPreviewClipStyle(lines: number): React.CSSProperties {
  return {
    maxHeight: `calc(var(--cy-output-step-lead-gap) + var(--spacing-sm) + ${lines}lh)`,
    overflow: "hidden",
  };
}

const STICKY_PREVIEW_CLIP_STYLE = stickyPreviewClipStyle(2);
/** A narrow pane previews one prompt line, keeping the pinned block short. */
const NARROW_STICKY_PREVIEW_CLIP_STYLE = stickyPreviewClipStyle(1);

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
  /** Whether the header of the step being read sticks below the run banner. */
  isStepHeaderPinned: boolean;
  /** Row offsets from the shared row layout, indexed like `rows`. */
  rowStarts: readonly number[];
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
  /**
   * Fires in the capture phase for any pointer, wheel, touch or key input in
   * the pane, before its own handlers read geometry.
   */
  onUserInputCapture: () => void;
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
  >,
  isStickyCopy = false
): React.ReactNode {
  return (
    <OutputRow
      row={row}
      isStickyCopy={isStickyCopy}
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
    isStepHeaderPinned,
    rowStarts,
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
    onUserInputCapture,
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

  const { stickySlotRef, stickyContentRef, stickyRows } =
    useOutputViewportSteps({
      isActive:
        hasOutput &&
        !isOutputCollapsed &&
        activeOutputTab === OUTPUT_TABS.OUTPUT,
      isStickyEnabled: isStepHeaderPinned,
      rows,
      rowStarts,
      totalSize: contentHeight,
      scrollContainerRef,
    });

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
      onPointerDownCapture={onUserInputCapture}
      onWheelCapture={onUserInputCapture}
      onTouchStartCapture={onUserInputCapture}
      onKeyDownCapture={onUserInputCapture}
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
      {/* Focusable so a press on output text takes focus. VS Code's webview
          host runs Ctrl/Cmd+C as execCommand("copy") and, when focus is on
          <body>, first refocuses the last focused element (a prompt editor or
          button), which moves the selection away and copies nothing. It is a
          named region so screen readers can jump to it; its handlers only
          track scrolling, touch and copy. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={outputRef}
        id="output-content"
        role="region"
        aria-label="Workflow output"
        tabIndex={-1}
        {...{ [SELECT_ALL_SCOPE_ATTRIBUTE]: SELECT_ALL_SCOPES.CONTENTS }}
        className="font-mono text-(length:--cy-output-font-size-sm) min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide outline-none"
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
            duration={runBanner.duration}
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
          <>
            {/* Zero-height slot that sticks just below a pinned run banner. Its
              on-screen top is the top of the readable area, which is what
              useOutputViewportSteps measures against; the stuck header hangs
              below it without taking any space in the row flow. */}
            <div
              ref={stickySlotRef}
              className="sticky z-raised h-0"
              style={{ top: `var(${OUTPUT_STICKY_TOP_CSS_VAR}, 0px)` }}
            >
              {stickyRows && (
                <div
                  ref={stickyContentRef}
                  data-testid="output-sticky-step"
                  className="absolute inset-x-0 top-0 bg-(--bg-primary) border-b border-(--border-color) shadow-(--cy-output-sticky-step-shadow)"
                >
                  {/* The same rows the stream renders, so the copy lines up
                    exactly with the real header when it scrolls back in. */}
                  {renderOutputRow(stickyRows.headerRow, props, true)}
                  {stickyRows.previewRow && (
                    <div
                      style={
                        stickyRows.headerRow.rowKind ===
                          OUTPUT_ROW_KINDS.CLI_HEADER &&
                        stickyRows.headerRow.narrowLayout
                          ? NARROW_STICKY_PREVIEW_CLIP_STYLE
                          : STICKY_PREVIEW_CLIP_STYLE
                      }
                    >
                      {renderOutputRow(stickyRows.previewRow, props, true)}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* The autoscroll glide clips this box while it translates the row
              container, so the translated overflow never reaches scrollHeight. */}
            <div data-output-glide-clip>
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
                          // Positioned by `top`, not translateY: sticky offsets are
                          // computed from layout and ignore ancestor transforms, so
                          // a translated row pins an expanded section's sticky
                          // "Hide full output" toggle to the section's bottom.
                          style={{
                            position: "absolute",
                            top: virtualRow.start,
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
            </div>
          </>
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
