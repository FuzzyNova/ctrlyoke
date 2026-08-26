import { create } from "zustand";
import {
  RUN_SUMMARY_CACHE_STATUSES,
  type RunSummaryCacheStatus,
} from "@root/types/DashboardConstants";
import { MESSAGE_TYPES } from "../types/messages";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";
import type { WorkflowKey, RunRef } from "@root/types/CtrlYokeTypes";
import { sendMessage } from "../hooks/useMessageHandler";

let requestSequence = 0;

interface RunSummaryCacheEntry {
  status: RunSummaryCacheStatus;
  requestId: string;
  runSummaries: RunSummary[];
  descriptorRevision: number;
  lastModifiedAt: number;
  executionRunRef?: RunRef;
  error?: string;
}

interface RunSummaryCacheState {
  /** Keyed by workflowKey. Session-lifetime only — never persisted. */
  entries: Record<string, RunSummaryCacheEntry>;

  /**
   * Fetches another lineage's run list for the run-panel drill-in, unless a
   * request is already in flight or a cached entry is at least as fresh as
   * `knownLastModifiedAt` (the caller's own view of the lineage — typically
   * the workflow-list row's `lastModifiedAt`). Safe to call on every render;
   * it no-ops once a fresh/loading entry exists.
   */
  ensureRunSummaries: (
    workflowKey: WorkflowKey,
    knownLastModifiedAt?: number
  ) => void;
  /** Applies a RUN_SUMMARIES_LOADED response, ignoring late replies to a superseded request. */
  resolveRunSummaries: (message: {
    requestId: string;
    workflowKey: WorkflowKey;
    descriptorRevision: number;
    lastModifiedAt: number;
    runSummaries: RunSummary[];
    executionRunRef?: RunRef;
  }) => void;
  /** Applies a WORKFLOW_ACTION_FAILED reply keyed by requestId to whichever entry is awaiting it. */
  resolveRunSummariesError: (requestId: string, error: string) => void;
  /** Drops a cached entry so the next `ensureRunSummaries` call re-fetches. */
  invalidate: (workflowKey: WorkflowKey) => void;
}

export const useRunSummaryCacheStore = create<RunSummaryCacheState>(
  (set, get) => ({
    entries: {},

    ensureRunSummaries: (workflowKey, knownLastModifiedAt) => {
      const existing = get().entries[workflowKey];
      const isFreshEnough =
        existing?.status === RUN_SUMMARY_CACHE_STATUSES.LOADED &&
        (knownLastModifiedAt === undefined ||
          existing.lastModifiedAt >= knownLastModifiedAt);
      if (
        existing?.status === RUN_SUMMARY_CACHE_STATUSES.LOADING ||
        isFreshEnough
      ) {
        return;
      }

      requestSequence += 1;
      const requestId = `run-summaries-${Date.now()}-${requestSequence}`;
      set((state) => ({
        entries: {
          ...state.entries,
          [workflowKey]: {
            status: RUN_SUMMARY_CACHE_STATUSES.LOADING,
            requestId,
            runSummaries: existing?.runSummaries ?? [],
            descriptorRevision: existing?.descriptorRevision ?? 0,
            lastModifiedAt: existing?.lastModifiedAt ?? 0,
            executionRunRef: existing?.executionRunRef,
          },
        },
      }));
      sendMessage(MESSAGE_TYPES.LOAD_RUN_SUMMARIES, {
        requestId,
        workflowKey,
      });
    },

    resolveRunSummaries: (message) =>
      set((state) => {
        const existing = state.entries[message.workflowKey];
        // Reject only while genuinely waiting on a *different* in-flight
        // request — a superseded ensureRunSummaries() call. A push that
        // arrives unsolicited (e.g. the server proactively refreshing this
        // lineage's listing after a delete) has no matching request to
        // correlate against and must still be accepted, or a drilled panel's
        // summaries would never reflect a delete it didn't itself request.
        if (
          existing?.status === RUN_SUMMARY_CACHE_STATUSES.LOADING &&
          existing.requestId !== message.requestId
        ) {
          return state;
        }
        return {
          entries: {
            ...state.entries,
            [message.workflowKey]: {
              status: RUN_SUMMARY_CACHE_STATUSES.LOADED,
              requestId: message.requestId,
              runSummaries: message.runSummaries,
              descriptorRevision: message.descriptorRevision,
              lastModifiedAt: message.lastModifiedAt,
              executionRunRef: message.executionRunRef,
            },
          },
        };
      }),

    resolveRunSummariesError: (requestId, error) =>
      set((state) => {
        const workflowKey = Object.keys(state.entries).find(
          (key) =>
            state.entries[key].requestId === requestId &&
            state.entries[key].status === RUN_SUMMARY_CACHE_STATUSES.LOADING
        );
        if (!workflowKey) return state;
        return {
          entries: {
            ...state.entries,
            [workflowKey]: {
              ...state.entries[workflowKey],
              status: RUN_SUMMARY_CACHE_STATUSES.ERROR,
              error,
            },
          },
        };
      }),

    invalidate: (workflowKey) =>
      set((state) => {
        if (!(workflowKey in state.entries)) return state;
        const next = { ...state.entries };
        delete next[workflowKey];
        return { entries: next };
      }),
  })
);
