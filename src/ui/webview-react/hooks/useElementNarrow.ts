import { useState, useCallback, useRef, type RefCallback } from "react";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";

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
 * Returns a **callback ref** rather than a `useRef` object. This ensures the
 * `ResizeObserver` is re-attached whenever the element mounts or remounts
 * (e.g. after a collapsible panel is expanded). With a plain `useRef` the
 * observer would silently stop working after the first collapse/expand cycle
 * because `useEffect` only re-runs on dependency changes, not when
 * `ref.current` changes.
 *
 * @param threshold  Width in pixels below which the element is "narrow".
 *                   Defaults to {@link DEFAULT_THRESHOLD}.
 * @returns          A tuple of `[callbackRef, isNarrow]`. Attach `callbackRef`
 *                   to the element you want to observe.
 */
export function useElementNarrow<T extends HTMLElement = HTMLDivElement>(
  threshold: number = DEFAULT_THRESHOLD
): [RefCallback<T>, boolean] {
  const [isNarrow, setIsNarrow] = useState(false);
  const disconnectRef = useRef<(() => void) | null>(null);

  const callbackRef = useCallback(
    (node: T | null) => {
      // Disconnect the previous observer whenever the node changes.
      if (disconnectRef.current) {
        disconnectRef.current();
        disconnectRef.current = null;
      }

      if (node) {
        // Snapshot the current width immediately so the initial render is
        // correct before the first ResizeObserver callback fires.
        setIsNarrow(node.getBoundingClientRect().width < threshold);

        const { observer, disconnect } = createAnimationFrameResizeObserver(
          (entries) => {
          for (const entry of entries) {
            setIsNarrow(entry.contentRect.width < threshold);
          }
          }
        );
        observer.observe(node);
        disconnectRef.current = disconnect;
      }
    },
    [threshold]
  );

  return [callbackRef, isNarrow];
}
