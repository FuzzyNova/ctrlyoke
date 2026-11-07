import { useRef, useCallback, useEffect } from "react";

export function getContextMenuOpener(
  currentTarget: EventTarget | null,
  target: EventTarget | null
): HTMLElement | null {
  const targetElement = target instanceof HTMLElement ? target : null;
  const targetButton = targetElement?.closest("button");
  if (targetButton) return targetButton;
  return currentTarget instanceof HTMLElement
    ? currentTarget.querySelector("button")
    : null;
}

/**
 * True for a `contextmenu` event raised by a touch long press (Android
 * Chrome fires one; iOS Safari does not). Elements that also spread
 * {@link useLongPress} handlers should ignore it, so the long press opens
 * their menu once and through one path. Chromium dispatches `contextmenu` as a
 * PointerEvent carrying `pointerType`.
 */
export function isTouchContextMenuEvent(event: MouseEvent): boolean {
  return (
    "pointerType" in event && (event as PointerEvent).pointerType === "touch"
  );
}

/** Pixels the touch point must travel before cancelling the long-press timer. */
const MOVE_THRESHOLD = 10;

/**
 * Detects a long press (press-and-hold) on touch devices — the standard mobile
 * equivalent of a right-click / context menu gesture.
 *
 * Returns touch event handlers to spread onto any element. After `delay` ms
 * without the finger moving or lifting, `callback` is invoked with the touch
 * coordinates so the caller can open a context menu at that position.
 *
 * If the finger moves more than MOVE_THRESHOLD pixels the timer is cancelled,
 * allowing normal scroll behaviour to proceed uninterrupted.
 *
 * Pass `null` or `undefined` as `callback` to disable — the returned handlers
 * become no-ops and are safe to spread unconditionally.
 *
 * Set `requireSelf = true` to only fire when the touch begins directly on the
 * element (not on a descendant). Useful for background containers where child
 * elements have their own long-press handlers.
 *
 * `shouldStart` vetoes arming the timer for a touch at the given point, for
 * touches that belong to a native gesture (such as grabbing a text-selection
 * handle) whose finger may never report a `touchmove`.
 */
export function useLongPress(
  callback:
    | ((x: number, y: number, opener: HTMLElement | null) => void)
    | null
    | undefined,
  delay = 500,
  requireSelf = false,
  shouldStart?: (x: number, y: number) => boolean
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      cancel();
      if (e.touches.length > 1) return;
      if (!callback) return;
      if (requireSelf && e.target !== e.currentTarget) return;
      const touch = e.touches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      if (shouldStart && !shouldStart(x, y)) return;
      const opener = getContextMenuOpener(e.currentTarget, e.target);
      startPosRef.current = { x, y };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startPosRef.current = null;
        callback(x, y, opener);
      }, delay);
    },
    [callback, cancel, delay, requireSelf, shouldStart]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (timerRef.current === null || !startPosRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startPosRef.current.x;
      const dy = touch.clientY - startPosRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        cancel();
      }
    },
    [cancel]
  );

  return {
    onTouchStart,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onTouchMove,
  };
}
