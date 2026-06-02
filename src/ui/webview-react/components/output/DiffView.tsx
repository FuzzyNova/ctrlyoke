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
 * - GitHub-style "N hidden lines" decorations between hunks with chunked and
 *   full-block expansion controls (only when oldContent is available for
 *   context line lookup).
 * - Global collapse/expand synced from uiStore.
 */
import React, {
  useMemo,
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
  getRenderedDiffStats,
} from "@utils/rdvAdapter";
import {
  normalizeStructuredPatch,
  countStructuredPatchDisplayLines,
} from "@utils/outputUtils";
import {
  injectSyntaxHighlightStyles,
  normalizeSyntaxLanguage,
  refractor,
} from "@utils/syntaxHighlighting";
import { useUiStore } from "@store/uiStore";
import { useElementNarrow } from "@hooks/useElementNarrow";

const SIDE_BY_SIDE_THRESHOLD = 1024;
const HIDDEN_CONTEXT_CHUNK_LINES = 25;

// Ensure the shared VS Code-themed syntax styles are in <head>.
injectSyntaxHighlightStyles();

function formatHiddenLines(count: number): string {
  return `${count} hidden line${count === 1 ? "" : "s"}`;
}

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
  /** Syntax language inferred from the file path (e.g. "typescript") */
  language?: string;
  /**
   * When true the diff renders collapsed (summary header only).
   * Can be overridden per-instance by the user clicking the expand button.
   */
  globallyCollapsed: boolean;
  /**
   * Optional local reset version. Increment to force a re-sync to
   * `globallyCollapsed` without touching the global `diffResetVersion`.
   * Used by contexts (e.g. UndoChangesDialog) that manage their own
   * expand/collapse state independently of the output section.
   */
  localResetVersion?: number;
  /** Optional content rendered inline with the expand/collapse toggle */
  actionSlot?: React.ReactNode;
  /** Controlled collapsed state used by virtualized output rows. */
  collapsed?: boolean;
  /** Called when the user toggles collapse in controlled mode. */
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
}

