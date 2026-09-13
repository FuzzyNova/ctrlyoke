/**
 * Briefly enables the flex-grow CSS transition on all [data-panel] elements.
 *
 * The transition is intentionally disabled by default so that panels don't
 * animate during initial mount, window resize, or drag interactions. Call
 * this immediately before any explicit user-triggered collapse/expand action
 * to get smooth 200ms animation for that specific interaction only.
 */
export function triggerPanelAnimation(): void {
  document.documentElement.classList.add("cy-panels-animating");
  setTimeout(() => {
    document.documentElement.classList.remove("cy-panels-animating");
  }, 250); // slightly longer than the 200ms transition
}
