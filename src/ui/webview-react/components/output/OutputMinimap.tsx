import React, { useState, useCallback, useEffect, useRef } from "react";
import { type FinalStepPhase } from "../../types/messages";

// ============================================================================
// Types
// ============================================================================

/** A single contiguous run of same-type diff lines. */
export interface DiffRun {
  type: "added" | "removed" | "context";
  count: number;
}

/** A single file-edit diff region to visualize in the minimap rail. */
export interface MinimapDiffBlock {
  /** 0–1 fraction of the scroll area where this diff starts */
  scrollFraction: number;
  /** 0–1 fraction of the scroll area the diff occupies (DOM-measured) */
  heightFraction: number;
  /** Total added lines — used for the collapsed 5px line split */
  addedLines: number;
  /** Total removed lines — used for the collapsed 5px line split */
  removedLines: number;
  /**
   * Ordered sequence of diff runs extracted from structuredPatch.
   * When present, the expanded minimap overlay uses per-run color strips
   * (matching VS Code's diff minimap) rather than a simple two-color split.
   * Empty when only oldContent/newContent is available (no hunk data).
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
  /** Real pixel fraction (0–1): offsetTop of the step anchor / scrollHeight */
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
  scrollTop: number;
}

// ============================================================================
// OutputMinimap
// ============================================================================

// CSS variable references for diff colors — these match VS Code's minimap gutter
// diff decorations, so the minimap colors align with the editor's diff theme.
const DIFF_REMOVED_COLOR =
  "var(--vscode-minimapGutter-deletedBackground, rgba(214,80,80,0.55))";
const DIFF_ADDED_COLOR =
  "var(--vscode-minimapGutter-addedBackground, rgba(100,185,100,0.55))";

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
 *   - Expanded diffs  → vertical band with red on top, green on bottom,
 *     proportional to removed/added line counts
 *
 * Marker positions use real pixel fractions (offsetTop / scrollHeight) so they
 * align with the actual rendered position of each step — not an index fraction.
 *
 * Hover fix: the popup and dot are siblings inside a single flex-row container,
 * so moving the mouse from the dot to the popup never leaves the container and
 * never triggers onMouseLeave.
 */
