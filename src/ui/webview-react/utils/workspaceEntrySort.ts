import type {
  WorkspaceEntrySort,
  WorkspaceEntrySortKey,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
} from "@root/types/HostedWorkspaceViewerTypes";

/**
 * Return the sort selection produced by activating a workspace-entry header.
 * Inactive keys choose their product default; the active key reverses its
 * current direction.
 */
export function nextWorkspaceEntrySort(
  current: WorkspaceEntrySort,
  requestedKey: WorkspaceEntrySortKey
): WorkspaceEntrySort {
  if (current.key !== requestedKey) {
    return {
      key: requestedKey,
      direction:
        requestedKey === WORKSPACE_ENTRY_SORT_KEYS.NAME
          ? WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
          : WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
    };
  }

  return {
    key: current.key,
    direction:
      current.direction === WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING
        ? WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING
        : WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
  };
}
