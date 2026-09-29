import {
  FINAL_STEP_PHASES,
  KEYBOARD_KEYS,
} from "@root/types/DashboardConstants";
import React, {
  memo,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { type FinalStepPhase } from "../../types/messages";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import { getProfilerState, logProfilerEvent } from "@utils/performanceProfiler";
import { quantizeOutputMinimapBars } from "@utils/outputMinimapBars";
import {
  getPromptChangeLabelParts,
  type PromptChangeSummary,
} from "@utils/promptUndo";
import { Icon } from "../shared/Icon";

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

export interface MinimapUndoAction {
  label: string;
  /**
   * Longer form for the button's tooltip, when the label alone understates the
   * scope — a concurrent group's entry undoes every member, not just the step
   * whose marker offers it.
   */
  title?: string;
  onTrigger: () => void;
}

export interface MinimapStep {
  key: string;
  kind: FinalStepPhase;
  stepIndex: number;
  firstMessageIndex: number;
  /** Real pixel fraction (0–1): offsetTop of the step anchor / shared content height */
  scrollFraction: number;
  label: string;
  hidden: boolean;
  selected?: boolean;
  hasHiddenActivity: boolean;
  /** One neutral viewer action for every step with at least one change row. */
  changeAction: MinimapUndoAction | null;
  changeSummary: PromptChangeSummary | null;
  /** Diff regions within this step — rendered as colored overlays on the rail. */
  diffBlocks: MinimapDiffBlock[];
}

interface OutputMinimapProps {
  steps: MinimapStep[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  contentHeight: number;
  onStepClick?: (step: MinimapStep) => void;
  onStepToggle?: (step: MinimapStep) => void;
  onStepSolo?: (step: MinimapStep) => void;
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
 * - Hover to reveal a speech-bubble popup with step info and one change-view
 *   action
 * - Renders colored diff overlays for file edits (red = removed, green = added):
 *   - Collapsed diffs → 5px horizontal line, split red/green proportionally
 *   - Expanded diffs  → row-aligned bands using the live diff's rendered layout
 *
 * Marker positions use real pixel fractions against the shared content-height
 * metric from OutputSection so the rail overlays, viewport thumb, and scroll
 * navigation all operate in the same coordinate space.
 *
 * Hover fix: the popup and pill are siblings inside a single flex-row container,
 * so moving the mouse from the pill to the popup never leaves the container and
 * never triggers onMouseLeave.
 */
const MIN_THUMB_PX = 24;
// Two markers whose raw scrollFraction positions land closer together than
// this always keep an overlapping click target, since each step's pill
// button occupies real layout space in the pills track at all times, not
// just on hover.
const MIN_MARKER_GAP_PX = 16;
const MARKER_EDGE_INSET_PX = 3;

function clampMarkerPx(scrollFraction: number, railHeightPx: number): number {
  return Math.min(
    Math.max(scrollFraction * railHeightPx, MARKER_EDGE_INSET_PX),
    railHeightPx - MARKER_EDGE_INSET_PX
  );
}

/**
 * Nudges markers apart along the rail so no two are closer than
 * MIN_MARKER_GAP_PX, without changing their relative order. Without this, two
 * step anchors close in scroll-fraction space (a common case for a run with
 * several fast steps) silently steal each other's clicks: the later step's
 * always-in-layout (opacity-0) eye-toggle button paints on top of the earlier
 * step's, so a click aimed at one step's toggle lands on its neighbor's.
 */
export function computeDeclutteredTopsPx(
  steps: readonly MinimapStep[],
  railHeightPx: number
): number[] {
  const result = new Array<number>(steps.length).fill(0);
  if (railHeightPx <= 0 || steps.length === 0) return result;

  const order = steps
    .map((step, index) => ({
      index,
      top: clampMarkerPx(step.scrollFraction, railHeightPx),
    }))
    .sort((a, b) => a.top - b.top);

  for (let i = 1; i < order.length; i++) {
    if (order[i].top < order[i - 1].top + MIN_MARKER_GAP_PX) {
      order[i].top = order[i - 1].top + MIN_MARKER_GAP_PX;
    }
  }

  const bottomLimit = railHeightPx - MARKER_EDGE_INSET_PX;
  const last = order[order.length - 1];
  if (last.top > bottomLimit) {
    last.top = bottomLimit;
    for (let i = order.length - 2; i >= 0; i--) {
      if (order[i].top > order[i + 1].top - MIN_MARKER_GAP_PX) {
        order[i].top = order[i + 1].top - MIN_MARKER_GAP_PX;
      }
    }
  }

  for (const { index, top } of order) {
    result[index] = top;
  }
  return result;
}

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
  onStepToggle,
  onStepSolo,
}) => {
  // pinnedKey: popup opened by tap/click (stays open until tapped away).
  // Mouse hover and focus visibility are handled by the marker group's CSS.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isThumbHovered, setIsThumbHovered] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const pillsColumnRef = useRef<HTMLDivElement>(null);
  const diffColumnRef = useRef<HTMLDivElement>(null);
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
  const [railHeightPx, setRailHeightPx] = useState(0);
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
      setRailHeightPx((prev) => (prev === railHeight ? prev : railHeight));
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
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      disconnect();
      el.removeEventListener("scroll", update);
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
      // Only handle direct taps on the rail background or on one of its two
      // track columns' own background (pills or diff) — not on markers, the
      // popup, or the thumb. Both tracks are click-to-scroll, matching VS
      // Code's overview-ruler + minimap split, where the (transparent) ruler
      // column is just as much a scrollbar as the diff column next to it.
      const isTrackBackground =
        target === rail ||
        target === pillsColumnRef.current ||
        target === diffColumnRef.current;
      if (!isTrackBackground) return;

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

  const declutteredTopsPx = useMemo(
    () => computeDeclutteredTopsPx(steps, railHeightPx),
    [steps, railHeightPx]
  );
  const diffBars = useMemo(
    () => quantizeOutputMinimapBars(steps, railHeightPx),
    [steps, railHeightPx]
  );

  return (
    // The rail is split into two vertical tracks, styled after VS Code's own
    // overview-ruler (pills) + minimap (diff) split: a transparent pills
    // track (left) for step markers, and an opaque diff track (right, flush
    // with the panel edge) for diff overlays and the scroll thumb. Neither
    // track clips its own content — markers and popups overflow left of the
    // rail intentionally (see the group container below).
    // The rail used to be aria-hidden, but it now contains real step controls,
    // so it has to stay in the accessibility tree. Its own drag-to-scroll is a
    // pointer-only shorthand for the output pane's native scrolling, and the
    // step markers inside it are individually focusable buttons, so there is no
    // keyboard affordance missing here for the rule to protect.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={railRef}
      className="relative flex-shrink-0 flex flex-row w-[var(--cy-output-minimap-width)] [--cy-minimap-diff-added:theme(colors.minimap-diff-added)] [--cy-minimap-diff-removed:theme(colors.minimap-diff-removed)]"
      onMouseDown={handleRailMouseDown}
      onTouchStart={handleRailTouchStart}
      style={{ cursor: canScroll ? "pointer" : "default", touchAction: "none" }}
    >
      {/* Pills track — transparent (page background shows through), so it can
          sit over content without visually blocking it. Its left border marks
          the rail's outer edge. Click-to-scroll like the diff track; step
          markers below are absolutely positioned on top of it. */}
      <div
        ref={pillsColumnRef}
        className="flex-shrink-0 w-[var(--cy-output-minimap-pills-width)] border-l border-panel-border"
      />

      {/* Diff track — opaque, flush with the panel edge; holds the diff
          overlays and the scroll thumb. */}
      <div
        ref={diffColumnRef}
        className="relative flex-shrink-0 w-[var(--cy-output-minimap-diff-width)] bg-sidebar-bg"
      >
        {/* Diff overlays — one bar per occupied rail pixel, below thumb and
            markers. Only a genuinely paired split-view row (or a collapsed
            block's summary line) renders as a red/green split; a bar that
            only has both colors because unrelated solo lines were quantized
            onto the same pixel renders solid, matching the live unified diff
            view where a row is never part red and part green. */}
        {diffBars.map((bar) => {
          const coverage = bar.addedCoverage + bar.removedCoverage;
          const background = bar.mixed
            ? (() => {
                const removedFraction = bar.removedCoverage / coverage;
                return `linear-gradient(to right,
                  var(--cy-minimap-diff-removed) 0%,
                  var(--cy-minimap-diff-removed) ${removedFraction * 100}%,
                  var(--cy-minimap-diff-added) ${removedFraction * 100}%,
                  var(--cy-minimap-diff-added) 100%
                )`;
              })()
            : bar.removedCoverage >= bar.addedCoverage
              ? "var(--cy-minimap-diff-removed)"
              : "var(--cy-minimap-diff-added)";
          return (
            <div
              key={bar.row}
              data-minimap-diff-bar
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${bar.row}px`,
                height: "1px",
                background,
              }}
            />
          );
        })}
      </div>

      {/* Draggable viewport thumb (replaces native scrollbar). Spans both
          tracks (pills + diff). */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Scroll viewport"
        aria-valuenow={Math.round(viewportPct.top * 100)}
        className={`absolute right-0 w-[var(--cy-output-minimap-width)] rounded-sm z-raised ${
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
          if (
            e.key === KEYBOARD_KEYS.ARROW_UP ||
            e.key === KEYBOARD_KEYS.ARROW_DOWN
          ) {
            e.preventDefault();
            const el = scrollContainerRef.current;
            if (!el) return;
            const sharedContentHeight = getSharedContentHeight();
            const maxScroll = sharedContentHeight - el.clientHeight;
            const delta = e.key === KEYBOARD_KEYS.ARROW_UP ? -0.05 : 0.05;
            el.scrollTop = Math.max(
              0,
              Math.min(maxScroll, el.scrollTop + delta * sharedContentHeight)
            );
          }
        }}
      />

      {/* Step markers */}
      {steps.map((step, stepPositionIndex) => {
        const topPct = step.scrollFraction * 100;
        const topStyle =
          railHeightPx > 0
            ? `${declutteredTopsPx[stepPositionIndex]}px`
            : `clamp(3px, ${topPct}%, calc(100% - 3px))`;
        const isPinned = pinnedKey === step.key;
        const changeAction = step.changeAction;
        const summary = step.changeSummary;
        const hasChanges = (summary?.total ?? 0) > 0;
        const hasUndoable = (summary?.undoable ?? 0) > 0;
        const hasUndone = (summary?.undone ?? 0) > 0;
        const isMixed = hasUndoable && hasUndone;
        const changeLabel = summary ? getPromptChangeLabelParts(summary) : null;
        const dotColorClass = step.selected
          ? "text-focus-border"
          : isMixed
            ? "text-warning-fg"
            : hasUndone
              ? "text-terminal-ansiGreen"
              : hasChanges
                ? "text-link-fg"
                : "text-description-fg";
        const hideShowLabel = `${step.hidden ? "Show" : "Hide"} ${step.kind === FINAL_STEP_PHASES.FINAL_STEP ? `final step loop ${step.stepIndex + 1}` : `step ${step.stepIndex + 1}`} output`;

        return (
          <React.Fragment key={step.key}>
            {/* Outer row: anchored to the boundary between the pills and diff
                tracks (not the rail's outer edge), so the marker pill lands
                inside the pills track while the popup grows further left,
                overflowing past the rail's own left edge — the overflow the
                top-of-file comment documents. The popup + dot are flex siblings
                so the hover zone covers both continuously — moving from dot to
                popup never leaves the container. */}
            <div
              role="group"
              aria-label={`Step ${step.label}`}
              className={`group absolute right-[var(--cy-output-minimap-diff-width)] flex flex-row items-center z-header ${step.hidden ? "opacity-60" : ""}`}
              style={{
                top: topStyle,
                transform: "translateY(-50%)",
              }}
            >
              {/* Speech-bubble popup — visible on hover (mouse) or when pinned open (touch/click) */}
              <div
                className={`flex items-stretch mr-[3px] ${isPinned ? "" : "hidden group-hover:flex group-focus-within:flex"}`}
              >
                {/* Bubble body */}
                <div
                  className="flex flex-col justify-center gap-1 px-2 py-1.5 rounded-l rounded-r-none bg-dropdown-bg border border-panel-border shadow-lg"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {/* Title row: step label + hide/show toggle */}
                  <div className="flex items-center gap-2">
                    <span className="text-xxs font-semibold text-foreground leading-tight">
                      {step.label}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStepToggle?.(step);
                      }}
                      style={{ touchAction: "manipulation" }}
                      aria-pressed={step.hidden}
                      aria-label={hideShowLabel}
                      title={hideShowLabel}
                      className="ml-auto flex items-center gap-1 text-xxs text-description-fg hover:text-foreground transition-colors leading-tight focus:outline-none"
                    >
                      <Icon
                        name={step.hidden ? "eye-closed" : "eye"}
                        className="codicon-sm"
                      />
                      {step.hidden ? "Show" : "Hide"}
                    </button>
                  </div>

                  {changeAction && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinnedKey(null);
                        changeAction.onTrigger();
                      }}
                      style={{ touchAction: "manipulation" }}
                      title={changeAction.title}
                      aria-label={changeAction.label}
                      className="flex items-center gap-1 text-xxs text-link-fg hover:text-link-active-fg transition-colors leading-tight focus:outline-none"
                    >
                      <Icon name="diff" className="text-xxs" />
                      {changeLabel && (
                        <>
                          {changeLabel.main}
                          {changeLabel.undone && (
                            <span className="text-terminal-ansiGreen">
                              {changeLabel.undone}
                            </span>
                          )}
                        </>
                      )}
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

              {/* Marker pill — click scrolls to step */}
              <button
                type="button"
                onClick={(e) => {
                  if (e.altKey && onStepSolo) {
                    e.preventDefault();
                    e.stopPropagation();
                    onStepSolo(step);
                    return;
                  }
                  // Keep the popup pinned for mouse, keyboard, and touch
                  // activation; stopping propagation protects it from the
                  // document-level dismiss listener.
                  e.stopPropagation();
                  handleMarkerClick(step);
                  setPinnedKey((prev) => (prev === step.key ? null : step.key));
                }}
                onKeyDown={(e) => {
                  if (e.key === KEYBOARD_KEYS.ESCAPE) {
                    setPinnedKey(null);
                  }
                }}
                title={step.label}
                aria-label={step.label}
                tabIndex={0}
                className={`h-1 w-[var(--cy-output-minimap-pills-width)] flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border transition-all duration-100 bg-current group-hover:h-1.5 group-focus-within:h-1.5 ${dotColorClass}`}
              />
              {step.hasHiddenActivity && (
                <span
                  data-minimap-hidden-activity
                  className="ml-0.5 h-1 w-1 rounded-full bg-output-streaming animate-pulse-streaming"
                  aria-hidden="true"
                />
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export const OutputMinimap = memo(OutputMinimapComponent);
OutputMinimap.displayName = "OutputMinimap";
