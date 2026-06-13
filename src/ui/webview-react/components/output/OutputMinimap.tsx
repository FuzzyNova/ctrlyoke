import React, { memo, useState, useCallback, useEffect, useRef } from "react";
import { type FinalStepPhase } from "../../types/messages";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import { getProfilerState, logProfilerEvent } from "@utils/performanceProfiler";

// ============================================================================
// Types
// ============================================================================

/** A single contiguous run of rendered diff rows. */
export interface DiffRun {
  count: number;
  addedLines: number;
  removedLines: number;
}

/** A single file-edit diff region to visualize in the minimap rail. */
export interface MinimapDiffBlock {
  /** Stable diff identifier shared with the rendered output row. */
  key: string;
  /** Source output row key used for debug correlation. */
  rowKey: string;
  /** 0–1 fraction of the scroll area where this diff starts */
  scrollFraction: number;
  /** 0–1 fraction of the scroll area the diff occupies from shared row layout. */
  heightFraction: number;
  /** Total added lines — used for the collapsed 5px line split */
  addedLines: number;
  /** Total removed lines — used for the collapsed 5px line split */
  removedLines: number;
  /**
   * Ordered sequence of rendered diff rows.
   * When present, the expanded minimap overlay follows the same row grouping
   * as the live diff view, including split-view delete/insert pair rows.
   */
  runs: DiffRun[];
  /** Whether the diff is currently collapsed in the output view (tracked via data-diff-collapsed attribute). */
  isCollapsed: boolean;
}

export interface MinimapStep {
  key: string;
  kind: FinalStepPhase;
  stepIndex: number;
  firstMessageIndex: number;
  /** Real pixel fraction (0–1): offsetTop of the step anchor / shared content height */
  scrollFraction: number;
  label: string;
  /**
   * Available undo/redo actions for this step.
   * Both can be non-null in mixed state (some files undone, others not).
   */
  undoActions: {
    undo: { label: string; onTrigger: () => void } | null;
    redo: { label: string; onTrigger: () => void } | null;
  };
  /** Diff regions within this step — rendered as colored overlays on the rail. */
  diffBlocks: MinimapDiffBlock[];
}

interface OutputMinimapProps {
  steps: MinimapStep[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  contentHeight: number;
  onStepClick?: (step: MinimapStep) => void;
}

// ============================================================================
// OutputMinimap
// ============================================================================

/**
 * A narrow rail on the right side of the output panel that doubles as the
 * scrollbar for the output content area.
 *
 * - Shows a proportional position marker for each prompt boundary
 * - Renders a draggable viewport thumb (replaces the native scrollbar)
 * - Click on the rail background to jump to that scroll position
 * - Click on any marker to scroll to that step's output
 * - Hover to reveal a speech-bubble popup with step info and undo/redo actions
 *   (stacked vertically when both are available — mixed state)
 * - Renders colored diff overlays for file edits (red = removed, green = added):
 *   - Collapsed diffs → 5px horizontal line, split red/green proportionally
 *   - Expanded diffs  → row-aligned bands using the live diff's rendered layout
 *
 * Marker positions use real pixel fractions against the shared content-height
 * metric from OutputSection so the rail overlays, viewport thumb, and scroll
 * navigation all operate in the same coordinate space.
 *
 * Hover fix: the popup and dot are siblings inside a single flex-row container,
 * so moving the mouse from the dot to the popup never leaves the container and
 * never triggers onMouseLeave.
 */
const MIN_THUMB_PX = 24;

function getResizeObserverEntryHeight(
  entry: ResizeObserverEntry | undefined
): number | null {
  const borderBox = entry?.borderBoxSize?.[0];
  if (borderBox) {
    return borderBox.blockSize;
  }

  const contentBox = entry?.contentBoxSize?.[0];
  if (contentBox) {
    return contentBox.blockSize;
  }

  return entry?.contentRect.height ?? null;
}

const OutputMinimapComponent: React.FC<OutputMinimapProps> = ({
  steps,
  scrollContainerRef,
  contentHeight,
  onStepClick,
}) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // pinnedKey: popup opened by tap/click (stays open until tapped away).
  // Separate from hoveredKey so mouse-hover and touch-tap don't conflict.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isThumbHovered, setIsThumbHovered] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef(steps);
  const contentHeightRef = useRef(contentHeight);
  const lastObservedScrollHeightRef = useRef<number | null>(null);
  const lastObservedRailHeightRef = useRef<number | null>(null);
  stepsRef.current = steps;
  contentHeightRef.current = contentHeight;

