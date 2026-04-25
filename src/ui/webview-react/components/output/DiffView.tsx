/**
 * DiffView — collapsible diff renderer powered by react-diff-view.
 *
 * Layout:
 * - Wide panels (≥ 1024 px): side-by-side split view via viewType="split".
 * - Narrow panels (< 1024 px): classic unified inline view.
 *
 * Features:
 * - Async-free syntax highlighting via refractor + tokenize() (runs in useMemo).
 * - Character-level inline diff marks via the markEdits() enhancer.
 * - GitHub-style "N hidden lines" decorations between hunks; click to expand
 *   (only when oldContent is available for context line lookup).
 * - Global collapse/expand synced from uiStore.
 */
import React, {
  useMemo,
  memo,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { Diff, Hunk, Decoration, tokenize, markEdits } from "react-diff-view";
import {
  getCollapsedLinesCountBetween,
  expandFromRawCode,
} from "react-diff-view";
import type { HunkData, DiffType } from "react-diff-view";
import {
  toRdvHunks,
  toRdvFromContent,
  normalizeLanguage,
  refractor,
} from "@utils/rdvAdapter";
import {
  normalizeStructuredPatch,
  countStructuredPatchDisplayLines,
} from "@utils/outputUtils";
import { useUiStore } from "@store/uiStore";
import { useElementNarrow } from "@hooks/useElementNarrow";

const SIDE_BY_SIDE_THRESHOLD = 1024;

interface DiffViewProps {
  /** Raw old file content (full-file edit path) */
  oldContent?: string;
  /** Raw new file content (full-file edit path) */
  newContent?: string;
  /** Pre-computed unified diff hunks (patch path, e.g. from Claude) */
  structuredPatch?: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  /** hljs language id inferred from the file path (e.g. "typescript") */
  language?: string;
  /**
   * When true the diff renders collapsed (summary header only).
   * Can be overridden per-instance by the user clicking the expand button.
   */
  globallyCollapsed: boolean;
  /** Optional content rendered inline with the expand/collapse toggle */
  actionSlot?: React.ReactNode;
  className?: string;
}

export const DiffView: React.FC<DiffViewProps> = ({
  oldContent,
  newContent,
  structuredPatch,
  language,
  globallyCollapsed,
  actionSlot,
  className = "",
}) => {
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const [isExpanded, setIsExpanded] = useState(!globallyCollapsed);

  // Snap to global state whenever the global flag or reset version changes.
  useEffect(() => {
    setIsExpanded(!globallyCollapsed);
  }, [globallyCollapsed, diffResetVersion]);

  const handleToggle = () => setIsExpanded((prev) => !prev);

  // Width tracking for split vs unified layout.
  const [narrowCallbackRef, isNarrow] = useElementNarrow<HTMLDivElement>(
    SIDE_BY_SIDE_THRESHOLD
  );
  const isWide = !isNarrow;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
      narrowCallbackRef(node);
    },
    [narrowCallbackRef]
  );

  // Propagate actual collapse state to the nearest [data-diff-anchor] wrapper.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const anchor = el.closest<HTMLElement>("[data-diff-anchor]");
    if (anchor) {
      anchor.setAttribute("data-diff-collapsed", isExpanded ? "false" : "true");
    }
  }, [isExpanded]);

  // Derive estimated line count for summary badge (cheap, no diff computation).
  const estimatedLineCount = useMemo(() => {
    const normalizedPatch = normalizeStructuredPatch(structuredPatch);
    if (normalizedPatch.length > 0) {
      return countStructuredPatchDisplayLines(normalizedPatch);
    }
    if (oldContent || newContent) {
      const oldLines = oldContent ? oldContent.split("\n").length : 0;
      const newLines = newContent ? newContent.split("\n").length : 0;
      return Math.max(oldLines, newLines);
    }
    return 0;
  }, [structuredPatch, oldContent, newContent]);

  const hasDiff = estimatedLineCount > 0;

  // Convert input to react-diff-view hunks — only when expanded (lazy).
  const { baseHunks, diffType } = useMemo((): {
    baseHunks: HunkData[];
    diffType: DiffType;
  } => {
    if (!isExpanded) return { baseHunks: [], diffType: "modify" };
    const normalizedPatch = normalizeStructuredPatch(structuredPatch);
    if (normalizedPatch.length > 0) {
      return { baseHunks: toRdvHunks(normalizedPatch), diffType: "modify" };
    }
    if (oldContent !== undefined && newContent !== undefined) {
      const result = toRdvFromContent(oldContent, newContent);
      return { baseHunks: result.hunks, diffType: result.diffType };
    }
    return { baseHunks: [], diffType: "modify" };
  }, [isExpanded, structuredPatch, oldContent, newContent]);

  // Track the currently-displayed hunks (can be expanded by user clicks).
  const [expandedHunks, setExpandedHunks] = useState<HunkData[]>(baseHunks);
  useEffect(() => {
    setExpandedHunks(baseHunks);
  }, [baseHunks]);

  // Expand N lines of context for the gap between two consecutive hunks.
  const handleExpand = useCallback(
    (prevHunk: HunkData | null, nextHunk: HunkData, count: number) => {
      if (!oldContent) return;
      const gapStart =
        prevHunk !== null ? prevHunk.oldStart + prevHunk.oldLines : 1;
      const gapEnd = nextHunk.oldStart;
      const expandEnd = Math.min(gapStart + count, gapEnd);
      setExpandedHunks((prev) =>
        expandFromRawCode(prev, oldContent, gapStart, expandEnd)
      );
    },
    [oldContent]
  );

  // Syntax highlighting + word-level edit marks via refractor (synchronous useMemo).
  const lang = normalizeLanguage(language);
  const tokens = useMemo(() => {
    if (!expandedHunks.length) return null;
    try {
      const enhancers = [markEdits(expandedHunks)];
      if (lang && refractor.registered(lang)) {
        return tokenize(expandedHunks, {
          highlight: true,
          refractor,
          language: lang,
          enhancers,
        });
      }
      return tokenize(expandedHunks, { highlight: false, enhancers });
    } catch {
      return null;
    }
  }, [expandedHunks, lang]);

  if (!hasDiff) return null;

  return (
    <div
      ref={setWrapperRef}
      className={`my-2 ${className}`}
    >
      {/* Summary / toggle header */}
      <div className="flex items-center gap-2 mb-1">
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-1.5 text-[length:var(--fp-output-font-size-xs)] text-description-fg hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 font-[inherit]"
          title={isExpanded ? "Collapse diff" : "Expand diff"}
        >
          <i
            className={`codicon codicon-chevron-right text-[length:var(--fp-output-font-size-xs)] transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
          />
          <span>
            {isExpanded ? "Hide" : "Show"} diff
            {!isExpanded && estimatedLineCount > 0 && (
              <span className="ml-1 opacity-60">
                (~{estimatedLineCount} lines)
              </span>
            )}
          </span>
        </button>
        {actionSlot}
      </div>

      {/* Diff — only mounted when expanded and there are hunks */}
      {isExpanded && expandedHunks.length > 0 && (
        <div className="rounded-[3px] overflow-x-auto overflow-y-hidden border border-panel-border">
          <Diff
            viewType={isWide ? "split" : "unified"}
            diffType={diffType}
            hunks={expandedHunks}
            tokens={tokens}
          >
            {(hunks) =>
              hunks.reduce<React.ReactElement[]>((nodes, hunk, i) => {
                const prevHunk = i > 0 ? hunks[i - 1] : null;
                const collapsed = getCollapsedLinesCountBetween(
                  prevHunk,
                  hunk
                );
                if (collapsed > 0) {
                  nodes.push(
                    <Decoration key={`gap-${i}-${hunk.oldStart}`}>
                      <button
                        type="button"
                        disabled={!oldContent}
                        onClick={() => handleExpand(prevHunk, hunk, 10)}
                        className="w-full text-left px-3 py-0.5 text-[length:var(--fp-output-font-size-xs)] text-description-fg hover:text-foreground disabled:cursor-default disabled:opacity-50 bg-transparent border-none font-mono cursor-pointer"
                      >
                        ▸ {collapsed} hidden lines
                      </button>
                    </Decoration>
                  );
                }
                nodes.push(<Hunk key={hunk.content} hunk={hunk} />);
                return nodes;
              }, [])
            }
          </Diff>
        </div>
      )}
    </div>
  );
};

export default memo(DiffView);
