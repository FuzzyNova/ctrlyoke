import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type RefCallback,
} from "react";
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
 * @param threshold   Width in pixels below which the element is "narrow".
 *                    Defaults to {@link DEFAULT_THRESHOLD}.
 * @param deferWhile  When true, suppresses narrow-state updates until it
 *                    becomes false, then applies the most recent observed
 *                    width. Useful for avoiding layout churn while a
 *                    higher-priority resize (e.g. a panel drag) is active.
 * @returns           A tuple of `[callbackRef, isNarrow]`. Attach `callbackRef`
 *                    to the element you want to observe.
 */
export function useElementNarrow<T extends HTMLElement = HTMLDivElement>(
  threshold: number = DEFAULT_THRESHOLD,
  deferWhile: boolean = false
): [RefCallback<T>, boolean] {
  const [isNarrow, setIsNarrow] = useState(false);
  const disconnectRef = useRef<(() => void) | null>(null);
  const nodeRef = useRef<T | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const deferredWidthRef = useRef<number | null>(null);

  const applyWidth = useCallback(
    (width: number) => {
      lastWidthRef.current = width;
      deferredWidthRef.current = null;
      setIsNarrow(width < threshold);
    },
    [threshold]
  );

  const callbackRef = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      // Disconnect the previous observer whenever the node changes.
      if (disconnectRef.current) {
        disconnectRef.current();
        disconnectRef.current = null;
      }

      if (node) {
        // Snapshot the current width immediately so the initial render is
        // correct before the first ResizeObserver callback fires.
        const initialWidth = node.getBoundingClientRect().width;
        applyWidth(initialWidth);

        const { observer, disconnect } = createAnimationFrameResizeObserver(
          (entries) => {
            for (const entry of entries) {
              const width = entry.contentRect.width;
              if (deferWhile) {
                deferredWidthRef.current = width;
                continue;
              }
              applyWidth(width);
            }
          }
        );
        observer.observe(node);
        disconnectRef.current = disconnect;
      }
    },
    [applyWidth, deferWhile]
  );

  useEffect(() => {
    if (deferWhile) {
      return;
    }

    const deferredWidth = deferredWidthRef.current;
    if (deferredWidth != null) {
      applyWidth(deferredWidth);
      return;
    }

    const node = nodeRef.current;
    if (!node) {
      return;
    }

    const liveWidth = node.getBoundingClientRect().width;
    if (
      lastWidthRef.current == null ||
      Math.abs(lastWidthRef.current - liveWidth) >= 1
    ) {
      applyWidth(liveWidth);
    }
  }, [applyWidth, deferWhile]);

  return [callbackRef, isNarrow];
}
