import { useEffect, type RefObject } from "react";
import { isEditableElement } from "@utils/domFocus";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";

/**
 * Scrolls the currently focused field back into view within `containerRef`
 * once the mobile on-screen keyboard has actually finished shrinking it.
 *
 * This intentionally does NOT key off `visualViewport`'s "resize" event.
 * That event fires the moment the keyboard STARTS animating in — well
 * before the panel's own height changes. On iOS the actual shrink is driven
 * by React state (`useIosVisualViewportRootStyle` in App.tsx) committed
 * asynchronously in response to that same event, so a `scrollIntoView()`
 * run synchronously on "resize" races ahead of the real layout change and
 * finds nothing to scroll — the container is still its pre-keyboard size.
 *
 * Watching the container's own box with `ResizeObserver` instead ties the
 * scroll to the layout actually shrinking, whatever caused it (the iOS root
 * pin, or a browser honoring `interactive-widget=resizes-content` natively),
 * and fires only once there's really somewhere new to scroll into view.
 *
 * CodeMirror-backed fields (AdditionalArgsEditor, BranchNameEditor,
 * ScriptCommandEditor, PermissionListEditor) already keep their own caret
 * visible inside their own internal scroller (see
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
    const container = containerRef.current;
    if (!container) return;

    const { observer, disconnect } = createAnimationFrameResizeObserver(() => {
      const focused = document.activeElement;
      if (
        !(focused instanceof HTMLElement) ||
        !isEditableElement(focused) ||
        !container.contains(focused)
      ) {
        return;
      }
      focused.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    observer.observe(container);
    return disconnect;
  }, [active, containerRef]);
}
