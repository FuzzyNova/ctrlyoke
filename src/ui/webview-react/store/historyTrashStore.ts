import { create } from "zustand";
import type {
  HistoryClearPreview,
  HistoryTrashEntrySummary,
} from "@root/types/HistoryTrashTypes";

/** Recently deleted as the host last reported it. */
export interface HistoryTrashListing {
  entries: HistoryTrashEntrySummary[];
  retentionDays: number;
  totalBytes: number;
}

/** The Clear all history preview for one request. */
export interface HistoryClearPreviewState {
  requestId: string;
  preview?: HistoryClearPreview;
  error?: string;
}

interface HistoryTrashState {
  /** Undefined until the first HISTORY_TRASH_LIST arrives. */
  listing?: HistoryTrashListing;
  /** Undefined until a preview is requested; `preview`/`error` fill in on reply. */
  clearPreview?: HistoryClearPreviewState;
  /** Entry ids with a restore/purge in flight, so their buttons can disable. */
  pendingEntryIds: readonly string[];
  setListing: (listing: HistoryTrashListing) => void;
  requestClearPreview: (requestId: string) => void;
  receiveClearPreview: (reply: HistoryClearPreviewState) => void;
  clearClearPreview: () => void;
  markEntryPending: (entryId: string) => void;
  clearEntryPending: (entryId: string) => void;
}

const NO_PENDING: readonly string[] = [];

/** Recently deleted listing and the Clear all history preview. Not persisted. */
export const useHistoryTrashStore = create<HistoryTrashState>((set) => ({
  listing: undefined,
  clearPreview: undefined,
  pendingEntryIds: NO_PENDING,
  setListing: (listing) =>
    set((state) => ({
      listing,
      // Entries that left the list are no longer in flight.
      pendingEntryIds: state.pendingEntryIds.filter((id) =>
        listing.entries.some((entry) => entry.id === id)
      ),
    })),
  requestClearPreview: (requestId) => set({ clearPreview: { requestId } }),
  receiveClearPreview: (reply) =>
    set((state) =>
      state.clearPreview?.requestId === reply.requestId
        ? { clearPreview: reply }
        : state
    ),
  clearClearPreview: () => set({ clearPreview: undefined }),
  markEntryPending: (entryId) =>
    set((state) =>
      state.pendingEntryIds.includes(entryId)
        ? state
        : { pendingEntryIds: [...state.pendingEntryIds, entryId] }
    ),
  clearEntryPending: (entryId) =>
    set((state) =>
      state.pendingEntryIds.includes(entryId)
        ? {
            pendingEntryIds: state.pendingEntryIds.filter(
              (id) => id !== entryId
            ),
          }
        : state
    ),
}));
