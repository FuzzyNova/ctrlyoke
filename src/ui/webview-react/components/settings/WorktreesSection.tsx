import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
  WorktreeManagementEntry,
} from "@root/types/WebviewMessageTypes";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  WORKTREE_MODES,
  WORKTREE_LIFECYCLE_OWNERS,
  WORKTREE_UI_STATUSES,
  WORKTREE_MANAGEMENT_ACTIONS,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useSettingsStore } from "@store/settingsStore";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { ResetConfirmModal } from "../shared/ResetConfirmModal";
import { ActionButton, type ActionFeedback } from "../shared/ActionButton";

const CONFIRMATION_VARIANTS = {
  DELETE: "delete",
  RESET: "reset",
} as const;

type ConfirmationVariant =
  (typeof CONFIRMATION_VARIANTS)[keyof typeof CONFIRMATION_VARIANTS];

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

let requestIdCounter = 0;
function generateRequestId(key: string): string {
  requestIdCounter += 1;
  return `${key}:${Date.now()}:${requestIdCounter}`;
}

/**
 * A destructive/recoverable action awaiting user confirmation, rendered via
 * `DeleteConfirmModal`/`ResetConfirmModal`. `window.confirm` is not usable
 * here: VS Code's webview iframe sandbox omits `allow-modals`, so native
 * `confirm()` calls resolve to `false` immediately with no dialog shown —
 * every confirm-gated button silently no-op'd instead of prompting.
 */
interface PendingConfirmRequest {
  variant: ConfirmationVariant;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  onConfirm: () => void;
}

type RequestConfirm = (request: PendingConfirmRequest) => void;

/**
 * Tracks the round trip for worktree management buttons: a click marks a key
 * "pending" (spinner, disabled), and once the extension's reply lands in
 * `settingsStore.worktreeActionResults` (correlated by requestId), the button
 * flashes success/error text below itself and clears after a delay.
 * `begin(key, count)` supports fan-out actions like bulk cleanup, which fire
 * one request per branch but resolve as a single button state.
 */
function useWorktreeActionFeedback() {
  const results = useSettingsStore((state) => state.worktreeActionResults);
  const clearResult = useSettingsStore(
    (state) => state.clearWorktreeActionResult
  );
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<Record<string, ActionFeedback>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    for (const [key, requestIds] of Object.entries(pending)) {
      const collected = requestIds.map((id) => results[id]);
      if (collected.some((result) => !result)) continue;

      const resolved = collected as { success: boolean; message: string }[];
      const succeeded = resolved.filter((result) => result.success).length;
      const success = succeeded === resolved.length;
      const message =
        resolved.length === 1
          ? resolved[0].message
          : success
            ? `${succeeded} of ${resolved.length} succeeded.`
            : `${succeeded} of ${resolved.length} succeeded — ${resolved
                .filter((result) => !result.success)
                .map((result) => result.message)
                .join(" ")}`;

      setFeedback((prev) => ({
        ...prev,
        [key]: {
          status: success
            ? USER_FEEDBACK_SEVERITY.SUCCESS
            : USER_FEEDBACK_SEVERITY.ERROR,
          message,
        },
      }));
      setPending((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      for (const id of requestIds) clearResult(id);

      clearTimeout(timersRef.current[key]);
      timersRef.current[key] = setTimeout(
        () =>
          setFeedback((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          }),
        success ? 4000 : 8000
      );
    }
  }, [results, pending, clearResult]);

  useEffect(
    () => () => {
      for (const timer of Object.values(timersRef.current)) clearTimeout(timer);
    },
    []
  );

  const begin = useCallback((key: string, count = 1): string[] => {
    const requestIds = Array.from({ length: count }, () =>
      generateRequestId(key)
    );
    clearTimeout(timersRef.current[key]);
    setPending((prev) => ({ ...prev, [key]: requestIds }));
    setFeedback((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    return requestIds;
  }, []);

  const isPending = useCallback((key: string) => key in pending, [pending]);
  const getFeedback = useCallback(
    (key: string): ActionFeedback | undefined => feedback[key],
    [feedback]
  );

  return { begin, isPending, getFeedback };
}

type WorktreeActionFeedback = ReturnType<typeof useWorktreeActionFeedback>;

function sendAction(
  vscode: ReturnType<typeof useVsCodeApi>,
  action: string,
  requestId: string,
  entry?: WorktreeManagementEntry,
  confirmed = false
): void {
  vscode.postMessage({
    type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION,
    action,
    requestId,
    ...(entry?.worktreePath ? { worktreePath: entry.worktreePath } : {}),
    ...(entry?.branchName ? { branchName: entry.branchName } : {}),
    confirmed,
  });
}

function normalizeWorktreePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
}

/** Shared by the per-row Sync button and the section-level Sync All orchestrator. */
function isSyncEligible(
  entry: WorktreeManagementEntry,
  sourceCheckoutRoot?: string
): boolean {
  const isSourceCheckout =
    !!sourceCheckoutRoot &&
    normalizeWorktreePath(entry.worktreePath) ===
      normalizeWorktreePath(sourceCheckoutRoot);
  return (
    entry.ownership === WORKTREE_LIFECYCLE_OWNERS.USER &&
    !isSourceCheckout &&
    !entry.inUse &&
    !entry.stale &&
    !!entry.branchName &&
    entry.branchState === WORKTREE_UI_STATUSES.BRANCH_PRESENT
  );
}

function worktreeRowKey(worktreePath: string, suffix: string): string {
  return `${worktreePath}::${suffix}`;
}

/**
 * Resolves once `requestId`'s result lands in `settingsStore.worktreeActionResults`.
 * Deliberately does not clear the result — `useWorktreeActionFeedback`'s own
 * effect (driven by a `begin()` call with the same requestId) owns that, so a
 * caller here can ride the same round trip a row's own button already tracks.
 */
function waitForWorktreeResult(
  requestId: string
): Promise<{ success: boolean; message: string }> {
  const existing = useSettingsStore.getState().worktreeActionResults[requestId];
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const unsubscribe = useSettingsStore.subscribe((state) => {
      const result = state.worktreeActionResults[requestId];
      if (result) {
        unsubscribe();
        resolve(result);
      }
    });
  });
}

