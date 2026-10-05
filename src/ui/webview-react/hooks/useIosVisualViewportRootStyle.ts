import { type CSSProperties, useEffect, useState } from "react";
import { isEditableElement, isEditableElementFocused } from "@utils/domFocus";
import { isIosDevice } from "@utils/platform";

export type IosVisualViewportRootStyle = CSSProperties & {
  "--safe-area-bottom"?: string;
};

/**
 * Emulates `interactive-widget=resizes-content` on iOS Safari (which doesn't
 * support it) by pinning the given root element to `visualViewport.height`
 * while an editable element is focused, so the mobile keyboard shrinks the
 * root's layout instead of the OS panning the page underneath it.
 *
 * Apply the returned style to any `fixed`/`position:fixed`-rooted tree that
 * needs this treatment. A `position: fixed; inset: 0` element (e.g. a
 * fullscreen modal portaled to `document.body`) is NOT automatically covered
 * by another element's use of this hook elsewhere in the DOM — each such root
 * needs its own instance, mirroring how `.safe-area-spacer` is reproduced
 * locally in every `fixed inset-0` overlay (see WorkspaceViewerModal,
 * OutputSection fullscreen, Modal size="full"). Multiple concurrent instances
 * are safe: each tracks its own scroll-lock state from the same pristine
 * saved values, so their lock/unlock calls stay consistent regardless of
 * mount order.
 */
