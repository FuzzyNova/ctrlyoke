export interface ViewportRowAnchor {
  rowKey: string;
  offsetTop: number;
  rowOffsetPx: number;
  viewportOffsetTop: number;
}

export function getMeasuredElementHeight(element: HTMLElement): number {
  return Math.max(
    element.getBoundingClientRect().height,
    element.offsetHeight,
    element.scrollHeight
  );
}

export function getResizeObserverEntryHeight(
  entry: ResizeObserverEntry | undefined
): number | null {
  const borderBox = entry?.borderBoxSize?.[0];
  if (borderBox) {
    return borderBox.blockSize;
  }

  const contentBox = entry?.contentBoxSize?.[0];
  if (contentBox) {
    return contentBox.blockSize;
  }

  return entry?.contentRect.height ?? null;
}

export function findRenderedRowElement(
  scrollElement: HTMLDivElement,
  rowIndex: number
): HTMLDivElement | null {
  return scrollElement.querySelector<HTMLDivElement>(
    `[data-index="${rowIndex}"]`
  );
}

export function findRenderedRowElementByKey(
  scrollElement: HTMLDivElement,
  rowKey: string
): HTMLDivElement | null {
  return (
    Array.from(
      scrollElement.querySelectorAll<HTMLDivElement>("[data-row-key]")
    ).find((element) => element.dataset.rowKey === rowKey) ?? null
  );
}

export function captureViewportRowAnchor(
  scrollElement: HTMLDivElement,
  mode: "center-point" | "visible-top" = "visible-top"
): ViewportRowAnchor | null {
  const containerRect = scrollElement.getBoundingClientRect();
  const viewportCenter = containerRect.top + containerRect.height / 2;
  let best: { element: HTMLDivElement; distance: number } | null = null;
  let bestVisibleTop: { element: HTMLDivElement; distance: number } | null =
    null;

  for (const element of scrollElement.querySelectorAll<HTMLDivElement>(
    "[data-row-key]"
  )) {
    const rowKey = element.dataset.rowKey;
    if (!rowKey) continue;

    const rowRect = element.getBoundingClientRect();
    if (
      rowRect.bottom <= containerRect.top ||
      rowRect.top >= containerRect.bottom
    ) {
      continue;
    }

    const rowCenter = rowRect.top + rowRect.height / 2;
    const distance = Math.abs(rowCenter - viewportCenter);
    if (rowRect.top >= containerRect.top) {
      // Nearest the container's TOP, which is what "visible-top" claims. This
      // scored against the viewport *centre* until 2026-08-13, so the committed
      // anchor was routinely a few hundred pixels down the pane (offsets of
      // 244-325 in a 586px viewport are all over that day's profiler log). Two
      // things went wrong downstream. Every row resizing in the band above the
      // anchor displaced it while failing the "above the viewport" test that
      // decides whether the lock's correction lands in the same paint as the
      // reflow — see shouldSyncMeasurementCorrection. And a tall row, whose top
      // can sit far above the fold while its centre is near it, produced wildly
      // negative offsets (-2261, -731) that are self-consistent but useless as a
      // restore reference.
      const topDistance = rowRect.top - containerRect.top;
      if (!bestVisibleTop || topDistance < bestVisibleTop.distance) {
        bestVisibleTop = { element, distance: topDistance };
      }
    }
    if (!best || distance < best.distance) {
      best = { element, distance };
    }
  }

  const anchorElement =
    mode === "center-point"
      ? (best?.element ?? bestVisibleTop?.element ?? null)
      : (bestVisibleTop?.element ?? best?.element ?? null);
  if (!anchorElement) {
    return null;
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  const anchorPoint =
    mode === "center-point"
      ? Math.min(Math.max(viewportCenter, anchorRect.top), anchorRect.bottom)
      : anchorRect.top;

  return {
    rowKey: anchorElement.dataset.rowKey ?? "",
    offsetTop: anchorRect.top - containerRect.top,
    rowOffsetPx: anchorPoint - anchorRect.top,
    viewportOffsetTop: anchorPoint - containerRect.top,
  };
}

export function alignRowElementToViewport(
  scrollElement: HTMLDivElement,
  rowElement: HTMLElement,
  align: "start" | "center" | "end"
): boolean {
  const containerRect = scrollElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const delta =
    align === "end"
      ? rowRect.bottom - containerRect.bottom
      : align === "center"
        ? rowRect.top +
          rowRect.height / 2 -
          (containerRect.top + containerRect.height / 2)
        : rowRect.top - containerRect.top;

  if (Math.abs(delta) < 2) {
    return true;
  }

  const maxScroll = Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.clientHeight
  );
  scrollElement.scrollTop = Math.max(
    0,
    Math.min(maxScroll, scrollElement.scrollTop + delta)
  );
  return false;
}

