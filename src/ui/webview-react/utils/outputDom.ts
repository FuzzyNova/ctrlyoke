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
      const topDistance = Math.abs(rowRect.top - viewportCenter);
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
