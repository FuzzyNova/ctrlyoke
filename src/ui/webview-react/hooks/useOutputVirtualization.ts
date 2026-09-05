import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { CLI_EVENT_TYPES } from "@/types/messages";
import { clamp } from "@utils/number";
import { createAnimationFrameResizeObserver } from "@utils/createAnimationFrameResizeObserver";
import {
  findRenderedRowElementByKey,
  getMeasuredElementHeight,
  getResizeObserverEntryHeight,
} from "@utils/outputDom";
import {
  getProfilerState,
  isProfilingEnabled,
  logProfilerEvent,
  measurePhase,
  shouldLogMeasurement,
  shouldLogVirtualRange,
} from "@utils/performanceProfiler";
import { OUTPUT_USER_SCROLL_INPUT_GRACE_MS } from "@utils/outputScrollConstants";
import { shouldSyncMeasurementCorrection } from "@utils/outputAutoscroll";
import type { OutputScrollTarget } from "@store/uiStore";
import {
  OUTPUT_ROW_KINDS,
  OUTPUT_SCROLL_TARGET_KINDS,
} from "@root/types/DashboardConstants";
import {
  estimateOutputRowHeight,
  type OutputRenderRow,
  type StructuredEventRow,
} from "@utils/outputRows";

const POST_LOAD_REMEASURE_DELAY_MS = 80;
const NON_VIRTUAL_STAGING_ROW_THRESHOLD = 60;
const NON_VIRTUAL_INITIAL_RENDER_ROWS = 24;
const NON_VIRTUAL_RENDER_CHUNK_ROWS = 24;

interface RowHeightBucketStats {
  sampleCount: number;
  totalMeasured: number;
  totalEstimated: number;
  maxAbsDelta: number;
}

interface OutputRowLayoutModel {
  rowStartsByIndex: number[];
  rowStartsByKey: Map<string, number>;
  rowSizesByKey: Map<string, number>;
  totalSize: number;
}

interface UseOutputVirtualizationInput {
  applyScrollTargetRef: RefObject<
    (
      phase: string,
      options?: { force?: boolean }
    ) => {
      resolved: boolean;
      appliedDelta: number;
    }
  >;
  getVirtualItemsRef: RefObject<() => readonly { index: number }[]>;
  isProgrammaticScrollRef: RefObject<boolean>;
  isMeasurementFlushInProgressRef: RefObject<boolean>;
  lastScrollEventAtRef: RefObject<number | null>;
  outputCollapsed: boolean;
  outputContentWidth: number;
  outputFontSize: number;
  outputOverscan: number;
  outputOverscanRef: RefObject<number>;
  outputRef: RefObject<HTMLDivElement | null>;
  outputVirtualizationRowThreshold: number;
  rowRenderIdentity: string;
  rows: OutputRenderRow[];
  scrollSeekPlaceholderActive: boolean;
  scrollSeekRestoreRequestedAtRef: RefObject<number | null>;
  scrollTargetRef: RefObject<OutputScrollTarget>;
}

function getZeroHeightStructuredEventReason(
  row: StructuredEventRow
): string | null {
  switch (row.event.type) {
    case CLI_EVENT_TYPES.TEXT:
      return (row.event.data as { text?: string }).text ? null : "missing-text";
    case CLI_EVENT_TYPES.THINKING:
      return (row.event.data as { text?: string }).text
        ? null
        : "missing-thinking-text";
    case CLI_EVENT_TYPES.FILE_EDIT:
    case CLI_EVENT_TYPES.FILE_WRITE:
    case CLI_EVENT_TYPES.FILE_READ:
    case CLI_EVENT_TYPES.FILE_DELETE:
      return (row.event.data as { path?: string }).path
        ? null
        : "missing-file-path";
    case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
      const data = row.event.data as { server?: string; tool?: string };
      if (!data.server) return "missing-mcp-server";
      return data.tool ? null : "missing-mcp-tool";
    }
    case CLI_EVENT_TYPES.WEB_SEARCH:
      return (row.event.data as { query?: string }).query
        ? null
        : "missing-web-search-query";
    case CLI_EVENT_TYPES.TOOL_CALL:
      return (row.event.data as { name?: string }).name
        ? null
        : "missing-tool-call-name";
    case CLI_EVENT_TYPES.TOOL_RESULT:
      return (row.event.data as { result?: unknown }).result
        ? null
        : "missing-tool-result";
    case CLI_EVENT_TYPES.BASH_COMMAND:
    case CLI_EVENT_TYPES.COMPACTION:
      return null;
    default:
      return "unsupported-structured-event";
  }
}

function getRowHeightBucket(row: OutputRenderRow): string {
  switch (row.rowKind) {
    case OUTPUT_ROW_KINDS.STEP_ANCHOR:
    case OUTPUT_ROW_KINDS.STEP_HIDDEN:
    case OUTPUT_ROW_KINDS.FINAL_STEP_LABEL:
    case OUTPUT_ROW_KINDS.STATUS:
    case OUTPUT_ROW_KINDS.CLI_HEADER:
    case OUTPUT_ROW_KINDS.PROMPT:
    case OUTPUT_ROW_KINDS.CLI_COMMAND:
    case OUTPUT_ROW_KINDS.SCRIPT_COMMAND:
    case OUTPUT_ROW_KINDS.ERROR:
    case OUTPUT_ROW_KINDS.PLAIN_RESPONSE:
    case OUTPUT_ROW_KINDS.SCRIPT_OUTPUT:
    case OUTPUT_ROW_KINDS.SCRIPT_VERDICT:
    case OUTPUT_ROW_KINDS.ATTEMPT_GROUP_SUMMARY:
    case OUTPUT_ROW_KINDS.STATS:
      return row.rowKind;
    case OUTPUT_ROW_KINDS.STRUCTURED_EVENT:
      if (row.diff) {
        return `structured-event:diff:${row.diff.renderPlan.viewType}:${row.diff.isCollapsed ? "collapsed" : "expanded"}`;
      }
      if (row.toolCall) {
        return "structured-event:tool-call";
      }
      if (row.event.type === CLI_EVENT_TYPES.TEXT) {
        const text = (row.event.data as { text?: string }).text ?? "";
        if (/^\|.+\|/m.test(text)) return "structured-event:text:table";
      }
      return `structured-event:${row.event.type}`;
  }
}

