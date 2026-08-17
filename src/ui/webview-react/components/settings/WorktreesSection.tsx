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
  WORKTREE_MANAGEMENT_ACTIONS,
} from "@root/types/DashboardConstants";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useSettingsStore } from "@store/settingsStore";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { DeleteConfirmModal } from "../shared/DeleteConfirmModal";
import { ResetConfirmModal } from "../shared/ResetConfirmModal";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

function formatAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return "—";
  const days = Math.floor(ageMs / 86_400_000);
  if (days > 0) return `${days}d old`;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours > 0) return `${hours}h old`;
  return `${Math.max(1, Math.floor(ageMs / 60_000))}m old`;
}

let requestIdCounter = 0;
function generateRequestId(key: string): string {
  requestIdCounter += 1;
  return `${key}:${Date.now()}:${requestIdCounter}`;
}

interface ActionFeedback {
  status: "success" | "error";
  message: string;
}

/**
 * A destructive/recoverable action awaiting user confirmation, rendered via
 * `DeleteConfirmModal`/`ResetConfirmModal`. `window.confirm` is not usable
 * here: VS Code's webview iframe sandbox omits `allow-modals`, so native
 * `confirm()` calls resolve to `false` immediately with no dialog shown —
 * every confirm-gated button silently no-op'd instead of prompting.
 */
