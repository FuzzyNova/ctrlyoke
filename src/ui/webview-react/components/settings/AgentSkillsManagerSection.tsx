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

// Encode/decode harnessId + scope into a single dropdown value string
function encodeTarget(harnessId: HarnessId | "flightpath", scope: "workspace" | "user"): string {
  return `${harnessId}:${scope}`;
}

function decodeTarget(encoded: string): { harnessId: HarnessId | "flightpath"; scope: "workspace" | "user" } {
  const colonIdx = encoded.lastIndexOf(":");
  return {
    harnessId: encoded.slice(0, colonIdx) as HarnessId | "flightpath",
    scope: encoded.slice(colonIdx + 1) as "workspace" | "user",
  };
}

// ============================================================================
// Badge
// ============================================================================

interface BadgeProps {
  id: HarnessId | "flightpath";
  scope: "workspace" | "user";
}

function HarnessBadge({ id, scope }: BadgeProps) {
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
      {getHarnessLabel(id)}{scope === "user" ? " ·user" : ""}
    </span>
  );
}

// ============================================================================
// File Row
// ============================================================================

interface FileRowProps {
  file: ManagedFile;
  onSave: (sourcePath: string, harnessId: string, scope: "workspace" | "user") => void;
  onDelete: (name: string, harnessId: string, scope: "workspace" | "user") => void;
}

