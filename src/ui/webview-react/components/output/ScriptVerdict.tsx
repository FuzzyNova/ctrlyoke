import { memo, useEffect } from "react";
import {
  DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT,
  type ScriptVerdict as ScriptVerdictData,
} from "@root/types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  SCRIPT_VERDICT_OUTCOMES,
} from "@root/types/DashboardConstants";
import {
  formatComparison,
  formatComparisonSubject,
  operatorTakesNoValue,
} from "@root/utils/ScriptComparison";
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
  return formatComparison(verdict);
}

function getExpectedLabel(verdict: ScriptVerdictData): string {
  return verdict.expected ?? DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT;
}

function getOutcomePresentation(outcome: ScriptVerdictData["outcome"]): {
  icon: string;
  label: string;
  className: string;
} {
  switch (outcome) {
    case SCRIPT_VERDICT_OUTCOMES.PASSED:
      return {
        icon: "✔",
        label: "Passed",
        className: "text-indicator-success",
      };
    case SCRIPT_VERDICT_OUTCOMES.FAILED:
      return {
        icon: "✖",
        label: "Failed",
        className: "text-indicator-error",
      };
    case SCRIPT_VERDICT_OUTCOMES.ERRORED:
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
  compareSource: ScriptVerdictData["compareSource"]
): string {
  return compareSource === COMPARE_SOURCES.EXIT_CODE ||
    /^-?\d+(\.\d+)?$/.test(value)
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
      verdict.compareSource
    );
    // isEmpty/isNotEmpty carry no value, so the subject says it all.
    const collapsedExpected = operatorTakesNoValue(verdict.operator)
      ? undefined
      : (verdict.expected ?? "0");

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
          className="block min-h-8 w-full min-w-0 whitespace-normal rounded-sm px-1 py-1 text-left text-(length:--cy-output-font-size-sm) wrap-anywhere"
          aria-expanded={false}
          aria-label={`${presentation.label} · ${getCompareLabel(verdict)} · ${actualLabel} · ${action} · ${formatDuration(verdict.durationMs)}`}
          onClick={() => onExpansionChange?.(true)}
        >
          <span className={`font-semibold ${presentation.className}`}>
            {presentation.icon} {presentation.label}
          </span>{" "}
          <span className="text-description-fg">
            · {formatComparisonSubject(verdict)}
            {collapsedExpected != null && (
              <>
                {" "}
                <span>
                  {highlightText(collapsedExpected, expectedFindMatches)}
                </span>
              </>
            )}
          </span>
          {verdict.outcome === SCRIPT_VERDICT_OUTCOMES.ERRORED &&
          verdict.error ? (
            <>
              {" "}
              <span className="text-error-fg">· {verdict.error}</span>
            </>
          ) : (
            <>
              {" "}
              <span className="text-description-fg">
                · actual{" "}
                <span className="text-foreground">
                  {highlightText(actualLabel, actualFindMatches)}
                  {actualPreview.isTruncated ? "…" : ""}
                </span>
              </span>
            </>
          )}{" "}
          <span className="text-description-fg">
            · {highlightText(action, actionFindMatches)}
          </span>{" "}
          <span className="text-description-fg">
            · {formatDuration(verdict.durationMs)}
          </span>
        </button>
      );
    }

    return (
      <div className="min-w-0 rounded-sm border border-panel-border bg-sidebar-bg/30 px-2 py-2 text-(length:--cy-output-font-size-sm) wrap-anywhere">
        <button
          type="button"
          className="mb-2 flex w-full min-w-0 flex-wrap items-center gap-1 text-left"
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
        <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-description-fg">Compare</dt>
          <dd className="min-w-0">{getCompareLabel(verdict)}</dd>
          <dt className="text-description-fg">Expected</dt>
          <dd className="min-w-0 wrap-break-word">
            {highlightText(expected, expectedFindMatches)}
          </dd>
          <dt className="text-description-fg">Actual</dt>
          <dd className="min-w-0 whitespace-pre-wrap wrap-break-word">
            {highlightText(actualPreview.visibleText || "∅", actualFindMatches)}
          </dd>
          <dt className="text-description-fg">Result</dt>
          <dd className="min-w-0">
            {presentation.label}
            {verdict.timedOut ? " (timed out)" : ""}
          </dd>
          <dt className="text-description-fg">Action</dt>
          <dd className="min-w-0">
            {highlightText(action, actionFindMatches)}
          </dd>
          {verdict.error && (
            <>
              <dt className="text-description-fg">Error</dt>
              <dd className="min-w-0 wrap-break-word text-error-fg">
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
