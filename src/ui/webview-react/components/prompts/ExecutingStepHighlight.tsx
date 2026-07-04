interface ExecutingStepHighlightProps {
  borderClassName?: string;
  testId?: string;
}

/**
 * Animated outline for the currently executing step/chip.
 *
 * This intentionally sizes from the running item's own relative container
 * instead of measuring from a parent overlay. Mobile drawers and sidebars can
 * unmount/remount while their ancestors are still settling geometry; letting CSS
 * own the inset box avoids stale 0-height measurements after those remounts.
 */
export function ExecutingStepHighlight({
  borderClassName = "border-2",
  testId = "executing-step-highlight",
}: ExecutingStepHighlightProps) {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-none absolute inset-0 z-raised ${borderClassName} border-status-idle animate-pulse-custom`}
      aria-hidden="true"
    />
  );
}
