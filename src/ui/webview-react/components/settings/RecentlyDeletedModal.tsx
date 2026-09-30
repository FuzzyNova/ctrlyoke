import { useEffect, useState } from "react";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { TypedConfirmModal } from "../shared/TypedConfirmModal";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useHistoryTrashStore } from "@store/historyTrashStore";
import { formatBytes } from "@utils/number";
import { formatRelativeTimeVerbose } from "@utils/time";
import { describeTrashEntry } from "@root/utils/HistoryTrashDescriptions";
import {
  EMPTY_TRASH_CONFIRMATION_PHRASE,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type { HistoryTrashEntrySummary } from "@root/types/HistoryTrashTypes";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LISTED_WORKFLOWS = 3;

function daysLeft(entry: HistoryTrashEntrySummary, now: number): string {
  const days = Math.max(0, Math.ceil((entry.expiresAt - now) / DAY_MS));
  return days <= 1 ? "Removed within a day" : `${days} days left`;
}

/** Names the workflows a multi-workflow entry holds, e.g. "a, b, c, and 4 more". */
function listedWorkflows(entry: HistoryTrashEntrySummary): string | null {
  if (entry.items.length < 2) return null;
  const names = entry.items
    .slice(0, MAX_LISTED_WORKFLOWS)
    .map((item) => item.workflowName)
    .join(", ");
  const more = entry.items.length - MAX_LISTED_WORKFLOWS;
  return more > 0 ? `${names}, and ${more} more` : names;
}

interface RowProps {
  entry: HistoryTrashEntrySummary;
  now: number;
  pending: boolean;
  onRestore: (entryId: string) => void;
  onPurge: (entryId: string) => void;
}

function RecentlyDeletedRow({
  entry,
  now,
  pending,
  onRestore,
  onPurge,
}: RowProps) {
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const workflows = listedWorkflows(entry);
  const description = describeTrashEntry(entry);

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 border-b border-panel-border last:border-b-0"
      aria-label={description}
    >
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-sm text-foreground break-words">{description}</div>
        {workflows && (
          <div className="text-xs text-description-fg break-words">
            {workflows}
          </div>
        )}
        <div className="text-xs text-description-fg">
          Deleted{" "}
          {formatRelativeTimeVerbose(entry.deletedAt, now)?.toLowerCase()} ·{" "}
          {formatBytes(entry.bytes)} · {daysLeft(entry, now)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirmingPurge ? (
          <>
            <span className="text-xs text-description-fg">Delete forever?</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingPurge(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirmingPurge(false);
                onPurge(entry.id);
              }}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmingPurge(true)}
            >
              Delete forever
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={() => onRestore(entry.id)}
            >
              Restore
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** Recently deleted runs and workflows: restore, delete one forever, or empty. */
export function RecentlyDeletedModal({ isOpen, onClose }: Props) {
  const vscode = useVsCodeApi();
  const listing = useHistoryTrashStore((state) => state.listing);
  const pendingEntryIds = useHistoryTrashStore(
    (state) => state.pendingEntryIds
  );
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const now = Date.now();

  useEffect(() => {
    if (isOpen) {
      vscode.postMessage({ type: MESSAGE_TYPES.HISTORY_TRASH_LIST_REQUEST });
    }
  }, [isOpen, vscode]);

  const postEntryAction = (
    type:
      | typeof MESSAGE_TYPES.HISTORY_TRASH_RESTORE
      | typeof MESSAGE_TYPES.HISTORY_TRASH_PURGE,
    entryId: string
  ) => {
    useHistoryTrashStore.getState().markEntryPending(entryId);
    vscode.postMessage({ type, entryId });
  };

  const entries = listing?.entries ?? [];

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Recently Deleted"
        size="lg"
        fullWidthOnNarrow
        headerSubtitle={
          listing
            ? `${entries.length} ${entries.length === 1 ? "item" : "items"} · ${formatBytes(listing.totalBytes)} · removed after ${listing.retentionDays} days`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={entries.length === 0}
              onClick={() => setConfirmingEmpty(true)}
            >
              Empty Recently deleted
            </Button>
            <Button variant="primary" size="md" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        {!listing ? (
          <p className="text-sm text-description-fg" role="status">
            Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-description-fg" role="status">
            Nothing here. Deleted runs and workflows appear here until they
            expire.
          </p>
        ) : (
          <ul aria-label="Recently deleted items">
            {entries.map((entry) => (
              <RecentlyDeletedRow
                key={entry.id}
                entry={entry}
                now={now}
                pending={pendingEntryIds.includes(entry.id)}
                onRestore={(entryId) =>
                  postEntryAction(MESSAGE_TYPES.HISTORY_TRASH_RESTORE, entryId)
                }
                onPurge={(entryId) =>
                  postEntryAction(MESSAGE_TYPES.HISTORY_TRASH_PURGE, entryId)
                }
              />
            ))}
          </ul>
        )}
      </Modal>
      <TypedConfirmModal
        isOpen={confirmingEmpty}
        title="Empty Recently Deleted"
        phrase={EMPTY_TRASH_CONFIRMATION_PHRASE}
        confirmLabel="Delete forever"
        onCancel={() => setConfirmingEmpty(false)}
        onConfirm={() => {
          setConfirmingEmpty(false);
          vscode.postMessage({
            type: MESSAGE_TYPES.HISTORY_TRASH_EMPTY,
            confirmation: EMPTY_TRASH_CONFIRMATION_PHRASE,
          });
        }}
      >
        <p>
          Permanently delete all {entries.length}{" "}
          {entries.length === 1 ? "item" : "items"} in Recently deleted? This
          cannot be undone.
        </p>
      </TypedConfirmModal>
    </>
  );
}