function FileRow({ file, onSave, onDelete }: FileRowProps) {
  const locationKeys = new Set(
    file.locations.map((l) => encodeTarget(l.harnessId, l.scope))
  );

  // Primary source path (prefer flightpath workspace, then flightpath user, then first)
  const primaryLoc: ManagedFileLocation =
    file.locations.find((l) => l.harnessId === "flightpath" && l.scope === "workspace") ??
    file.locations.find((l) => l.harnessId === "flightpath" && l.scope === "user") ??
    file.locations[0];

  const saveItems: ActionDropdownItem[] = [
    ...DISPLAYED_HARNESS_IDS.flatMap((id) =>
      (["workspace", "user"] as const).map((scope) => {
        const encoded = encodeTarget(id, scope);
        const present = locationKeys.has(encoded);
        return {
          label: `${getHarnessLabel(id)} (${scope})`,
          value: encoded,
          disabled: present,
          title: present ? "Already present" : undefined,
        };
      })
    ),
    ...( (["workspace", "user"] as const).map((scope) => {
      const encoded = encodeTarget("flightpath", scope);
      const present = locationKeys.has(encoded);
      return {
        label: `FlightPath (${scope})`,
        value: encoded,
        disabled: present,
        title: present ? "Already present" : undefined,
      };
    }) ),
  ];

  const deleteItems: ActionDropdownItem[] = file.locations.map((loc) => ({
    label: `${getHarnessLabel(loc.harnessId)} (${loc.scope})`,
    value: encodeTarget(loc.harnessId, loc.scope),
  }));

  return (
    <div className="py-2 px-3 border-b border-panel-border last:border-0">
      {/* File name — full-width own line, never squished */}
      <div className="text-sm font-medium text-foreground truncate mb-1.5">
        {file.displayName}
      </div>

      {/* Location badges (left) + actions (right) — share one responsive row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {file.locations.map((loc) => (
            <HarnessBadge
              key={`${loc.harnessId}-${loc.scope}-${loc.path}`}
              id={loc.harnessId}
              scope={loc.scope}
            />
          ))}
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          <ActionDropdown
            label="Save"
            items={saveItems}
            onSelect={(encoded) => {
              const { harnessId, scope } = decodeTarget(encoded);
              onSave(primaryLoc.path, harnessId, scope);
            }}
          />

          <ActionDropdown
            label="Delete"
            items={deleteItems}
            onSelect={(encoded) => {
              const { harnessId, scope } = decodeTarget(encoded);
              onDelete(file.name, harnessId, scope);
            }}
            className="text-error-fg"
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// All-actions bar (Save All / Delete All)
// ============================================================================

type BulkAction = "save" | "delete";

interface AllActionsBarProps {
  files: ManagedFile[];
  onSave: (encoded: string) => void;
  onDeleteAll: (encoded: string) => void;
}

function AllActionsBar({ files, onSave, onDeleteAll }: AllActionsBarProps) {
  const [action, setAction] = useState<BulkAction>("save");
  const [target, setTarget] = useState<string>(
    encodeTarget(HARNESS_IDS.CLAUDE_CLI as HarnessId, "workspace")
  );

  const handleExecute = () => {
    if (action === "save") {
      onSave(target);
    } else {
      onDeleteAll(target);
    }
  };

  const preposition = action === "save" ? "to:" : "from:";

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-panel-border">
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as BulkAction)}
        className="h-6 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border shrink-0"
      >
        <option value="save">Save All</option>
        <option value="delete">Delete All</option>
      </select>

      <span className="text-xs text-description-fg shrink-0">
        {preposition}
      </span>

      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="h-6 flex-1 min-w-0 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border"
      >
        {DISPLAYED_HARNESS_IDS.flatMap((id) =>
          (["workspace", "user"] as const).map((scope) => (
            <option key={encodeTarget(id, scope)} value={encodeTarget(id, scope)}>
              {getHarnessLabel(id)} ({scope})
            </option>
          ))
        )}
        {(["workspace", "user"] as const).map((scope) => (
          <option key={encodeTarget("flightpath", scope)} value={encodeTarget("flightpath", scope)}>
            FlightPath ({scope})
          </option>
        ))}
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
        {action === "save" ? "Save All" : "Delete All"}
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
  const deleteFile = useHarnessFileStore((s) => s.deleteFile);
  const syncAll = useHarnessFileStore((s) => s.syncAll);
  const deleteAll = useHarnessFileStore((s) => s.deleteAll);
  const openHarnessDir = useHarnessFileStore((s) => s.openHarnessDir);

  const [confirmDelete, setConfirmDelete] = useState<{
    name: string;
    harnessId: string;
    scope: "workspace" | "user";
  } | null>(null);

  const [confirmDeleteAll, setConfirmDeleteAll] = useState<{
    harnessId: string;
    scope: "workspace" | "user";
  } | null>(null);

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  const handleSave = useCallback(
    (sourcePath: string, harnessId: string, scope: "workspace" | "user") => {
      exportFile(sourcePath, harnessId, activeType, false, scope);
    },
    [exportFile, activeType]
  );

  const handleDeleteRequest = useCallback(
    (name: string, harnessId: string, scope: "workspace" | "user") => {
      setConfirmDelete({ name, harnessId, scope });
    },
    []
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!confirmDelete) return;
    deleteFile(confirmDelete.name, confirmDelete.harnessId, activeType, confirmDelete.scope);
    setConfirmDelete(null);
  }, [confirmDelete, deleteFile, activeType]);

  const handleSaveAll = useCallback(
    (encoded: string) => {
      const { harnessId, scope } = decodeTarget(encoded);
      const files = managedFiles.map((f) => {
        const primary =
          f.locations.find((l) => l.harnessId === "flightpath" && l.scope === "workspace") ??
          f.locations.find((l) => l.harnessId === "flightpath" && l.scope === "user") ??
          f.locations[0];
        return { sourcePath: primary.path, name: f.name };
      });
      syncAll(files, harnessId, activeType, scope);
    },
    [managedFiles, syncAll, activeType]
  );

  const handleDeleteAllRequest = useCallback((encoded: string) => {
    const { harnessId, scope } = decodeTarget(encoded);
    setConfirmDeleteAll({ harnessId, scope });
  }, []);

  const handleDeleteAllConfirm = useCallback(() => {
    if (!confirmDeleteAll) return;
    deleteAll(confirmDeleteAll.harnessId, activeType, confirmDeleteAll.scope);
    setConfirmDeleteAll(null);
  }, [confirmDeleteAll, deleteAll, activeType]);

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Agent & Skills Manager
      </h3>

      <p className="text-xs text-description-fg">
        Manage agent and skill files across harness directories. Save to a
        harness directory to give it native subagent-spawn access. Workspace
        dirs live inside the project; user dirs live in your home folder and
        apply globally.
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
                ...DISPLAYED_HARNESS_IDS.flatMap((id) =>
                  (["workspace", "user"] as const).map((scope) => ({
                    label: `${getHarnessLabel(id)} (${scope})`,
                    value: encodeTarget(id, scope),
                  }))
                ),
                ...(["workspace", "user"] as const).map((scope) => ({
                  label: `FlightPath (${scope})`,
                  value: encodeTarget("flightpath", scope),
                })),
              ]}
              onSelect={(encoded) => {
                const { harnessId, scope } = decodeTarget(encoded);
                openHarnessDir(harnessId, activeType, scope);
              }}
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
              onSave={handleSave}
              onDelete={handleDeleteRequest}
            />
          ))}
      </div>

      {/* Bulk actions (Save All / Delete All) */}
      <AllActionsBar
        files={managedFiles}
        onSave={handleSaveAll}
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
              </strong>{" "}
              ({confirmDelete.scope})? This only deletes the file from that
              directory — other copies are not affected.
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
              </strong>{" "}
              ({confirmDeleteAll.scope}). Copies in other directories are not
              affected.
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
