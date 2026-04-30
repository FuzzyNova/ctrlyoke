import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Closes a dropdown when the user clicks outside its trigger and popup.
 *
 * Stabilises `refs` and `onClose` in refs so the effect only re-runs when
 * `isOpen` or `enabled` changes — avoids exhaustive-deps churn from inline
 * handlers or arrays recreated on every render.
 *
 * @param refs     Elements to treat as "inside" (trigger button + popup div).
 * @param isOpen   Whether the dropdown is currently open.
 * @param onClose  Callback invoked when a click outside is detected.
 * @param enabled  Pass `false` to disable the listener (e.g. inline mode).
 *                 Defaults to `true`.
 */
export function useClickOutside(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  isOpen: boolean,
  onClose: () => void,
  enabled: boolean = true
): void {
  const refsRef = useRef(refs);
  const onCloseRef = useRef(onClose);
  refsRef.current = refs;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen || !enabled) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (refsRef.current.every((r) => !r.current?.contains(target))) {
        onCloseRef.current();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, enabled]);
}
