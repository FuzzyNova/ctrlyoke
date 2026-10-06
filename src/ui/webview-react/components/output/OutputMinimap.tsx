import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
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
import { groupOutputMinimapMarkers } from "@utils/outputMinimapMarkers";
import { type PromptChangeSummary } from "@utils/promptUndo";
import { OutputMinimapMarker } from "./OutputMinimapMarker";

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
 * - Shows a marker at each prompt boundary's true position. Steps too close
 *   together to tell apart share one fatter marker rather than being pushed
 *   apart (see `groupOutputMinimapMarkers`), so the marker count is bounded
 *   by the rail's height, however many steps the run has
 * - Renders a draggable viewport thumb (replaces the native scrollbar)
 * - Click on the rail background to jump to that scroll position
 * - Click on any marker to scroll to its (first) step's output
 * - Hover to reveal a speech-bubble popup with one row per step in the
 *   marker: label, hide/show toggle, and one change-view action
 * - Renders colored diff overlays for file edits (red = removed, green = added):
 *   - Collapsed diffs → 5px horizontal line, split red/green proportionally
 *   - Expanded diffs  → row-aligned bands using the live diff's rendered layout
 *
 * Marker positions use real pixel fractions against the shared content-height
 * metric from OutputSection so the rail overlays, viewport thumb, and scroll
 * navigation all operate in the same coordinate space.
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
  onStepToggle,
  onStepSolo,
}) => {
  // pinnedKey: the marker group whose popup was opened by tap/click (stays
  // open until tapped away). Hover and focus visibility live in each marker.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const togglePinnedKey = useCallback((groupKey: string) => {
    setPinnedKey((prev) => (prev === groupKey ? null : groupKey));
  }, []);
  const dismissPinnedKey = useCallback(() => setPinnedKey(null), []);
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

  const markerGroups = useMemo(
    () => groupOutputMinimapMarkers(steps, railHeightPx),
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
      className="relative shrink-0 flex flex-row w-(--cy-output-minimap-width) [--cy-minimap-diff-added:var(--color-minimap-diff-added)] [--cy-minimap-diff-removed:var(--color-minimap-diff-removed)]"
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
        className="shrink-0 w-(--cy-output-minimap-pills-width) border-l border-panel-border"
      />

      {/* Diff track — opaque, flush with the panel edge; holds the diff
          overlays and the scroll thumb. */}
      <div
        ref={diffColumnRef}
        className="relative shrink-0 w-(--cy-output-minimap-diff-width) bg-sidebar-bg"
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
        className={`absolute right-0 w-(--cy-output-minimap-width) rounded-xs z-raised ${
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

      {/* Step markers — one per group of steps too close to tell apart */}
      {markerGroups.map((group) => (
        <OutputMinimapMarker
          key={group.key}
          group={group}
          railHeightPx={railHeightPx}
          isPinned={pinnedKey === group.key}
          onTogglePin={togglePinnedKey}
          onDismissPin={dismissPinnedKey}
          onStepClick={handleMarkerClick}
          onStepToggle={onStepToggle}
          onStepSolo={onStepSolo}
        />
      ))}
    </div>
  );
};

export const OutputMinimap = memo(OutputMinimapComponent);
OutputMinimap.displayName = "OutputMinimap";
