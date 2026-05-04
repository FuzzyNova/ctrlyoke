import { useEffect, useState, useCallback } from "react";
import { useHarnessFileStore } from "@store/useHarnessFileStore";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  ManagedFileLocation,
} from "@root/types/WebviewMessageTypes";
import { ActionDropdown } from "@components/shared/ActionDropdown";
import type { ActionDropdownItem } from "@components/shared/ActionDropdown";
import { isStandalone } from "@hooks/useVsCodeApi";

// ============================================================================
// Constants
// ============================================================================

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

// Deduplicate copilot-chat (shares dirs with copilot-cli)
const DISPLAYED_HARNESS_IDS: HarnessId[] = ALL_HARNESS_IDS.filter(
  (id) => id !== HARNESS_IDS.COPILOT_CHAT
);

function getHarnessLabel(id: HarnessId | "flightpath"): string {
  if (id === "flightpath") return "FlightPath";
  const info = HARNESS_INFO[id as keyof typeof HARNESS_INFO];
  return info?.shortName ?? id;
}

// ============================================================================
// Badge
// ============================================================================

interface BadgeProps {
  id: HarnessId | "flightpath";
}

function HarnessBadge({ id }: BadgeProps) {
  const isFp = id === "flightpath";
  return (
    <span
      className={`inline-flex items-center px-1 py-0.5 rounded text-xxs font-medium leading-none
        ${
          isFp
            ? "bg-badge-bg text-badge-fg"
            : "bg-list-hover-bg text-foreground border border-panel-border"
        }`}
    >
      {getHarnessLabel(id)}
    </span>
  );
}

// ============================================================================
// File Row
// ============================================================================

interface FileRowProps {
  file: ManagedFile;
  onExport: (sourcePath: string, targetId: string) => void;
  onImport: (sourcePath: string) => void;
  onDelete: (name: string, harnessId: string) => void;
}

