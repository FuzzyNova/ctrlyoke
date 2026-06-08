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

/** Row count where fast-scroll placeholder and virtualization-overlay behavior is enabled. */
export const LARGE_WORKFLOW_ROW_THRESHOLD = 20;