interface PendingConfirmRequest {
  variant: "delete" | "reset";
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
  const clearResult = useSettingsStore((state) => state.clearWorktreeActionResult);
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
        [key]: { status: success ? "success" : "error", message },
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
    const requestIds = Array.from({ length: count }, () => generateRequestId(key));
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

function ActionButton({
  label,
  pendingLabel,
  onClick,
  disabled,
  pending,
  feedback,
}: {
  label: string;
  pendingLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  pending: boolean;
  feedback?: ActionFeedback;
}) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        className="fp-select-trigger text-xs inline-flex items-center gap-1"
        disabled={disabled || pending}
        onClick={onClick}
      >
        {pending && (
          <i className="codicon codicon-loading codicon-modifier-spin text-xxs" />
        )}
        {pending ? (pendingLabel ?? label) : label}
      </button>
      {feedback && (
        <span
          className={`text-xxs ${feedback.status === "success" ? "text-indicator-success" : "text-error-fg"}`}
          role="status"
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}

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
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmRequest | null>(null);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
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
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE });
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
        management?.entries.find((candidate) => candidate.branchName === branchName)
      )
      .filter((entry): entry is WorktreeManagementEntry => Boolean(entry));
    if (!targets.length) return;
    const requestIds = feedback.begin("bulk-cleanup", targets.length);
    targets.forEach((entry, index) =>
      sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH, requestIds[index], entry)
    );
  };

  const prune = () => {
    const [requestId] = feedback.begin("prune");
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.PRUNE, requestId, undefined, true);
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
        label="Worktree root"
        description="Absolute or ~-prefixed directory where named worktrees are placed."
        id="worktrees-root"
        path="worktrees.root"
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
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border disabled:opacity-60 disabled:cursor-not-allowed"
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
          <span className="text-xxs text-description-fg">({effectiveTier})</span>
        </div>
        <div id="worktrees-effective-root" role="status" className="w-full rounded border border-input-border bg-input-bg px-2 py-1 text-sm text-description-fg font-mono break-all">
          {effectiveRoot}
        </div>
      </div>

      <section aria-labelledby="manage-worktrees-heading" className="border-t border-panel-border pt-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 id="manage-worktrees-heading" className="text-sm font-semibold text-foreground">Manage Worktrees</h4>
            <p className="text-xs text-description-fg">Ownership, leases, branches, and retention actions.</p>
          </div>
          <ActionButton
            label="Refresh"
            pendingLabel="Refreshing…"
            pending={feedback.isPending("refresh")}
            feedback={feedback.getFeedback("refresh")}
            onClick={refresh}
          />
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
          <p className="mt-3 text-xs text-description-fg">No linked worktrees were discovered.</p>
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
          Safe cleanup preselects only ctrlyoke-owned, inactive branches proven merged into their recorded target. Squash and rebase merges stay explicit.
        </p>
      </section>

      <DeleteConfirmModal
        isOpen={pendingConfirm?.variant === "delete"}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const request = pendingConfirm;
          setPendingConfirm(null);
          request?.onConfirm();
        }}
        title={pendingConfirm?.variant === "delete" ? pendingConfirm.title : ""}
        message={pendingConfirm?.variant === "delete" ? pendingConfirm.message : ""}
        detail={pendingConfirm?.variant === "delete" ? pendingConfirm.detail : undefined}
      />
      <ResetConfirmModal
        isOpen={pendingConfirm?.variant === "reset"}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const request = pendingConfirm;
          setPendingConfirm(null);
          request?.onConfirm();
        }}
        title={pendingConfirm?.variant === "reset" ? pendingConfirm.title : ""}
        message={pendingConfirm?.variant === "reset" ? pendingConfirm.message : ""}
        detail={pendingConfirm?.variant === "reset" ? pendingConfirm.detail : undefined}
        confirmLabel={pendingConfirm?.variant === "reset" ? pendingConfirm.confirmLabel : undefined}
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
  const rowKey = (suffix: string) => `${entry.worktreePath}::${suffix}`;
  const owner = entry.inUse
    ? `In use — ${entry.leaseOwners.map((item) => `${item.lease.workflowKey}/${item.lease.runRef}`).join(", ")}`
    : entry.ownership === "managed" ? "ctrlyoke-owned" : "user-owned";
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
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.REMOVE, requestId, entry, true);
  };
  const remove = () => {
    if (!confirmDeleteOperations) {
      doRemove();
      return;
    }
    requestConfirm({
      variant: "delete",
      title: "Remove Worktree",
      message: `Remove worktree "${entry.worktreePath}"?`,
      onConfirm: doRemove,
    });
  };
  const doForceRemove = () => {
    const [requestId] = feedback.begin(rowKey("force-remove"));
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE, requestId, entry, true);
  };
  const forceRemove = () => {
    if (!confirmDeleteOperations) {
      doForceRemove();
      return;
    }
    requestConfirm({
      variant: "delete",
      title: "Force Remove Worktree",
      message: `Force remove worktree "${entry.worktreePath}"?`,
      detail: "Uncommitted work in this worktree may be lost.",
      onConfirm: doForceRemove,
    });
  };
  const cleanupBranch = (confirmed: boolean) => {
    const [requestId] = feedback.begin(rowKey("cleanup-branch"));
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH, requestId, entry, confirmed);
  };
  const deleteBranchWithConfirm = () => {
    if (!confirmDeleteOperations) {
      cleanupBranch(true);
      return;
    }
    requestConfirm({
      variant: "delete",
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
  const normalizePath = (value: string) => value.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const isSourceCheckout =
    !!sourceCheckoutRoot && normalizePath(entry.worktreePath) === normalizePath(sourceCheckoutRoot);
  const canSync =
    entry.ownership === "user" &&
    !isSourceCheckout &&
    !entry.inUse &&
    !entry.stale &&
    !!entry.branchName &&
    entry.branchState === "present";
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
      variant: "reset",
      title: "Sync Worktree",
      message: `Sync "${entry.branchName}" with "${sourceCheckoutBranch ?? "the source checkout"}"?`,
      detail: `This merges "${entry.branchName}" into "${sourceCheckoutBranch ?? "the checked-out branch"}", then merges that branch back into "${entry.branchName}" — the same two commands you'd otherwise run by hand.`,
      confirmLabel: "Sync",
      onConfirm: doSync,
    });
  };
  return (
    <div className={`rounded border p-2 text-xs ${entry.inUse ? "border-warning-fg" : "border-panel-border"}`}>
      <div className="font-mono break-all text-foreground">{entry.worktreePath}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-description-fg">
        <span>Owner: {owner}</span>
        <span>Age: {formatAge(entry.ageMs)}</span>
        <span>Branch: {entry.branchName ?? "detached"} ({entry.branchState})</span>
        <span>{entry.prunableReason ? `Prunable: ${entry.prunableReason}` : entry.stale ? "Stale admin entry" : entry.directoryState === "removed" ? "Directory removed" : "Git entry present"}</span>
      </div>
      {entry.inUse && <div className="mt-1 text-warning-fg">Retry after the owner releases it, or open the owning workspace from its run.</div>}
      {entry.divergence && <div className="mt-1 text-description-fg">{entry.branchName} — {entry.divergence.ahead} ahead, {entry.divergence.behind} behind {entry.divergence.comparisonLabel}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        {entry.inUse && entry.leaseOwners[0] && <>
          <ActionButton
            label="Retry"
            pendingLabel="Retrying…"
            pending={feedback.isPending(rowKey("retry"))}
            feedback={feedback.getFeedback(rowKey("retry"))}
            onClick={retry}
          />
          <button type="button" className="fp-select-trigger text-xs" onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.OPEN_WORKTREE_OWNER, stateRoot: entry.leaseOwners[0].lease.stateRoot })}>Open owning workspace</button>
        </>}
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
        {entry.ownership === "managed" && entry.branchName && entry.branchState === "present" && !entry.branchCleanupEligible && !entry.inUse && !entry.stale && (
          <ActionButton
            label="Delete branch…"
            pendingLabel="Deleting…"
            pending={feedback.isPending(rowKey("cleanup-branch"))}
            feedback={feedback.getFeedback(rowKey("cleanup-branch"))}
            onClick={deleteBranchWithConfirm}
          />
        )}
        {entry.ownership === "managed" && entry.directoryState !== "removed" && (
          <ActionButton
            label="Remove"
            pendingLabel="Removing…"
            disabled={entry.inUse}
            pending={feedback.isPending(rowKey("remove"))}
            feedback={feedback.getFeedback(rowKey("remove"))}
            onClick={remove}
          />
        )}
        {entry.ownership === "managed" && entry.directoryState !== "removed" && (
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
