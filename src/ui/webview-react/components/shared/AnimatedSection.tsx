import React, { useState, useRef, useEffect, useCallback } from "react";

const ANIMATION_DURATION_MS = 300;

/**
 * AnimatedSection — mounts/unmounts children with a slide-down animation.
 *
 * When `visible` changes to `true`, children appear immediately with a
 * slide-down-fade-in animation. When `visible` changes to `false`, the
 * component plays a slide-down-fade-out animation before actually unmounting,
 * giving the user a smooth visual cue.
 */
export const AnimatedSection: React.FC<{
  visible: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({ visible, children, className }) => {
  const [rendering, setRendering] = useState(visible);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // When visibility changes, manage the mount/unmount animation cycle
  useEffect(() => {
    if (visible) {
      // Opening: render immediately, play slide-in animation. Cancel any
      // in-flight close timer first — reopening before a previous close
      // finished would otherwise let that timer unmount the now-visible
      // content (and leave it unmounted until `visible` changes again).
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setClosing(false);
      setRendering(true);
    } else {
      // Closing: play slide-out animation first, then unmount
      setClosing(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setRendering(false);
        setClosing(false);
      }, ANIMATION_DURATION_MS);
    }
  }, [visible]);

  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      // Animation already handled by the useEffect timeout; this is a safety net
      // in case the CSS animation ends before the timer fires.
      if (timerRef.current) clearTimeout(timerRef.current);
      setRendering(false);
      setClosing(false);
    }
  }, [closing]);

  if (!rendering) return null;

  return (
    <div
      className={[
        "grid animate-slide-down-in",
        closing && "animate-slide-down-out",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  );
};