export const DiffView: React.FC<DiffViewProps> = ({
  oldContent,
  newContent,
  structuredPatch,
  language,
  globallyCollapsed,
  localResetVersion,
  actionSlot,
  collapsed,
  onCollapsedChange,
  className = "",
}) => {
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const isControlled = collapsed !== undefined;
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(
    !globallyCollapsed
  );
  const isExpanded = isControlled ? !collapsed : uncontrolledExpanded;
  const hasExpandableSource = oldContent !== undefined;

  // Snap to global state whenever the global flag or either reset version changes.
  useEffect(() => {
    if (!isControlled) {
      setUncontrolledExpanded(!globallyCollapsed);
    }
  }, [globallyCollapsed, diffResetVersion, localResetVersion, isControlled]);

  const handleToggle = useCallback(() => {
    if (isControlled) {
      onCollapsedChange?.(isExpanded);
      return;
    }
    setUncontrolledExpanded((prev) => !prev);
  }, [isControlled, isExpanded, onCollapsedChange]);

  // Width tracking for split vs unified layout.
  const [narrowCallbackRef, isNarrow] = useElementNarrow<HTMLDivElement>(
    SIDE_BY_SIDE_THRESHOLD
  );
  const isWide = !isNarrow;
  const viewType = isWide ? "split" : "unified";

  const wrapperRef = useRef<HTMLDivElement>(null);
  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
      narrowCallbackRef(node);
    },
    [narrowCallbackRef]
  );

  // Derive estimated line count for summary badge (cheap, no diff computation).
  const estimatedLineCount = useMemo(() => {
    const normalizedPatch = normalizeStructuredPatch(structuredPatch);
    if (normalizedPatch.length > 0) {
      return countStructuredPatchDisplayLines(normalizedPatch);
    }
    if (oldContent !== undefined || newContent !== undefined) {
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

  // Expand hidden context for the gap between two consecutive hunks.
  const handleExpand = useCallback(
    (prevHunk: HunkData | null, nextHunk: HunkData, mode: "chunk" | "all") => {
      if (oldContent === undefined) return;
      const gapStart =
        prevHunk !== null ? prevHunk.oldStart + prevHunk.oldLines : 1;
      const gapEnd = nextHunk.oldStart;
      const expandEnd =
        mode === "all"
          ? gapEnd
          : Math.min(gapStart + HIDDEN_CONTEXT_CHUNK_LINES, gapEnd);
      const oldLineCount = oldContent.split("\n").length;
      if (gapStart > oldLineCount) {
        console.warn(
          `[DiffView] expand skipped: gapStart=${gapStart} exceeds oldContent lines=${oldLineCount}. ` +
            `oldContent may be a snippet rather than the full file.`
        );
        return;
      }
      setExpandedHunks((prev) =>
        expandFromRawCode(prev, oldContent, gapStart, expandEnd)
      );
    },
    [oldContent]
  );

  // Syntax highlighting + word-level edit marks via refractor (synchronous useMemo).
  const lang = normalizeSyntaxLanguage(language);
  const tokens = useMemo(() => {
    if (!expandedHunks.length) return null;
    try {
      const enhancers = [markEdits(expandedHunks)];
      if (lang && refractor.registered(lang)) {
        return tokenize(expandedHunks, {
          highlight: true,
          refractor,
          language: lang,
          oldSource: oldContent,
          enhancers,
        });
      }
      return tokenize(expandedHunks, { highlight: false, enhancers });
    } catch (error) {
      console.warn("[DiffView] syntax tokenization failed", error);
      return null;
    }
  }, [expandedHunks, lang, oldContent]);

  const minimapStats = useMemo(
    () => getRenderedDiffStats(expandedHunks, viewType),
    [expandedHunks, viewType]
  );

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const anchor = el.closest<HTMLElement>("[data-diff-anchor]");
    if (!anchor) return;

    anchor.setAttribute("data-diff-collapsed", isExpanded ? "false" : "true");
    anchor.setAttribute("data-diff-view-type", viewType);
    anchor.setAttribute(
      "data-diff-wrapper-width",
      String(Math.round(el.getBoundingClientRect().width * 100) / 100)
    );
    anchor.setAttribute(
      "data-diff-estimated-lines",
      String(estimatedLineCount)
    );
    anchor.setAttribute(
      "data-diff-rendered-rows",
      String(minimapStats.runs.reduce((sum, run) => sum + run.count, 0))
    );

    if (expandedHunks.length > 0) {
      anchor.setAttribute("data-diff-added-lines", String(minimapStats.added));
      anchor.setAttribute(
        "data-diff-removed-lines",
        String(minimapStats.removed)
      );
      anchor.setAttribute("data-diff-runs", JSON.stringify(minimapStats.runs));
      return;
    }

    anchor.removeAttribute("data-diff-added-lines");
    anchor.removeAttribute("data-diff-removed-lines");
    anchor.removeAttribute("data-diff-runs");
  }, [estimatedLineCount, isExpanded, expandedHunks.length, minimapStats, viewType]);

  if (!hasDiff) return null;

  return (
    <div ref={setWrapperRef} className={`my-2 ${className}`}>
      {/* Summary / toggle header */}
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={handleToggle}
          className="flex min-w-0 items-center gap-1.5 text-[length:var(--fp-output-font-size-xs)] text-description-fg hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 font-[inherit]"
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
        {actionSlot && (
          <div className="ml-auto flex shrink-0 items-center">{actionSlot}</div>
        )}
      </div>

      {/* Diff — only mounted when expanded and there are hunks */}
      {isExpanded && expandedHunks.length > 0 && (
        <div className="rounded-[3px] overflow-x-auto overflow-y-hidden border border-panel-border">
          <Diff
            viewType={viewType}
            diffType={diffType}
            hunks={expandedHunks}
            tokens={tokens}
            optimizeSelection={viewType === "split"}
          >
            {(hunks) =>
              hunks.reduce<React.ReactElement[]>((nodes, hunk, i) => {
                const prevHunk = i > 0 ? hunks[i - 1] : null;
                const collapsed =
                  prevHunk !== null
                    ? getCollapsedLinesCountBetween(prevHunk, hunk)
                    : 0;
                if (collapsed > 0) {
                  const hiddenLinesLabel = formatHiddenLines(collapsed);
                  const chunkSize = Math.min(
                    HIDDEN_CONTEXT_CHUNK_LINES,
                    collapsed
                  );
                  nodes.push(
                    <Decoration key={`gap-${i}-${hunk.oldStart}`}>
                      {hasExpandableSource ? (
                        <div className="flex w-full items-center justify-center gap-x-3 bg-diff-hidden-bg px-3 py-0.5 text-[length:var(--fp-output-font-size-xs)]">
                          <i className="codicon codicon-triangle-right text-description-fg" />
                          <button
                            type="button"
                            onClick={() =>
                              handleExpand(prevHunk, hunk, "chunk")
                            }
                            className="cursor-pointer border-none bg-transparent p-0 font-mono text-link-fg hover:text-link-active-fg"
                            title={
                              collapsed <= HIDDEN_CONTEXT_CHUNK_LINES
                                ? "Expand hidden lines"
                                : `Expand ${chunkSize} hidden lines`
                            }
                          >
                            {collapsed <= HIDDEN_CONTEXT_CHUNK_LINES
                              ? `Show ${hiddenLinesLabel}`
                              : `Show ${chunkSize} of ${hiddenLinesLabel}`}
                          </button>
                          {collapsed > HIDDEN_CONTEXT_CHUNK_LINES && (
                            <button
                              type="button"
                              onClick={() =>
                                handleExpand(prevHunk, hunk, "all")
                              }
                              className="cursor-pointer border-none bg-transparent p-0 font-mono text-description-fg hover:text-foreground"
                              title="Expand all hidden lines"
                            >
                              Show all
                            </button>
                          )}
                          <i className="codicon codicon-triangle-left text-description-fg" />
                        </div>
                      ) : (
                        <div
                          className="flex w-full items-center justify-center gap-x-2 bg-diff-hidden-bg px-3 py-0.5 font-mono text-[length:var(--fp-output-font-size-xs)] text-description-fg opacity-70"
                          title="Hidden lines can't be expanded because the original file content is unavailable for this diff."
                        >
                          {hiddenLinesLabel}
                        </div>
                      )}
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
