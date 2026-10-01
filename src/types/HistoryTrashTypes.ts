import type {
  HistoryTrashAction,
  HistoryTrashEntryKind,
} from "./DashboardConstants";
import type { RunRef, WorkflowKey } from "./CtrlYokeTypes";

/**
 * One lineage's share of a Recently deleted entry. `wholeLineage` means the
 * lineage directory itself (descriptor, draft, every run) was moved; otherwise
 * only the listed runs were, and the lineage stayed in `.runs`.
 */
export interface HistoryTrashItem {
  workflowKey: WorkflowKey;
  workflowName: string;
  wholeLineage: boolean;
  runRefs: RunRef[];
  /** Display run IDs, parallel to `runRefs` where known. */
  runIds: number[];
}

/** The persisted `entry.json` of one Recently deleted entry. */
export interface HistoryTrashEntry {
  schemaVersion: number;
  id: string;
  kind: HistoryTrashEntryKind;
  deletedAt: number;
  /** `webview`, `browser:<id>`, or `cli` — whoever asked for the delete. */
  requestedBy: string;
  items: HistoryTrashItem[];
  /** Lineages a bulk delete left in place because they were live. */
  skippedLive: WorkflowKey[];
  bytes: number;
}

/** A Recently deleted entry as the dashboard lists it. */
export interface HistoryTrashEntrySummary extends HistoryTrashEntry {
  expiresAt: number;
}

/** What Clear all history would do right now. */
export interface HistoryClearPreview {
  lineageCount: number;
  runCount: number;
  bytes: number;
  /** Lineages that will be kept because a run of theirs is live. */
  liveLineages: { workflowKey: WorkflowKey; workflowName: string }[];
}

/** What restoring one entry did. */
export interface HistoryTrashRestoreResult {
  restoredLineages: number;
  restoredRuns: number;
  /** Lineages whose history was restored. */
  restoredWorkflowKeys: WorkflowKey[];
  /** Paths that could not go back because something now occupies them. */
  conflicts: string[];
}

/** What a single trash/restore/purge call did, for toasts and the CLI. */
export interface HistoryTrashOutcome {
  action: HistoryTrashAction;
  entryId?: string;
  ok: boolean;
  message: string;
}
