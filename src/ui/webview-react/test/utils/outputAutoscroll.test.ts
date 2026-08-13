import { describe, expect, it } from "vitest";
import {
  getAutoscrollReleaseThresholdPx,
  getDistanceFromBottomPx,
  isProgrammaticScrollEcho,
  isWithinAutoscrollRearmThreshold,
  nextAutoscrollArmed,
  type AutoscrollLatchInput,
} from "@utils/outputAutoscroll";
import {
  OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX,
  OUTPUT_AUTOSCROLL_RELEASE_MIN_PX,
} from "@utils/outputScrollConstants";

const VIEWPORT_HEIGHT = 800;

function latch(overrides: Partial<AutoscrollLatchInput> = {}): boolean {
  return nextAutoscrollArmed({
    distanceFromBottomPx: 0,
    viewportHeightPx: VIEWPORT_HEIGHT,
    isArmed: true,
    movedUp: false,
    isUserDriven: true,
    ...overrides,
  });
}

describe("outputAutoscroll", () => {
  describe("getDistanceFromBottomPx", () => {
    it("measures the gap between the viewport and the content bottom", () => {
      expect(
        getDistanceFromBottomPx({
          clientHeight: 200,
          scrollHeight: 1000,
          scrollTop: 700,
        })
      ).toBe(100);
    });

    it("floors overscrolled containers at zero", () => {
      expect(
        getDistanceFromBottomPx({
          clientHeight: 200,
          scrollHeight: 1000,
          scrollTop: 900,
        })
      ).toBe(0);
    });
  });

  describe("release threshold", () => {
    it("scales with the viewport but never below the floor", () => {
      expect(getAutoscrollReleaseThresholdPx(4000)).toBe(600);
      expect(getAutoscrollReleaseThresholdPx(200)).toBe(
        OUTPUT_AUTOSCROLL_RELEASE_MIN_PX
      );
    });

    it("is far looser than the re-arm threshold", () => {
      expect(getAutoscrollReleaseThresholdPx(VIEWPORT_HEIGHT)).toBeGreaterThan(
        OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX
      );
    });
  });

  describe("isWithinAutoscrollRearmThreshold", () => {
    it("treats the threshold as inclusive", () => {
      expect(
        isWithinAutoscrollRearmThreshold(OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX)
      ).toBe(true);
      expect(
        isWithinAutoscrollRearmThreshold(
          OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX + 1
        )
      ).toBe(false);
    });
  });

  describe("nextAutoscrollArmed", () => {
    it("re-arms whenever the viewport lands near the bottom", () => {
      expect(latch({ isArmed: false, distanceFromBottomPx: 20 })).toBe(true);
    });

    it("re-arms even when the user was the one scrolling down", () => {
      expect(
        latch({
          isArmed: false,
          distanceFromBottomPx: 10,
          movedUp: false,
          isUserDriven: true,
        })
      ).toBe(true);
    });

    // The core regression: streaming output grows the content below a pinned
    // viewport, so the gap widens without the viewport ever moving.
    it("stays armed when content grows out from under a pinned viewport", () => {
      expect(latch({ distanceFromBottomPx: 4000, movedUp: false })).toBe(true);
    });

    it("stays armed when a virtualizer correction moves the view up", () => {
      expect(
        latch({
          distanceFromBottomPx: 4000,
          movedUp: true,
          isUserDriven: false,
        })
      ).toBe(true);
    });

    it("stays armed for a small upward nudge inside the release distance", () => {
      expect(
        latch({
          distanceFromBottomPx:
            getAutoscrollReleaseThresholdPx(VIEWPORT_HEIGHT) - 1,
          movedUp: true,
        })
      ).toBe(true);
    });

    it("releases on a decisive upward user scroll", () => {
      expect(
        latch({
          distanceFromBottomPx:
            getAutoscrollReleaseThresholdPx(VIEWPORT_HEIGHT) + 1,
          movedUp: true,
        })
      ).toBe(false);
    });

    it("stays released until the viewport returns near the bottom", () => {
      expect(
        latch({
          isArmed: false,
          distanceFromBottomPx: OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX + 1,
          movedUp: false,
        })
      ).toBe(false);
    });
  });
});

describe("isProgrammaticScrollEcho", () => {
  const echo = { scrollTop: 82918, lastProgrammaticScrollTop: 82918 };

  // Position is the whole signal — there is deliberately no timing input, so an
  // echo is claimed however many frames late the browser dispatches it. The
  // flag-plus-animation-frame guard this backstops cannot do that, and every
  // escaped echo re-anchors the pane where the lock left it rather than where
  // the user did.
  it("claims an event sitting exactly where the pane last wrote", () => {
    expect(
      isProgrammaticScrollEcho({ ...echo, hasRecentUserScrollInput: false })
    ).toBe(true);
  });

  it("claims a sub-pixel rounding difference from that write", () => {
    expect(
      isProgrammaticScrollEcho({
        ...echo,
        scrollTop: 82918.4,
        hasRecentUserScrollInput: false,
      })
    ).toBe(true);
  });

  it.each([
    ["the pane moved since that write", { scrollTop: 82900 }],
    ["nothing has been written yet", { lastProgrammaticScrollTop: null }],
  ])("does not claim an event when %s", (_label, override) => {
    expect(
      isProgrammaticScrollEcho({
        ...echo,
        ...override,
        hasRecentUserScrollInput: false,
      })
    ).toBe(false);
  });

  // A user who scrolls back to the exact pixel the lock last wrote must still
  // be heard; their wheel/touch stamp lands before the scroll event does.
  it("yields to a real input landing on the same pixel", () => {
    expect(
      isProgrammaticScrollEcho({ ...echo, hasRecentUserScrollInput: true })
    ).toBe(false);
  });
});
