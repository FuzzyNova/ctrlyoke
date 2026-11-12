import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fallback for a missed `animationend` (the slide-out lasts 220ms), so a
 * drawer can never stay wedged mounted and leaving.
 */
const DRAWER_EXIT_FALLBACK_MS = 320;

/**
 * Slide-in/slide-out lifecycle for a view that slides over the workflow
 * dropdown's list (the run panel, the schedule panel). The drawer stays
 * mounted while it leaves so the slide-right exit is visible, and `onExited`
 * runs once it has finished, from `animationend` or the fallback timer.
 */
export function useDrawerTransition(onExited: () => void) {
  const [isLeaving, setIsLeaving] = useState(false);
  const [animateEntry, setAnimateEntry] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const clearFallback = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  /** Drops any transition without calling `onExited` (the dropdown closed). */
  const reset = useCallback(() => {
    clearFallback();
    setIsLeaving(false);
    setAnimateEntry(false);
  }, [clearFallback]);

  const finish = useCallback(() => {
    reset();
    onExitedRef.current();
  }, [reset]);

  /** Shows the drawer; `animate` slides it in (a lateral drill-in) rather than appearing with the dropdown. */
  const enter = useCallback(
    (animate: boolean) => {
      clearFallback();
      setIsLeaving(false);
      setAnimateEntry(animate);
    },
    [clearFallback]
  );

  const leave = useCallback(() => {
    setIsLeaving(true);
    clearFallback();
    timeoutRef.current = setTimeout(finish, DRAWER_EXIT_FALLBACK_MS);
  }, [clearFallback, finish]);

  const onAnimationEnd = useCallback(
    (event: React.AnimationEvent<HTMLElement>) => {
      if (event.target === event.currentTarget && isLeaving) finish();
    },
    [finish, isLeaving]
  );

  useEffect(() => clearFallback, [clearFallback]);

  const className = isLeaving
    ? "pointer-events-none animate-slide-out-right"
    : animateEntry
      ? "animate-slide-in-right"
      : "";

  return { isLeaving, className, enter, leave, reset, onAnimationEnd };
}
