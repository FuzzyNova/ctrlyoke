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
 * Hook that classifies a DOM element's content width into a discrete tier.
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
 * The tier — not the raw width — is what enters React state, so a resize only
 * re-renders when it actually crosses a boundary. That makes two requirements
 * of `resolveTier`: it must return a **primitive** (so React's `Object.is`
 * bail-out works) and it must be **referentially stable** (module-level
 * function or `useCallback`), since changing its identity re-measures.
 *
 * @param resolveTier  Maps an observed width to its tier.
 * @param initialTier  Tier assumed before the element is first measured.
 * @param deferWhile   When true, suppresses tier updates until it becomes
 *                     false, then applies the most recent observed width.
 *                     Useful for avoiding layout churn while a higher-priority
 *                     resize (e.g. a panel drag) is active.
 * @returns            A tuple of `[callbackRef, tier]`. Attach `callbackRef`
 *                     to the element you want to observe.
 */
export function useElementTier<
  Tier extends string | number | boolean,
  T extends HTMLElement = HTMLDivElement,
>(
  resolveTier: (width: number) => Tier,
  initialTier: Tier,
  deferWhile: boolean = false
): [RefCallback<T>, Tier] {
  const [tier, setTier] = useState<Tier>(initialTier);
  const disconnectRef = useRef<(() => void) | null>(null);
  const nodeRef = useRef<T | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const deferredWidthRef = useRef<number | null>(null);

  const applyWidth = useCallback(
    (width: number) => {
      lastWidthRef.current = width;
      deferredWidthRef.current = null;
      setTier(resolveTier(width));
    },
    [resolveTier]
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

  return [callbackRef, tier];
}

/**
 * Two-tier {@link useElementTier}: tracks whether an element's content width is
 * below a single threshold.
 *
 * @param threshold   Width in pixels below which the element is "narrow".
 *                    Defaults to {@link DEFAULT_THRESHOLD}.
 * @param deferWhile  See {@link useElementTier}.
 * @returns           A tuple of `[callbackRef, isNarrow]`.
 */
export function useElementNarrow<T extends HTMLElement = HTMLDivElement>(
  threshold: number = DEFAULT_THRESHOLD,
  deferWhile: boolean = false
): [RefCallback<T>, boolean] {
  const resolveNarrow = useCallback(
    (width: number) => width < threshold,
    [threshold]
  );
  return useElementTier<boolean, T>(resolveNarrow, false, deferWhile);
}
