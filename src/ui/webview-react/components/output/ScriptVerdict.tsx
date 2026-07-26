import { memo, useEffect } from "react";
import type { ScriptVerdict as ScriptVerdictData } from "@root/types/CtrlYokeTypes";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
} from "@utils/outputTruncation";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";

interface ScriptVerdictProps {
  verdict: ScriptVerdictData;
  expanded: boolean;
  expectedFindMatches?: RowFindDecoration["matches"];
  actualFindMatches?: RowFindDecoration["matches"];
  actionFindMatches?: RowFindDecoration["matches"];
  onExpansionChange?: (expanded: boolean) => void;
}

function getCompareLabel(verdict: ScriptVerdictData): string {
  const actualSource =
    verdict.actualSource === "exitCode" ? "exit code" : verdict.actualSource;
  if (verdict.compareSource === "auto") {
    return `auto → ${actualSource}`;
  }
  return verdict.compareSource === "exitCode"
    ? "exitCode"
    : verdict.compareSource;
}

function getExpectedLabel(verdict: ScriptVerdictData): string {
  return verdict.expected ?? "exit code 0 (no `returns` set)";
}

function getMatchedByLabel(verdict: ScriptVerdictData): string {
  switch (verdict.matchRule) {
    case "numericGte":
      return "numeric ≥";
    case "exitCode":
      return "exit code";
    case "none":
      return "no match";
    default:
      return verdict.matchRule;
  }
}

function getOutcomePresentation(outcome: ScriptVerdictData["outcome"]): {
  icon: string;
  label: string;
  className: string;
} {
  switch (outcome) {
    case "passed":
      return {
        icon: "✔",
        label: "Passed",
        className: "text-indicator-success",
      };
    case "failed":
      return {
        icon: "✖",
        label: "Failed",
        className: "text-indicator-error",
      };
    case "errored":
      return {
        icon: "⚠",
        label: "Errored",
        className: "text-warning-fg",
      };
  }
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildActualPreview(verdict: ScriptVerdictData, expanded: boolean) {
  return buildCollapsedOutputPreview(verdict.actual, {
    expanded,
    maxLines: DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
    maxChars: DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  });
}

function getActionLabel(verdict: ScriptVerdictData): string {
  return verdict.actionDetail ?? verdict.action;
}

function formatSummaryValue(
  value: string,
  actualSource: ScriptVerdictData["actualSource"]
): string {
  return actualSource === "exitCode" || /^-?\d+(\.\d+)?$/.test(value)
    ? value
    : `"${value}"`;
}

export const ScriptVerdict = memo<ScriptVerdictProps>(
  ({
    verdict,
    expanded,
    expectedFindMatches = [],
    actualFindMatches = [],
    actionFindMatches = [],
    onExpansionChange,
  }) => {
    const presentation = getOutcomePresentation(verdict.outcome);
    const expected = getExpectedLabel(verdict);
    const action = getActionLabel(verdict);
    const actualPreview = buildActualPreview(verdict, expanded);
    const collapsedActual = actualPreview.visibleText.replace(/\s+/g, " ");
    const actualLabel = formatSummaryValue(
      collapsedActual || "∅",
      verdict.actualSource
    );
    const collapsedExpected =
      verdict.expected ??
      (verdict.actualSource === "exitCode" ? "0" : undefined);

    useEffect(() => {
      const activeActualMatch = actualFindMatches.find((match) => match.active);
      if (
        !expanded &&
        activeActualMatch &&
        activeActualMatch.end >
          buildActualPreview(verdict, false).visibleText.length
      ) {
        onExpansionChange?.(true);
      }
    }, [actualFindMatches, expanded, onExpansionChange, verdict]);

    if (!expanded) {
      return (
        <button
          type="button"
          className="flex min-h-8 w-full min-w-0 items-center gap-1 overflow-hidden rounded px-1 py-1 text-left text-[length:var(--fp-output-font-size-sm)]"
          aria-expanded={false}
          aria-label={`${presentation.label} · ${getCompareLabel(verdict)} · ${actualLabel} · ${action} · ${formatDuration(verdict.durationMs)}`}
          onClick={() => onExpansionChange?.(true)}
        >
          <span className={`shrink-0 font-semibold ${presentation.className}`}>
            {presentation.icon} {presentation.label}
          </span>
          <span className="shrink-0 text-description-fg">·</span>
          <span className="shrink-0 text-description-fg">
            {getCompareLabel(verdict)}
            {collapsedExpected != null &&
              verdict.actualSource !== "exitCode" && (
                <>
                  {" ~ "}
                  <span>
                    {highlightText(collapsedExpected, expectedFindMatches)}
                  </span>
                </>
              )}
          </span>
          {verdict.outcome === "errored" && verdict.error ? (
            <span className="min-w-0 truncate text-error-fg">
              · {verdict.error}
            </span>
          ) : (
            <>
              {verdict.actualSource === "exitCode" && (
                <span className="shrink-0 text-description-fg">
                  · expected{" "}
                  {highlightText(collapsedExpected ?? "0", expectedFindMatches)}
                </span>
              )}
              <span className="shrink-0 text-description-fg">· actual </span>
              <span className="min-w-0 truncate text-foreground">
                {highlightText(actualLabel, actualFindMatches)}
                {actualPreview.isTruncated ? "…" : ""}
              </span>
            </>
          )}
          <span className="shrink-0 text-description-fg">·</span>
          <span className="shrink-0 text-description-fg">
            {highlightText(action, actionFindMatches)}
          </span>
          <span className="shrink-0 text-description-fg">
            · {formatDuration(verdict.durationMs)}
          </span>
        </button>
      );
    }

    return (
      <div className="rounded border border-panel-border bg-sidebar-bg/30 px-2 py-2 text-[length:var(--fp-output-font-size-sm)]">
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-1 text-left"
          aria-expanded={true}
          onClick={() => onExpansionChange?.(false)}
        >
          <span className={`font-semibold ${presentation.className}`}>
            {presentation.icon} {presentation.label}
          </span>
          <span className="text-description-fg">
            · {formatDuration(verdict.durationMs)}
          </span>
        </button>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-description-fg">Compare</dt>
          <dd>{getCompareLabel(verdict)}</dd>
          <dt className="text-description-fg">Expected</dt>
          <dd className="min-w-0 break-words">
            {highlightText(expected, expectedFindMatches)}
          </dd>
          <dt className="text-description-fg">Actual</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">
            {highlightText(actualPreview.visibleText || "∅", actualFindMatches)}
          </dd>
          <dt className="text-description-fg">Matched by</dt>
          <dd>{getMatchedByLabel(verdict)}</dd>
          <dt className="text-description-fg">Result</dt>
          <dd>
            {presentation.label}
            {verdict.timedOut ? " (timed out)" : ""}
          </dd>
          <dt className="text-description-fg">Action</dt>
          <dd>{highlightText(action, actionFindMatches)}</dd>
          {verdict.error && (
            <>
              <dt className="text-description-fg">Error</dt>
              <dd className="min-w-0 break-words text-error-fg">
                {verdict.error}
              </dd>
            </>
          )}
        </dl>
      </div>
    );
  }
);

ScriptVerdict.displayName = "ScriptVerdict";