export function getRowScopedScrollTop(
  scrollElement: HTMLDivElement,
  rowElement: HTMLElement,
  align: "start" | "center" | "end"
): number {
  const containerRect = scrollElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const delta =
    align === "end"
      ? rowRect.bottom - containerRect.bottom
      : align === "center"
        ? rowRect.top +
          rowRect.height / 2 -
          (containerRect.top + containerRect.height / 2)
        : rowRect.top - containerRect.top;
  const maxScroll = Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.clientHeight
  );
  return Math.max(0, Math.min(maxScroll, scrollElement.scrollTop + delta));
}

export function getEstimatedRowScopedScrollTop(
  scrollElement: HTMLDivElement,
  rowStart: number,
  rowSize: number | undefined,
  align: "start" | "center" | "end"
): number {
  const target =
    align === "end"
      ? rowStart + (rowSize ?? 0) - scrollElement.clientHeight
      : align === "center"
        ? rowStart + (rowSize ?? 0) / 2 - scrollElement.clientHeight / 2
        : rowStart;
  const maxScroll = Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.clientHeight
  );
  return Math.max(0, Math.min(maxScroll, target));
}

export interface ActiveFindRevealResult {
  adjusted: boolean;
  foundMark: boolean;
  foundRow: boolean;
  rowKey: string | null;
  rowViewportOffsetPx: number | null;
}

export function revealActiveFindMatchInRow(
  scrollElement: HTMLDivElement,
  rowIndex: number
): ActiveFindRevealResult {
  const rowElement = findRenderedRowElement(scrollElement, rowIndex);
  if (!rowElement) {
    return {
      adjusted: false,
      foundMark: false,
      foundRow: false,
      rowKey: null,
      rowViewportOffsetPx: null,
    };
  }

  const activeMark = rowElement.querySelector<HTMLElement>(
    'mark[data-find-active="true"]'
  );
  if (!activeMark) {
    return {
      adjusted: false,
      foundMark: false,
      foundRow: true,
      rowKey: rowElement.dataset.rowKey ?? null,
      rowViewportOffsetPx: null,
    };
  }

  const containerRect = scrollElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const markRect = activeMark.getBoundingClientRect();
  const rowViewportOffsetBeforeScroll = rowRect.top - containerRect.top;
  const scrollTopBeforeReveal = scrollElement.scrollTop;
  const markFullyVisible =
    markRect.top >= containerRect.top &&
    markRect.bottom <= containerRect.bottom;

  if (!markFullyVisible) {
    const delta =
      markRect.top +
      markRect.height / 2 -
      (containerRect.top + containerRect.height / 2);
    const maxScroll = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight
    );
    scrollElement.scrollTop = Math.max(
      0,
      Math.min(maxScroll, scrollElement.scrollTop + delta)
    );
  }

  // The persistent scroll target must describe where the row sits *after* the
  // match reveal. getBoundingClientRect() above was captured before the
  // scrollTop write, so keeping that stale offset lets the anchor lock undo the
  // match-specific scroll on its next layout pass. Derive the landed offset
  // from the actual (possibly clamped) scroll delta instead.
  const appliedScrollDelta = scrollElement.scrollTop - scrollTopBeforeReveal;

  return {
    adjusted: !markFullyVisible,
    foundMark: true,
    foundRow: true,
    rowKey: rowElement.dataset.rowKey ?? null,
    rowViewportOffsetPx: rowViewportOffsetBeforeScroll - appliedScrollDelta,
  };
}
