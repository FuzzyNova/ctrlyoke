import { useCallback, useImperativeHandle, useMemo, useState } from "react";
import type { Ref, RefObject } from "react";
import type {
  DiffFileListCommand,
  DiffFileListHandle,
} from "@components/diff/DiffFileList";
import type { DiffGapExpansionState } from "@utils/outputRenderUtils";

/** Attribute a paged diff list puts on each realized card's wrapper. */
export const PAGED_DIFF_FILE_KEY_ATTRIBUTE = "data-diff-file-key";

interface PagedOverride<T> {
  listingId: string | null;
  version: number;
  value: T;
}

export interface PagedDiffListAnchor {
  index: number;
  viewportOffset: number;
}

export interface PagedDiffListState {
  /** Row to restore after an Expand/Collapse all command, if one was captured. */
  anchorRestore: PagedDiffListAnchor | null;
  collapsedFor: (key: string) => boolean;
  setCollapsed: (key: string, collapsed: boolean) => void;
  expandedGapsFor: (key: string) => DiffGapExpansionState;
  expandGap: (
    key: string,
    gapIndex: number,
    nextExpandedToLine: number
  ) => void;
}

const EMPTY_EXPANDED_GAPS: DiffGapExpansionState = new Map();

/**
 * Per-card collapse and gap state for a virtualized, paged diff list.
 *
 * Cards unmount when they scroll out of the window, so the list, not the card,
 * owns this state. An override only applies to the listing and Expand/Collapse
 * all command it was made under; everything else follows `command.collapsed`,
 * which is what makes pages loaded after an Expand all arrive expanded.
 */
export function usePagedDiffListState(
  ref: Ref<DiffFileListHandle>,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  listingId: string | null,
  command: DiffFileListCommand
): PagedDiffListState {
  const [collapsedOverrides, setCollapsedOverrides] = useState(
    new Map<string, PagedOverride<boolean>>()
  );
  const [expandedGapsOverrides, setExpandedGapsOverrides] = useState(
    new Map<string, PagedOverride<DiffGapExpansionState>>()
  );
  const [anchorRestore, setAnchorRestore] =
    useState<PagedDiffListAnchor | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      prepareGlobalLayoutChange: () => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const containerRect = container.getBoundingClientRect();
        const visibleFiles = container.querySelectorAll<HTMLElement>(
          `[${PAGED_DIFF_FILE_KEY_ATTRIBUTE}]`
        );
        for (const file of visibleFiles) {
          const fileRect = file.getBoundingClientRect();
          if (
            fileRect.bottom > containerRect.top &&
            fileRect.top < containerRect.bottom
          ) {
            const row = file.closest<HTMLElement>("[data-index]");
            const index = Number(row?.dataset.index);
            if (Number.isSafeInteger(index)) {
              setAnchorRestore({
                index,
                viewportOffset: fileRect.top - containerRect.top,
              });
            }
            return;
          }
        }
        setAnchorRestore(null);
      },
    }),
    [scrollContainerRef]
  );

  const isCurrent = useCallback(
    <T>(override: PagedOverride<T> | undefined): override is PagedOverride<T> =>
      override !== undefined &&
      override.listingId === listingId &&
      override.version === command.version,
    [command.version, listingId]
  );

  const collapsedFor = useCallback(
    (key: string): boolean => {
      const override = collapsedOverrides.get(key);
      return isCurrent(override) ? override.value : command.collapsed;
    },
    [collapsedOverrides, command.collapsed, isCurrent]
  );

  const setCollapsed = useCallback(
    (key: string, collapsed: boolean): void =>
      setCollapsedOverrides((previous) => {
        const next = new Map(previous);
        next.set(key, {
          listingId,
          version: command.version,
          value: collapsed,
        });
        return next;
      }),
    [command.version, listingId]
  );

  const expandedGapsFor = useCallback(
    (key: string): DiffGapExpansionState => {
      const override = expandedGapsOverrides.get(key);
      return isCurrent(override) ? override.value : EMPTY_EXPANDED_GAPS;
    },
    [expandedGapsOverrides, isCurrent]
  );

  const expandGap = useCallback(
    (key: string, gapIndex: number, nextExpandedToLine: number): void =>
      setExpandedGapsOverrides((previous) => {
        const existing = previous.get(key);
        const expandedGaps = new Map(existing?.value);
        expandedGaps.set(gapIndex, nextExpandedToLine);
        const next = new Map(previous);
        next.set(key, {
          listingId,
          version: command.version,
          value: expandedGaps,
        });
        return next;
      }),
    [command.version, listingId]
  );

  return useMemo(
    () => ({
      anchorRestore,
      collapsedFor,
      setCollapsed,
      expandedGapsFor,
      expandGap,
    }),
    [anchorRestore, collapsedFor, expandGap, expandedGapsFor, setCollapsed]
  );
}
