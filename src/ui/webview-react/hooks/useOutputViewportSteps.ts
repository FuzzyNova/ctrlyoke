import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUiStore } from "@store/uiStore";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import type { OutputRenderRow } from "@utils/outputRows";
import {
  buildOutputStepSections,
  resolveOutputViewportSteps,
} from "@utils/outputViewportSteps";

const EMPTY_TARGET_KEYS: readonly string[] = [];

export interface OutputStickyStepRows {
  headerRow: OutputRenderRow;
  previewRow?: OutputRenderRow;
}

interface UseOutputViewportStepsInput {
  /** False while the output tab is hidden, collapsed or empty. */
  isActive: boolean;
  isStickyEnabled: boolean;
  rows: readonly OutputRenderRow[];
  rowStarts: readonly number[];
  totalSize: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function sameStickyIndices(
  a: { headerRow: number; previewRow?: number } | null,
  b: { headerRow: number; previewRow?: number } | null
): boolean {
  return a?.headerRow === b?.headerRow && a?.previewRow === b?.previewRow;
}

/**
 * Tracks which steps the output pane is showing, for the sticky step header
 * and the steps panel's in-view marker.
 *
 * Positions come from the virtualizer's row layout rather than the DOM,
 * because the header that should stick has usually been virtualized away by
 * the time it is needed. The only DOM reads are the sticky slot (whose
 * on-screen top *is* the top of the readable area, below a pinned run banner
 * or not) and the row container it is measured against.
 *
 * Runs synchronously in the scroll event so the header switches in the same
 * frame the content moves. The push-out offset changes every frame and is
 * written to the element directly; React only re-renders when the stuck
 * header changes.
 */
export function useOutputViewportSteps({
  isActive,
  isStickyEnabled,
  rows,
  rowStarts,
  totalSize,
  scrollContainerRef,
}: UseOutputViewportStepsInput) {
  const stickySlotRef = useRef<HTMLDivElement>(null);
  const stickyContentRef = useRef<HTMLDivElement>(null);
  const [stickyIndices, setStickyIndices] = useState<{
    headerRow: number;
    previewRow?: number;
  } | null>(null);
  const stickyIndicesRef = useRef(stickyIndices);
  stickyIndicesRef.current = stickyIndices;
  const offsetPxRef = useRef(0);

  const model = useMemo(() => buildOutputStepSections(rows), [rows]);

  const applyOffset = useCallback(() => {
    const content = stickyContentRef.current;
    if (content) {
      content.style.transform =
        offsetPxRef.current === 0 ? "" : `translateY(${offsetPxRef.current}px)`;
    }
  }, []);

  const update = useCallback(() => {
    const setInView = useUiStore.getState().setOutputInViewTargetKeys;
    const scrollElement = scrollContainerRef.current;
    const slot = stickySlotRef.current;
    const rowContainer = scrollElement?.querySelector<HTMLElement>(
      "[data-output-row-container]"
    );
    if (!isActive || !scrollElement || !slot || !rowContainer) {
      setInView(EMPTY_TARGET_KEYS);
      if (stickyIndicesRef.current) setStickyIndices(null);
      return;
    }

    const containerTop = rowContainer.getBoundingClientRect().top;
    const result = resolveOutputViewportSteps({
      rows,
      model,
      rowStarts,
      totalSize,
      viewportTop: slot.getBoundingClientRect().top - containerTop,
      viewportBottom:
        scrollElement.getBoundingClientRect().bottom - containerTop,
      stickyHeightPx: stickyContentRef.current?.offsetHeight ?? 0,
    });
    setInView(result.inViewTargetKeys);

    const nextIndices =
      isStickyEnabled && result.sticky
        ? {
            headerRow: result.sticky.headerRow,
            previewRow: result.sticky.previewRow,
          }
        : null;
    offsetPxRef.current = result.sticky?.offsetPx ?? 0;
    if (!sameStickyIndices(stickyIndicesRef.current, nextIndices)) {
      stickyIndicesRef.current = nextIndices;
      setStickyIndices(nextIndices);
    } else {
      applyOffset();
    }
  }, [
    applyOffset,
    isActive,
    isStickyEnabled,
    model,
    rowStarts,
    rows,
    scrollContainerRef,
    totalSize,
  ]);

  const updateRef = useRef(update);
  updateRef.current = update;

  // Layout changes (rows, measurements, pin toggles) and the commit of a new
  // stuck header: recompute before paint, then re-apply the offset to the
  // element that commit may have just mounted.
  useLayoutEffect(() => {
    update();
    applyOffset();
  }, [applyOffset, stickyIndices, update]);

  useEffect(() => {
    const scrollElement = scrollContainerRef.current;
    if (!scrollElement) return;
    const handleScroll = () => updateRef.current();
    const { observer, disconnect } = createAnimationFrameResizeObserver(() =>
      updateRef.current()
    );
    observer.observe(scrollElement);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      disconnect();
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [scrollContainerRef]);

  useEffect(
    () => () =>
      useUiStore.getState().setOutputInViewTargetKeys(EMPTY_TARGET_KEYS),
    []
  );

  const headerRow = stickyIndices ? rows[stickyIndices.headerRow] : undefined;
  const previewRow =
    stickyIndices?.previewRow !== undefined
      ? rows[stickyIndices.previewRow]
      : undefined;
  const stickyRows: OutputStickyStepRows | null = headerRow
    ? { headerRow, previewRow }
    : null;

  return { stickySlotRef, stickyContentRef, stickyRows };
}
