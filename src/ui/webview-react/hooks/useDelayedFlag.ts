import { useEffect, useState } from "react";

/**
 * Returns `true` only once `value` has stayed `true` for `delayMs`, and
 * `false` the moment it turns `false`. Used for progress indicators that
 * should appear only when a wait is long enough to notice, so work that
 * finishes within a frame or two never flashes them.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [isShown, setIsShown] = useState(false);

  useEffect(() => {
    if (!value) {
      setIsShown(false);
      return;
    }
    const timer = setTimeout(() => setIsShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return value && isShown;
}
