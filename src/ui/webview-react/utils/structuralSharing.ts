/**
 * Structural sharing for extension-fed store state.
 *
 * Snapshot replays (`RUN_VIEW_LOADED` and friends) deliver freshly parsed
 * objects whose content is usually identical to what the store already holds.
 * Writing those fresh objects verbatim gives every array/object a new identity,
 * which defeats the memoization chain that keeps the output pane stable
 * (`useOutputRowsModel` → `buildOutputRows` → `OutputRow`/`CliOutput` memos)
 * and forces a full re-render of already-rendered rows and diffs.
 *
 * `preserveReferences(prev, next)` returns `next` with every subtree that is
 * deep-equal to the corresponding subtree of `prev` replaced by the `prev`
 * reference — returning `prev` itself when the whole value is equal. Consumers
 * relying on reference equality (React memo, useMemo deps, Zustand selectors)
 * then see no change for unchanged data.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively reuse references from `prev` wherever `next` is deep-equal.
 * Only plain objects and arrays are merged (store data is JSON-shaped);
 * class instances, Maps, etc. are returned from `next` as-is.
 */
export function preserveReferences<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;

  if (Array.isArray(prev) && Array.isArray(next)) {
    // reusablePrev: every item resolved to prev's item → return prev itself.
    // untouchedNext: no item borrowed a prev reference → return next as-is.
    let reusablePrev = prev.length === next.length;
    let untouchedNext = true;
    const merged = next.map((item, index) => {
      const preserved =
        index < prev.length ? preserveReferences(prev[index], item) : item;
      if (index >= prev.length || preserved !== prev[index]) {
        reusablePrev = false;
      }
      if (preserved !== item) {
        untouchedNext = false;
      }
      return preserved;
    });
    if (reusablePrev) return prev as unknown as T;
    if (untouchedNext) return next;
    return merged as unknown as T;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let reusablePrev = Object.keys(prev).length === nextKeys.length;
    let untouchedNext = true;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const nextValue = (next as Record<string, unknown>)[key];
      const hasKey = Object.prototype.hasOwnProperty.call(prev, key);
      const preserved = hasKey
        ? preserveReferences(prev[key], nextValue)
        : nextValue;
      merged[key] = preserved;
      if (!hasKey || preserved !== prev[key]) {
        reusablePrev = false;
      }
      if (preserved !== nextValue) {
        untouchedNext = false;
      }
    }
    if (reusablePrev) return prev as T;
    if (untouchedNext) return next;
    return merged as T;
  }

  return next;
}