export const OutputMinimap: React.FC<OutputMinimapProps> = ({
  steps,
  scrollContainerRef,
  scrollTop,
}) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // pinnedKey: popup opened by tap/click (stays open until tapped away).
  // Separate from hoveredKey so mouse-hover and touch-tap don't conflict.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isThumbHovered, setIsThumbHovered] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);

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
  const MIN_THUMB_PX = 24;
  const [viewportPct, setViewportPct] = useState({ top: 0, height: 100 });

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const update = () => {
      const { scrollHeight, clientHeight } = el;
      const railHeight = railRef.current?.clientHeight ?? 0;

      if (scrollHeight <= clientHeight || railHeight === 0) {
        setViewportPct({ top: 0, height: 100 });
        return;
      }

      const naturalPx = (clientHeight / scrollHeight) * railHeight;
      const thumbPx = Math.max(MIN_THUMB_PX, naturalPx);
      const scrollRange = scrollHeight - clientHeight;
      const topPx = (el.scrollTop / scrollRange) * (railHeight - thumbPx);

      setViewportPct({
        top: (topPx / railHeight) * 100,
        height: (thumbPx / railHeight) * 100,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [scrollContainerRef, scrollTop]);

  // ── Draggable thumb ────────────────────────────────────────────────────────

  const startThumbDrag = useCallback(
    (startY: number) => {
      const el = scrollContainerRef.current;
      const rail = railRef.current;
      if (!el || !rail) return;

      const canScroll = el.scrollHeight > el.clientHeight;
      if (!canScroll) return;

      const startScrollTop = el.scrollTop;
      const railHeight = rail.clientHeight;

      setIsDragging(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientY - startY;
        const maxScroll = el.scrollHeight - el.clientHeight;
        const scrollDelta = (delta / railHeight) * el.scrollHeight;
        el.scrollTop = Math.max(
          0,
          Math.min(maxScroll, startScrollTop + scrollDelta)
        );
      };

      const onTouchMove = (moveEvent: TouchEvent) => {
        const delta = moveEvent.touches[0].clientY - startY;
        const maxScroll = el.scrollHeight - el.clientHeight;
        const scrollDelta = (delta / railHeight) * el.scrollHeight;
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
    [scrollContainerRef]
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

      const canScroll = el.scrollHeight > el.clientHeight;
      if (!canScroll) return;

      const rect = rail.getBoundingClientRect();
      const fraction = (clientY - rect.top) / rect.height;
      const maxScroll = el.scrollHeight - el.clientHeight;
      // Center the viewport on the tapped position
      el.scrollTop = Math.max(
        0,
        Math.min(maxScroll, fraction * el.scrollHeight - el.clientHeight / 2)
      );
    },
    [scrollContainerRef]
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
      const el = scrollContainerRef.current;
      if (!el) return;
      el.scrollTo({
        top: step.scrollFraction * el.scrollHeight,
        behavior: "smooth",
      });
    },
    [scrollContainerRef]
  );

  if (steps.length === 0) return null;

  const canScroll = scrollContainerRef.current
    ? scrollContainerRef.current.scrollHeight >
      scrollContainerRef.current.clientHeight
    : false;

  return (
    // The rail itself is 14px and clips nothing — markers overflow to the left.
    <div
      ref={railRef}
      className="relative flex-shrink-0 w-[14px] bg-sidebar-bg border-l border-panel-border"
      aria-hidden="true"
      onMouseDown={handleRailMouseDown}
      onTouchStart={handleRailTouchStart}
      style={{ cursor: canScroll ? "pointer" : "default", touchAction: "none" }}
    >
      {/* Diff overlays — rendered below thumb and markers */}
      {steps.map((step) => (
        <React.Fragment key={`diffs-${step.key}`}>
          {step.diffBlocks.map((block, blockIdx) => {
            const significantLines = block.addedLines + block.removedLines;
            if (significantLines === 0) return null;

            const removedFraction = block.removedLines / significantLines;

            if (block.isCollapsed) {
              // Collapsed: fixed 2px horizontal line, left portion red, right green
              return (
                <div
                  key={blockIdx}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: `clamp(0px, ${block.scrollFraction * 100}%, calc(100% - 2px))`,
                    height: "2px",
                    background: `linear-gradient(to right,
                      ${DIFF_REMOVED_COLOR} 0%,
                      ${DIFF_REMOVED_COLOR} ${removedFraction * 100}%,
                      ${DIFF_ADDED_COLOR} ${removedFraction * 100}%,
                      ${DIFF_ADDED_COLOR} 100%
                    )`,
                  }}
                />
              );
            }

            // Expanded: per-run color strips matching VS Code's diff minimap style.
            // Each run gets a proportional slice of the block height; context = transparent.
            // The overlay height is DOM-measured so colored bands are proportional to
            // changed line counts relative to total lines shown (including context).
            let background: string;
            if (block.runs.length > 0) {
              const totalRunLines = block.runs.reduce((s, r) => s + r.count, 0);
              if (totalRunLines > 0) {
                const stops: string[] = [];
                let pct = 0;
                for (const run of block.runs) {
                  const end = pct + (run.count / totalRunLines) * 100;
                  const color =
                    run.type === "removed"
                      ? DIFF_REMOVED_COLOR
                      : run.type === "added"
                        ? DIFF_ADDED_COLOR
                        : "transparent";
                  // Hard stop: same color repeated at start and end of each run
                  stops.push(`${color} ${pct}%`, `${color} ${end}%`);
                  pct = end;
                }
                background = `linear-gradient(to bottom, ${stops.join(", ")})`;
              } else {
                background = "transparent";
              }
            } else {
              // Fallback when no run data (oldContent/newContent path): simple split
              background = `linear-gradient(to bottom,
                ${DIFF_REMOVED_COLOR} 0%,
                ${DIFF_REMOVED_COLOR} ${removedFraction * 100}%,
                ${DIFF_ADDED_COLOR} ${removedFraction * 100}%,
                ${DIFF_ADDED_COLOR} 100%
              )`;
            }

            return (
              <div
                key={blockIdx}
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: `${block.scrollFraction * 100}%`,
                  height: `${block.heightFraction * 100}%`,
                  background,
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
        className="absolute left-0 right-0 rounded-sm"
        style={{
          top: `${viewportPct.top}%`,
          height: `${viewportPct.height}%`,
          background: isDragging
            ? "var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.8))"
            : isThumbHovered
              ? "var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7))"
              : "var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4))",
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
            const maxScroll = el.scrollHeight - el.clientHeight;
            const delta = e.key === "ArrowUp" ? -0.05 : 0.05;
            el.scrollTop = Math.max(
              0,
              Math.min(maxScroll, el.scrollTop + delta * el.scrollHeight)
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

        // Dot color:
        //   mixed  → warning-fg (orange — attention needed)
        //   redo   → green
        //   undo   → link-fg (blue)
        //   plain  → description-fg
        const dotColor = isMixed
          ? "var(--vscode-editorWarning-foreground, #d19a66)"
          : hasRedo
            ? "var(--vscode-terminal-ansiGreen, #89d185)"
            : hasUndo
              ? "var(--vscode-textLink-foreground, #4ec9b0)"
              : "var(--vscode-descriptionForeground, #858585)";

        return (
          // Outer row: anchored to the right edge of the rail, grows leftward.
          // The popup + dot are flex siblings so the hover zone covers both
          // continuously — moving from dot to popup never leaves the container.
          <div
            key={step.key}
            role="button"
            tabIndex={0}
            className="absolute right-0 flex flex-row items-center z-20"
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
                  <span className="text-[10px] font-semibold text-foreground leading-tight">
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
                      className="flex items-center gap-1 text-[10px] text-terminal-ansiGreen hover:opacity-80 transition-opacity leading-tight focus:outline-none"
                    >
                      <i className="codicon codicon-redo text-[10px]" />
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
                      className="flex items-center gap-1 text-[10px] text-link-fg hover:text-link-active-fg transition-colors leading-tight focus:outline-none"
                    >
                      <i className="codicon codicon-discard text-[10px]" />
                      {undo.label}
                    </button>
                  )}
                </div>

                {/* Tail triangle pointing right toward the dot */}
                <div
                  className="self-center flex-shrink-0"
                  style={{
                    width: 0,
                    height: 0,
                    borderTop: "5px solid transparent",
                    borderBottom: "5px solid transparent",
                    borderLeft:
                      "5px solid var(--vscode-dropdown-background, #3c3c3c)",
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
              className="w-[14px] flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border transition-all duration-100"
              style={{
                height: isHovered ? "6px" : "4px",
                background: dotColor,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};
