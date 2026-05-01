import { useEffect, useState, useCallback } from "react";
import { useHarnessFileStore } from "@store/useHarnessFileStore";
import { HARNESS_IDS, HARNESS_INFO } from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import type { ManagedFile, ManagedFileLocation } from "@root/types/WebviewMessageTypes";
import { ActionDropdown } from "@components/shared/ActionDropdown";
import type { ActionDropdownItem } from "@components/shared/ActionDropdown";

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
        ${isFp
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
            <HarnessBadge key={`${loc.harnessId}-${loc.path}`} id={loc.harnessId} />
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
// Sync All control
// ============================================================================

interface SyncAllBarProps {
  files: ManagedFile[];
  onSync: (targetId: string) => void;
}

function SyncAllBar({ files, onSync }: SyncAllBarProps) {
  const [targetHarness, setTargetHarness] = useState<HarnessId>(
    HARNESS_IDS.CLAUDE_CLI as HarnessId
  );

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-panel-border">
      <span className="text-xs text-description-fg shrink-0">Sync all to:</span>
      <select
        value={targetHarness}
        onChange={(e) => setTargetHarness(e.target.value as HarnessId)}
        className="h-6 flex-1 min-w-0 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border"
      >
        {DISPLAYED_HARNESS_IDS.map((id) => (
          <option key={id} value={id}>
            {getHarnessLabel(id)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={files.length === 0}
        onClick={() => onSync(targetHarness)}
        className="h-6 px-2 text-xs rounded bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        Sync All
      </button>
    </div>
  );
}

// ============================================================================
// Main Section
// ============================================================================

export function HarnessFileManagerSection() {
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
  const openHarnessDir = useHarnessFileStore((s) => s.openHarnessDir);

  const [confirmDelete, setConfirmDelete] = useState<{
    name: string;
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

  const handleDeleteRequest = useCallback(
    (name: string, harnessId: string) => {
      setConfirmDelete({ name, harnessId });
    },
    []
  );

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

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Harness File Manager
      </h3>

      <p className="text-xs text-description-fg">
        Manage agent and skill files across harness directories. Export to give
        a harness native subagent-spawn access; import to bring files into the
        FlightPath-exclusive directory.
      </p>

      {/* Type switcher + Open Folder */}
      <div className="flex items-center gap-2">
        <div className="flex rounded border border-btn-border overflow-hidden text-xs font-medium">
          {(["agent", "skill"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveType(t)}
              className={`px-3 py-1 transition-colors capitalize
                ${activeType === t
                  ? "bg-btn-bg text-btn-fg"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                }
                ${t === "skill" ? "border-l border-btn-border" : ""}`}
            >
              {t === "agent" ? "Agents" : "Skills"}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <ActionDropdown
            label="Open Folder"
            items={[
              ...DISPLAYED_HARNESS_IDS.map((id) => ({ label: getHarnessLabel(id), value: id })),
              { label: "FlightPath", value: "flightpath" },
            ]}
            onSelect={(id) => openHarnessDir(id, activeType)}
          />
        </div>
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

        {!loading && managedFiles.map((file) => (
          <FileRow
            key={file.name}
            file={file}
            onExport={handleExport}
            onImport={handleImport}
            onDelete={handleDeleteRequest}
          />
        ))}
      </div>

      {/* Sync all */}
      <SyncAllBar
        files={managedFiles}
        onSync={handleSyncAll}
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
              <strong>{getHarnessLabel(confirmDelete.harnessId as HarnessId | "flightpath")}</strong>?
              This only deletes the file from that directory — other copies are not affected.
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
    </div>
  );
}
