import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_ANIMATION_DURATION_MS,
  triggerPanelAnimation,
} from "@utils/panelAnimation";

const ANIMATING_CLASS = "cy-panels-animating";
const DURATION_PROP = "--cy-panel-animation-duration";
const EASING_PROP = "--cy-panel-animation-easing";

function root(): HTMLElement {
  return document.documentElement;
}

describe("triggerPanelAnimation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    root().classList.remove(ANIMATING_CLASS);
    root().style.removeProperty(DURATION_PROP);
    root().style.removeProperty(EASING_PROP);
  });

  it("enables the panel transition for the default duration only", () => {
    triggerPanelAnimation();

    expect(root().classList.contains(ANIMATING_CLASS)).toBe(true);
    // No overrides: the stylesheet's own fallbacks stay in effect.
    expect(root().style.getPropertyValue(DURATION_PROP)).toBe("");
    expect(root().style.getPropertyValue(EASING_PROP)).toBe("");

    vi.advanceTimersByTime(PANEL_ANIMATION_DURATION_MS);
    expect(root().classList.contains(ANIMATING_CLASS)).toBe(true);

    vi.advanceTimersByTime(50);
    expect(root().classList.contains(ANIMATING_CLASS)).toBe(false);
  });

  it("publishes a caller's duration and easing, then clears them", () => {
    triggerPanelAnimation({ durationMs: 300, easing: "linear" });

    expect(root().style.getPropertyValue(DURATION_PROP)).toBe("300ms");
    expect(root().style.getPropertyValue(EASING_PROP)).toBe("linear");

    vi.advanceTimersByTime(350);
    expect(root().classList.contains(ANIMATING_CLASS)).toBe(false);
    expect(root().style.getPropertyValue(DURATION_PROP)).toBe("");
    expect(root().style.getPropertyValue(EASING_PROP)).toBe("");
  });

  it("lets a later animation outlive the earlier one's teardown", () => {
    // Two toggles in quick succession: the first timer must not strip the
    // class out from under the second animation.
    triggerPanelAnimation({ durationMs: 200 });
    vi.advanceTimersByTime(100);
    triggerPanelAnimation({ durationMs: 300 });

    vi.advanceTimersByTime(150); // first teardown would have fired by now
    expect(root().classList.contains(ANIMATING_CLASS)).toBe(true);
    expect(root().style.getPropertyValue(DURATION_PROP)).toBe("300ms");

    vi.advanceTimersByTime(200);
    expect(root().classList.contains(ANIMATING_CLASS)).toBe(false);
  });
});
