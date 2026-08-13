import { describe, expect, it } from "vitest";
import {
  OUTPUT_SCROLL_VERDICTS,
  classifyOutputScrollEvent,
  getAutoscrollReleaseThresholdPx,
  getDistanceFromBottomPx,
  isProgrammaticScrollEcho,
  isWithinAutoscrollRearmThreshold,
  nextAutoscrollArmed,
  resolveDeferredScrollTargetApplyDelayMs,
  resolveDiffGapExpansionScrollTarget,
  shouldSyncMeasurementCorrection,
  type AutoscrollLatchInput,
  type OutputScrollAttributionInput,
} from "@utils/outputAutoscroll";
import type { OutputScrollTarget } from "@store/uiStore";
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

describe("classifyOutputScrollEvent", () => {
  function classify(
    overrides: Partial<OutputScrollAttributionInput> = {}
  ): string {
    return classifyOutputScrollEvent({
      hasRecentUserScrollInput: false,
      isLayoutWorkSuppressed: false,
      isMeasurementFlushInProgress: false,
      isProgrammaticScrollFlagRaised: false,
      lastProgrammaticScrollTop: null,
      scrollTop: 82918,
      ...overrides,
    });
  }

  it("attributes an unclaimed event to the user", () => {
    expect(classify()).toBe(OUTPUT_SCROLL_VERDICTS.userScroll);
  });

  it.each([
    [
      OUTPUT_SCROLL_VERDICTS.suppressedLayoutWork,
      { isLayoutWorkSuppressed: true },
    ],
    [
      OUTPUT_SCROLL_VERDICTS.programmaticFlag,
      { isProgrammaticScrollFlagRaised: true },
    ],
    [
      OUTPUT_SCROLL_VERDICTS.measurementFlush,
      { isMeasurementFlushInProgress: true },
    ],
    [
      OUTPUT_SCROLL_VERDICTS.programmaticEcho,
      { lastProgrammaticScrollTop: 82918 },
    ],
  ])("returns %s", (verdict, overrides) => {
    expect(classify(overrides)).toBe(verdict);
  });

  // Order is the contract, not an implementation detail: the handler branches on
  // the verdict, so a reordering here silently reroutes events. The echo check
  // is last because it is the only one that can be wrong about a user who lands
  // on the lock's pixel, and the three flags above it are unambiguous.
  it("prefers the earlier guard when several apply at once", () => {
    expect(
      classify({
        isLayoutWorkSuppressed: true,
        isProgrammaticScrollFlagRaised: true,
        isMeasurementFlushInProgress: true,
        lastProgrammaticScrollTop: 82918,
      })
    ).toBe(OUTPUT_SCROLL_VERDICTS.suppressedLayoutWork);
    expect(
      classify({
        isProgrammaticScrollFlagRaised: true,
        isMeasurementFlushInProgress: true,
      })
    ).toBe(OUTPUT_SCROLL_VERDICTS.programmaticFlag);
  });

  // Every verdict must be reachable and distinct — the reason the handler can
  // log one line per scroll event and have it mean something.
  it("never returns a verdict outside the published set", () => {
    expect(Object.values(OUTPUT_SCROLL_VERDICTS)).toContain(classify());
  });
});

describe("shouldSyncMeasurementCorrection", () => {
  const bigEnough = 24;

  // The anchor sits wherever the user left it, commonly a few hundred pixels
  // down the pane. A row resizing in the band between the viewport top and the
  // anchor displaces the anchor, so its correction has to batch into the same
  // commit as the reflow or it paints as a flash.
  it("claims a row inside the viewport but above the anchor", () => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx: bigEnough,
        rowTopPx: 100,
        anchorTopPx: 314,
      })
    ).toBe(true);
  });

  it("claims a row straddling the viewport top", () => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx: bigEnough,
        rowTopPx: -80,
        anchorTopPx: 314,
      })
    ).toBe(true);
  });

  // Resizing the anchor row does not move its own top, and nothing after it can
  // reach back. Both keep the batched bump so a burst costs one render.
  it.each([
    ["the anchor row itself", 314],
    ["a row below the anchor", 900],
  ])("defers %s to the batched bump", (_label, rowTopPx) => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx: bigEnough,
        rowTopPx,
        anchorTopPx: 314,
      })
    ).toBe(false);
  });

  // A magnitude threshold here is the amplitude of the flash it admits: every
  // above-anchor displacement below it paints a frame before its correction.
  // The 2026-08-13 04:31 session put 45 of 140 settled corrections in the 1-24px
  // band that the old 24px threshold deferred. Only a sub-pixel no-op is
  // deferred now, so a small resize must claim the synchronous path.
  it.each([
    ["a one-pixel growth", 1],
    ["a small growth well under the old 24px threshold", 6],
    ["a small shrink", -6],
  ])("claims %s above the anchor", (_label, heightDeltaPx) => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx,
        rowTopPx: 100,
        anchorTopPx: 314,
      })
    ).toBe(true);
  });

  it("defers a measurement that did not move the row at all", () => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx: 0.25,
        rowTopPx: -5000,
        anchorTopPx: 314,
      })
    ).toBe(false);
  });

  it("claims a shrink as readily as a growth", () => {
    expect(
      shouldSyncMeasurementCorrection({
        heightDeltaPx: -bigEnough,
        rowTopPx: 100,
        anchorTopPx: 314,
      })
    ).toBe(true);
  });
});

