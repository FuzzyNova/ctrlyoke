import { useState, useEffect } from "react";

/**
 * React hook that tracks a CSS media query.
 *
 * - Reads `matchMedia` synchronously in the `useState` initializer so the
 *   first render already has the correct value (no flash of wrong layout).
 * - Subscribes to the `change` event which fires only when the match state
 *   crosses the threshold, so re-renders are minimal.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    // Sync in case the value changed between initial render and effect
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/**
 * Convenience hook: `true` when the viewport is below Tailwind's `sm`
 * breakpoint (640px).  Used to switch between mobile vertical stacking
 * and the desktop horizontal three-column layout.
 */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}

/**
 * Convenience hook: `true` when the viewport is below the project's custom
 * `xs` breakpoint (380px, `--breakpoint-xs` in `styles/globals.css`) — the width at which the
 * header already starts dropping non-actionable controls entirely. Reserve it
 * for the last round of concessions, after icon-only labels (`useIsMobile`)
 * have stopped being enough.
 */
export function useIsNarrowMobile(): boolean {
  return useMediaQuery("(max-width: 379px)");
}
