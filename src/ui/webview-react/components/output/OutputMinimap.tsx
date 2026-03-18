import React, { useState, useCallback, useEffect } from "react";

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
 * - Hover to reveal a speech-bubble popup with step info and undo/redo action
 *
 * Hover fix: the popup and dot are siblings inside a single flex-row container,
 * so moving the mouse from the dot to the popup never leaves the container and
 * never triggers onMouseLeave.
 */
export const OutputMinimap: React.FC<OutputMinimapProps> = ({
  steps,
  totalMessages,
  scrollContainerRef,
  scrollTop,
}) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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
    // The rail itself is 14px and clips nothing — markers overflow to the left.
    <div
      className="relative flex-shrink-0 w-[14px] bg-sidebar-bg border-l border-panel-border"
      aria-hidden="true"
    >
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 pointer-events-none rounded-sm"
        style={{
          top: `${viewportPct.top}%`,
          height: `${viewportPct.height}%`,
          background:
            "var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4))",
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

        const dotColor = hasUndo
          ? isRedo
            ? "var(--vscode-terminal-ansiGreen, #89d185)"
            : "var(--vscode-textLink-foreground, #4ec9b0)"
          : "var(--vscode-descriptionForeground, #858585)";

        return (
          // Outer row: anchored to the right edge of the rail, grows leftward.
          // The popup + dot are flex siblings so the hover zone covers both
          // continuously — moving from dot to popup never leaves the container.
          <div
            key={step.key}
            className="absolute right-0 flex flex-row items-center z-20"
            style={{ top: `${topPct}%`, transform: "translateY(-50%)" }}
            onMouseEnter={() => setHoveredKey(step.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            {/* Speech-bubble popup — visible on hover */}
            {isHovered && (
              <div className="flex items-stretch mr-[3px]">
                {/* Bubble body */}
                <div
                  className="flex flex-col justify-center gap-0.5 px-2 py-1.5 rounded-l rounded-r-none bg-dropdown-bg border border-panel-border shadow-lg"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {/* Step label */}
                  <span className="text-[10px] font-semibold text-foreground leading-tight">
                    {step.label}
                  </span>

                  {/* Undo/redo action row */}
                  {hasUndo && step.undoAction && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        step.undoAction!.onTrigger();
                      }}
                      className="flex items-center gap-1 text-[10px] text-link-fg hover:text-link-active-fg transition-colors leading-tight focus:outline-none"
                    >
                      <i
                        className={`codicon ${isRedo ? "codicon-redo" : "codicon-discard"} text-[10px]`}
                      />
                      {step.undoAction.label}
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
                    filter: "drop-shadow(1px 0 0 var(--vscode-panel-border, rgba(128,128,128,0.35)))",
                  }}
                />
              </div>
            )}

            {/* Marker dot — click scrolls to step */}
            <button
              type="button"
              onClick={() => handleMarkerClick(step)}
              title={step.label}
              tabIndex={0}
              className="w-[14px] h-[18px] flex items-center justify-center flex-shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-border"
            >
              <span
                className="block rounded-full transition-all duration-100"
                style={{
                  width: isHovered ? "10px" : "8px",
                  height: isHovered ? "10px" : "8px",
                  background: dotColor,
                }}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
};
