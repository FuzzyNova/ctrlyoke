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
const RESIZE_ACTIVITY_WINDOW_MS = 150;

/**
 * Single source of truth for "how wide is this element".
 *
 * Every measurement site in {@link useElementTier} must go through this. An
 * earlier version mixed `getBoundingClientRect().width` (border box, used when
 * attaching the ref) with `ResizeObserverEntry.contentRect.width` (content
 * box, used in the observer). On an element with horizontal padding those two
 * disagree by exactly that padding, so any width landing inside the resulting
 * band resolved to one tier when the ref re-attached and the other when the
 * observer fired — and the two measurements fought each other every animation
 * frame, re-rendering the subtree ~60x/sec and breaking click hit-testing.
 */
function measureWidth(node: HTMLElement): number {
  return node.getBoundingClientRect().width;
}

/**
 * Hook that classifies a DOM element's width into a discrete tier.
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
 * @param resolveTier  Maps an observed width to its tier. The width is the
 *                     element's border box (see {@link measureWidth}).
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
        const initialWidth = measureWidth(node);
        if (deferWhile) {
          lastWidthRef.current = initialWidth;
          deferredWidthRef.current = initialWidth;
        } else {
          applyWidth(initialWidth);
        }

        // Deliberately ignores the entry's own rects and re-measures the
        // node, so this site cannot drift from the two above. The callback is
        // already deferred to an animation frame, so reading layout here is
        // safe and the value is the one the browser just computed.
        const { observer, disconnect } = createAnimationFrameResizeObserver(
          () => {
            const observed = nodeRef.current;
            if (!observed) {
              return;
            }
            const width = measureWidth(observed);
            if (deferWhile) {
              lastWidthRef.current = width;
              deferredWidthRef.current = width;
              return;
            }
            applyWidth(width);
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

    const liveWidth = measureWidth(node);
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
 * Reports whether an element's width changed recently.
 *
 * This deliberately observes the element itself instead of a particular
 * resize control. It therefore covers panel splitters, the host application's
 * panel edge, and outer viewport resizes through the same signal.
 */
export function useElementResizeActivity<
  T extends HTMLElement = HTMLDivElement,
>(): [RefCallback<T>, boolean] {
  const [isActive, setIsActive] = useState(false);
  const disconnectRef = useRef<(() => void) | null>(null);
  const nodeRef = useRef<T | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const markActivity = useCallback(
    (width: number) => {
      if (
        lastWidthRef.current !== null &&
        Math.abs(lastWidthRef.current - width) < 1
      ) {
        return;
      }
      lastWidthRef.current = width;
      setIsActive(true);
      clearSettleTimer();
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setIsActive(false);
      }, RESIZE_ACTIVITY_WINDOW_MS);
    },
    [clearSettleTimer]
  );

  const callbackRef = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      disconnectRef.current?.();
      disconnectRef.current = null;

      if (!node) {
        // A merged ref can briefly receive null when another ref in the
        // merge changes identity (useElementTier does this when deferWhile
        // flips). Keep the activity window alive across that handoff; the
        // timer is the settle signal, not ref detachment.
        lastWidthRef.current = null;
        return;
      }

      lastWidthRef.current = measureWidth(node);
      const observer = new ResizeObserver(() => {
        const observed = nodeRef.current;
        if (observed) {
          markActivity(measureWidth(observed));
        }
      });
      observer.observe(node);
      disconnectRef.current = () => observer.disconnect();
    },
    [markActivity]
  );

  useEffect(
    () => () => {
      disconnectRef.current?.();
      clearSettleTimer();
    },
    [clearSettleTimer]
  );

  return [callbackRef, isActive];
}

/**
 * Two-tier {@link useElementTier}: tracks whether an element's width is below
 * a single threshold.
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
