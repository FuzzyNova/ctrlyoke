import type {
  WorkspaceEntry,
  WorkspaceEntrySort,
  WorkspaceEntrySortDirection,
  WorkspaceEntrySortKey,
} from "../types/HostedWorkspaceViewerTypes";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "../types/HostedWorkspaceViewerTypes";
import { WorkspaceTreeBadRequestError } from "./WorkspaceTreeErrors";

/** Normalize an optional or runtime-originating sort selection. */
export function normalizeWorkspaceEntrySort(
  sort: WorkspaceEntrySort | undefined
): WorkspaceEntrySort {
  if (sort === undefined) return DEFAULT_WORKSPACE_ENTRY_SORT;
  if (!isSortKey(sort.key) || !isSortDirection(sort.direction)) {
    throw new WorkspaceTreeBadRequestError("sort selection is invalid");
  }
  return { key: sort.key, direction: sort.direction };
}

/** Compare entries according to the complete server-side workspace contract. */
export function compareWorkspaceEntries(
  left: WorkspaceEntry,
  right: WorkspaceEntry,
  sort: WorkspaceEntrySort
): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  if (sort.key === WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT) {
    const leftModifiedAt = left.modifiedAt;
    const rightModifiedAt = right.modifiedAt;
    const leftKnown = leftModifiedAt !== undefined;
    const rightKnown = rightModifiedAt !== undefined;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && leftModifiedAt !== rightModifiedAt) {
      const comparison = leftModifiedAt < rightModifiedAt ? -1 : 1;
      return sort.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
        ? comparison
        : -comparison;
    }
    return left.name.localeCompare(right.name);
  }

  const comparison = left.name.localeCompare(right.name);
  return sort.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
    ? comparison
    : -comparison;
}

/** Return a sorted copy, preserving the caller's entry array. */
export function sortWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  sort: WorkspaceEntrySort
): WorkspaceEntry[] {
  return [...entries].sort((left, right) =>
    compareWorkspaceEntries(left, right, sort)
  );
}

function isSortKey(value: unknown): value is WorkspaceEntrySortKey {
  return (
    value === WORKSPACE_ENTRY_SORT_KEYS.NAME ||
    value === WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT
  );
}

function isSortDirection(value: unknown): value is WorkspaceEntrySortDirection {
  return (
    value === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING ||
    value === WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING
  );
}
