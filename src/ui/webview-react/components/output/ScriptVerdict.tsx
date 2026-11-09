import { memo, useEffect } from "react";
import { type ScriptVerdict as ScriptVerdictData } from "@root/types/CtrlYokeTypes";
import {
  COMPARE_SOURCES,
  SCRIPT_VERDICT_OUTCOMES,
} from "@root/types/DashboardConstants";
import {
  formatComparison,
  formatComparisonSubject,
  resolveVerdictDisplay,
} from "@root/utils/ScriptComparison";
import {
  DEFAULT_COLLAPSED_OUTPUT_MAX_CHARS,
  DEFAULT_COLLAPSED_OUTPUT_MAX_LINES,
  buildCollapsedOutputPreview,
} from "@utils/outputTruncation";
import { highlightText, type RowFindDecoration } from "@utils/outputFind";
import { formatClockDuration, formatSpokenDuration } from "@utils/time";

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

function buildActualPreview(actual: string, expanded: boolean) {
  return buildCollapsedOutputPreview(actual, {
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
    const display = resolveVerdictDisplay(verdict);
    const expected = display.expected;
    const action = getActionLabel(verdict);
    const actualPreview = buildActualPreview(display.actual, expanded);
    const collapsedActual = actualPreview.visibleText.replace(/\s+/g, " ");
    const actualLabel = formatSummaryValue(
      collapsedActual || "∅",
      display.compareSource
    );
    // isEmpty/isNotEmpty carry no value, so the subject says it all.
    const collapsedExpected = display.expected;

    useEffect(() => {
      const activeActualMatch = actualFindMatches.find((match) => match.active);
      if (
        !expanded &&
        activeActualMatch &&
        activeActualMatch.end >
          buildActualPreview(display.actual, false).visibleText.length
      ) {
        onExpansionChange?.(true);
      }
    }, [
      actualFindMatches,
      display.actual,
      expanded,
      onExpansionChange,
      verdict,
    ]);

    if (!expanded) {
      return (
        <button
          type="button"
          className="block min-h-8 w-full min-w-0 whitespace-normal rounded-sm px-1 py-1 text-left text-(length:--cy-output-font-size-sm) wrap-anywhere"
          aria-expanded={false}
          aria-label={`${presentation.label} · ${getCompareLabel(verdict)} · ${actualLabel} · ${action} · ${formatSpokenDuration(verdict.durationMs)}`}
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
            · {formatClockDuration(verdict.durationMs)}
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
            · {formatClockDuration(verdict.durationMs)}
          </span>
        </button>
        <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-description-fg">Compare</dt>
          <dd className="min-w-0">{getCompareLabel(verdict)}</dd>
          {expected !== undefined && (
            <>
              <dt className="text-description-fg">Expected</dt>
              <dd className="min-w-0 wrap-break-word">
                {highlightText(expected, expectedFindMatches)}
              </dd>
            </>
          )}
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
