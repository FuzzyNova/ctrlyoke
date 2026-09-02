/**
 * DiffView — collapsible diff renderer powered by react-diff-view.
 *
 * Layout:
 * - Wide panels (≥ 1024 px): side-by-side split view via viewType="split".
 * - Narrow panels (< 1024 px): classic unified inline view.
 *
 * Features:
 * - Syntax highlighting via refractor + tokenize(); large diffs render plain
 *   first, then add tokens during browser idle time.
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
import { getCollapsedLinesCountBetween } from "react-diff-view";
import type { HunkData, DiffType, RenderToken } from "react-diff-view";
import {
  applyDiffGapExpansionState,
  type DiffGapExpansionState,
} from "@utils/outputRenderUtils";
import { WebviewLog } from "@utils/logger";
import {
  toRdvHunks,
  toRdvFromContent,
  getRenderedDiffStats,
  locateActiveDiffMatch,
} from "@utils/rdvAdapter";
import {
  normalizeStructuredPatch,
  countStructuredPatchDisplayLines,
} from "@utils/outputUtils";
import {
  injectFindHighlightStyles,
  injectSyntaxHighlightStyles,
  normalizeSyntaxLanguage,
  refractor,
} from "@utils/syntaxHighlighting";
import { markFindTokens, applyActiveDiffMatch } from "@utils/rdvFindTokens";
import {
  OUTPUT_FIND_ACTIVE_ATTRIBUTE,
  OUTPUT_FIND_ACTIVE_CLASS,
} from "@utils/outputFind";
import { useUiStore } from "@store/uiStore";
import { useElementNarrow } from "@hooks/useElementNarrow";
import {
  DIFF_MARK_TYPES,
  DIFF_TOKEN_TYPES,
  DIFF_VIEW_TYPES,
  type DiffViewType,
} from "@root/types/DashboardConstants";

const SIDE_BY_SIDE_THRESHOLD = 1024;
const HIDDEN_CONTEXT_CHUNK_LINES = 25;
/**
 * Shared empty hunk list for the collapsed state. Must be a module constant,
 * not a `[]` literal — `baseHunks` is an effect dependency below, and a fresh
 * array each render re-fires that effect on every render.
 */
const EMPTY_HUNKS: HunkData[] = [];
const DEFER_DIFF_TOKENIZATION_LINE_THRESHOLD = 240;
const DEFER_DIFF_TOKENIZATION_TIMEOUT_MS = 900;

const DIFF_EXPANSION_MODES = {
  CHUNK: "chunk",
  ALL: "all",
} as const;

type IdleCallbackDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleCallbackDeadline) => void,
    options?: { timeout?: number }
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// Ensure the shared VS Code-themed syntax + find-highlight styles are in <head>.
injectSyntaxHighlightStyles();
injectFindHighlightStyles();

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
  /** Controlled hidden-gap expansion state keyed by base gap index. */
  expandedGaps?: DiffGapExpansionState;
  /** Called when the user expands hidden context in controlled mode. */
  onExpandGap?: (gapIndex: number, nextExpandedToLine: number) => void;
  /**
   * When provided, overrides the internal useElementNarrow split/unified
   * detection. Pass this from the parent that already knows the correct view
   * type (e.g. OutputSection's outputDiffViewType) to avoid the initial
   * wrong-viewType render that causes large height changes on first mount.
   */
  viewType?: DiffViewType;
  className?: string;
  /** Outer vertical margin. The default is part of virtualized row geometry. */
  outerMarginClassName?: string;
  /**
   * Pre-parsed react-diff-view hunks (e.g. from parseUnifiedDiffToFiles).
   * When provided, DiffView skips its own content/patch parsing and uses these
   * directly. diffType must also be provided when hunks is provided.
   */
  hunks?: HunkData[];
  /** Diff type to use alongside pre-parsed `hunks`. */
  diffType?: DiffType;
  /** "Find in output" query to highlight within rendered diff lines. */
  findQuery?: string;
  /** Whether `findQuery` matching is case-sensitive. */
  findCaseSensitive?: boolean;
  /**
   * Offset range of the currently active "Find in output" match within this
   * diff's searched text (`getStructuredPatchText` — the raw `structuredPatch`
   * lines flattened and joined with "\n"). When set, DiffView marks that exact
   * occurrence for precise scroll targeting and force-expands a collapsed diff
   * so the match can be found and scrolled to at all.
   */
  activeMatchRange?: { start: number; end: number } | null;
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
  expandedGaps,
  onExpandGap,
  viewType: viewTypeProp,
  className = "",
  outerMarginClassName = "my-2",
  hunks: externalHunks,
  diffType: externalDiffType,
  findQuery,
  findCaseSensitive = false,
  activeMatchRange,
}) => {
  const diffResetVersion = useUiStore((s) => s.diffResetVersion);
  const isControlled = collapsed !== undefined;
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    useState(!globallyCollapsed);
  const isExpanded = isControlled ? !collapsed : uncontrolledExpanded;
  const hasExpandableSource = oldContent !== undefined;

  // Snap to global state whenever the global flag or either reset version changes.
  useEffect(() => {
    if (!isControlled) {
      setUncontrolledExpanded(!globallyCollapsed);
    }
  }, [globallyCollapsed, diffResetVersion, localResetVersion, isControlled]);

  // Force-expand a collapsed diff that contains the active find match — its
  // content (and the mark `revealActiveFindMatchInRow` looks for) doesn't
  // exist in the DOM at all while collapsed, so navigation could never reveal
  // it otherwise. Declared after the "snap to global state" effect above so it
  // wins the mount-time ordering when both fire together (e.g. a collapsed
  // diff whose active match arrives on first render).
  useEffect(() => {
    if (!activeMatchRange || isExpanded) return;
    if (isControlled) {
      onCollapsedChange?.(false);
    } else {
      setUncontrolledExpanded(true);
    }
  }, [activeMatchRange, isExpanded, isControlled, onCollapsedChange]);

  const handleToggle = useCallback(() => {
    if (isControlled) {
      onCollapsedChange?.(isExpanded);
      return;
    }
    setUncontrolledExpanded((prev) => !prev);
  }, [isControlled, isExpanded, onCollapsedChange]);
  const [uncontrolledExpandedGaps, setUncontrolledExpandedGaps] = useState<
    Map<number, number>
  >(new Map());
  const activeExpandedGaps = expandedGaps ?? uncontrolledExpandedGaps;

  // Width tracking for split vs unified layout.
  // When viewTypeProp is provided (from a virtualized parent that already knows
  // the correct type), skip useElementNarrow entirely to avoid the initial
  // wrong-viewType render that causes large height changes on first mount.
  const [narrowCallbackRef, isNarrow] = useElementNarrow<HTMLDivElement>(
    SIDE_BY_SIDE_THRESHOLD
  );
  const isWide = !isNarrow;
  const viewType =
    viewTypeProp ?? (isWide ? DIFF_VIEW_TYPES.SPLIT : DIFF_VIEW_TYPES.UNIFIED);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const setWrapperRef = useCallback(
    (node: HTMLDivElement | null) => {
      (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
      // Skip the ResizeObserver when viewType is provided externally — the
      // internal isNarrow state would never affect viewType in that case, so
      // attaching the observer only causes unnecessary re-renders.
      if (!viewTypeProp) narrowCallbackRef(node);
    },
    [narrowCallbackRef, viewTypeProp]
  );

  // Derive estimated line count for summary badge (cheap, no diff computation).
  const estimatedLineCount = useMemo(() => {
    if (externalHunks !== undefined) {
      return externalHunks.reduce((sum, h) => sum + h.changes.length, 0);
    }
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
  }, [externalHunks, structuredPatch, oldContent, newContent]);

  const hasDiff = estimatedLineCount > 0;

  // Parse the source once so the collapsed header can show exact add/remove
  // counts. Rendering, gap expansion, and tokenization remain lazy below.
  const parsedDiff = useMemo((): {
    baseHunks: HunkData[];
    diffType: DiffType;
  } => {
    if (externalHunks !== undefined) {
      return {
        baseHunks: externalHunks,
        diffType: externalDiffType ?? "modify",
      };
    }
    const normalizedPatch = normalizeStructuredPatch(structuredPatch);
    if (normalizedPatch.length > 0) {
      return { baseHunks: toRdvHunks(normalizedPatch), diffType: "modify" };
    }
    if (oldContent !== undefined && newContent !== undefined) {
      const result = toRdvFromContent(oldContent, newContent);
      return { baseHunks: result.hunks, diffType: result.diffType };
    }
    return { baseHunks: [], diffType: "modify" };
  }, [
    externalHunks,
    externalDiffType,
    structuredPatch,
    oldContent,
    newContent,
  ]);

  const { baseHunks, diffType } = isExpanded
    ? parsedDiff
    : { baseHunks: EMPTY_HUNKS, diffType: parsedDiff.diffType };

  // Reset gap expansion whenever the underlying hunks change.
  //
  // Both halves of this matter, and dropping either reintroduces an infinite
  // render loop that exhausts the heap (it OOM'd the whole UI test suite):
  // `baseHunks` must keep a stable identity while collapsed (see EMPTY_HUNKS),
  // and the update must return the *same* Map when there is nothing to clear.
  // A fresh `new Map()` is never Object.is-equal to the previous state, so
  // React re-renders unconditionally — render → effect → setState → render.
  useEffect(() => {
    if (expandedGaps !== undefined) return;
    setUncontrolledExpandedGaps((previous) =>
      previous.size === 0 ? previous : new Map()
    );
  }, [baseHunks, expandedGaps]);

  // Auto-expand single-line gaps: a "show 1 hidden line" control takes as much
  // vertical space as the line itself, so just show it unconditionally.
  const effectiveExpandedGaps = useMemo((): DiffGapExpansionState => {
    if (!oldContent || baseHunks.length === 0) return activeExpandedGaps;
    let modified = false;
    const next = new Map(activeExpandedGaps);
    for (let i = 1; i < baseHunks.length; i++) {
      const hidden = getCollapsedLinesCountBetween(
        baseHunks[i - 1],
        baseHunks[i]
      );
      if (hidden === 1 && !next.has(i)) {
        next.set(i, baseHunks[i].oldStart);
        modified = true;
      }
    }
    return modified ? next : activeExpandedGaps;
  }, [activeExpandedGaps, baseHunks, oldContent]);

  const expandedHunks = useMemo(
    () =>
      applyDiffGapExpansionState(baseHunks, oldContent, effectiveExpandedGaps),
    [effectiveExpandedGaps, baseHunks, oldContent]
  );

  // Expand hidden context for the gap between two consecutive hunks.
  const handleExpand = useCallback(
    (
      gapIndex: number,
      prevHunk: HunkData | null,
      nextHunk: HunkData,
      mode: (typeof DIFF_EXPANSION_MODES)[keyof typeof DIFF_EXPANSION_MODES]
    ) => {
      if (oldContent === undefined) return;
      const gapStart =
        prevHunk !== null ? prevHunk.oldStart + prevHunk.oldLines : 1;
      const gapEnd = nextHunk.oldStart;
      const currentExpandedToLine =
        activeExpandedGaps.get(gapIndex) ?? gapStart;
      const nextExpandedToLine =
        mode === DIFF_EXPANSION_MODES.ALL
          ? gapEnd
          : Math.min(
              currentExpandedToLine + HIDDEN_CONTEXT_CHUNK_LINES,
              gapEnd
            );
      const oldLineCount = oldContent.split("\n").length;
      if (gapStart > oldLineCount) {
        WebviewLog.warn(
          `[DiffView] expand skipped: gapStart=${gapStart} exceeds oldContent lines=${oldLineCount}. ` +
            `oldContent may be a snippet rather than the full file.`
        );
        return;
      }
      if (expandedGaps === undefined) {
        setUncontrolledExpandedGaps((previous) => {
          const next = new Map(previous);
          next.set(gapIndex, nextExpandedToLine);
          return next;
        });
      }
      onExpandGap?.(gapIndex, nextExpandedToLine);
    },
    [activeExpandedGaps, expandedGaps, oldContent, onExpandGap]
  );

  const shouldDeferTokenization =
    isExpanded && estimatedLineCount >= DEFER_DIFF_TOKENIZATION_LINE_THRESHOLD;
  const [deferredTokenizationReady, setDeferredTokenizationReady] =
    useState(false);

  useEffect(() => {
    if (!shouldDeferTokenization) {
      setDeferredTokenizationReady(false);
      return;
    }

    let cancelled = false;
    const idleWindow = window as WindowWithIdleCallback;
    const markReady = () => {
      if (!cancelled) {
        setDeferredTokenizationReady(true);
      }
    };

    setDeferredTokenizationReady(false);
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(markReady, {
        timeout: DEFER_DIFF_TOKENIZATION_TIMEOUT_MS,
      });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(
      markReady,
      DEFER_DIFF_TOKENIZATION_TIMEOUT_MS
    );
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    estimatedLineCount,
    isExpanded,
    oldContent,
    shouldDeferTokenization,
    structuredPatch,
    newContent,
    activeExpandedGaps,
  ]);

  // Syntax highlighting + word-level edit marks via refractor (synchronous useMemo).
  const lang = normalizeSyntaxLanguage(language);
  const shouldComputeTokens =
    !shouldDeferTokenization || deferredTokenizationReady;
  // A structured patch can describe a later edit to a file that was already
  // changed earlier in the run, while oldContent is the attempt-start
  // workspace snapshot. Passing that stale source to react-diff-view makes it
  // rebuild token lines at the patch's line numbers from unrelated content,
  // so the painted diff no longer matches either the patch or find offsets.
  // Structured patches are already self-contained; tokenize their rendered
  // hunks directly. Raw old/new-content diffs still benefit from full-source
  // tokenization because their oldContent is the source used to create them.
  const tokenizationOldSource = structuredPatch?.length
    ? undefined
    : oldContent;
  const tokens = useMemo(() => {
    if (!expandedHunks.length || !shouldComputeTokens) return null;
    try {
      const enhancers = [markEdits(expandedHunks)];
      if (lang && refractor.registered(lang)) {
        return tokenize(expandedHunks, {
          highlight: true,
          refractor,
          language: lang,
          oldSource: tokenizationOldSource,
          enhancers,
        });
      }
      return tokenize(expandedHunks, { highlight: false, enhancers });
    } catch (error) {
      WebviewLog.warn("[DiffView] syntax tokenization failed", error);
      return null;
    }
  }, [expandedHunks, lang, shouldComputeTokens, tokenizationOldSource]);

  // Wrap find-query occurrences in `mark` tokens so they highlight inside the
  // rendered diff. react-diff-view's default token renderer paints `mark`
  // tokens via the `.diff-code-mark-find` style (no custom renderToken needed).
  const highlightedTokens = useMemo(
    () => markFindTokens(tokens, findQuery, findCaseSensitive),
    [tokens, findQuery, findCaseSensitive]
  );

  // Locate + re-tag the specific occurrence that's the active find match (as
  // opposed to just any occurrence of the query) so it renders as a real
  // `<mark data-find-active>` — see renderDiffToken below. This is what lets
  // `revealActiveFindMatchInRow` scroll to the exact match instead of only the
  // containing row, which is otherwise indistinguishable from any other match
  // in the same diff.
  const activeMatchLocation = useMemo(
    () =>
      activeMatchRange
        ? locateActiveDiffMatch(
            structuredPatch,
            activeMatchRange.start,
            activeMatchRange.end
          )
        : null,
    [activeMatchRange, structuredPatch]
  );
  const activeHighlightedTokens = useMemo(
    () => applyActiveDiffMatch(highlightedTokens, activeMatchLocation),
    [highlightedTokens, activeMatchLocation]
  );
  const renderDiffToken = useCallback<RenderToken>(
    (token, renderDefault, index) => {
      if (
        token.type === DIFF_TOKEN_TYPES.MARK &&
        token.markType === DIFF_MARK_TYPES.FIND_ACTIVE
      ) {
        return (
          <mark
            key={index}
            {...{ [OUTPUT_FIND_ACTIVE_ATTRIBUTE]: "true" }}
            className={`diff-code-mark ${OUTPUT_FIND_ACTIVE_CLASS}`}
          >
            {token.value}
          </mark>
        );
      }
      return renderDefault(token, index);
    },
    []
  );

  const minimapStats = useMemo(
    () => getRenderedDiffStats(expandedHunks, viewType),
    [expandedHunks, viewType]
  );

  const summaryStats = useMemo(
    () => getRenderedDiffStats(parsedDiff.baseHunks, viewType),
    [parsedDiff.baseHunks, viewType]
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
  }, [
    estimatedLineCount,
    isExpanded,
    expandedHunks.length,
    minimapStats,
    viewType,
  ]);

  if (!hasDiff) return null;

  return (
    <div
      ref={setWrapperRef}
      className={`${outerMarginClassName} ${className}`.trim()}
    >
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
        {(summaryStats.added > 0 || summaryStats.removed > 0) && (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-[length:var(--fp-output-font-size-xs)]"
            aria-label={`${summaryStats.added} lines added, ${summaryStats.removed} lines removed`}
          >
            {summaryStats.added > 0 && (
              <span className="text-minimap-diff-added">
                +{summaryStats.added}
              </span>
            )}
            {summaryStats.removed > 0 && (
              <span className="text-minimap-diff-removed">
                -{summaryStats.removed}
              </span>
            )}
          </span>
        )}
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
            tokens={activeHighlightedTokens}
            renderToken={renderDiffToken}
            optimizeSelection={viewType === DIFF_VIEW_TYPES.SPLIT}
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
                              handleExpand(i, prevHunk, hunk, "chunk")
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
                                handleExpand(
                                  i,
                                  prevHunk,
                                  hunk,
                                  DIFF_EXPANSION_MODES.ALL
                                )
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
