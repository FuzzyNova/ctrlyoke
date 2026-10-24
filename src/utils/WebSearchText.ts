import type { ToolResult, WebSearchData } from "../types/CliOutputTypes";
import { WEB_SEARCH_ACTIONS } from "../types/DashboardConstants";

/** Whether a web search event names anything to show: a query or a page. */
export function hasWebSearchTarget(data: WebSearchData): boolean {
  return !!data.query || !!data.url;
}

/** Canonical one-line label for a web search row, export and find. */
export function getWebSearchLabel(data: WebSearchData): string {
  switch (data.action) {
    case WEB_SEARCH_ACTIONS.OPEN_PAGE:
      return `Open page: ${data.url ?? data.query}`;
    case WEB_SEARCH_ACTIONS.FIND_IN_PAGE:
      return data.url
        ? `Find in page: "${data.query}" in ${data.url}`
        : `Find in page: "${data.query}"`;
    default:
      return `Web search: "${data.query}"`;
  }
}

/**
 * The result text followed by the sources it does not already quote. Some
 * harnesses report prose and a separate source list (Copilot, Antigravity),
 * some only sources (OpenCode), and some the whole text with its links inline.
 */
export function getWebSearchResultText(data: WebSearchData): string {
  const output = data.output?.trim() ?? "";
  const sources = (data.results ?? [])
    .filter((result) => !output.includes(result.url))
    .map((result) =>
      [result.title, result.url, result.snippet].filter(Boolean).join("\n")
    );
  if (sources.length === 0) return output;
  const sourceText = sources.join("\n\n");
  return output ? `${output}\n\nSources:\n${sourceText}` : sourceText;
}

/**
 * The search as a tool result, so the row reuses the tool-call result body.
 * Undefined while the search is still running.
 */
export function getWebSearchToolResult(
  data: WebSearchData
): ToolResult | undefined {
  if (data.success === undefined && !data.error) return undefined;
  // A harness that reports a failure as its result text would repeat it.
  const resultText = getWebSearchResultText(data);
  const output =
    resultText && resultText !== data.error?.trim() ? resultText : undefined;
  return {
    success: data.success ?? !data.error,
    ...(output ? { output } : {}),
    ...(data.error ? { error: data.error } : {}),
  };
}
