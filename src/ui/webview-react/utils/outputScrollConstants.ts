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
 * Minimum height change (px) for an above-viewport row before its measurement
 * forces a synchronous layout-version bump. Below this, the batched rAF bump is
 * used; at/above it, the corrective scroll-target apply is coalesced into the
 * same paint as the row's reflow to avoid a one-frame "jump then snap" flash.
 */
export const OUTPUT_ABOVE_VIEWPORT_SYNC_CORRECTION_MIN_DELTA_PX = 24;
