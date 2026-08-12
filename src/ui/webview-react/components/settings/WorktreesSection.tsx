import { useEffect, useMemo, useState } from "react";
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

function sendAction(
  vscode: ReturnType<typeof useVsCodeApi>,
  action: string,
  entry?: WorktreeManagementEntry,
  confirmed = false
): void {
  vscode.postMessage({
    type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION,
    action,
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

  const refresh = () =>
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE, refresh: true });

  const bulkCleanup = () => {
    for (const branchName of selectedBranches) {
      const entry = management?.entries.find(
        (candidate) => candidate.branchName === branchName
      );
            if (entry) sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH, entry);
    }
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
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 id="manage-worktrees-heading" className="text-sm font-semibold text-foreground">Manage Worktrees</h4>
            <p className="text-xs text-description-fg">Ownership, leases, branches, and retention actions.</p>
          </div>
          <button type="button" className="fp-select-trigger text-xs" onClick={refresh}>Refresh</button>
        </div>

        {management?.entries.length ? (
          <div className="mt-3 space-y-2">
            {management.entries.map((entry) => (
              <WorktreeRow key={`${entry.worktreePath}:${entry.branchName ?? "detached"}`} entry={entry} vscode={vscode} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-description-fg">No linked worktrees were discovered.</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="fp-select-trigger text-xs" disabled={!selectedBranches.length} onClick={bulkCleanup}>
            Clean up safe merged branches ({selectedBranches.length})
          </button>
          <button type="button" className="fp-select-trigger text-xs" onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.WORKTREE_MANAGEMENT_ACTION, action: WORKTREE_MANAGEMENT_ACTIONS.PRUNE, confirmed: true })}>
            Prune stale Git entries
          </button>
        </div>
        <p className="mt-2 text-xs text-description-fg">
          Safe cleanup preselects only ctrlyoke-owned, inactive branches proven merged into their recorded target. Squash and rebase merges stay explicit.
        </p>
      </section>
    </div>
  );
}

function WorktreeRow({ entry, vscode }: { entry: WorktreeManagementEntry; vscode: ReturnType<typeof useVsCodeApi> }) {
  const owner = entry.inUse
    ? `In use — ${entry.leaseOwners.map((item) => `${item.lease.workflowKey}/${item.lease.runRef}`).join(", ")}`
    : entry.ownership === "managed" ? "ctrlyoke-owned" : "user-owned";
  const remove = () => {
    if (!window.confirm(`Remove worktree ${entry.worktreePath}?`)) return;
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.REMOVE, entry, true);
  };
  const forceRemove = () => {
    if (!window.confirm(`Force remove ${entry.worktreePath}? Uncommitted work may be lost.`)) return;
    sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE, entry, true);
  };
  return (
    <div className={`rounded border p-2 text-xs ${entry.inUse ? "border-warning-fg" : "border-panel-border"}`}>
      <div className="font-mono break-all text-foreground">{entry.worktreePath}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-description-fg">
        <span>Owner: {owner}</span>
        <span>Age: {formatAge(entry.ageMs)}</span>
        <span>Branch: {entry.branchName ?? "detached"} ({entry.branchState})</span>
        <span>{entry.prunableReason ? `Prunable: ${entry.prunableReason}` : entry.stale ? "Stale admin entry" : "Git entry present"}</span>
      </div>
      {entry.inUse && <div className="mt-1 text-warning-fg">Retry after the owner releases it, or open the owning workspace from its run.</div>}
      {entry.divergence && <div className="mt-1 text-description-fg">{entry.branchName} — {entry.divergence.ahead} ahead, {entry.divergence.behind} behind {entry.divergence.comparisonLabel}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        {entry.inUse && entry.leaseOwners[0] && <>
          <button type="button" className="fp-select-trigger text-xs" onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_WORKTREE_MANAGEMENT_STATE, refresh: true })}>Retry</button>
          <button type="button" className="fp-select-trigger text-xs" onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.OPEN_WORKTREE_OWNER, stateRoot: entry.leaseOwners[0].lease.stateRoot })}>Open owning workspace</button>
        </>}
        {entry.branchCleanupEligible && entry.branchName && <button type="button" className="fp-select-trigger text-xs" onClick={() => sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH, entry)}>Delete merged branch</button>}
        {entry.ownership === "managed" && entry.branchName && entry.branchState === "present" && !entry.branchCleanupEligible && !entry.inUse && !entry.stale && <button type="button" className="fp-select-trigger text-xs" onClick={() => { if (window.confirm(`Delete branch ${entry.branchName}? This cannot be undone by ctrlyoke.`)) sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH, entry, true); }}>Delete branch…</button>}
        {entry.ownership === "managed" && entry.directoryState === "present" && <button type="button" className="fp-select-trigger text-xs" disabled={entry.inUse} onClick={remove}>Remove</button>}
        {entry.ownership === "managed" && entry.directoryState === "present" && <button type="button" className="fp-select-trigger text-xs" disabled={entry.inUse} onClick={forceRemove}>Force remove</button>}
        {entry.stale && <button type="button" className="fp-select-trigger text-xs" onClick={() => sendAction(vscode, WORKTREE_MANAGEMENT_ACTIONS.REPAIR, entry)}>Repair entry</button>}
      </div>
    </div>
  );
}
