/**
 * DiffView — lazy, collapsible diff renderer with async HLJS highlighting.
 *
 * Performance design:
 * - Collapsed (default): renders a single summary line. Zero DOM nodes for
 *   diff lines, zero HLJS calls — the main render path is O(1).
 * - Expanded: diff lines computed via useMemo (gated on expand), then HLJS
 *   runs in a useEffect so it never blocks the initial paint. Shows plain
 *   (un-highlighted) diff lines immediately and upgrades once HLJS finishes.
 */
import React, { useMemo, memo, useState, useEffect, useRef } from "react";
import {
  parseUnifiedDiff,
  generateDiffLines,
  type DiffLine,
} from "@utils/outputUtils";
import { highlightLines, injectHljsStyles } from "@utils/hljsUtils";
import { useUiStore } from "@store/uiStore";

// Ensure VS Code-themed HLJS stylesheet is in <head> (idempotent)
injectHljsStyles();

const DIFF_LINE_STYLES = {
  added: {
    bg: "bg-diff-added-bg",
    contentColor: "text-diff-added-fg",
    lineNumColor: "text-diff-added-fg opacity-80",
    prefix: "+ ",
  },
  removed: {
    bg: "bg-diff-removed-bg",
    contentColor: "text-diff-removed-fg",
    lineNumColor: "text-diff-removed-fg opacity-80",
    prefix: "- ",
  },
  context: {
    bg: "bg-transparent",
    contentColor: "text-diff-context-fg",
    lineNumColor: "",
    prefix: "  ",
  },
} as const;

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

  // When the global flag changes or the reset version is bumped (e.g. user clicks
  // "Expand all" / "Collapse all"), always snap to the global state.
  // diffResetVersion is included so the effect fires even when globallyCollapsed
  // doesn't change — e.g. diffsCollapsed is already false but the user manually
  // collapsed one diff and then clicks "Expand all" again.
  useEffect(() => {
    setIsExpanded(!globallyCollapsed);
  }, [globallyCollapsed, diffResetVersion]);

  const handleToggle = () => {
    setIsExpanded((prev) => !prev);
  };

  // Compute diff lines lazily — only when expanded.
  // This avoids running Diff.diffLines() (O(N*D)) and parseUnifiedDiff() for
  // every file edit at mount time.
  const diffLines = useMemo((): DiffLine[] => {
    if (!isExpanded) return [];
    if (structuredPatch && structuredPatch.length > 0) {
      return parseUnifiedDiff(structuredPatch);
    }
    if (oldContent && newContent) {
      return generateDiffLines(oldContent, newContent);
    }
    return [];
  }, [isExpanded, structuredPatch, oldContent, newContent]);

  // Derive a quick line-count estimate for the summary badge without computing
  // the full diff. For structured patches we count hunk lines; for full-file
  // pairs we just count the larger file.
  const estimatedLineCount = useMemo(() => {
    if (structuredPatch && structuredPatch.length > 0) {
      return structuredPatch.reduce((acc, h) => acc + h.lines.length, 0);
    }
    if (oldContent || newContent) {
      const oldLines = oldContent ? oldContent.split("\n").length : 0;
      const newLines = newContent ? newContent.split("\n").length : 0;
      return oldLines + newLines;
    }
    return 0;
  }, [structuredPatch, oldContent, newContent]);

  const hasDiff = estimatedLineCount > 0;

  // Ref on the wrapper div so we can traverse up to the diff anchor and
  // stamp data-diff-collapsed whenever expand/collapse state changes.
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Propagate actual collapse state to the nearest [data-diff-anchor] wrapper
  // so OutputSection's measurement can read the true state rather than
  // inferring it from rendered height.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const anchor = el.closest<HTMLElement>("[data-diff-anchor]");
    if (anchor) {
      anchor.setAttribute("data-diff-collapsed", isExpanded ? "false" : "true");
    }
  }, [isExpanded]);

  // Async HLJS highlighting — runs in useEffect so it never blocks the paint.
  // When diffLines changes (expand) we kick off highlighting and set the result
  // once it's done. Until then, plain (un-highlighted) text is shown.
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const highlightVersion = useRef(0); // prevents stale async result from landing

  useEffect(() => {
    if (diffLines.length === 0) {
      setHighlightedLines([]);
      return;
    }
    const version = ++highlightVersion.current;
    // Run HLJS in a macrotask so the browser can paint the un-highlighted
    // diff lines first, keeping the expand interaction responsive.
    const id = setTimeout(() => {
      const combined = diffLines.map((l) => l.content).join("\n");
      const result = highlightLines(combined, language);
      if (highlightVersion.current === version) {
        setHighlightedLines(result);
      }
    }, 0);
    return () => clearTimeout(id);
  }, [diffLines, language]);

  if (!hasDiff) return null;

  return (
    <div
      ref={wrapperRef}
      className={`my-2 ml-6 font-mono text-[length:var(--fp-output-font-size-sm)] ${className}`}
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

      {/* Diff lines — only mounted when expanded */}
      {isExpanded && diffLines.length > 0 && (
        <div className="rounded-[3px] overflow-x-auto overflow-y-hidden border border-vscode-border bg-vscode-bg">
          {diffLines.map((line, index) => {
            const styles =
              DIFF_LINE_STYLES[line.type] || DIFF_LINE_STYLES.context;
            const highlighted = highlightedLines[index] ?? "";

            return (
              <div
                key={index}
                className={`flex items-baseline whitespace-pre font-inherit leading-[1.4] py-px ${styles.bg}`}
              >
                <span
                  className={`inline-block w-10 text-right px-1.5 select-none text-[length:var(--fp-output-font-size-xs)] opacity-60 shrink-0 text-diff-line-num ${styles.lineNumColor}`}
                >
                  {line.type !== "added" ? line.oldLineNum : ""}
                </span>
                <span
                  className={`inline-block w-10 text-right px-1.5 select-none text-[length:var(--fp-output-font-size-xs)] opacity-60 shrink-0 text-diff-line-num border-r border-diff-line-num mr-2 ${styles.lineNumColor}`}
                >
                  {line.type !== "removed" ? line.newLineNum : ""}
                </span>
                <span className="flex-1 min-w-0 py-0.5 pr-2 overflow-visible whitespace-pre">
                  <span className={`font-bold ${styles.contentColor}`}>
                    {styles.prefix}
                  </span>
                  {highlighted ? (
                    <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                  ) : (
                    <span className={styles.contentColor}>{line.content}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Memo wrapper with display name for DevTools
export default memo(DiffView);
