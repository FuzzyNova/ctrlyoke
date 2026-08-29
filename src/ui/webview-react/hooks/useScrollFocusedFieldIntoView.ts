import { useEffect, type RefObject } from "react";
import { isEditableElement } from "@utils/domFocus";

/**
 * Scrolls the currently focused field back into view within `containerRef`
 * whenever the mobile on-screen keyboard opens (`visualViewport` "resize").
 *
 * Focusing a field runs the browser's default scroll-into-view against the
 * pre-keyboard layout. The container this hook watches is a `flex-1`
 * scrollable panel whose height only shrinks once the keyboard finishes
 * animating in — after that initial scroll already ran — so a field that was
 * visible at focus time can end up hidden below the new, shorter viewport
 * with nothing left to re-scroll it into view.
 *
 * CodeMirror-backed fields (AdditionalArgsEditor, BranchNameEditor,
 * ScriptCommandEditor, PermissionListEditor) already keep their own caret
 * visible inside their own internal scroller on this same event (see
 * `SingleLineCompletionEditor`/`CodeMirrorEditor`); that alone doesn't help
 * when the whole editor box — often a fixed, short height — sits outside the
 * panel's visible area, which is the gap this hook closes at the panel level
 * for every field type (native inputs included) in one place.
 */
export function useScrollFocusedFieldIntoView(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean
): void {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const handleResize = () => {
      const container = containerRef.current;
      const focused = document.activeElement;
      if (
        !container ||
        !(focused instanceof HTMLElement) ||
        !isEditableElement(focused) ||
        !container.contains(focused)
      ) {
        return;
      }
      focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, [active, containerRef]);
}