export function useIosVisualViewportRootStyle(
  isMobile: boolean
): CSSProperties {
  const [rootStyle, setRootStyle] = useState<IosVisualViewportRootStyle>({});

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!isMobile || !isIosDevice() || !visualViewport) {
      setRootStyle({});
      return;
    }

    let frameId: number | null = null;
    let keyboardViewportActive = false;

    // Scroll lock. The bug this solves was a scroll-driven feedback loop:
    // iOS pans the layout viewport to reveal the focused editor (offsetTop
    // tracks scrollY), and `body { overflow: hidden }` does NOT stop it
    // (scrollY still ran to 510). Only taking the body out of the scroll flow
    // with `position: fixed` truly locks it. With scroll locked at 0, offsetTop
    // stays 0, so the root pin can use a constant `top: 0` — which also kills
    // the loop, since a constant style no longer reflows on every scroll event.
    const body = document.body;
    const html = document.documentElement;
    let scrollLocked = false;
    const savedBody = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      bottom: body.style.bottom,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    const savedHtmlOverflow = html.style.overflow;
    const rootContainer = document.getElementById("root");

    // iOS Safari reveals a focused input by setting the `scrollTop` of an
    // `overflow: hidden` ancestor (html / body / #root) — `overflow: hidden`
    // does NOT block this programmatic scroll, and `window.scrollTo` does NOT
    // reset it (that only touches the document scroll). While the root is
    // `position: fixed` the ancestor scroll is invisible, but on unlock the
    // root returns to normal flow and the leftover `scrollTop` shifts it up —
    // the "stays offset after close" bug. So reset the containers directly.
    const resetScrollContainers = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      html.scrollTop = 0;
      body.scrollTop = 0;
      if (rootContainer) {
        rootContainer.scrollTop = 0;
      }
    };

    const lockScroll = () => {
      if (scrollLocked) {
        return;
      }
      scrollLocked = true;
      resetScrollContainers();
      body.style.position = "fixed";
      body.style.top = "0";
      body.style.left = "0";
      body.style.right = "0";
      body.style.bottom = "0";
      body.style.width = "100%";
      body.style.overflow = "hidden";
      html.style.overflow = "hidden";
    };

    const unlockScroll = () => {
      if (!scrollLocked) {
        return;
      }
      scrollLocked = false;
      body.style.position = savedBody.position;
      body.style.top = savedBody.top;
      body.style.left = savedBody.left;
      body.style.right = savedBody.right;
      body.style.bottom = savedBody.bottom;
      body.style.width = savedBody.width;
      body.style.overflow = savedBody.overflow;
      html.style.overflow = savedHtmlOverflow;
      // The ancestor scrollTop that Safari set to reveal the input outlives the
      // fixed pin — reset it after restoring flow, or the root stays shifted.
      // Reset now, then again next frame: the root is still `position: fixed`
      // this tick (React clears its style asynchronously), so the ancestor has
      // no scroll height yet; the deferred pass runs once flow is restored.
      resetScrollContainers();
      requestAnimationFrame(resetScrollContainers);
    };

    const updateRootStyle = () => {
      frameId = null;

      const offsetTop = Math.max(0, visualViewport.offsetTop);
      const keyboardInset = Math.max(
        0,
        window.innerHeight - visualViewport.height - offsetTop
      );
      const viewportLooksKeyboardAdjusted = keyboardInset > 80 || offsetTop > 0;

      // Arming on focus alone (not focus AND a keyboard-adjusted viewport) is
      // deliberate — see handleFocusIn. Deactivation still waits for the
      // viewport to return to normal, so the pin survives the whole time the
      // keyboard is up even if focus moves to a non-editable element.
      const editableFocused = isEditableElementFocused();
      if (editableFocused) {
        keyboardViewportActive = true;
      } else if (!viewportLooksKeyboardAdjusted) {
        keyboardViewportActive = false;
      }

      if (!keyboardViewportActive) {
        unlockScroll();
        setRootStyle({});
        return;
      }

      // Lock the body out of the scroll flow so iOS can neither pan nor run the
      // reveal-the-input feedback loop, then pin the root to the top of the
      // (now unpannable) visual viewport. `top` is a CONSTANT 0, never
      // offsetTop: locking holds offsetTop at 0, and a constant style means
      // repeated scroll events don't reflow the root — which is what stopped
      // the runaway loop. `top`/height only (no transform) so fixed descendants
      // aren't trapped and no body background is exposed (the "black box").
      lockScroll();
      // iOS can still set `scrollTop` on an overflow:hidden ancestor after the
      // lock (its reveal-the-caret pass runs asynchronously). Re-assert 0 on
      // every viewport event: unlike changing the root's `top`, this does not
      // reflow the root, so it cannot restart the scroll→reflow→re-pan loop.
      resetScrollContainers();
      const nextStyle: IosVisualViewportRootStyle = {
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        width: "100%",
        height: `${Math.round(visualViewport.height)}px`,
        overflow: "hidden",
        "--safe-area-bottom": "0px",
      };

      setRootStyle((currentStyle) =>
        currentStyle.height === nextStyle.height &&
        currentStyle.position === nextStyle.position
          ? currentStyle
          : nextStyle
      );
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(updateRootStyle);
    };

    // Lock SYNCHRONOUSLY the moment an editable is focused — before the keyboard
    // animates in, and before the rAF-deferred style update runs. Waiting for
    // the visual viewport to look keyboard-adjusted (the `resize` event) leaves
    // a window in which iOS runs its own scroll-the-caret-into-view pass against
    // a still-scrollable document. The pan it establishes then outlives the pin,
    // which uses a constant `top: 0` and so paints the root off the top of the
    // visible area — the "tapping the editor scrolls the page to the bottom,
    // only the editor footer is left visible" bug. Locking first leaves iOS
    // nothing to scroll, so no pan is ever established.
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && isEditableElement(target)) {
        keyboardViewportActive = true;
        lockScroll();
      }
      scheduleUpdate();
    };

    scheduleUpdate();
    visualViewport.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("orientationchange", scheduleUpdate);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", scheduleUpdate);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      visualViewport.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("orientationchange", scheduleUpdate);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", scheduleUpdate);
      // Never leave the body locked if the hook tears down mid-keyboard.
      unlockScroll();
    };
  }, [isMobile]);

  return rootStyle;
}
