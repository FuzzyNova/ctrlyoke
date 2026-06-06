export type AnimationFrameResizeObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver
) => void;

export interface AnimationFrameResizeObserverHandle {
  observer: ResizeObserver;
  disconnect: () => void;
}

/**
 * Defers ResizeObserver work to the next animation frame so layout-affecting
 * updates do not run inside the observer delivery cycle.
 */
export function createAnimationFrameResizeObserver(
  callback: AnimationFrameResizeObserverCallback
): AnimationFrameResizeObserverHandle {
  let frameId: number | null = null;
  let pendingEntries: ResizeObserverEntry[] = [];

  const flush = (observer: ResizeObserver) => {
    frameId = null;
    const entries = pendingEntries;
    pendingEntries = [];
    callback(entries, observer);
  };

  const observer = new ResizeObserver((entries, currentObserver) => {
    pendingEntries = entries;
    if (frameId != null) {
      return;
    }
    frameId = requestAnimationFrame(() => flush(currentObserver));
  });

  return {
    observer,
    disconnect: () => {
      if (frameId != null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      pendingEntries = [];
      observer.disconnect();
    },
  };
}
