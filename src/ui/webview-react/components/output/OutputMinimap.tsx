import React, { useState, useCallback, useEffect, useRef } from "react";

// ============================================================================
// Types
// ============================================================================

export interface MinimapStep {
  key: string;
  kind: "queue" | "finalPrompt";
  stepIndex: number;
  firstMessageIndex: number;
  label: string;
  undoAction: {
    label: string;
    isRedo: boolean;
    onTrigger: () => void;
  } | null;
}

interface OutputMinimapProps {
  steps: MinimapStep[];
  totalMessages: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  scrollTop: number;
}

// ============================================================================
// OutputMinimap
// ============================================================================

/**
 * A narrow rail on the right side of the output panel.
 * - Shows a proportional position marker for each prompt boundary
 * - Renders a viewport indicator (scroll thumb)
 * - Click on any marker to scroll to that step's output
 * - Hover over a marker to reveal an undo/redo button
 */
export const OutputMinimap: React.FC<OutputMinimapProps> = ({
  steps,
  totalMessages,
  scrollContainerRef,
  scrollTop,
}) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute viewport indicator dimensions
  const [viewportPct, setViewportPct] = useState({ top: 0, height: 100 });

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const update = () => {
      const { scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) {
        setViewportPct({ top: 0, height: 100 });
        return;
      }
      const top = (el.scrollTop / scrollHeight) * 100;
      const height = (clientHeight / scrollHeight) * 100;
      setViewportPct({ top, height });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollContainerRef, scrollTop]);

  const handleMarkerClick = useCallback(
    (step: MinimapStep) => {
      const el = scrollContainerRef.current;
      if (!el || totalMessages === 0) return;
      const fraction = step.firstMessageIndex / totalMessages;
      el.scrollTo({ top: fraction * el.scrollHeight, behavior: "smooth" });
    },
    [scrollContainerRef, totalMessages]
  );

  if (steps.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative flex-shrink-0 w-[14px] bg-sidebar-bg border-l border-panel-border"
      aria-hidden="true"
    >
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 pointer-events-none rounded-sm"
        style={{
          top: `${viewportPct.top}%`,
          height: `${viewportPct.height}%`,
          background: "var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4))",
          opacity: 0.5,
        }}
      />

      {/* Step markers */}
      {steps.map((step) => {
        const topPct =
          totalMessages > 0
            ? (step.firstMessageIndex / totalMessages) * 100
            : 0;
        const isHovered = hoveredKey === step.key;
        const hasUndo = step.undoAction !== null;
        const isRedo = step.undoAction?.isRedo ?? false;

        // Dot color:
        //   redo  → green (terminal-ansiGreen)
        //   undo  → link-fg (blue)
        //   plain → description-fg
        const dotColor = hasUndo
          ? isRedo
            ? "var(--vscode-terminal-ansiGreen, #89d185)"
            : "var(--vscode-textLink-foreground, #4ec9b0)"
          : "var(--vscode-descriptionForeground, #858585)";

        return (
          <div
            key={step.key}
            className="absolute left-0 right-0 flex items-center justify-center group"
            style={{ top: `${topPct}%`, transform: "translateY(-50%)" }}
            onMouseEnter={() => setHoveredKey(step.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            {/* Tooltip + undo button — shown on hover, pops to the left */}
            {isHovered && (
              <div
                className="absolute right-[18px] flex items-center gap-1 z-10 pointer-events-auto"
                style={{ whiteSpace: "nowrap" }}
              >
                {/* Step label tooltip */}
                <span className="text-[10px] bg-dropdown-bg border border-panel-border text-foreground px-1.5 py-0.5 rounded shadow-md">
                  {step.label}
                </span>

                {/* Undo/redo button */}
                {hasUndo && step.undoAction && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      step.undoAction!.onTrigger();
                    }}
                    title={step.undoAction.label}
                    className="flex items-center justify-center w-[22px] h-[22px] rounded bg-btn-bg hover:bg-btn-hover text-btn-fg transition-colors shadow-md"
                  >
                    <i
                      className={`codicon ${isRedo ? "codicon-redo" : "codicon-discard"} text-[11px]`}
                    />
                  </button>
                )}
              </div>
            )}

            {/* Marker dot — click scrolls to step */}
            <button
              type="button"
              onClick={() => handleMarkerClick(step)}
              title={step.label}
              tabIndex={0}
              className="relative z-0 w-[8px] h-[8px] rounded-full transition-transform hover:scale-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border"
              style={{ background: dotColor }}
            />
          </div>
        );
      })}
    </div>
  );
};