function FileRow({ file, onExport, onImport, onDelete }: FileRowProps) {
  const locationIds = new Set(file.locations.map((l) => l.harnessId));
  const hasFlightPath = locationIds.has("flightpath");

  // Primary source path (prefer flightpath, else first location)
  const primaryLoc: ManagedFileLocation =
    file.locations.find((l) => l.harnessId === "flightpath") ??
    file.locations[0];

  const exportItems: ActionDropdownItem[] = DISPLAYED_HARNESS_IDS.map((id) => {
    const present = locationIds.has(id);
    return {
      label: getHarnessLabel(id),
      value: id,
      disabled: present,
      title: present ? "Already present" : undefined,
    };
  });

  const deleteItems: ActionDropdownItem[] = file.locations.map((loc) => ({
    label: `${getHarnessLabel(loc.harnessId)} — ${loc.harnessId === "flightpath" ? "FP dir" : "native dir"}`,
    value: loc.harnessId,
  }));

  return (
    <div className="py-2 px-3 border-b border-panel-border last:border-0">
      {/* File name — full-width own line, never squished */}
      <div className="text-sm font-medium text-foreground truncate mb-1.5">
        {file.displayName}
      </div>

      {/* Location badges (left) + actions (right) — share one responsive row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1">
          {file.locations.map((loc) => (
            <HarnessBadge
              key={`${loc.harnessId}-${loc.path}`}
              id={loc.harnessId}
            />
          ))}
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          {!hasFlightPath && (
            <button
              type="button"
              onClick={() => onImport(primaryLoc.path)}
              className="px-2 py-0.5 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
              title="Copy to .flightpath directory"
            >
              Import
            </button>
          )}

          <ActionDropdown
            label="Export"
            items={exportItems}
            onSelect={(targetId) => onExport(primaryLoc.path, targetId)}
          />

          <ActionDropdown
            label="Delete"
            items={deleteItems}
            onSelect={(harnessId) => onDelete(file.name, harnessId)}
            className="text-error-fg"
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// All-actions bar (Sync All / Delete All)
// ============================================================================

type BulkAction = "sync" | "delete";

interface AllActionsBarProps {
  files: ManagedFile[];
  onSync: (targetId: string) => void;
  onDeleteAll: (targetId: string) => void;
}

function AllActionsBar({ files, onSync, onDeleteAll }: AllActionsBarProps) {
  const [action, setAction] = useState<BulkAction>("sync");
  const [target, setTarget] = useState<HarnessId | "flightpath">(
    HARNESS_IDS.CLAUDE_CLI as HarnessId
  );

  const handleExecute = () => {
    if (action === "sync") {
      onSync(target);
    } else {
      onDeleteAll(target);
    }
  };

  const preposition = action === "sync" ? "to:" : "from:";

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-panel-border">
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as BulkAction)}
        className="h-6 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border shrink-0"
      >
        <option value="sync">Sync All</option>
        <option value="delete">Delete All</option>
      </select>

      <span className="text-xs text-description-fg shrink-0">
        {preposition}
      </span>

      <select
        value={target}
        onChange={(e) => setTarget(e.target.value as HarnessId | "flightpath")}
        className="h-6 flex-1 min-w-0 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border"
      >
        {DISPLAYED_HARNESS_IDS.map((id) => (
          <option key={id} value={id}>
            {getHarnessLabel(id)}
          </option>
        ))}
        <option value="flightpath">FlightPath</option>
      </select>

      <button
        type="button"
        disabled={files.length === 0}
        onClick={handleExecute}
        className={`h-6 px-2 text-xs rounded disabled:opacity-50 disabled:cursor-not-allowed shrink-0
          ${
            action === "delete"
              ? "bg-btn-secondary-bg text-error-fg border border-btn-border hover:bg-btn-secondary-hover"
              : "bg-btn-bg text-btn-fg hover:bg-btn-hover"
          }`}
      >
        {action === "sync" ? "Sync All" : "Delete All"}
      </button>
    </div>
  );
}

// ============================================================================
// Main Section
// ============================================================================

export function AgentSkillsManagerSection() {
  const managedFiles = useHarnessFileStore((s) => s.managedFiles);
  const activeType = useHarnessFileStore((s) => s.activeType);
  const loading = useHarnessFileStore((s) => s.loading);
  const error = useHarnessFileStore((s) => s.error);
  const setActiveType = useHarnessFileStore((s) => s.setActiveType);
  const requestFiles = useHarnessFileStore((s) => s.requestFiles);
  const exportFile = useHarnessFileStore((s) => s.exportFile);
  const importFile = useHarnessFileStore((s) => s.importFile);
  const deleteFile = useHarnessFileStore((s) => s.deleteFile);
  const syncAll = useHarnessFileStore((s) => s.syncAll);
  const deleteAll = useHarnessFileStore((s) => s.deleteAll);
  const openHarnessDir = useHarnessFileStore((s) => s.openHarnessDir);

  const [confirmDelete, setConfirmDelete] = useState<{
    name: string;
    harnessId: string;
  } | null>(null);

  const [confirmDeleteAll, setConfirmDeleteAll] = useState<{
    harnessId: string;
  } | null>(null);

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  const handleExport = useCallback(
    (sourcePath: string, targetId: string) => {
      exportFile(sourcePath, targetId, activeType, false);
    },
    [exportFile, activeType]
  );

  const handleImport = useCallback(
    (sourcePath: string) => {
      importFile(sourcePath, activeType, false);
    },
    [importFile, activeType]
  );

  const handleDeleteRequest = useCallback((name: string, harnessId: string) => {
    setConfirmDelete({ name, harnessId });
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!confirmDelete) return;
    deleteFile(confirmDelete.name, confirmDelete.harnessId, activeType);
    setConfirmDelete(null);
  }, [confirmDelete, deleteFile, activeType]);

  const handleSyncAll = useCallback(
    (targetId: string) => {
      const files = managedFiles.map((f) => {
        const primary =
          f.locations.find((l) => l.harnessId === "flightpath") ??
          f.locations[0];
        return { sourcePath: primary.path, name: f.name };
      });
      syncAll(files, targetId, activeType);
    },
    [managedFiles, syncAll, activeType]
  );

  const handleDeleteAllRequest = useCallback((targetId: string) => {
    setConfirmDeleteAll({ harnessId: targetId });
  }, []);

  const handleDeleteAllConfirm = useCallback(() => {
    if (!confirmDeleteAll) return;
    deleteAll(confirmDeleteAll.harnessId, activeType);
    setConfirmDeleteAll(null);
  }, [confirmDeleteAll, deleteAll, activeType]);

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Agent & Skills Manager
      </h3>

      <p className="text-xs text-description-fg">
        Manage agent and skill files across harness directories. Export to give
        a harness native subagent-spawn access; import to bring files into the
        FlightPath-exclusive directory.
      </p>

      {/* Type switcher + Open Folder */}
      <div className="flex items-center gap-2">
        <div className="fp-mode-switch" role="group" aria-label="Agent or skill type">
          <button
            type="button"
            onClick={() => setActiveType("agent")}
            className={`fp-mode-switch-btn ${activeType === "agent" ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            title="Manage agent files"
          >
            <i className="codicon codicon-agent codicon-sm" />
            Agents
          </button>
          <div className="fp-mode-switch-divider">
            <div className="w-px h-full bg-current opacity-40" />
          </div>
          <button
            type="button"
            onClick={() => setActiveType("skill")}
            className={`fp-mode-switch-btn ${activeType === "skill" ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            title="Manage skill files"
          >
            <i className="codicon codicon-tools codicon-sm" />
            Skills
          </button>
        </div>

        {!isStandalone && (
          <div className="ml-auto">
            <ActionDropdown
              label="Open Folder"
              items={[
                ...DISPLAYED_HARNESS_IDS.map((id) => ({
                  label: getHarnessLabel(id),
                  value: id,
                })),
                { label: "FlightPath", value: "flightpath" },
              ]}
              onSelect={(id) => openHarnessDir(id, activeType)}
            />
          </div>
        )}
      </div>

      {/* File list */}
      <div className="border border-panel-border rounded overflow-hidden">
        {loading && (
          <div className="px-3 py-4 text-xs text-description-fg text-center">
            Loading…
          </div>
        )}

        {!loading && error && (
          <div className="px-3 py-4 text-xs text-error-fg">{error}</div>
        )}

        {!loading && !error && managedFiles.length === 0 && (
          <div className="px-3 py-4 text-xs text-description-fg text-center">
            No {activeType}s discovered in any harness directory.
          </div>
        )}

        {!loading &&
          managedFiles.map((file) => (
            <FileRow
              key={file.name}
              file={file}
              onExport={handleExport}
              onImport={handleImport}
              onDelete={handleDeleteRequest}
            />
          ))}
      </div>

      {/* Bulk actions (Sync All / Delete All) */}
      <AllActionsBar
        files={managedFiles}
        onSync={handleSyncAll}
        onDeleteAll={handleDeleteAllRequest}
      />

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-editor-bg border border-panel-border rounded p-4 max-w-sm w-full mx-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-foreground mb-1 font-semibold">
              Delete {activeType}?
            </p>
            <p className="text-xs text-description-fg mb-4">
              Remove <strong>{confirmDelete.name}</strong> from{" "}
              <strong>
                {getHarnessLabel(
                  confirmDelete.harnessId as HarnessId | "flightpath"
                )}
              </strong>
              ? This only deletes the file from that directory — other copies
              are not affected.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="px-3 py-1 text-xs rounded bg-btn-bg text-btn-fg hover:bg-btn-hover"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete All confirmation modal */}
      {confirmDeleteAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setConfirmDeleteAll(null)}
        >
          <div
            className="bg-editor-bg border border-panel-border rounded p-4 max-w-sm w-full mx-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-foreground mb-1 font-semibold">
              Delete all {activeType}s?
            </p>
            <p className="text-xs text-description-fg mb-4">
              Remove every discovered {activeType} from{" "}
              <strong>
                {getHarnessLabel(
                  confirmDeleteAll.harnessId as HarnessId | "flightpath"
                )}
              </strong>
              . Copies in other directories are not affected.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteAll(null)}
                className="px-3 py-1 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteAllConfirm}
                className="px-3 py-1 text-xs rounded bg-btn-bg text-btn-fg hover:bg-btn-hover"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