  // Dismiss the pinned popup when clicking/tapping anywhere outside it.
  // Uses only 'click' (not 'touchend') to avoid a race where touchend fires
  // before click and incorrectly resets pinnedKey before the toggle runs.
  useEffect(() => {
    if (!pinnedKey) return;
    const dismiss = () => setPinnedKey(null);
    document.addEventListener("click", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
    };
  }, [pinnedKey]);

  // Compute viewport indicator dimensions.
  // Thumb height is floored at MIN_THUMB_PX so it remains grabbable even when
  // the content is very long. The top position is recalculated to match so the
  // thumb still accurately tracks the scroll position.
  const [viewportPct, setViewportPct] = useState({ top: 0, height: 100 });
  // Do NOT read live scrollHeight here. During navigation TanStack Virtual
  // temporarily inflates getTotalSize() (and therefore scrollHeight) with
  // large bucket estimates for newly-rendered rows. Reading the live value
  // causes sharedContentHeight to spike (e.g. 69 k → 86 k) mid-animation
  // while step fractions are still computed against the old rowLayout.totalSize,
  // making the thumb appear far above the clicked pill. Use contentHeight
  // (= rowLayout.totalSize from the last React render) as the stable reference;
  // getTotalSize() ≈ scrollHeight in settled state so the thumb still reaches 100%.
  const getSharedContentHeight = useCallback(() => {
    const clientHeight = scrollContainerRef.current?.clientHeight ?? 0;
    return Math.max(contentHeight, clientHeight, 1);
  }, [contentHeight, scrollContainerRef]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const update = () => {
      const startedAt = performance.now();
      const { clientHeight } = el;
      const railHeight = railRef.current?.clientHeight ?? 0;
      const sharedContentHeight = getSharedContentHeight();
      const logUpdateDuration = () => {
        const durationMs = performance.now() - startedAt;
        const profilerState = getProfilerState();
        if (
          !profilerState.enabled ||
          durationMs < profilerState.slowThresholdMs
        ) {
          return;
        }

        logProfilerEvent("minimapViewportUpdate", {
          durationMs,
          steps: stepsRef.current.length,
          diffBlocks: stepsRef.current.reduce(
            (count, step) => count + step.diffBlocks.length,
            0
          ),
          scrollTop: el.scrollTop,
          clientHeight,
          railHeight,
          sharedContentHeight,
          contentHeight: contentHeightRef.current,
        });
      };

      if (sharedContentHeight <= clientHeight || railHeight === 0) {
        setViewportPct((prev) =>
          prev.top === 0 && prev.height === 100 ? prev : { top: 0, height: 100 }
        );
        logUpdateDuration();
        return;
      }

      const naturalPx = (clientHeight / sharedContentHeight) * railHeight;
      const thumbPx = Math.max(MIN_THUMB_PX, naturalPx);
      const scrollRange = sharedContentHeight - clientHeight;
      const topPx =
        scrollRange <= 0
          ? 0
          : (el.scrollTop / scrollRange) * (railHeight - thumbPx);

      const next = {
        top: (topPx / railHeight) * 100,
        height: (thumbPx / railHeight) * 100,
      };
      setViewportPct((prev) =>
        Math.abs(prev.top - next.top) < 0.01 &&
        Math.abs(prev.height - next.height) < 0.01
          ? prev
          : next
      );
      logUpdateDuration();
    };

    update();
    const { observer, disconnect } = createAnimationFrameResizeObserver(
      (entries) => {
        const containerHeight = entries[0]
          ? getResizeObserverEntryHeight(entries[0])
          : null;
        const railHeight = railRef.current?.clientHeight ?? null;

        const heightUnchanged =
          containerHeight != null &&
          railHeight != null &&
          lastObservedScrollHeightRef.current != null &&
          lastObservedRailHeightRef.current != null &&
          Math.abs(lastObservedScrollHeightRef.current - containerHeight) <
            0.5 &&
          Math.abs(lastObservedRailHeightRef.current - railHeight) < 0.5;

        if (heightUnchanged) {
          return;
        }

        if (containerHeight != null) {
          lastObservedScrollHeightRef.current = containerHeight;
        }
        if (railHeight != null) {
          lastObservedRailHeightRef.current = railHeight;
        }

        update();
      }
    );
    observer.observe(el);
    const handleScroll = () => update();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      disconnect();
      el.removeEventListener("scroll", handleScroll);
    };
  }, [getSharedContentHeight, scrollContainerRef]);

  // ── Draggable thumb ────────────────────────────────────────────────────────

  const startThumbDrag = useCallback(
    (startY: number) => {
      const el = scrollContainerRef.current;
      const rail = railRef.current;
      if (!el || !rail) return;

      const sharedContentHeight = getSharedContentHeight();
      const canScroll = sharedContentHeight > el.clientHeight;
      if (!canScroll) return;

      const startScrollTop = el.scrollTop;
      const railHeight = rail.clientHeight;

      setIsDragging(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientY - startY;
        const maxScroll = sharedContentHeight - el.clientHeight;
        const scrollDelta = (delta / railHeight) * sharedContentHeight;
        el.scrollTop = Math.max(
          0,
          Math.min(maxScroll, startScrollTop + scrollDelta)
        );
      };

      const onTouchMove = (moveEvent: TouchEvent) => {
        const delta = moveEvent.touches[0].clientY - startY;
        const maxScroll = sharedContentHeight - el.clientHeight;
        const scrollDelta = (delta / railHeight) * sharedContentHeight;
        el.scrollTop = Math.max(
          0,
          Math.min(maxScroll, startScrollTop + scrollDelta)
        );
      };

      const cleanup = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", cleanup);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      document.addEventListener("touchmove", onTouchMove, { passive: true });
      document.addEventListener("touchend", cleanup);
    },
    [getSharedContentHeight, scrollContainerRef]
  );

  const handleThumbMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation(); // prevent rail jump handler from firing
      startThumbDrag(e.clientY);
    },
    [startThumbDrag]
  );

  const handleThumbTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation(); // prevent rail touch handler from firing
      startThumbDrag(e.touches[0].clientY);
    },
    [startThumbDrag]
  );

  // ── Rail background click — jump to position ───────────────────────────────

  const jumpToRailPosition = useCallback(
    (clientY: number, target: EventTarget | null) => {
      const rail = railRef.current;
      const el = scrollContainerRef.current;
      if (!rail || !el) return;
      // Only handle direct taps on the rail background, not on children
      if (target !== rail) return;

      const sharedContentHeight = getSharedContentHeight();
      const canScroll = sharedContentHeight > el.clientHeight;
      if (!canScroll) return;

      const rect = rail.getBoundingClientRect();
      const fraction = (clientY - rect.top) / rect.height;
      const maxScroll = sharedContentHeight - el.clientHeight;
      // Center the viewport on the tapped position
      el.scrollTop = Math.max(
        0,
        Math.min(
          maxScroll,
          fraction * sharedContentHeight - el.clientHeight / 2
        )
      );
    },
    [getSharedContentHeight, scrollContainerRef]
  );

  const handleRailMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      jumpToRailPosition(e.clientY, e.target);
    },
    [jumpToRailPosition]
  );

  const handleRailTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      jumpToRailPosition(e.touches[0].clientY, e.target);
    },
    [jumpToRailPosition]
  );

  // ── Marker click — scroll to step ─────────────────────────────────────────

  const handleMarkerClick = useCallback(
    (step: MinimapStep) => {
      if (onStepClick) {
        onStepClick(step);
        return;
      }

      const el = scrollContainerRef.current;
      if (!el) return;
      const targetTop = step.scrollFraction * getSharedContentHeight();
      el.scrollTo({
        top: targetTop,
        behavior: "smooth",
      });
    },
    [getSharedContentHeight, onStepClick, scrollContainerRef]
  );

  const canScroll = scrollContainerRef.current
    ? getSharedContentHeight() > scrollContainerRef.current.clientHeight
    : false;

  return (
    // The rail itself is 14px and clips nothing — markers overflow to the left.
    <div
      ref={railRef}
      className="relative flex-shrink-0 w-[14px] bg-sidebar-bg border-l border-panel-border [--fp-minimap-diff-added:theme(colors.minimap-diff-added)] [--fp-minimap-diff-removed:theme(colors.minimap-diff-removed)]"
      aria-hidden="true"
      onMouseDown={handleRailMouseDown}
      onTouchStart={handleRailTouchStart}
      style={{ cursor: canScroll ? "pointer" : "default", touchAction: "none" }}
    >
      {/* Diff overlays — rendered below thumb and markers */}
      {steps.map((step) => (
        <React.Fragment key={`diffs-${step.key}`}>
          {step.diffBlocks.map((block) => {
            const significantLines = block.addedLines + block.removedLines;
            if (significantLines === 0) return null;

            const removedFraction = block.removedLines / significantLines;

            if (block.isCollapsed) {
              // Collapsed: fixed 2px horizontal line, left portion red, right green
              return (
                <div
                  key={block.key}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: `clamp(0px, ${block.scrollFraction * 100}%, calc(100% - 2px))`,
                    height: "2px",
                    background: `linear-gradient(to right,
                        var(--fp-minimap-diff-removed) 0%,
                        var(--fp-minimap-diff-removed) ${removedFraction * 100}%,
                        var(--fp-minimap-diff-added) ${removedFraction * 100}%,
                        var(--fp-minimap-diff-added) 100%
                      )`,
                  }}
                />
              );
            }

            if (block.runs.length > 0) {
              const totalRunRows = block.runs.reduce(
                (sum, run) => sum + run.count,
                0
              );
              if (totalRunRows > 0) {
                let offsetRows = 0;
                return (
                  <div
                    key={block.key}
                    className="absolute left-0 right-0 pointer-events-none overflow-hidden"
                    style={{
                      top: `${block.scrollFraction * 100}%`,
                      height: `${block.heightFraction * 100}%`,
                      minHeight: "1px",
                    }}
                  >
                    {block.runs.map((run, runIndex) => {
                      const top = (offsetRows / totalRunRows) * 100;
                      const height = (run.count / totalRunRows) * 100;
                      offsetRows += run.count;

                      const changedLines = run.addedLines + run.removedLines;
                      let background = "transparent";

                      if (changedLines > 0) {
                        const removedPct =
                          (run.removedLines / changedLines) * 100;
                        background =
                          run.addedLines > 0 && run.removedLines > 0
                            ? `linear-gradient(to right,
                                  var(--fp-minimap-diff-removed) 0%,
                                  var(--fp-minimap-diff-removed) ${removedPct}%,
                                  var(--fp-minimap-diff-added) ${removedPct}%,
                                  var(--fp-minimap-diff-added) 100%
                                )`
                            : run.removedLines > 0
                              ? "var(--fp-minimap-diff-removed)"
                              : "var(--fp-minimap-diff-added)";
                      }

                      return (
                        <div
                          key={runIndex}
                          className="absolute left-0 right-0 pointer-events-none"
                          style={{
                            top: `${top}%`,
                            height: `${height}%`,
                            background,
                          }}
                        />
                      );
                    })}
                  </div>
                );
              }
            }

            return (
              <div
                key={block.key}
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: `${block.scrollFraction * 100}%`,
                  height: `${block.heightFraction * 100}%`,
                  minHeight: "1px",
                  background: `linear-gradient(to bottom,
                      var(--fp-minimap-diff-removed) 0%,
                      var(--fp-minimap-diff-removed) ${removedFraction * 100}%,
                      var(--fp-minimap-diff-added) ${removedFraction * 100}%,
                      var(--fp-minimap-diff-added) 100%
                    )`,
                }}
              />
            );
          })}
        </React.Fragment>
      ))}

      {/* Draggable viewport thumb (replaces native scrollbar) */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Scroll viewport"
        aria-valuenow={Math.round(viewportPct.top * 100)}
        className={`absolute left-0 right-0 rounded-sm z-raised ${
          isDragging
            ? "bg-minimap-thumb-active"
            : isThumbHovered
              ? "bg-minimap-thumb-hover"
              : "bg-minimap-thumb"
        }`}
        style={{
          top: `${viewportPct.top}%`,
          height: `${viewportPct.height}%`,
          boxShadow:
            "inset 0 0 0 1px var(--vscode-panel-border, rgba(128,128,128,0.45))",
          cursor: isDragging ? "grabbing" : canScroll ? "grab" : "default",
          transition: isDragging ? "none" : "background 0.1s",
        }}
        onMouseDown={handleThumbMouseDown}
        onTouchStart={handleThumbTouchStart}
        onMouseEnter={() => setIsThumbHovered(true)}
        onMouseLeave={() => setIsThumbHovered(false)}
        onKeyDown={(e) => {
          // Allow keyboard scrolling: ArrowUp/ArrowDown move the viewport
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const el = scrollContainerRef.current;
            if (!el) return;
            const sharedContentHeight = getSharedContentHeight();
            const maxScroll = sharedContentHeight - el.clientHeight;
            const delta = e.key === "ArrowUp" ? -0.05 : 0.05;
            el.scrollTop = Math.max(
              0,
              Math.min(maxScroll, el.scrollTop + delta * sharedContentHeight)
            );
          }
        }}
      />

      {/* Step markers */}
      {steps.map((step) => {
        const topPct = step.scrollFraction * 100;
        // isHovered: true when mouse-hovering OR popup was pinned open by tap
        const isHovered = hoveredKey === step.key || pinnedKey === step.key;
        const { undo, redo } = step.undoActions;
        const hasUndo = undo !== null;
        const hasRedo = redo !== null;
        const isMixed = hasUndo && hasRedo;
        const dotColorClass = isMixed
          ? "text-warning-fg"
          : hasRedo
            ? "text-terminal-ansiGreen"
            : hasUndo
              ? "text-link-fg"
              : "text-description-fg";

        return (
          // Outer row: anchored to the right edge of the rail, grows leftward.
          // The popup + dot are flex siblings so the hover zone covers both
          // continuously — moving from dot to popup never leaves the container.
          <div
            key={step.key}
            role="button"
            tabIndex={0}
            className="absolute right-0 flex flex-row items-center z-header"
            style={{
              top: `clamp(3px, ${topPct}%, calc(100% - 3px))`,
              transform: "translateY(-50%)",
            }}
            onMouseEnter={() => setHoveredKey(step.key)}
            onMouseLeave={() => setHoveredKey(null)}
            onClick={(e) => {
              // stopPropagation prevents the document dismiss-listener from
              // immediately closing the popup we're about to open.
              e.stopPropagation();
              setPinnedKey((prev) => (prev === step.key ? null : step.key));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setPinnedKey((prev) => (prev === step.key ? null : step.key));
              } else if (e.key === "Escape") {
                setHoveredKey(null);
                setPinnedKey(null);
              }
            }}
            aria-label={`Step ${step.label}: ${hasUndo ? "undo available. " : ""}${hasRedo ? "redo available." : ""}`}
          >
            {/* Speech-bubble popup — visible on hover (mouse) or when pinned open (touch/click) */}
            {isHovered && (
              <div className="flex items-stretch mr-[3px]">
                {/* Bubble body */}
                <div
                  className="flex flex-col justify-center gap-1 px-2 py-1.5 rounded-l rounded-r-none bg-dropdown-bg border border-panel-border shadow-lg"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {/* Step label */}
                  <span className="text-xxs font-semibold text-foreground leading-tight">
                    {step.label}
                  </span>

                  {/* Redo action (shown above undo in mixed state) */}
                  {hasRedo && redo && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinnedKey(null);
                        redo.onTrigger();
                      }}
                      style={{ touchAction: "manipulation" }}
                      className="flex items-center gap-1 text-xxs text-terminal-ansiGreen hover:opacity-80 transition-opacity leading-tight focus:outline-none"
                    >
                      <i className="codicon codicon-redo text-xxs" />
                      {redo.label}
                    </button>
                  )}

                  {/* Undo action */}
                  {hasUndo && undo && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinnedKey(null);
                        undo.onTrigger();
                      }}
                      style={{ touchAction: "manipulation" }}
                      className="flex items-center gap-1 text-xxs text-link-fg hover:text-link-active-fg transition-colors leading-tight focus:outline-none"
                    >
                      <i className="codicon codicon-discard text-xxs" />
                      {undo.label}
                    </button>
                  )}
                </div>

                {/* Tail triangle pointing right toward the dot */}
                <div
                  className="self-center flex-shrink-0 text-dropdown-bg"
                  style={{
                    width: 0,
                    height: 0,
                    borderTop: "5px solid transparent",
                    borderBottom: "5px solid transparent",
                    borderLeft: "5px solid currentColor",
                    filter:
                      "drop-shadow(1px 0 0 var(--vscode-panel-border, rgba(128,128,128,0.35)))",
                  }}
                />
              </div>
            )}

            {/* Marker pill — click scrolls to step */}
            <button
              type="button"
              onClick={() => handleMarkerClick(step)}
              title={step.label}
              aria-label={step.label}
              tabIndex={0}
              className={`w-[14px] flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border transition-all duration-100 bg-current ${dotColorClass}`}
              style={{
                height: isHovered ? "6px" : "4px",
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export const OutputMinimap = memo(OutputMinimapComponent);
OutputMinimap.displayName = "OutputMinimap";
