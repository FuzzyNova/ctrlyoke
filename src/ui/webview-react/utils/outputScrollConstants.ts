/**
 * Output scroll/virtualization constants shared across multiple hooks.
 *
 * These coordinate suppression and threshold behavior between
 * `useOutputScrollSeek`, `useOutputVirtualization`, `useOutputScrollTarget`,
 * and `OutputSection` — keep them here so the hooks stay in sync rather than
 * drifting if tuned independently.
 */

/** Recent user scroll/wheel input window that lets real user scrolling bypass settle suppression. */
export const OUTPUT_USER_SCROLL_INPUT_GRACE_MS = 200;

/**
 * Distance from the bottom (px) within which auto-scroll re-arms. Landing here
 * pins the view to the bottom again no matter how the viewport got here.
 */
export const OUTPUT_AUTOSCROLL_REARM_THRESHOLD_PX = 40;

/**
 * Auto-scroll release is deliberately far looser than re-arm (see
 * `nextAutoscrollArmed`). A single threshold makes the latch drop on any frame
 * where content grew before the pinning write landed — the "stuck just above
 * the bottom, auto-scroll silently dead" bug. Releasing only after a decisive
 * upward gesture means growth alone can never unpin the view.
 */
export const OUTPUT_AUTOSCROLL_RELEASE_VIEWPORT_FRACTION = 0.15;

/** Floor for the release distance so short panes still need a deliberate scroll. */
export const OUTPUT_AUTOSCROLL_RELEASE_MIN_PX = 150;

/** Row count where fast-scroll placeholder and virtualization-overlay behavior is enabled. */
export const LARGE_WORKFLOW_ROW_THRESHOLD = 20;

/**
 * Height change (px) below which a row's measurement is treated as a no-op and
 * left to the batched rAF bump.
 *
 * This is a sub-pixel floor, not a tuning knob. It used to be 24px, on the
 * theory that only large reflows were worth a synchronous layout-version bump —
 * but the threshold *is* the amplitude of the flash it lets through, because
 * anything below it paints the reflow one frame before the correction. The
 * 2026-08-13 04:31 profiler session recorded 45 of 140 settled corrections in
 * the 1-24px band, arriving in frame-cadence bursts.
 *
 * Deriving the diff geometry from CSS (commit 17ace0f1) is what made that
 * visible: it moved most first-measurement deltas out of the >=24px synchronous
 * band and into the deferred one — `bashCommand` n=150 avgDelta 0, `fileRead`
 * n=44 avgDelta -7, `diff:unified:expanded` n=43 avgDelta 12. Better estimates
 * mean smaller reflows, and smaller reflows were the ones being deferred.
 */
export const OUTPUT_MEASUREMENT_REFLOW_MIN_DELTA_PX = 1;
