/**
 * "Find in output" highlighting for react-diff-view token trees.
 *
 * react-diff-view's `tokenize()` produces a `{ old, new }` structure where each
 * side is an array of lines, each line an array of tokens. A token is either a
 * text leaf (`{ type: "text" | <syntax>, value }`) or a container with
 * `children` (e.g. the `edit` tokens produced by the `markEdits` enhancer).
 *
 * `markFindTokens()` walks that tree and splits any text leaf whose value
 * contains the find query into surrounding text tokens plus `{ type: "mark",
 * markType: "find" }` tokens. react-diff-view's `defaultRenderToken` renders
 * `mark` tokens natively as `<span class="diff-code-mark diff-code-mark-find">`
 * (recursing into `children`), so no custom `renderToken` prop is needed — only
 * the `.diff-code-mark-find` style injected by `injectFindHighlightStyles()`.
 *
 * Matching mirrors the plain-text find pass (case-insensitive by default,
 * simple substring). Like the syntax `markEdits` enhancer, matches that span
 * two adjacent tokens (e.g. across a syntax-highlight boundary) are not marked.
 */

import type { HunkTokens, TokenNode } from "react-diff-view";

const FIND_MARK_TYPE = "find";

function splitTokenValue(
  token: TokenNode,
  query: string,
  caseSensitive: boolean
): TokenNode[] {
  const value = token.value;
  if (typeof value !== "string") return [token];

  const haystack = caseSensitive ? value : value.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!haystack.includes(needle)) return [token];

  const result: TokenNode[] = [];
  let cursor = 0;
  let matchIndex = haystack.indexOf(needle);
  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      result.push({ ...token, value: value.slice(cursor, matchIndex) });
    }
    result.push({
      type: "mark",
      markType: FIND_MARK_TYPE,
      value: value.slice(matchIndex, matchIndex + needle.length),
    });
    cursor = matchIndex + needle.length;
    matchIndex = haystack.indexOf(needle, cursor);
  }
  if (cursor < value.length) {
    result.push({ ...token, value: value.slice(cursor) });
  }
  return result;
}

function splitToken(
  token: TokenNode,
  query: string,
  caseSensitive: boolean
): TokenNode[] {
  if (token.children) {
    return [
      {
        ...token,
        children: token.children.flatMap((child) =>
          splitToken(child, query, caseSensitive)
        ),
      },
    ];
  }
  // Leave existing mark tokens (e.g. from other enhancers) untouched.
  if (token.type === "mark") return [token];
  return splitTokenValue(token, query, caseSensitive);
}

/**
 * Returns a new token tree with find-query occurrences wrapped in `mark`
 * tokens. Returns the input unchanged when there is no query or no tokens.
 */
export function markFindTokens(
  tokens: HunkTokens | null | undefined,
  query: string | undefined,
  caseSensitive: boolean
): HunkTokens | null | undefined {
  if (!tokens || !query) return tokens;

  const markLine = (line: TokenNode[]): TokenNode[] =>
    line.flatMap((token) => splitToken(token, query, caseSensitive));

  return {
    old: tokens.old.map(markLine),
    new: tokens.new.map(markLine),
  };
}
