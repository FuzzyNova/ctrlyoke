/** Default panel animation duration — mirrors the fallback in globals.css. */
export const PANEL_ANIMATION_DURATION_MS = 200;

export interface PanelAnimationOptions {
  /** Duration in ms; defaults to `PANEL_ANIMATION_DURATION_MS`. */
  durationMs?: number;
  /** CSS timing function; defaults to the stylesheet's `ease-in-out`. */
  easing?: string;
}

/** Cancels a pending teardown so overlapping animations can't cut each other short. */
let animationToken = 0;

/**
 * Briefly enables the grow CSS transition on all [data-panel] elements.
 *
 * The transition is intentionally disabled by default so that panels don't
 * animate during initial mount, window resize, or drag interactions. Call
 * this immediately before any explicit user-triggered collapse/expand action
 * to get a smooth animation for that specific interaction only.
 *
 * Pass `durationMs`/`easing` when the resize has to move in lockstep with
 * another animation (the properties drawer's slide) rather than at the
 * default panel tempo. Call it *before* mutating the layout: the transition
 * is read from the after-change style, so both can land in the same task.
 */
export function triggerPanelAnimation(options?: PanelAnimationOptions): void {
  const durationMs = options?.durationMs ?? PANEL_ANIMATION_DURATION_MS;
  const root = document.documentElement;

  if (options?.durationMs !== undefined) {
    root.style.setProperty("--cy-panel-animation-duration", `${durationMs}ms`);
  } else {
    root.style.removeProperty("--cy-panel-animation-duration");
  }
  if (options?.easing !== undefined) {
    root.style.setProperty("--cy-panel-animation-easing", options.easing);
  } else {
    root.style.removeProperty("--cy-panel-animation-easing");
  }

  root.classList.add("cy-panels-animating");
  const token = ++animationToken;
  setTimeout(() => {
    if (token !== animationToken) return; // a later animation owns the class now
    root.classList.remove("cy-panels-animating");
    root.style.removeProperty("--cy-panel-animation-duration");
    root.style.removeProperty("--cy-panel-animation-easing");
  }, durationMs + 50); // slightly longer than the transition
}
