import { useState, useEffect, useRef, type RefObject } from "react";

/**
 * Default width threshold (in px) below which an element is considered "narrow".
 * Individual callers can override this.
 */
const DEFAULT_THRESHOLD = 380;

/**
 * Hook that tracks whether a DOM element's content width is below a threshold.
 *
 * Uses `ResizeObserver` so it reacts to panel resizes, not just viewport
 * changes. This is essential in a resizable-panels layout where individual
 * panels can shrink independently of the overall window width.
 *
 * @param threshold  Width in pixels below which the element is "narrow".
 *                   Defaults to {@link DEFAULT_THRESHOLD}.
 * @returns          A tuple of `[ref, isNarrow]`. Attach `ref` to the
 *                   outermost container element of the panel.
 */
export function useElementNarrow<T extends HTMLElement = HTMLDivElement>(
  threshold: number = DEFAULT_THRESHOLD
): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < threshold);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, isNarrow];
}
