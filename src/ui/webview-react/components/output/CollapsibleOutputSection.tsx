import { createContext, memo, useContext } from "react";
import {
  formatFullOutputToggleLabel,
  formatHiddenOutputNotice,
} from "@utils/outputTruncation";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import { TOOL_ERROR_LINE, TOOL_RESULT_LINE } from "./outputStyles";
import { ToolCallExpandToggle } from "./ToolCallExpandToggle";

/** Selects a section root by name — the `data-collapsible-output-section` below. */
export function collapsibleOutputSectionSelector(section: string): string {
  return `[data-collapsible-output-section="${section}"]`;
}

/** Name of the section enclosing `element`, if any. */
export function getEnclosingCollapsibleOutputSection(
  element: HTMLElement
): string | undefined {
  return element.closest<HTMLElement>("[data-collapsible-output-section]")
    ?.dataset.collapsibleOutputSection;
}

/**
 * Told about each user click on a section toggle, just before it toggles, so
 * the output pane can hold the toggle where it was clicked. Find navigation
 * expands sections through the same state handlers without clicking, and must
 * keep its own scroll target, which is why this is separate from `onToggle`.
 * Standalone renders (no pane) get the no-op default.
 */
export const OutputTogglePinContext = createContext<
  (toggle: HTMLElement) => void
>(() => {});

interface CollapsibleOutputSectionProps {
  /** Section name, echoed on the root so the pane can find it again. */
  section: string;
  /** DOM id of the text container (`aria-controls` target). */
  contentId: string;
  isError?: boolean;
  /** What the toggle names: "Show full output" / "Show full error". */
  noun: string;
  visibleText: string;
  findMatches?: RowFindDecoration["matches"];
  canToggle: boolean;
  isExpanded: boolean;
  isTruncated: boolean;
  hiddenLineCount: number;
  onToggle: (expanded: boolean) => void;
}

/**
 * A ⎿ result section that collapses to a preview. The toggle sits *above* the
 * text, so expanding grows the section downward from a fixed point; while
 * expanded it sticks to the top of the pane so it can be collapsed from
 * anywhere inside a long output. A collapsed section ends with a plain notice
 * of how much is hidden — it is information, not a second control.
 *
 * Its block lines are sized by `getCollapsibleOutputChromeLineCount`; change
 * the two together.
 */
export const CollapsibleOutputSection = memo<CollapsibleOutputSectionProps>(
  ({
    section,
    contentId,
    isError = false,
    noun,
    visibleText,
    findMatches,
    canToggle,
    isExpanded,
    isTruncated,
    hiddenLineCount,
    onToggle,
  }) => {
    const pinToggle = useContext(OutputTogglePinContext);
    return (
      <div
        data-collapsible-output-section={section}
        className={isError ? TOOL_ERROR_LINE : TOOL_RESULT_LINE}
      >
        {canToggle && (
          // Same pill as "Show full command", so the two read as one control
          // family. The wrapper is flex so its height is the pill's 1.625em —
          // one result line, which is what the estimators charge for it.
          <div
            className={`flex bg-(--bg-primary) ${
              isExpanded ? "sticky top-(--cy-output-sticky-top,0px) z-1" : ""
            }`}
          >
            <ToolCallExpandToggle
              expanded={isExpanded}
              onToggle={(toggle) => {
                pinToggle(toggle);
                onToggle(!isExpanded);
              }}
              label={formatFullOutputToggleLabel(noun, false)}
              showLabel
              aria-controls={contentId}
            />
          </div>
        )}
        {/* Highlight only the visible slice — find offsets are computed against
          the full text, and highlightText drops matches past its end, so a
          match hidden by the collapse simply renders no <mark>. */}
        <div className="flex items-start gap-1">
          <span className="shrink-0">⎿</span>
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere"
            id={contentId}
          >
            {highlightText(visibleText, findMatches ?? [])}
          </div>
        </div>
        {!isExpanded && isTruncated && (
          <div className="text-description-fg italic">
            {formatHiddenOutputNotice(hiddenLineCount, noun)}
          </div>
        )}
      </div>
    );
  }
);
CollapsibleOutputSection.displayName = "CollapsibleOutputSection";
