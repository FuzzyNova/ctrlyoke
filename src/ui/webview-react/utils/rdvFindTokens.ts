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
import type { DiffActiveMatchLocation } from "./rdvAdapter";
import {
  DIFF_MARK_TYPES,
  DIFF_SIDES,
  DIFF_TOKEN_TYPES,
} from "@root/types/DashboardConstants";

const FIND_MARK_TYPE = DIFF_MARK_TYPES.FIND;
const FIND_ACTIVE_MARK_TYPE = DIFF_MARK_TYPES.FIND_ACTIVE;

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
      type: DIFF_TOKEN_TYPES.MARK,
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
  if (token.type === DIFF_TOKEN_TYPES.MARK) return [token];
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

/** Sum of the text length a token (or its recursively nested children) renders. */
function getTokenTextLength(token: TokenNode): number {
  if (typeof token.value === "string") return token.value.length;
  if (token.children) {
    return token.children.reduce(
      (sum, child) => sum + getTokenTextLength(child),
      0
    );
  }
  return 0;
}

function promoteActiveMarkInNode(
  token: TokenNode,
  cursor: { pos: number },
  start: number,
  end: number
): TokenNode {
  if (
    token.type === DIFF_TOKEN_TYPES.MARK &&
    token.markType === FIND_MARK_TYPE
  ) {
    const length = getTokenTextLength(token);
    const tokenStart = cursor.pos;
    cursor.pos += length;
    if (tokenStart < end && tokenStart + length > start) {
      return { ...token, markType: FIND_ACTIVE_MARK_TYPE };
    }
    return token;
  }
  if (token.children) {
    return {
      ...token,
      children: token.children.map((child) =>
        promoteActiveMarkInNode(child, cursor, start, end)
      ),
    };
  }
  cursor.pos += getTokenTextLength(token);
  return token;
}

/**
 * Re-tags the single "find" mark token covering `[location.start,
 * location.end)` on `location`'s line with a distinct markType so
 * `renderDiffToken` in DiffView can render it as a `<mark data-find-active>`
 * — the element `revealActiveFindMatchInRow` looks for to scroll precisely to
 * the active occurrence instead of only the containing row.
 *
 * Must run after `markFindTokens` has already split that line's tokens on the
 * find query, since it walks existing "find" mark tokens rather than the raw
 * query text.
 */
export function applyActiveDiffMatch(
  tokens: HunkTokens | null | undefined,
  location: DiffActiveMatchLocation | null | undefined
): HunkTokens | null | undefined {
  if (!tokens || !location) return tokens;

  const sideLines = location.side === DIFF_SIDES.OLD ? tokens.old : tokens.new;
  const lineIndex = location.lineNumber - 1;
  const line = sideLines[lineIndex];
  if (!line) return tokens;

  const cursor = { pos: 0 };
  const updatedLine = line.map((token) =>
    promoteActiveMarkInNode(token, cursor, location.start, location.end)
  );
  const updatedSideLines = sideLines.map((existingLine, index) =>
    index === lineIndex ? updatedLine : existingLine
  );

  return {
    ...tokens,
    [location.side]: updatedSideLines,
  };
}
