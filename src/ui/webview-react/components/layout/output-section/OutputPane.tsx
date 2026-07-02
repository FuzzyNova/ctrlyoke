import React, { memo, Profiler } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { OutputRow } from "@components/output";
import {
  DEFAULT_BASH_OUTPUT_EXPANSION_STATE,
  type BashOutputExpansionSection,
  type BashOutputExpansionState,
} from "@components/output/BashOutput";
import type { OutputRowFileUndoRequest } from "@components/output/OutputRow";
import {
  OutputMinimap,
  type MinimapStep,
} from "@components/output/OutputMinimap";
import type {
  CliHeaderRow,
  OutputRenderRow,
  StructuredEventRow,
} from "@utils/outputRows";
import type { OutputFindMatch, RowFindDecoration } from "@utils/outputFind";
import type { ToolCallExpansionSection } from "@utils/toolCallLayout";
import {
  OutputScrollSeekPlaceholder,
  shouldRenderScrollSeekPlaceholder,
} from "./OutputScrollSeekPlaceholder";

interface OutputPaneProps {
  activeOutputTab: "output" | "terminal";
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
  minimapSteps: MinimapStep[];
  nonVirtualRows: OutputRenderRow[];
  nonVirtualSpacerHeight: number;
  outputRef: React.RefObject<HTMLDivElement | null>;
  renderedScrollSeekIndices: ReadonlySet<number>;
  rows: OutputRenderRow[];
  showVirtualizationOverlay: boolean;
  virtualRows: VirtualItem[];
  virtualizedTotalSize: number;
  measureRowElement: React.RefCallback<HTMLDivElement>;
  measureStaticRowElement: React.RefCallback<HTMLDivElement>;
  onBackToLive: () => void;
  onBashExpansionChange: (
    rowKey: string,
    section: BashOutputExpansionSection,
    expanded: boolean
  ) => void;
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
  onOutputProfilerRender: React.ProfilerOnRenderCallback;
  onPromptRedo: (row: CliHeaderRow) => void;
  onPromptUndo: (row: CliHeaderRow) => void;
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
    | "isExecutionActive"
    | "onBackToLive"
    | "onBashExpansionChange"
    | "onDiffCollapsedChange"
    | "onDiffGapExpand"
    | "onFileUndo"
    | "onPromptRedo"
    | "onPromptUndo"
    | "onToolCallExpansionChange"
    | "activeMatch"
  >
): React.ReactNode {
  return (
    <OutputRow
      row={row}
      findDecorations={props.findDecorations?.get(row.key)}
      findQuery={props.findQuery}
      findCaseSensitive={props.findCaseSensitive}
      activeFindMatch={
        props.activeMatch?.rowKey === row.key ? props.activeMatch : null
      }
      isExecutionActive={props.isExecutionActive}
      onBackToLive={props.onBackToLive}
      onPromptUndo={props.onPromptUndo}
      onPromptRedo={props.onPromptRedo}
      onFileUndo={props.onFileUndo}
      onDiffCollapsedChange={props.onDiffCollapsedChange}
      onDiffGapExpand={props.onDiffGapExpand}
      onToolCallExpansionChange={props.onToolCallExpansionChange}
      bashExpansion={
        props.bashExpansionState.get(row.key) ??
        DEFAULT_BASH_OUTPUT_EXPANSION_STATE
      }
      onBashExpansionChange={props.onBashExpansionChange}
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
    renderedScrollSeekIndices,
    rows,
    showVirtualizationOverlay,
    virtualRows,
    virtualizedTotalSize,
    measureRowElement,
    measureStaticRowElement,
    onContextMenuOpen,
    onMinimapStepClick,
    onOutputProfilerRender,
    onScroll,
    onTouchCancel,
    onTouchEnd,
    onTouchMove,
    onTouchStart,
    onWheel,
  } = props;

  return (
    <div
      aria-hidden={activeOutputTab !== "output" || isOutputCollapsed}
      className={`absolute inset-0 flex flex-row min-h-0 ${
        isOutputCollapsed
          ? "hidden"
          : activeOutputTab === "output"
            ? ""
            : "invisible pointer-events-none"
      }`}
    >
      {findBar}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={outputRef}
        id="output-content"
        className="font-mono text-[length:var(--fp-output-font-size-sm)] min-h-0 p-0 flex-1 overflow-y-auto scrollbar-hide"
        style={{ overflowAnchor: "none" }}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenuOpen(e.clientX, e.clientY, e.currentTarget);
        }}
      >
        {!hasOutput ? (
          <p className="text-center text-description-fg italic p-[var(--spacing-lg)]">
            Output will appear here during execution
          </p>
        ) : (
          <Profiler
            id={isOutputVirtualized ? "OutputVirtualRows" : "OutputRows"}
            onRender={onOutputProfilerRender}
          >
            {isOutputVirtualized ? (
              <div
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
              <div>
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
        <div className="pointer-events-none absolute inset-y-0 left-0 right-[var(--fp-output-minimap-width)] flex items-center justify-center">
          <div className="flex items-center gap-2 rounded border border-widget-border bg-editor-bg/90 px-3 py-1.5 text-xs text-description-fg shadow-sm backdrop-blur-[1px]">
            <i className="codicon codicon-loading codicon-modifier-spin" />
            <span>Rendering output…</span>
          </div>
        </div>
      )}

      {hasOutput && (
        <Profiler id="OutputMinimap" onRender={onOutputProfilerRender}>
          <OutputMinimap
            steps={minimapSteps}
            scrollContainerRef={outputRef}
            contentHeight={contentHeight}
            onStepClick={onMinimapStepClick}
          />
        </Profiler>
      )}
    </div>
  );
};

export const OutputPane = memo(OutputPaneComponent);