/** Machine-level checkout placement settings and explicit worktree management. */
export function WorktreesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const vscode = useVsCodeApi();
  const management = useSettingsStore((state) => state.worktreeManagement);
  const confirmDeleteOperations = useSettingsStore(
    (state) => state.globalSettings.confirmDeleteOperations
  );
  const confirmResetOperations = useSettingsStore(
    (state) => state.globalSettings.confirmResetOperations
  );
  const feedback = useWorktreeActionFeedback();
  const [pendingConfirm, setPendingConfirm] =
    useState<PendingConfirmRequest | null>(null);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [syncAllPending, setSyncAllPending] = useState(false);
  const [syncAllFeedback, setSyncAllFeedback] = useState<
    ActionFeedback | undefined
  >(undefined);
  const syncAllTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  useEffect(() => () => clearTimeout(syncAllTimerRef.current), []);
  const sources = settings.sources as Record<string, SettingSource>;
  const configuredRoot = settings.settings.worktrees.root.trim();
  const userScopeOnly = activeScope === SETTING_SCOPES.WORKSPACE;
  const effectiveRoot =
    management?.resolvedRoot ??
    (configuredRoot || "Automatic repository worktree root");
  const effectiveTier = configuredRoot
    ? "User-configured root"
    : "Automatic: repository sibling, then user fallback";

  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE,
    });
  }, [vscode]);

  const safeBranches = useMemo(
    () =>
      (management?.entries ?? [])
        .filter((entry) => entry.branchCleanupEligible && entry.branchName)
        .map((entry) => entry.branchName!),
    [management]
  );

  useEffect(() => {
    setSelectedBranches(safeBranches);
  }, [safeBranches]);

  const refresh = () => {
    const [requestId] = feedback.begin("refresh");
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE,
      refresh: true,
      requestId,
    });
  };

  const bulkCleanup = () => {
    const targets = selectedBranches
      .map((branchName) =>
        management?.entries.find(
          (candidate) => candidate.branchName === branchName
        )
      )
      .filter((entry): entry is WorktreeManagementEntry => Boolean(entry));
    if (!targets.length) return;
    const requestIds = feedback.begin("bulk-cleanup", targets.length);
    targets.forEach((entry, index) =>
      sendAction(
        vscode,
        WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH,
        requestIds[index],
        entry
      )
    );
  };

  const prune = () => {
    const [requestId] = feedback.begin("prune");
    sendAction(
      vscode,
      WORKTREE_MANAGEMENT_ACTIONS.PRUNE,
      requestId,
      undefined,
      true
    );
  };

  const syncEligibleEntries = useMemo(
    () =>
      (management?.entries ?? []).filter((entry) =>
        isSyncEligible(entry, management?.sourceCheckoutRoot)
      ),
    [management]
  );

  /**
   * Merging branch-into-source then source-into-branch for each eligible
   * branch (in display order) leaves earlier branches missing changes from
   * branches synced after them — the source only picks up branch N's
   * changes once branch N runs. A second pass over every branch except the
   * last, walked in reverse, is then a no-op merge-into-source (already a
   * subset) plus a real source-into-branch that picks up everything: after
   * the forward pass the source already holds every branch's changes, so
   * one reverse pass is provably sufficient regardless of branch count.
   */
  const doSyncAll = async () => {
    if (!management) return;
    const sourceCheckoutRoot = management.sourceCheckoutRoot;
    const order = management.entries
      .filter((entry) => isSyncEligible(entry, sourceCheckoutRoot))
      .map((entry) => entry.worktreePath);
    if (!order.length) return;
    const sequence =
      order.length > 1
        ? [...order, ...[...order].slice(0, -1).reverse()]
        : order;

    setSyncAllPending(true);
    setSyncAllFeedback(undefined);
    clearTimeout(syncAllTimerRef.current);

    let attempted = 0;
    let succeeded = 0;
    const failures: string[] = [];

    for (const worktreePath of sequence) {
      const latest = useSettingsStore.getState().worktreeManagement;
      const entry = latest?.entries.find(
        (candidate) => candidate.worktreePath === worktreePath
      );
      if (!entry || !isSyncEligible(entry, latest?.sourceCheckoutRoot)) {
        continue;
      }
      attempted += 1;
      const [requestId] = feedback.begin(worktreeRowKey(worktreePath, "sync"));
      vscode.postMessage({
        type: MESSAGE_TYPES.SYNC_NAMED_WORKTREE,
        worktreePath,
        requestId,
      });
      const result = await waitForWorktreeResult(requestId);
      if (result.success) {
        succeeded += 1;
      } else {
        failures.push(
          `"${entry.branchName ?? worktreePath}": ${result.message}`
        );
      }
    }

    setSyncAllPending(false);
    const success = failures.length === 0;
    const message =
      attempted === 0
        ? "Nothing to sync."
        : success
          ? `Synced ${succeeded} of ${attempted} branch${attempted === 1 ? "" : "es"}.`
          : `Synced ${succeeded} of ${attempted} — ${failures.join(" ")}`;
    setSyncAllFeedback({
      status: success
        ? USER_FEEDBACK_SEVERITY.SUCCESS
        : USER_FEEDBACK_SEVERITY.ERROR,
      message,
    });
    syncAllTimerRef.current = setTimeout(
      () => setSyncAllFeedback(undefined),
      success ? 4000 : 8000
    );
  };

  const syncAll = () => {
    if (!syncEligibleEntries.length) return;
    if (!confirmResetOperations) {
      void doSyncAll();
      return;
    }
    setPendingConfirm({
      variant: CONFIRMATION_VARIANTS.RESET,
      title: "Sync All Worktrees",
      message: `Sync all ${syncEligibleEntries.length} worktree${
        syncEligibleEntries.length === 1 ? "" : "s"
      } with "${management?.sourceCheckoutBranch ?? "the source checkout"}"?`,
      detail:
        "Each branch merges into the source checkout, then the source checkout merges back into it, in order — then the same runs in reverse (skipping the last branch) so earlier branches pick up changes from later ones. A branch that can't merge cleanly is skipped and reported; the rest still run.",
      confirmLabel: "Sync All",
      onConfirm: doSyncAll,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-1 tracking-wide">
          Worktrees
        </h3>
        <p className="text-xs text-description-fg">
          Worktree directories are shared machine configuration. The resolver
          tries a configured root first, then the repository sibling, then the
          user fallback when the earlier location is unavailable.
        </p>
      </div>

      <SettingInputRow
        settingKey="worktrees.root"
        id="worktrees-root"
        sources={sources}
        onReset={onReset}
        activeScope={activeScope}
      >
        <LocalTextInput
          id="worktrees-root"
          value={settings.settings.worktrees.root}
          onCommit={(value) => onUpdate("worktrees.root", value)}
          disabled={userScopeOnly}
          placeholder="Automatic"
          className="w-full bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border disabled:opacity-60 disabled:cursor-not-allowed"
        />
        {userScopeOnly && (
          <p className="text-xs text-warning-fg mt-1" role="note">
            Worktree root is user-scoped and cannot be changed from workspace
            scope. Switch the scope selector to User to edit it.
          </p>
        )}
      </SettingInputRow>

      <div className="border-t border-panel-border pt-4">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs text-description-fg">Effective root</span>
          <span className="text-xxs text-description-fg">
            ({effectiveTier})
          </span>
        </div>
        <div
          id="worktrees-effective-root"
          role="status"
          className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1 text-sm text-description-fg font-mono break-all"
        >
          {effectiveRoot}
        </div>
      </div>

      <section
        aria-labelledby="manage-worktrees-heading"
        className="border-t border-panel-border pt-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <h4
              id="manage-worktrees-heading"
              className="text-sm font-semibold text-foreground"
            >
              Manage Worktrees
            </h4>
            <p className="text-xs text-description-fg">
              Ownership, leases, branches, and retention actions.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <ActionButton
              label={`Sync All with ${management?.sourceCheckoutBranch ?? "checkout"}`}
              pendingLabel="Syncing all…"
              disabled={!syncEligibleEntries.length}
              pending={syncAllPending}
              feedback={syncAllFeedback}
              onClick={syncAll}
            />
            <ActionButton
              label="Refresh"
              pendingLabel="Refreshing…"
              pending={feedback.isPending("refresh")}
              feedback={feedback.getFeedback("refresh")}
              onClick={refresh}
            />
          </div>
        </div>

        {management?.entries.length ? (
          <div className="mt-3 space-y-2">
            {management.entries.map((entry) => (
              <WorktreeRow
                key={`${entry.worktreePath}:${entry.branchName ?? "detached"}`}
                entry={entry}
                vscode={vscode}
                feedback={feedback}
                confirmDeleteOperations={confirmDeleteOperations}
                confirmResetOperations={confirmResetOperations}
                requestConfirm={setPendingConfirm}
                sourceCheckoutRoot={management.sourceCheckoutRoot}
                sourceCheckoutBranch={management.sourceCheckoutBranch}
              />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-description-fg">
            No linked worktrees were discovered.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton
            label={`Clean up safe merged branches (${selectedBranches.length})`}
            pendingLabel="Cleaning up…"
            disabled={!selectedBranches.length}
            pending={feedback.isPending("bulk-cleanup")}
            feedback={feedback.getFeedback("bulk-cleanup")}
            onClick={bulkCleanup}
          />
          <ActionButton
            label="Prune stale Git entries"
            pendingLabel="Pruning…"
            pending={feedback.isPending("prune")}
            feedback={feedback.getFeedback("prune")}
            onClick={prune}
          />
        </div>
        <p className="mt-2 text-xs text-description-fg">
          Safe cleanup preselects only ctrlyoke-owned, inactive branches proven
          merged into their recorded target. Squash and rebase merges stay
          explicit.
        </p>
      </section>

      <DeleteConfirmModal
        isOpen={pendingConfirm?.variant === CONFIRMATION_VARIANTS.DELETE}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const request = pendingConfirm;
          setPendingConfirm(null);
          request?.onConfirm();
        }}
        title={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.DELETE
            ? pendingConfirm.title
            : ""
        }
        message={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.DELETE
            ? pendingConfirm.message
            : ""
        }
        detail={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.DELETE
            ? pendingConfirm.detail
            : undefined
        }
      />
      <ResetConfirmModal
        isOpen={pendingConfirm?.variant === CONFIRMATION_VARIANTS.RESET}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const request = pendingConfirm;
          setPendingConfirm(null);
          request?.onConfirm();
        }}
        title={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.RESET
            ? pendingConfirm.title
            : ""
        }
        message={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.RESET
            ? pendingConfirm.message
            : ""
        }
        detail={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.RESET
            ? pendingConfirm.detail
            : undefined
        }
        confirmLabel={
          pendingConfirm?.variant === CONFIRMATION_VARIANTS.RESET
            ? pendingConfirm.confirmLabel
            : undefined
        }
      />
    </div>
  );
}

function WorktreeRow({
  entry,
  vscode,
  feedback,
  confirmDeleteOperations,
  confirmResetOperations,
  requestConfirm,
  sourceCheckoutRoot,
  sourceCheckoutBranch,
}: {
  entry: WorktreeManagementEntry;
  vscode: ReturnType<typeof useVsCodeApi>;
  feedback: WorktreeActionFeedback;
  confirmDeleteOperations: boolean;
  confirmResetOperations: boolean;
  requestConfirm: RequestConfirm;
  sourceCheckoutRoot?: string;
  sourceCheckoutBranch?: string | null;
}) {
  const rowKey = (suffix: string) => worktreeRowKey(entry.worktreePath, suffix);
  const owner = entry.inUse
    ? `In use — ${entry.leaseOwners.map((item) => `${item.lease.workflowKey}/${item.lease.runRef}`).join(", ")}`
    : entry.ownership === WORKTREE_MODES.MANAGED
      ? "ctrlyoke-owned"
      : "user-owned";
  const retry = () => {
    const [requestId] = feedback.begin(rowKey("retry"));
    vscode.postMessage({
      type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE,
      refresh: true,
      requestId,
    });
  };
  const doRemove = () => {
    const [requestId] = feedback.begin(rowKey("remove"));
    sendAction(
      vscode,
      WORKTREE_MANAGEMENT_ACTIONS.REMOVE,
      requestId,
      entry,
      true
    );
  };
  const remove = () => {
    if (!confirmDeleteOperations) {
      doRemove();
      return;
    }
    requestConfirm({
      variant: CONFIRMATION_VARIANTS.DELETE,
      title: "Remove Worktree",
      message: `Remove worktree "${entry.worktreePath}"?`,
      onConfirm: doRemove,
    });
  };
  const doForceRemove = () => {
    const [requestId] = feedback.begin(rowKey("force-remove"));
    sendAction(
      vscode,
      WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE,
      requestId,
      entry,
      true
    );
  };
  const forceRemove = () => {
    if (!confirmDeleteOperations) {
      doForceRemove();
      return;
    }
    requestConfirm({
      variant: CONFIRMATION_VARIANTS.DELETE,
      title: "Force Remove Worktree",
      message: `Force remove worktree "${entry.worktreePath}"?`,
      detail: "Uncommitted work in this worktree may be lost.",
      onConfirm: doForceRemove,
    });
  };
  const cleanupBranch = (confirmed: boolean) => {
    const [requestId] = feedback.begin(rowKey("cleanup-branch"));
    sendAction(
      vscode,
      WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH,
      requestId,
      entry,
      confirmed
    );
  };
  const deleteBranchWithConfirm = () => {
    if (!confirmDeleteOperations) {
      cleanupBranch(true);
      return;
    }
    requestConfirm({
      variant: CONFIRMATION_VARIANTS.DELETE,
      title: "Delete Branch",
      message: `Delete branch "${entry.branchName}"?`,
      detail: "This cannot be undone by ctrlyoke.",
      onConfirm: () => cleanupBranch(true),
    });
  };
  const repair = () => {
    const [requestId] = feedback.begin(rowKey("repair"));
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.REPAIR, requestId, entry);
  };
  const canSync = isSyncEligible(entry, sourceCheckoutRoot);
  const doSync = () => {
    const [requestId] = feedback.begin(rowKey("sync"));
    vscode.postMessage({
      type: MESSAGE_TYPES.SYNC_NAMED_WORKTREE,
      worktreePath: entry.worktreePath,
      requestId,
    });
  };
  const sync = () => {
    if (!confirmResetOperations) {
      doSync();
      return;
    }
    requestConfirm({
      variant: CONFIRMATION_VARIANTS.RESET,
      title: "Sync Worktree",
      message: `Sync "${entry.branchName}" with "${sourceCheckoutBranch ?? "the source checkout"}"?`,
      detail: `This merges "${entry.branchName}" into "${sourceCheckoutBranch ?? "the checked-out branch"}", then merges that branch back into "${entry.branchName}" — the same two commands you'd otherwise run by hand.`,
      confirmLabel: "Sync",
      onConfirm: doSync,
    });
  };
  return (
    <div
      className={`rounded-sm border p-2 text-xs ${entry.inUse ? "border-warning-fg" : "border-panel-border"}`}
    >
      <div className="font-mono break-all text-foreground">
        {entry.worktreePath}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-description-fg">
        <span>Owner: {owner}</span>
        <span>
          Branch: {entry.branchName ?? "detached"} ({entry.branchState})
        </span>
        <span>
          {entry.prunableReason
            ? `Prunable: ${entry.prunableReason}`
            : entry.stale
              ? "Stale admin entry"
              : entry.directoryState === WORKTREE_UI_STATUSES.DIRECTORY_REMOVED
                ? "Directory removed"
                : "Git entry present"}
        </span>
      </div>
      {entry.inUse && (
        <div className="mt-1 text-warning-fg">
          Retry after the owner releases it, or open the owning workspace from
          its run.
        </div>
      )}
      {entry.divergence && (
        <div className="mt-1 text-description-fg">
          {entry.branchName} — {entry.divergence.ahead} ahead,{" "}
          {entry.divergence.behind} behind {entry.divergence.comparisonLabel}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {entry.inUse && entry.leaseOwners[0] && (
          <>
            <ActionButton
              label="Retry"
              pendingLabel="Retrying…"
              pending={feedback.isPending(rowKey("retry"))}
              feedback={feedback.getFeedback(rowKey("retry"))}
              onClick={retry}
            />
            <button
              type="button"
              className="cy-select-trigger text-xs"
              onClick={() =>
                vscode.postMessage({
                  type: MESSAGE_TYPES.OPEN_WORKTREE_OWNER,
                  stateRoot: entry.leaseOwners[0].lease.stateRoot,
                })
              }
            >
              Open owning workspace
            </button>
          </>
        )}
        {canSync && (
          <ActionButton
            label={`Sync with ${sourceCheckoutBranch ?? "checkout"}`}
            pendingLabel="Syncing…"
            pending={feedback.isPending(rowKey("sync"))}
            feedback={feedback.getFeedback(rowKey("sync"))}
            onClick={sync}
          />
        )}
        {entry.branchCleanupEligible && entry.branchName && (
          <ActionButton
            label="Delete merged branch"
            pendingLabel="Deleting…"
            pending={feedback.isPending(rowKey("cleanup-branch"))}
            feedback={feedback.getFeedback(rowKey("cleanup-branch"))}
            onClick={() => cleanupBranch(false)}
          />
        )}
        {entry.ownership === WORKTREE_MODES.MANAGED &&
          entry.branchName &&
          entry.branchState === WORKTREE_UI_STATUSES.BRANCH_PRESENT &&
          !entry.branchCleanupEligible &&
          !entry.inUse &&
          !entry.stale && (
            <ActionButton
              label="Delete branch…"
              pendingLabel="Deleting…"
              pending={feedback.isPending(rowKey("cleanup-branch"))}
              feedback={feedback.getFeedback(rowKey("cleanup-branch"))}
              onClick={deleteBranchWithConfirm}
            />
          )}
        {entry.ownership === WORKTREE_MODES.MANAGED &&
          entry.directoryState !== WORKTREE_UI_STATUSES.DIRECTORY_REMOVED && (
            <ActionButton
              label="Remove"
              pendingLabel="Removing…"
              disabled={entry.inUse}
              pending={feedback.isPending(rowKey("remove"))}
              feedback={feedback.getFeedback(rowKey("remove"))}
              onClick={remove}
            />
          )}
        {entry.ownership === WORKTREE_MODES.MANAGED &&
          entry.directoryState !== WORKTREE_UI_STATUSES.DIRECTORY_REMOVED && (
            <ActionButton
              label="Force remove"
              pendingLabel="Force removing…"
              disabled={entry.inUse}
              pending={feedback.isPending(rowKey("force-remove"))}
              feedback={feedback.getFeedback(rowKey("force-remove"))}
              onClick={forceRemove}
            />
          )}
        {entry.stale && (
          <ActionButton
            label="Repair entry"
            pendingLabel="Repairing…"
            pending={feedback.isPending(rowKey("repair"))}
            feedback={feedback.getFeedback(rowKey("repair"))}
            onClick={repair}
          />
        )}
      </div>
    </div>
  );
}
