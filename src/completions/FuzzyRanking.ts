import fuzzysort, { type SnapshotKeys } from "fuzzysort";

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

/**
 * A reusable, pre-indexed set of items for repeated queries against the same
 * list (e.g. the cached workspace file list). Building one prepares every
 * target once instead of on every keystroke.
 */
export interface FuzzyIndex<T> {
  readonly snapshot: SnapshotKeys<T>;
}

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

function weightedScore(scores: readonly { score: number }[]): number {
  let best = 0;
  scores.forEach(({ score }, index) => {
    const weighted = index === 0 ? score : score * SECONDARY_KEY_WEIGHT;
    if (weighted > best) {
      best = weighted;
    }
  });
  return best;
}

/**
 * Build a {@link FuzzyIndex} over `items` for repeated {@link rankIndexByFuzzyQuery}
 * calls. `keys[0]` is the primary field; later keys are down-weighted.
 */
export function buildFuzzyIndex<T>(
  items: readonly T[],
  keys: readonly FuzzyKey<T>[]
): FuzzyIndex<T> {
  return { snapshot: fuzzysort.snapshot(items, { keys }) };
}

/**
 * Items in `index` matching `query`, best match first. An empty query returns
 * nothing — callers own the unfiltered ordering. `limit` 0 means unlimited.
 */
export function rankIndexByFuzzyQuery<T>(
  query: string,
  index: FuzzyIndex<T>,
  limit = 0
): T[] {
  if (!query) {
    return [];
  }
  return fuzzysort
    .go(query, index.snapshot, {
      threshold: ANY_MATCH_THRESHOLD,
      limit,
      scoreFn: weightedScore,
    })
    .map((result) => result.obj);
}

/**
 * One-shot variant of {@link rankIndexByFuzzyQuery} for lists that change on
 * every query (e.g. workspace symbols) and so gain nothing from an index.
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
      scoreFn: weightedScore,
    })
    .map((result) => result.obj);
}
