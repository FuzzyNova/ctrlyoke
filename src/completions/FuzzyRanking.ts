import fuzzysort, { type KeysResult } from "fuzzysort";

/**
 * Shared fuzzy matching/ranking for every completion source (files, symbols,
 * secrets, keywords, path suggestions), backed by fuzzysort so all of them
 * agree on what "matches" means: the query's characters appear in order,
 * case-insensitively, anywhere in the candidate (`codeeditor` →
 * `CodeMirrorEditor.tsx`, `usecontext` → `useFinalStepContextMenu`), with
 * word-start, contiguous and early matches scoring higher.
 */

/**
 * fuzzysort's own default threshold (0.5) silently drops legitimate gapped
 * matches on long names — `usecontext` scores ~0.7 against
 * `useFinalStepContextMenu`, `cme` only ~0.3 against a deep path — so keep
 * every in-order match and let the ranking push weak ones to the bottom.
 */
const ANY_MATCH_THRESHOLD = 0;

/**
 * A match on a secondary key (e.g. the full path, when the primary key is the
 * basename) counts for less, so `editor` ranks `CodeMirrorEditor.tsx` above an
 * unrelated file that merely lives under `components/editor/`.
 */
const SECONDARY_KEY_WEIGHT = 0.9;

/** One searchable field of a ranked item; the first key is the primary one. */
export type FuzzyKey<T> = (item: T) => string;

/** True when `query` fuzzily matches `candidate` (an empty query matches everything). */
export function fuzzyMatches(candidate: string, query: string): boolean {
  if (!query) {
    return true;
  }
  return fuzzysort.single(query, candidate) !== null;
}

/**
 * The characters of `text` that `query` fuzzily matches, as a flat list of
 * `[from, to, from, to, ...]` half-open ranges (adjacent matched characters
 * merged) — the shape CodeMirror's `CompletionResult.getMatch` expects for
 * highlighting. Empty when the query is empty or doesn't match.
 */
export function fuzzyMatchRanges(text: string, query: string): number[] {
  const match = query ? fuzzysort.single(query, text) : null;
  if (!match) {
    return [];
  }

  const ranges: number[] = [];
  for (const index of [...match.indexes].sort((a, b) => a - b)) {
    if (ranges.length > 0 && ranges[ranges.length - 1] === index) {
      ranges[ranges.length - 1] = index + 1;
    } else {
      ranges.push(index, index + 1);
    }
  }
  return ranges;
}

/**
 * The largest fraction an item's position may lower its score. fuzzysort
 * orders equal scores arbitrarily, so without this an exact basename match
 * repeated across many directories (`SKILL.md` in every downloaded VS Code
 * build) came back in no particular order. The adjustment is multiplicative
 * because fuzzysort drops a zero score, and far too small to reorder matches
 * whose scores really differ.
 */
const ORDER_TIEBREAK_SPAN = 1e-6;

/** Score one fuzzysort multi-key result using the shared secondary-key weight. */
export function scoreFuzzyMatch(result: KeysResult<unknown>): number {
  let best = 0;
  result.forEach(({ score }, index) => {
    const weighted = index === 0 ? score : score * SECONDARY_KEY_WEIGHT;
    if (weighted > best) {
      best = weighted;
    }
  });
  return best;
}

/** Score one item against a query across ordered keys; the first key is primary. */
export function scoreFuzzyQuery<T>(
  query: string,
  item: T,
  keys: readonly FuzzyKey<T>[]
): number | undefined {
  if (!query) return undefined;
  const result = fuzzysort.go(query, [item], {
    keys,
    threshold: ANY_MATCH_THRESHOLD,
    scoreFn: scoreFuzzyMatch,
  })[0];
  return result ? fuzzysort.score(result) : undefined;
}

/** {@link weightedScore}, with equal scores ranked in the order of `items`. */
function orderedScoreFn<T>(
  items: readonly T[]
): (result: KeysResult<T>) => number {
  const order = new Map<T, number>();
  items.forEach((item, position) => order.set(item, position));
  const step = ORDER_TIEBREAK_SPAN / Math.max(1, items.length);
  return (result) =>
    scoreFuzzyMatch(result) * (1 - (order.get(result.obj) ?? 0) * step);
}

/**
 * Rank a list for one query. Large, changing workspace file sets use the
 * dedicated worker query engine instead of preparing a duplicate fuzzy index.
 * Equal scores rank in the order of `items`.
 */
export function rankByFuzzyQuery<T>(
  query: string,
  items: readonly T[],
  keys: readonly FuzzyKey<T>[],
  limit = 0
): T[] {
  if (!query) {
    return [];
  }
  return fuzzysort
    .go(query, items, {
      keys,
      threshold: ANY_MATCH_THRESHOLD,
      limit,
      scoreFn: orderedScoreFn(items),
    })
    .map((result) => result.obj);
}