describe("resolveDeferredScrollTargetApplyDelayMs", () => {
  const userScrollInputGraceMs = 200;

  // A muted attempt that lands right as the scroll happened needs the full
  // window before the mute genuinely expires.
  it("waits the full grace period when the mute was just triggered", () => {
    expect(
      resolveDeferredScrollTargetApplyDelayMs({
        now: 1000,
        lastUserScrollInputAt: 1000,
        lastScrollEventAt: null,
        userScrollInputGraceMs,
      })
    ).toBe(200);
  });

  // The bug this closes: a reflow-triggered muted attempt arriving partway
  // through the window used to wait a *full* grace period from itself,
  // stacking extra delay on top of what was already elapsed (150ms elapsed +
  // a fresh 200ms = 350ms uncorrected instead of the 50ms actually left).
  it("only waits out whatever remains of the window", () => {
    expect(
      resolveDeferredScrollTargetApplyDelayMs({
        now: 1150,
        lastUserScrollInputAt: 1000,
        lastScrollEventAt: null,
        userScrollInputGraceMs,
      })
    ).toBe(50);
  });

  it("floors at zero once the window has already elapsed", () => {
    expect(
      resolveDeferredScrollTargetApplyDelayMs({
        now: 1500,
        lastUserScrollInputAt: 1000,
        lastScrollEventAt: null,
        userScrollInputGraceMs,
      })
    ).toBe(0);
  });

  // Either signal can be the one that armed the mute — the later of the two
  // is what actually governs when it expires.
  it("uses whichever signal is more recent", () => {
    expect(
      resolveDeferredScrollTargetApplyDelayMs({
        now: 1100,
        lastUserScrollInputAt: 1000,
        lastScrollEventAt: 1080,
        userScrollInputGraceMs,
      })
    ).toBe(180);
  });

  it("treats a missing signal as having never happened", () => {
    expect(
      resolveDeferredScrollTargetApplyDelayMs({
        now: 1100,
        lastUserScrollInputAt: null,
        lastScrollEventAt: 1080,
        userScrollInputGraceMs,
      })
    ).toBe(180);
  });
});

describe("resolveDiffGapExpansionScrollTarget", () => {
  const anchoredRow: OutputScrollTarget = {
    kind: "row",
    rowKey: "diff-row",
    viewportOffsetPx: 120,
  };

  // The row's own top hasn't moved — the growth is entirely inside it — so
  // the anchor lock's ordinal above-anchor check never fires for it. Shrinking
  // viewportOffsetPx is what makes the lock's own next resolve scroll further
  // by exactly the growth, which is what re-centers the point the user clicked.
  it("shrinks viewportOffsetPx by the measured growth when the anchor is the row that grew", () => {
    expect(
      resolveDiffGapExpansionScrollTarget(anchoredRow, "diff-row", 450)
    ).toEqual({ kind: "row", rowKey: "diff-row", viewportOffsetPx: -330 });
  });

  it("grows viewportOffsetPx back when the expanded gap is collapsed again", () => {
    expect(
      resolveDiffGapExpansionScrollTarget(anchoredRow, "diff-row", -450)
    ).toEqual({ kind: "row", rowKey: "diff-row", viewportOffsetPx: 570 });
  });

  it("does nothing when a different row is anchored", () => {
    expect(
      resolveDiffGapExpansionScrollTarget(anchoredRow, "other-row", 450)
    ).toBeNull();
  });

  it("does nothing while auto-scroll is pinned to the bottom", () => {
    expect(
      resolveDiffGapExpansionScrollTarget({ kind: "bottom" }, "diff-row", 450)
    ).toBeNull();
  });

  it("ignores a sub-pixel measurement no-op", () => {
    expect(
      resolveDiffGapExpansionScrollTarget(anchoredRow, "diff-row", 0.4)
    ).toBeNull();
  });
});