export function useOutputVirtualization({
  applyScrollTargetRef,
  getVirtualItemsRef,
  isProgrammaticScrollRef,
  isMeasurementFlushInProgressRef,
  lastScrollEventAtRef,
  outputCollapsed,
  outputContentWidth,
  outputFontSize,
  outputOverscan,
  outputOverscanRef,
  outputRef,
  outputVirtualizationRowThreshold,
  rowRenderIdentity,
  rows,
  scrollSeekPlaceholderActive,
  scrollSeekRestoreRequestedAtRef,
  scrollTargetRef,
}: UseOutputVirtualizationInput) {
  const measurementCacheRef = useRef<Map<string, number>>(new Map());
  const rowHeightBucketStatsRef = useRef<Map<string, RowHeightBucketStats>>(
    new Map()
  );
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const measurementVersionRef = useRef(measurementVersion);
  const measurementVersionFrameRef = useRef<number | null>(null);
  const [nonVirtualRenderedRowCount, setNonVirtualRenderedRowCount] =
    useState<number>(Number.MAX_SAFE_INTEGER);
  const nonVirtualRenderFrameRef = useRef<number | null>(null);
  const nonVirtualRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const nonVirtualRenderIdentityRef = useRef<string | null>(null);
  const nonVirtualPrevRowCountRef = useRef(0);
  const nonVirtualRenderedRowCountRef = useRef(Number.MAX_SAFE_INTEGER);
  const lastVirtualRangeRef = useRef<string>("");
  const isBulkRemeasureInProgressRef = useRef(false);
  const pendingMeasurementCacheRef = useRef<Map<string, number>>(new Map());
  const mountedRowElementsRef = useRef<Set<HTMLDivElement>>(new Set());
  const pendingMeasurementFlushTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const postLoadRemeasureFrameRef = useRef<number | null>(null);
  const postLoadRemeasureTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const schedulePendingMeasurementFlushRef = useRef<() => void>(() => {});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowIndexByKey = useMemo(
    () => new Map(rows.map((row, index) => [row.key, index] as const)),
    [rows]
  );

  useEffect(() => {
    measurementVersionRef.current = measurementVersion;
  }, [measurementVersion]);

  const effectiveVirtualizationRowThreshold = Math.trunc(
    Number.isFinite(outputVirtualizationRowThreshold)
      ? outputVirtualizationRowThreshold
      : 200
  );
  const isOutputVirtualized =
    effectiveVirtualizationRowThreshold >= 0 &&
    (effectiveVirtualizationRowThreshold === 0 ||
      rows.length >= effectiveVirtualizationRowThreshold);

  const getEstimatedRowHeight = useCallback(
    (row: OutputRenderRow): number => {
      const baseEstimate = estimateOutputRowHeight(
        row,
        outputFontSize,
        outputContentWidth
      );
      const bucket = getRowHeightBucket(row);
      const bucketStats = rowHeightBucketStatsRef.current.get(bucket);
      if (
        !bucketStats ||
        bucketStats.sampleCount < 2 ||
        bucketStats.totalEstimated <= 0
      ) {
        return baseEstimate;
      }

      const averageScale =
        bucketStats.totalMeasured / bucketStats.totalEstimated;
      const clampedScale = clamp(
        averageScale,
        0.5,
        bucket.startsWith("structured-event:diff:") ? 3.5 : 3
      );
      const rawScaled = Math.round(baseEstimate * clampedScale * 100) / 100;
      if (bucket.startsWith("structured-event:diff:")) {
        return rawScaled;
      }
      return clamp(rawScaled, baseEstimate * 0.6, baseEstimate + 200);
    },
    [outputContentWidth, outputFontSize]
  );

  const getEstimatedRowHeightRef = useRef(getEstimatedRowHeight);
  getEstimatedRowHeightRef.current = getEstimatedRowHeight;

  const scheduleMeasurementVersionBump = useCallback(() => {
    if (measurementVersionFrameRef.current != null) {
      return;
    }

    measurementVersionFrameRef.current = requestAnimationFrame(() => {
      measurementVersionFrameRef.current = null;
      setMeasurementVersion((version) => version + 1);
    });
  }, []);

  const updateRowMeasurementCache = useCallback(
    (
      element: HTMLDivElement,
      measuredHeight: number,
      source: "dom-read" | "resize-observer"
    ): number => {
      const startedAt = isProfilingEnabled() ? performance.now() : 0;
      const index = Number(element.dataset.index ?? -1);
      const row = rowsRef.current[index];
      if (!row) return measuredHeight;

      const zeroHeightReason =
        row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT
          ? getZeroHeightStructuredEventReason(row)
          : null;
      if (
        (!Number.isFinite(measuredHeight) || measuredHeight <= 0) &&
        zeroHeightReason == null
      ) {
        // A row that legitimately renders nothing is handled below; anything
        // else reading 0 is a transient measurement — the pane is collapsed
        // (`display: none` zeroes every row), or the element was observed
        // before its first layout. Returning the raw 0 handed it straight to
        // `resizeItem`, which adopts whatever `measureElement` returns: the row
        // collapsed to nothing and its neighbours overlapped it until some
        // unrelated pass happened to remeasure. Report the size the row already
        // has instead, so a bogus read is a no-op rather than a regression.
        return (
          measurementCacheRef.current.get(row.key) ??
          getEstimatedRowHeightRef.current(row)
        );
      }

      const nextHeight =
        zeroHeightReason != null && measuredHeight <= 0 ? 0 : measuredHeight;
      const rowHeightBucket = getRowHeightBucket(row);
      const estimatedHeight = getEstimatedRowHeightRef.current(row);

      const previousHeight = measurementCacheRef.current.get(row.key);
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - nextHeight) < 1.0
      ) {
        if (startedAt > 0) {
          const durationMs = performance.now() - startedAt;
          if (shouldLogMeasurement(durationMs)) {
            logProfilerEvent("rowMeasurement:unchanged", {
              index,
              rowKey: row.key,
              rowKind: row.rowKind,
              bucket: rowHeightBucket,
              measuredHeight: nextHeight,
              estimatedHeight,
              source,
              durationMs,
            });
          }
        }
        return nextHeight;
      }

      // Deferring during a scroll is what keeps a measurement from reflowing the
      // pane under the user's finger — but a measurement taken *by the flush*
      // must never re-enter that queue. The flush is the only thing that drains
      // it, and it can legitimately run inside the grace window (its rAF chain
      // writes scrollTop, and the user can start scrolling again mid-flush), so
      // a re-pended row would be dropped and never offered again: its DOM size
      // has not changed, so no ResizeObserver entry is coming. That row then
      // keeps its *estimate* for as long as it stays mounted, which is exactly
      // the gap-above / clipped-below pair that survives after scrolling stops.
      const isScrolling =
        !isMeasurementFlushInProgressRef.current &&
        lastScrollEventAtRef.current != null &&
        performance.now() - lastScrollEventAtRef.current <
          OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
      if (isScrolling) {
        pendingMeasurementCacheRef.current.set(row.key, nextHeight);
        schedulePendingMeasurementFlushRef.current();
        return previousHeight !== undefined ? previousHeight : estimatedHeight;
      }

      measurementCacheRef.current.set(row.key, nextHeight);
      const previousBucketStats = rowHeightBucketStatsRef.current.get(
        rowHeightBucket
      ) ?? {
        sampleCount: 0,
        totalMeasured: 0,
        totalEstimated: 0,
        maxAbsDelta: 0,
      };
      rowHeightBucketStatsRef.current.set(rowHeightBucket, {
        sampleCount: previousBucketStats.sampleCount + 1,
        totalMeasured: previousBucketStats.totalMeasured + nextHeight,
        totalEstimated: previousBucketStats.totalEstimated + estimatedHeight,
        maxAbsDelta: Math.max(
          previousBucketStats.maxAbsDelta,
          Math.abs(nextHeight - estimatedHeight)
        ),
      });

      if (isProfilingEnabled()) {
        const absDelta = Math.abs(nextHeight - estimatedHeight);
        const pctDelta = estimatedHeight > 0 ? absDelta / estimatedHeight : 0;
        if (absDelta > 40 && pctDelta > 0.1) {
          const extras: Record<string, unknown> = {};
          if (
            row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
            row.event.type === CLI_EVENT_TYPES.TEXT
          ) {
            const text = (row.event.data as { text?: string }).text ?? "";
            extras.textLength = text.length;
            extras.hasTable = /^\|.+\|/m.test(text);
            extras.hasCodeBlock = text.includes("```");
            extras.hasList = /^\s*[-*+]\s/m.test(text);
            extras.textPreview = text.slice(0, 100).replace(/\n/g, "↵");
          } else if (
            row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
            (row.event.type === CLI_EVENT_TYPES.TOOL_CALL ||
              row.event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL)
          ) {
            const tc = row.event.data as {
              input?: unknown;
              name?: string;
              result?: unknown;
              tool?: string;
            };
            extras.toolName = tc.name ?? tc.tool ?? "unknown";
            extras.inputLength =
              tc.input != null ? JSON.stringify(tc.input).length : 0;
            extras.resultLength =
              tc.result != null ? JSON.stringify(tc.result).length : 0;
          } else if (
            row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
            row.event.type === CLI_EVENT_TYPES.BASH_COMMAND
          ) {
            const bc = row.event.data as {
              command?: string;
              error?: string;
              output?: string;
            };
            extras.outputLength = (bc.output ?? "").length;
            extras.errorLength = (bc.error ?? "").length;
          } else if (
            row.rowKind === OUTPUT_ROW_KINDS.CLI_COMMAND ||
            row.rowKind === OUTPUT_ROW_KINDS.SCRIPT_COMMAND
          ) {
            const fullText = `${row.workingDirectory || "workspace"}> ${row.command}`;
            extras.commandLength = fullText.length;
            extras.commandPreview = fullText.slice(0, 120).replace(/\n/g, "↵");
          }
          logProfilerEvent("rowEstimateOutlier", {
            rowKey: row.key,
            bucket: rowHeightBucket,
            measuredHeight: nextHeight,
            estimatedHeight,
            delta: nextHeight - estimatedHeight,
            pctDelta: Math.round(pctDelta * 100),
            ...extras,
          });
        }
      }

      if (startedAt > 0) {
        const durationMs = performance.now() - startedAt;
        if (shouldLogMeasurement(durationMs)) {
          logProfilerEvent("rowMeasurement:updated", {
            index,
            rowKey: row.key,
            rowKind: row.rowKind,
            bucket: rowHeightBucket,
            measuredHeight: nextHeight,
            estimatedHeight,
            delta: nextHeight - estimatedHeight,
            previousHeight,
            source,
            durationMs,
          });
        }
      }
      // When a row ABOVE THE ANCHOR changes height, its reflow shifts everything
      // below it — including the anchored content the user is looking at.
      // scheduleMeasurementVersionBump defers the corrective layout-effect to a
      // rAF, so the correction lands a frame AFTER TanStack's reflow has already
      // painted: the visible "jump then snap back" flash. For that case bump the
      // version synchronously so the correction batches with the reflow render
      // and lands in the SAME paint. Rows at or after the anchor cannot move it,
      // so they keep the batched rAF bump, and the flush path owns its own
      // (already synchronous) reconciliation.
      //
      // Every above-anchor resize takes the synchronous path, however small —
      // see shouldSyncMeasurementCorrection for why a magnitude threshold here
      // sets the flash amplitude without saving a render.
      //
      // The anchor's pinned position is read from the committed target rather
      // than from the anchor row's DOM rect: it is the offset the lock is about
      // to restore the row *to*, so it stays a fixed reference no matter how far
      // the in-flight reflow has already displaced the row — and it costs no
      // extra layout read.
      const scrollElement = outputRef.current;
      const heightDeltaPx = nextHeight - (previousHeight ?? estimatedHeight);
      const target = scrollTargetRef.current;
      if (
        !isMeasurementFlushInProgressRef.current &&
        scrollElement != null &&
        shouldSyncMeasurementCorrection({
          heightDeltaPx,
          rowTopPx: element.getBoundingClientRect().top,
          anchorTopPx:
            scrollElement.getBoundingClientRect().top +
            (target.kind === OUTPUT_SCROLL_TARGET_KINDS.ROW ||
            target.kind === OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY
              ? target.viewportOffsetPx
              : 0),
        })
      ) {
        setMeasurementVersion((version) => version + 1);
      } else {
        scheduleMeasurementVersionBump();
      }
      return nextHeight;
    },
    [
      isMeasurementFlushInProgressRef,
      lastScrollEventAtRef,
      outputRef,
      scheduleMeasurementVersionBump,
      scrollTargetRef,
    ]
  );

  const measureOutputRowElement = useCallback(
    (element: HTMLDivElement, entry?: ResizeObserverEntry): number => {
      const observerHeight = getResizeObserverEntryHeight(entry);
      const measuredHeight =
        observerHeight ?? getMeasuredElementHeight(element);
      return updateRowMeasurementCache(
        element,
        measuredHeight,
        observerHeight == null ? "dom-read" : "resize-observer"
      );
    },
    [updateRowMeasurementCache]
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => outputRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 48;
      return (
        measurementCacheRef.current.get(row.key) ?? getEstimatedRowHeight(row)
      );
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    measureElement: measureOutputRowElement,
    overscan: outputOverscan,
  });
  getVirtualItemsRef.current = () => rowVirtualizer.getVirtualItems();

  // The virtualizer must never compensate a size change itself: the anchor lock
  // in `useOutputScrollTarget` is the single owner of scrollTop.
  //
  // The two cannot coexist, because they act on different clocks. Rows are
  // absolutely positioned at `translateY(virtualRow.start)`, so a row growing
  // does not displace its siblings — the anchor row only moves once React
  // commits the new starts. The virtualizer's compensation runs from the
  // ResizeObserver, *before* that commit: it writes `scrollTop += delta` while
  // every row is still painted at its old offset, so the whole viewport visibly
  // slides by the delta. Hundreds of milliseconds later (a phone commit for this
  // pane runs 450-650ms) the re-render lands, the anchor row moves by the same
  // delta, and the layout-effect lock reads the settled DOM and puts it back.
  // That round trip is exactly the "jumps ~40px then jumps back a second later"
  // the profiler captured on 2026-08-12 23:36:33 — TanStack compensating +51.77
  // for row 479 while the lock applied -50.91 against a DOM that had not moved
  // yet, then chasing +391.7 and -632.43 as the commits caught up.
  //
  // The lock alone is complete and cannot overshoot: `measurementVersion` is in
  // `layoutApplyTrigger`, so every measurement round re-runs it, and it resolves
  // from the anchor row's own `getBoundingClientRect()` in a layout effect —
  // closed-loop against the committed DOM, pre-paint. A refused compensation
  // costs nothing: with no scrollTop write and no committed start change, the
  // viewport simply does not move.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) => {
    if (isProfilingEnabled() && Math.abs(delta) >= 40) {
      const target = scrollTargetRef.current;
      logProfilerEvent("scrollCorrection", {
        itemKey: item.key,
        itemIndex: item.index,
        delta,
        scrollTop: outputRef.current?.scrollTop ?? 0,
        targetRowIndex:
          target.kind === OUTPUT_SCROLL_TARGET_KINDS.ROW ||
          target.kind === OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY
            ? (rowIndexByKey.get(target.rowKey) ?? null)
            : null,
        overscan: outputOverscanRef.current,
        deferredToAnchorLock: true,
      });
    }
    return false;
  };

  // Wraps rowVirtualizer.measure() so the resulting burst of per-row size-change
  // notifications doesn't each trigger applyScrollTargetRef. The scroll target
  // is reconciled once, after the measure pass and its re-render have settled.
  const performBulkRemeasure = useCallback(() => {
    isBulkRemeasureInProgressRef.current = true;
    rowVirtualizer.measure();
    requestAnimationFrame(() => {
      isBulkRemeasureInProgressRef.current = false;
      applyScrollTargetRef.current("bulk-remeasure", { force: true });
    });
  }, [applyScrollTargetRef, rowVirtualizer]);

  const measureRowElement = useCallback(
    (element: HTMLDivElement | null): void | (() => void) => {
      if (!element) return;
      mountedRowElementsRef.current.add(element);
      rowVirtualizer.measureElement(element);
      return () => {
        mountedRowElementsRef.current.delete(element);
        rowVirtualizer.measureElement(null);
      };
    },
    [rowVirtualizer]
  );

  const measureStaticRowElement = useCallback(
    (element: HTMLDivElement | null): void | (() => void) => {
      if (!element) return;
      mountedRowElementsRef.current.add(element);

      const measure = (entry?: ResizeObserverEntry) => {
        const measuredHeight =
          getResizeObserverEntryHeight(entry) ??
          getMeasuredElementHeight(element);
        updateRowMeasurementCache(
          element,
          measuredHeight,
          entry == null ? "dom-read" : "resize-observer"
        );
      };

      measure();
      const resizeObserver = createAnimationFrameResizeObserver((entries) => {
        measure(entries[0]);
      });
      resizeObserver.observer.observe(element);

      return () => {
        mountedRowElementsRef.current.delete(element);
        resizeObserver.disconnect();
      };
    },
    [updateRowMeasurementCache]
  );

  // TanStack's `measureElement` silently skips its own `resizeItem` whenever it
  // believes a scroll is in flight — which is exactly the state the flush exists
  // to recover from. Feed the measurement to `resizeItem` directly instead, the
  // same path the live-row layout effect above uses, so a flush always lands.
  const applyRowMeasurement = useCallback(
    (element: HTMLDivElement) => {
      const index = Number(element.dataset.index ?? -1);
      if (index < 0 || index >= rowsRef.current.length) return;
      rowVirtualizer.resizeItem(index, measureOutputRowElement(element));
    },
    [measureOutputRowElement, rowVirtualizer]
  );

  const flushPendingScrollMeasurements = useCallback(() => {
    if (pendingMeasurementCacheRef.current.size === 0) return;
    isMeasurementFlushInProgressRef.current = true;
    if (isProfilingEnabled()) {
      logProfilerEvent("measurementFlush", {
        pendingCount: pendingMeasurementCacheRef.current.size,
        mountedCount: mountedRowElementsRef.current.size,
        targetKind: scrollTargetRef.current.kind,
        targetRowKey:
          scrollTargetRef.current.kind === OUTPUT_SCROLL_TARGET_KINDS.ROW ||
          scrollTargetRef.current.kind ===
            OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY
            ? scrollTargetRef.current.rowKey
            : undefined,
      });
    }

    // Drain before iterating, not after: the loop below re-enters
    // `updateRowMeasurementCache`, and clearing afterwards would discard
    // anything it queued while the flush was running.
    const pending = Array.from(pendingMeasurementCacheRef.current);
    pendingMeasurementCacheRef.current.clear();

    const elementsByRowKey = new Map<string, HTMLDivElement>();
    for (const element of mountedRowElementsRef.current) {
      const rowKey = element.dataset.rowKey;
      if (rowKey) elementsByRowKey.set(rowKey, element);
    }

    for (const [key, height] of pending) {
      const element = elementsByRowKey.get(key);
      if (element) {
        applyRowMeasurement(element);
      } else {
        measurementCacheRef.current.set(key, height);
      }
    }

    // Settling the scroll is also the moment to close the gap the deferral can
    // leave open. A row that mounted mid-scroll is observed by TanStack but not
    // measured (`measureElement` skips its own `resizeItem` while `isScrolling`),
    // and if its first ResizeObserver entry landed inside the grace window the
    // value went to the pending map rather than the cache. Either way the row is
    // on screen at an estimated height. Measuring the mounted rows that still
    // have no recorded measurement is bounded by the overscan window and makes
    // "rendered implies measured" true again by the time the pane comes to rest.
    for (const [rowKey, element] of elementsByRowKey) {
      if (measurementCacheRef.current.has(rowKey)) continue;
      applyRowMeasurement(element);
    }
    // Don't correct scrollTop on this synchronous path. measureElement above has
    // updated the virtualizer's measurementsCache, but the new row transforms
    // only paint on React's next commit — writing scrollTop now shifts the
    // viewport a frame before the rows reflow, which is the visible "jump then
    // snap back". Instead bump measurementVersion synchronously: it batches with
    // the virtualizer's own measurement-driven re-render, so layoutApplyTrigger
    // changes in the SAME render pass and the post-commit useLayoutEffect in
    // useOutputScrollTarget applies the correction in lockstep with the reflow.
    // The RAF chain below remains an idempotent safety net.
    setMeasurementVersion((version) => version + 1);
    requestAnimationFrame(() => {
      const firstFrameRestore = applyScrollTargetRef.current(
        "measurement-flush-raf-1"
      );
      requestAnimationFrame(() => {
        const secondFrameRestore = applyScrollTargetRef.current(
          "measurement-flush-raf-2"
        );

        requestAnimationFrame(() => {
          if (
            isProfilingEnabled() &&
            (!firstFrameRestore.resolved ||
              !secondFrameRestore.resolved ||
              Math.abs(firstFrameRestore.appliedDelta) >= 1 ||
              Math.abs(secondFrameRestore.appliedDelta) >= 1)
          ) {
            logProfilerEvent("measurementFlushTargetSettled", {
              target: scrollTargetRef.current,
              firstFrameApplied: firstFrameRestore.appliedDelta,
              secondFrameApplied: secondFrameRestore.appliedDelta,
              firstFrameResolved: firstFrameRestore.resolved,
              secondFrameResolved: secondFrameRestore.resolved,
              scrollTop: outputRef.current?.scrollTop,
            });
          }
          isMeasurementFlushInProgressRef.current = false;
        });
      });
    });
  }, [
    applyRowMeasurement,
    applyScrollTargetRef,
    isMeasurementFlushInProgressRef,
    outputRef,
    scrollTargetRef,
  ]);

  const schedulePendingMeasurementFlush = useCallback(() => {
    if (pendingMeasurementFlushTimerRef.current !== null) {
      clearTimeout(pendingMeasurementFlushTimerRef.current);
    }
    pendingMeasurementFlushTimerRef.current = setTimeout(() => {
      pendingMeasurementFlushTimerRef.current = null;
      flushPendingScrollMeasurements();
    }, OUTPUT_USER_SCROLL_INPUT_GRACE_MS + 50);
  }, [flushPendingScrollMeasurements]);
  schedulePendingMeasurementFlushRef.current = schedulePendingMeasurementFlush;

  useLayoutEffect(() => {
    if (outputCollapsed || !isOutputVirtualized) {
      return;
    }

    // A displayed historical run gets a post-load sweep below, but a live run
    // keeps the same render identity while stable-key rows receive new content.
    // Those rows do not remount, so their ref callback cannot provide the
    // deterministic post-commit measurement that newly realized rows get.
    //
    // Measure only the mounted set and feed the result directly to TanStack.
    // This keeps live and historical rows on the same measured-size path
    // without restoring the old per-append bulk sweep, whose forced scroll
    // target reconciliation caused the streaming snap-back regression.
    for (const element of mountedRowElementsRef.current) {
      if (!element.isConnected) {
        mountedRowElementsRef.current.delete(element);
        continue;
      }

      const index = Number(element.dataset.index ?? -1);
      if (index < 0 || index >= rows.length) {
        continue;
      }

      rowVirtualizer.resizeItem(index, measureOutputRowElement(element));
    }
  }, [
    isOutputVirtualized,
    measureOutputRowElement,
    outputCollapsed,
    rowVirtualizer,
    rows,
  ]);

  const measureMountedRowsAndRestoreTarget = useCallback(
    (phase: string) => {
      if (
        outputCollapsed ||
        !isOutputVirtualized ||
        mountedRowElementsRef.current.size === 0
      ) {
        return;
      }

      const now = performance.now();
      const hasRecentScrollEvent =
        lastScrollEventAtRef.current != null &&
        now - lastScrollEventAtRef.current < OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
      if (hasRecentScrollEvent) {
        return;
      }

      isBulkRemeasureInProgressRef.current = true;
      for (const element of mountedRowElementsRef.current.values()) {
        rowVirtualizer.measureElement(element);
      }

      requestAnimationFrame(() => {
        isBulkRemeasureInProgressRef.current = false;
        applyScrollTargetRef.current(phase, { force: true });
      });
    },
    [
      applyScrollTargetRef,
      isOutputVirtualized,
      lastScrollEventAtRef,
      outputCollapsed,
      rowVirtualizer,
    ]
  );

  const rowLayout: OutputRowLayoutModel = useMemo(
    () =>
      measurePhase(
        "rowLayout",
        {
          rows: rows.length,
          measurementVersion,
          overscan: outputOverscan,
          virtualizerTotalSize: rowVirtualizer.getTotalSize(),
        },
        () => {
          void measurementVersion;
          if (!isOutputVirtualized) {
            let offset = 0;
            const rowStartsByIndex: number[] = [];
            const rowStartsByKey = new Map<string, number>();
            const rowSizesByKey = new Map<string, number>();

            for (const [index, row] of rows.entries()) {
              const size =
                measurementCacheRef.current.get(row.key) ??
                getEstimatedRowHeight(row);
              rowStartsByIndex[index] = offset;
              rowStartsByKey.set(row.key, offset);
              rowSizesByKey.set(row.key, size);
              offset += size;
            }

            return {
              totalSize: Math.max(offset, 1),
              rowStartsByIndex,
              rowStartsByKey,
              rowSizesByKey,
            };
          }

          let fallbackOffset = 0;
          const rowStartsByIndex: number[] = [];
          const rowStartsByKey = new Map<string, number>();
          const rowSizesByKey = new Map<string, number>();
          const measurementsByKey = new Map(
            rowVirtualizer.measurementsCache
              .filter((item): item is NonNullable<typeof item> => item != null)
              .map((item) => [String(item.key), item] as const)
          );

          for (const [index, row] of rows.entries()) {
            const measurement =
              measurementsByKey.get(row.key) ??
              rowVirtualizer.measurementsCache[index];
            const size =
              measurement?.size ??
              measurementCacheRef.current.get(row.key) ??
              getEstimatedRowHeight(row);
            const start = measurement?.start ?? fallbackOffset;
            rowStartsByIndex[index] = start;
            rowStartsByKey.set(row.key, start);
            rowSizesByKey.set(row.key, size);
            fallbackOffset = start + size;
          }

          return {
            totalSize: Math.max(
              rowVirtualizer.getTotalSize(),
              fallbackOffset,
              1
            ),
            rowStartsByIndex,
            rowStartsByKey,
            rowSizesByKey,
          };
        }
      ),
    [
      getEstimatedRowHeight,
      isOutputVirtualized,
      rows,
      measurementVersion,
      outputContentWidth,
      outputFontSize,
      outputOverscan,
      rowVirtualizer,
    ]
  );

  const previousIsOutputVirtualized = useRef(isOutputVirtualized);
  useEffect(() => {
    if (previousIsOutputVirtualized.current === isOutputVirtualized) {
      return;
    }
    previousIsOutputVirtualized.current = isOutputVirtualized;
    pendingMeasurementCacheRef.current.clear();
    measurementCacheRef.current.clear();
    setMeasurementVersion((v) => v + 1);
    if (isOutputVirtualized) {
      performBulkRemeasure();
    }
  }, [isOutputVirtualized, performBulkRemeasure]);

  useEffect(() => {
    if (nonVirtualRenderFrameRef.current !== null) {
      cancelAnimationFrame(nonVirtualRenderFrameRef.current);
      nonVirtualRenderFrameRef.current = null;
    }
    if (nonVirtualRenderTimerRef.current !== null) {
      clearTimeout(nonVirtualRenderTimerRef.current);
      nonVirtualRenderTimerRef.current = null;
    }

    const shouldStageRows =
      !isOutputVirtualized && rows.length >= NON_VIRTUAL_STAGING_ROW_THRESHOLD;

    if (!shouldStageRows) {
      nonVirtualPrevRowCountRef.current = rows.length;
      nonVirtualRenderedRowCountRef.current = Number.MAX_SAFE_INTEGER;
      setNonVirtualRenderedRowCount(Number.MAX_SAFE_INTEGER);
      return;
    }

    const previousIdentity = nonVirtualRenderIdentityRef.current;
    const identityChanged = previousIdentity !== rowRenderIdentity;
    nonVirtualRenderIdentityRef.current = rowRenderIdentity;

    const previousRowCount = nonVirtualPrevRowCountRef.current;
    nonVirtualPrevRowCountRef.current = rows.length;

    const wasCaughtUp =
      !identityChanged &&
      nonVirtualRenderedRowCountRef.current >= previousRowCount;

    if (wasCaughtUp) {
      // This effect only reran because rows.length changed, most commonly a
      // single streamed event appended at the tail while already fully
      // rendered. Extend synchronously instead of restarting the chunked
      // catch-up flow below — deferring even a 1-row append via rAF is what
      // caused the "Rendering output..." overlay to flash on every streamed
      // event.
      nonVirtualRenderedRowCountRef.current = rows.length;
      setNonVirtualRenderedRowCount(rows.length);
      return;
    }

    const initialCount = identityChanged
      ? Math.min(rows.length, NON_VIRTUAL_INITIAL_RENDER_ROWS)
      : Math.min(rows.length, nonVirtualRenderedRowCountRef.current);
    nonVirtualRenderedRowCountRef.current = initialCount;
    setNonVirtualRenderedRowCount(initialCount);

    nonVirtualRenderTimerRef.current = setTimeout(() => {
      nonVirtualRenderTimerRef.current = null;
      const renderNextChunk = () => {
        const next = Math.min(
          rows.length,
          nonVirtualRenderedRowCountRef.current + NON_VIRTUAL_RENDER_CHUNK_ROWS
        );
        nonVirtualRenderedRowCountRef.current = next;
        setNonVirtualRenderedRowCount(next);
        if (next < rows.length) {
          nonVirtualRenderFrameRef.current =
            requestAnimationFrame(renderNextChunk);
        } else {
          nonVirtualRenderFrameRef.current = null;
        }
      };

      nonVirtualRenderFrameRef.current = requestAnimationFrame(renderNextChunk);
    }, 0);
  }, [isOutputVirtualized, rowRenderIdentity, rows.length]);

  useEffect(() => {
    if (outputCollapsed || !isOutputVirtualized) {
      return;
    }

    requestAnimationFrame(() => {
      performBulkRemeasure();
    });
    // rows.length is intentionally excluded. rowVirtualizer.measure() clears
    // itemSizeCache and re-estimates every row from bucket estimates; doing
    // that on every appended row can momentarily mismatch dozens of
    // already-rendered rows at once. New rows are measured individually as
    // they mount, so a full re-measure is only needed when the output pane
    // transitions from collapsed back into view (the output/terminal tab
    // switch keeps the pane's layout size via visibility, so it doesn't need
    // this). A row-render identity change also means the row structure or its
    // measurements changed (for example, a step filter toggle), so it must
    // take this same bulk-remeasure path. performBulkRemeasure suppresses the
    // per-row scroll-correction cascade from that mismatch (error #185) and
    // reconciles the scroll target once afterward.
  }, [
    isOutputVirtualized,
    outputCollapsed,
    performBulkRemeasure,
    rowRenderIdentity,
  ]);

  const hasAnyRows = rows.length > 0;

  useEffect(() => {
    if (postLoadRemeasureFrameRef.current !== null) {
      cancelAnimationFrame(postLoadRemeasureFrameRef.current);
      postLoadRemeasureFrameRef.current = null;
    }
    if (postLoadRemeasureTimerRef.current !== null) {
      clearTimeout(postLoadRemeasureTimerRef.current);
      postLoadRemeasureTimerRef.current = null;
    }

    if (outputCollapsed || !isOutputVirtualized || !hasAnyRows) {
      return;
    }

    postLoadRemeasureFrameRef.current = requestAnimationFrame(() => {
      postLoadRemeasureFrameRef.current = null;
      measureMountedRowsAndRestoreTarget("post-load-remeasure");

      postLoadRemeasureTimerRef.current = setTimeout(() => {
        postLoadRemeasureTimerRef.current = null;
        measureMountedRowsAndRestoreTarget("post-load-remeasure-settle");
      }, POST_LOAD_REMEASURE_DELAY_MS);
    });
    // Keyed on `hasAnyRows`, never on `rows.length` — for the same reason the
    // bulk-remeasure effect above excludes it, but with sharper teeth here: this
    // pass remeasures every mounted row and then applies the scroll target with
    // `force: true`, bypassing the recent-user-scroll grace. Running it per
    // appended row meant that during streaming, every new row at the tail
    // re-measured the rows the user was actually looking at hundreds of rows
    // above and force-wrote scrollTop right after they stopped scrolling — the
    // "scrolls a bit and snaps back" glitch. Genuinely new rows are measured
    // individually as they mount; a sweep is only needed when the displayed run
    // changes or output first appears.
  }, [
    hasAnyRows,
    isOutputVirtualized,
    measureMountedRowsAndRestoreTarget,
    outputCollapsed,
    rowRenderIdentity,
  ]);

  const hasOutput = hasAnyRows;
  const nonVirtualVisibleRowCount = isOutputVirtualized
    ? rows.length
    : Math.min(rows.length, nonVirtualRenderedRowCount);
  const nonVirtualRows = isOutputVirtualized
    ? rows
    : rows.slice(0, nonVirtualVisibleRowCount);
  const lastNonVirtualRow = nonVirtualRows[nonVirtualRows.length - 1];
  const nonVirtualRenderedHeight = lastNonVirtualRow
    ? (rowLayout.rowStartsByKey.get(lastNonVirtualRow.key) ?? 0) +
      (rowLayout.rowSizesByKey.get(lastNonVirtualRow.key) ??
        getEstimatedRowHeight(lastNonVirtualRow))
    : 0;
  const nonVirtualSpacerHeight = Math.max(
    0,
    rowLayout.totalSize - nonVirtualRenderedHeight
  );
  const isNonVirtualOutputStaging =
    !isOutputVirtualized &&
    hasOutput &&
    nonVirtualVisibleRowCount < rows.length;
  const isOutputScrollSeeking =
    isOutputVirtualized && scrollSeekPlaceholderActive;
  const virtualRows: VirtualItem[] = isOutputVirtualized
    ? rowVirtualizer.getVirtualItems()
    : [];

  useEffect(() => {
    if (!isOutputVirtualized || !shouldLogVirtualRange()) {
      return;
    }

    const first = virtualRows[0];
    const last = virtualRows[virtualRows.length - 1];
    const signature = `${first?.index ?? -1}:${last?.index ?? -1}:${virtualRows.length}:${rows.length}`;
    if (signature === lastVirtualRangeRef.current) {
      return;
    }

    lastVirtualRangeRef.current = signature;
    logProfilerEvent("virtualRange", {
      firstIndex: first?.index ?? null,
      lastIndex: last?.index ?? null,
      virtualRows: virtualRows.length,
      overscan: outputOverscan,
      scrollSeekPlaceholder: isOutputScrollSeeking,
      totalRows: rows.length,
      totalSize: rowVirtualizer.getTotalSize(),
    });
  }, [
    isOutputScrollSeeking,
    isOutputVirtualized,
    outputOverscan,
    rowVirtualizer,
    rows.length,
    virtualRows,
  ]);

  const handleOutputProfilerRender = useCallback(
    (
      id: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number
    ) => {
      const profilerState = getProfilerState();
      if (
        !profilerState.enabled ||
        actualDuration < profilerState.slowThresholdMs
      ) {
        return;
      }

      logProfilerEvent("reactCommit", {
        id,
        phase,
        actualDuration,
        baseDuration,
        renderToCommitGap: commitTime - startTime,
        virtualRows: virtualRows.length,
        overscan: outputOverscan,
        scrollSeekPlaceholder: isOutputScrollSeeking,
        scrollSeekRestorePendingMs:
          scrollSeekRestoreRequestedAtRef.current != null
            ? commitTime - scrollSeekRestoreRequestedAtRef.current
            : undefined,
        totalRows: rows.length,
        measurementVersion,
      });
    },
    [
      isOutputScrollSeeking,
      measurementVersion,
      outputOverscan,
      rows.length,
      scrollSeekRestoreRequestedAtRef,
      virtualRows.length,
    ]
  );

  const getRowEstimateStats = useCallback(() => {
    return Array.from(rowHeightBucketStatsRef.current.entries())
      .filter(([, s]) => s.sampleCount > 0)
      .map(([bucket, s]) => ({
        bucket,
        n: s.sampleCount,
        avgMeasured: Math.round(s.totalMeasured / s.sampleCount),
        avgEstimated: Math.round(s.totalEstimated / s.sampleCount),
        avgDelta: Math.round(
          (s.totalMeasured - s.totalEstimated) / s.sampleCount
        ),
        maxAbsDelta: Math.round(s.maxAbsDelta),
        scaleFactor:
          s.totalEstimated > 0
            ? Math.round((s.totalMeasured / s.totalEstimated) * 100) / 100
            : null,
      }))
      .sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
  }, []);

  const clearMeasurements = useCallback(() => {
    pendingMeasurementCacheRef.current.clear();
    measurementCacheRef.current.clear();
    setMeasurementVersion((v) => v + 1);
  }, []);

  const hasPendingMeasurements = useCallback(
    () => pendingMeasurementCacheRef.current.size > 0,
    []
  );

  const invalidateMeasuredRow = useCallback(
    (rowKey: string) => {
      measurementCacheRef.current.delete(rowKey);
      rowVirtualizer.measure();
      setMeasurementVersion((version) => version + 1);
    },
    [rowVirtualizer]
  );

  const invalidateMeasuredRowForUserResize = useCallback(
    (rowKey: string) => {
      measurementCacheRef.current.delete(rowKey);

      requestAnimationFrame(() => {
        const nextScrollElement = outputRef.current;
        if (!nextScrollElement) {
          setMeasurementVersion((version) => version + 1);
          return;
        }

        const nextRowElement = findRenderedRowElementByKey(
          nextScrollElement,
          rowKey
        );
        if (!nextRowElement) {
          rowVirtualizer.measure();
          setMeasurementVersion((version) => version + 1);
          return;
        }

        rowVirtualizer.measureElement(nextRowElement);
        setMeasurementVersion((version) => version + 1);

        requestAnimationFrame(() => {
          applyScrollTargetRef.current("row-resize", { force: true });
        });
      });
    },
    [applyScrollTargetRef, outputRef, rowVirtualizer]
  );

  useEffect(
    () => () => {
      if (measurementVersionFrameRef.current != null) {
        cancelAnimationFrame(measurementVersionFrameRef.current);
        measurementVersionFrameRef.current = null;
      }
      if (pendingMeasurementFlushTimerRef.current !== null) {
        clearTimeout(pendingMeasurementFlushTimerRef.current);
        pendingMeasurementFlushTimerRef.current = null;
      }
      isProgrammaticScrollRef.current = false;
      if (postLoadRemeasureFrameRef.current !== null) {
        cancelAnimationFrame(postLoadRemeasureFrameRef.current);
        postLoadRemeasureFrameRef.current = null;
      }
      if (postLoadRemeasureTimerRef.current !== null) {
        clearTimeout(postLoadRemeasureTimerRef.current);
        postLoadRemeasureTimerRef.current = null;
      }
      if (nonVirtualRenderFrameRef.current !== null) {
        cancelAnimationFrame(nonVirtualRenderFrameRef.current);
        nonVirtualRenderFrameRef.current = null;
      }
      if (nonVirtualRenderTimerRef.current !== null) {
        clearTimeout(nonVirtualRenderTimerRef.current);
        nonVirtualRenderTimerRef.current = null;
      }
    },
    []
  );

  return {
    clearMeasurements,
    flushPendingScrollMeasurements,
    getEstimatedRowHeight,
    getRowEstimateStats,
    hasPendingMeasurements,
    handleOutputProfilerRender,
    isNonVirtualOutputStaging,
    isOutputScrollSeeking,
    isOutputVirtualized,
    measureRowElement,
    measureStaticRowElement,
    measurementVersion,
    measurementVersionRef,
    nonVirtualRows,
    nonVirtualSpacerHeight,
    rowLayout,
    rowVirtualizer,
    rowsRef,
    schedulePendingMeasurementFlush,
    setMeasurementVersion,
    virtualRows,
    invalidateMeasuredRow,
    invalidateMeasuredRowForUserResize,
  };
}
