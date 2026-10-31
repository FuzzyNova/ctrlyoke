import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefCallback,
} from "react";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";

/**
 * Sub-pixel slack for the edge checks. `scrollTop` is fractional on scaled
 * displays, so a fully scrolled element can report `scrollHeight` a fraction
 * of a pixel past `scrollTop + clientHeight`.
 */
const EDGE_TOLERANCE_PX = 1;

/** Which directions a vertical scroll container can still scroll. */
export interface ScrollOverflowEdges {
  canScrollUp: boolean;
  canScrollDown: boolean;
}

/**
 * Tracks whether a vertical scroll container has hidden content above or
 * below its viewport, for drawing "more this way" affordances on a container
 * whose native scrollbar is hidden.
 *
 * Re-measures on scroll, and on resize of both the container (its viewport)
 * and its first child (the content, which grows when items are added without
 * the container itself changing size). Keep the content in a single wrapper
 * element for that second signal to work.
 *
 * Each direction is its own boolean state, so a scroll only re-renders when
 * an edge actually appears or disappears.
 *
 * @returns A tuple of `[callbackRef, edges]`. Attach `callbackRef` to the
 *          scroll container.
 */
export function useScrollOverflowEdges<
  T extends HTMLElement = HTMLDivElement,
>(): [RefCallback<T>, ScrollOverflowEdges] {
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const detachRef = useRef<(() => void) | null>(null);

  const callbackRef = useCallback((node: T | null) => {
    detachRef.current?.();
    detachRef.current = null;
    if (!node) {
      return;
    }

    const measure = () => {
      setCanScrollUp(node.scrollTop > EDGE_TOLERANCE_PX);
      setCanScrollDown(
        node.scrollTop + node.clientHeight <
          node.scrollHeight - EDGE_TOLERANCE_PX
      );
    };

    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const { observer, disconnect } =
      createAnimationFrameResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) {
      observer.observe(node.firstElementChild);
    }
    detachRef.current = () => {
      node.removeEventListener("scroll", measure);
      disconnect();
    };
  }, []);

  useEffect(() => () => detachRef.current?.(), []);

  return [callbackRef, { canScrollUp, canScrollDown }];
}
