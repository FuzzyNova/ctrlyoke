import { useEffect, useState, useCallback } from "react";
import { useHarnessFileStore } from "@store/useHarnessFileStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
  HARNESS_FILE_TYPES,
} from "@root/types/DashboardConstants";
import type { HarnessId, AnyTargetId } from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  ManagedTargetDirectory,
} from "@root/types/WebviewMessageTypes";
import { ActionDropdown } from "@components/shared/ActionDropdown";
import type { ActionDropdownItem } from "@components/shared/ActionDropdown";
import { FlyoutActionDropdown } from "@components/shared/FlyoutActionDropdown";
import type { FlyoutGroup } from "@components/shared/FlyoutActionDropdown";
import { isStandalone } from "@hooks/useVsCodeApi";

// ============================================================================
// Constants
// ============================================================================

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

// All harnesses eligible for display (excludes copilot-chat which shares dirs with copilot-cli)
const ELIGIBLE_HARNESS_IDS: HarnessId[] = ALL_HARNESS_IDS.filter(
  (id) => id !== HARNESS_IDS.COPILOT_CHAT
);

function getTargetLabel(id: AnyTargetId): string {
  if (id === SPECIAL_TARGET_IDS.FLIGHTPATH) return "FlightPath";
  if (id === SPECIAL_TARGET_IDS.AGENTS) return "Agents";
  if (id === SPECIAL_TARGET_IDS.VSCODE) return "VS Code";
  const info = HARNESS_INFO[id as keyof typeof HARNESS_INFO];
  return info?.shortName ?? id;
}

// Encode/decode targetId + scope into a single string value for dropdowns
function encodeTarget(id: AnyTargetId, scope: "workspace" | "user"): string {
  return `${id}:${scope}`;
}

function decodeTarget(encoded: string): { id: AnyTargetId; scope: "workspace" | "user" } {
  const colonIdx = encoded.lastIndexOf(":");
  return {
    id: encoded.slice(0, colonIdx) as AnyTargetId,
    scope: encoded.slice(colonIdx + 1) as "workspace" | "user",
  };
}

function formatPathForDisplay(folderPath: string): string {
  return folderPath.split("\\").join("/");
}

function getParentFolderPath(filePath: string): string {
  const normalized = filePath.split("\\").join("/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : normalized;
}

function getLocationFolderPath(file: ManagedFile, locationIndex: number): string {
  const location = file.locations[locationIndex];
  return file.type === HARNESS_FILE_TYPES.SKILL
    ? location.path
    : getParentFolderPath(location.path);
}

function getTargetDirectoryPath(
  targetDirectories: ManagedTargetDirectory[],
  id: AnyTargetId,
  scope: "workspace" | "user"
): string | undefined {
  return targetDirectories.find(
    (dir) => dir.harnessId === id && dir.scope === scope
  )?.path;
}

// ============================================================================
// Dropdown item builders — two-level (Workspace / User sections)
// ============================================================================

// Special targets that always appear regardless of harness availability
const SPECIAL_WORKSPACE_SUFFIXES: AnyTargetId[] = ["agents", "flightpath"];
const SPECIAL_USER_SUFFIXES: AnyTargetId[] = ["agents", "vscode", "flightpath"];

function getWorkspaceTargets(availableIds: Set<HarnessId>): AnyTargetId[] {
  return [
    ...ELIGIBLE_HARNESS_IDS.filter((id) => availableIds.has(id)),
    ...SPECIAL_WORKSPACE_SUFFIXES,
  ];
}

function getUserTargets(availableIds: Set<HarnessId>): AnyTargetId[] {
  return [
    ...ELIGIBLE_HARNESS_IDS.filter((id) => availableIds.has(id)),
    ...SPECIAL_USER_SUFFIXES,
  ];
}

function buildSaveFlyoutGroups(
  presentKeys: Set<string>,
  availableIds: Set<HarnessId>,
  targetDirectories: ManagedTargetDirectory[]
): FlyoutGroup[] {
  const wsItems: ActionDropdownItem[] = getWorkspaceTargets(availableIds).map((id) => {
    const encoded = encodeTarget(id, "workspace");
    const present = presentKeys.has(encoded);
    return {
      label: getTargetLabel(id),
      value: encoded,
      description: formatPathForDisplay(
        getTargetDirectoryPath(targetDirectories, id, "workspace") ?? ""
      ),
      disabled: present,
      title: present ? "Already present" : undefined,
    };
  });

  const userItems: ActionDropdownItem[] = getUserTargets(availableIds).map((id) => {
    const encoded = encodeTarget(id, "user");
    const present = presentKeys.has(encoded);
    return {
      label: getTargetLabel(id),
      value: encoded,
      description: formatPathForDisplay(
        getTargetDirectoryPath(targetDirectories, id, "user") ?? ""
      ),
      disabled: present,
      title: present ? "Already present" : undefined,
    };
  });

  return [
    { id: "workspace", label: "Workspace", items: wsItems },
    { id: "user", label: "User", items: userItems },
  ];
}

function buildOpenFolderGroups(
  availableIds: Set<HarnessId>,
  targetDirectories: ManagedTargetDirectory[]
): FlyoutGroup[] {
  return [
    {
      id: "workspace",
      label: "Workspace",
      items: getWorkspaceTargets(availableIds).map((id) => ({
        label: getTargetLabel(id),
        value: encodeTarget(id, "workspace"),
        description: formatPathForDisplay(
          getTargetDirectoryPath(targetDirectories, id, "workspace") ?? ""
        ),
      })),
    },
    {
      id: "user",
      label: "User",
      items: getUserTargets(availableIds).map((id) => ({
        label: getTargetLabel(id),
        value: encodeTarget(id, "user"),
        description: formatPathForDisplay(
          getTargetDirectoryPath(targetDirectories, id, "user") ?? ""
        ),
      })),
    },
  ];
}

// ============================================================================
// Badge
// ============================================================================

function HarnessBadge({ id, scope }: { id: AnyTargetId; scope: "workspace" | "user" }) {
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
      {getTargetLabel(id)}{scope === SETTING_SCOPES.USER ? " ·user" : ""}
    </span>
  );
}

// ============================================================================
// File Row
// ============================================================================

interface FileRowProps {
  file: ManagedFile;
  availableIds: Set<HarnessId>;
  targetDirectories: ManagedTargetDirectory[];
  onSave: (sourcePath: string, id: AnyTargetId, scope: "workspace" | "user") => void;
  onDelete: (name: string, id: AnyTargetId, scope: "workspace" | "user") => void;
}

function FileRow({
  file,
  availableIds,
  targetDirectories,
  onSave,
  onDelete,
}: FileRowProps) {
  const presentKeys = new Set(
    file.locations.map((l) => encodeTarget(l.harnessId, l.scope))
  );

  // Primary source path: prefer flightpath workspace, then flightpath user, then first
  const primaryLoc =
    file.locations.find((l) => l.harnessId === SPECIAL_TARGET_IDS.FLIGHTPATH && l.scope === SETTING_SCOPES.WORKSPACE) ??
    file.locations.find((l) => l.harnessId === SPECIAL_TARGET_IDS.FLIGHTPATH && l.scope === SETTING_SCOPES.USER) ??
    file.locations[0];

  const deleteItems: ActionDropdownItem[] = file.locations.map((loc, index) => ({
    label: `${getTargetLabel(loc.harnessId)} (${loc.scope})`,
    value: encodeTarget(loc.harnessId, loc.scope),
    description: formatPathForDisplay(getLocationFolderPath(file, index)),
  }));

  return (
    <div className="py-2 px-3 border-b border-panel-border last:border-0">
      <div className="text-sm font-medium text-foreground truncate mb-1.5">
        {file.displayName}
      </div>

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
          <FlyoutActionDropdown
            label="Save"
            groups={buildSaveFlyoutGroups(
              presentKeys,
              availableIds,
              targetDirectories
            )}
            onSelect={(encoded) => {
              const { id, scope } = decodeTarget(encoded);
              onSave(primaryLoc.path, id, scope);
            }}
          />

          <ActionDropdown
            label="Delete"
            items={deleteItems}
            onSelect={(encoded) => {
              const { id, scope } = decodeTarget(encoded);
              onDelete(file.name, id, scope);
            }}
            className="text-error-fg"
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// All-actions bar (Save All / Delete All) — two-level scope + target selects
// ============================================================================

type BulkAction = "save" | "delete";

interface AllActionsBarProps {
  files: ManagedFile[];
  availableIds: Set<HarnessId>;
  targetDirectories: ManagedTargetDirectory[];
  onSave: (id: AnyTargetId, scope: "workspace" | "user") => void;
  onDeleteAll: (id: AnyTargetId, scope: "workspace" | "user") => void;
}

function AllActionsBar({
  files,
  availableIds,
  targetDirectories,
  onSave,
  onDeleteAll,
}: AllActionsBarProps) {
  const [action, setAction] = useState<BulkAction>("save");
  const [scope, setScope] = useState<"workspace" | "user">("workspace");
  const [targetId, setTargetId] = useState<AnyTargetId>(HARNESS_IDS.CLAUDE_CLI as HarnessId);

  const scopeTargets =
    scope === SETTING_SCOPES.WORKSPACE ? getWorkspaceTargets(availableIds) : getUserTargets(availableIds);

  // Reset target when scope or available harnesses change if current target isn't in the list
  const handleScopeChange = (newScope: "workspace" | "user") => {
    setScope(newScope);
    const targets =
      newScope === SETTING_SCOPES.WORKSPACE ? getWorkspaceTargets(availableIds) : getUserTargets(availableIds);
    if (!targets.includes(targetId)) {
      setTargetId(targets[0] ?? "flightpath");
    }
  };

  const preposition = action === "save" ? "to:" : "from:";
  const targetItems: ActionDropdownItem[] = scopeTargets.map((id) => ({
    label: getTargetLabel(id),
    value: id,
    description: formatPathForDisplay(
      getTargetDirectoryPath(targetDirectories, id, scope) ?? ""
    ),
  }));

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-panel-border flex-wrap">
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as BulkAction)}
        className="h-6 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border shrink-0"
      >
        <option value="save">Save All</option>
        <option value="delete">Delete All</option>
      </select>

      <span className="text-xs text-description-fg shrink-0">{preposition}</span>

      <select
        value={scope}
        onChange={(e) => handleScopeChange(e.target.value as "workspace" | "user")}
        className="h-6 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border shrink-0"
      >
        <option value="workspace">Workspace</option>
        <option value="user">User</option>
      </select>

      <ActionDropdown
        label={getTargetLabel(targetId)}
        items={targetItems}
        onSelect={(value) => setTargetId(value as AnyTargetId)}
        className="flex-1 min-w-[220px]"
      />

      <button
        type="button"
        disabled={files.length === 0}
        onClick={() => {
          if (action === "save") onSave(targetId, scope);
          else onDeleteAll(targetId, scope);
        }}
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
  const targetDirectories = useHarnessFileStore((s) => s.targetDirectories);
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

  const harnessStatusMap = useSettingsStore((s) => s.harnessStatus);
  const availableIds = new Set(
    ELIGIBLE_HARNESS_IDS.filter((id) => harnessStatusMap[id]?.available)
  );

  const [confirmDelete, setConfirmDelete] = useState<{
    name: string;
    id: AnyTargetId;
    scope: "workspace" | "user";
  } | null>(null);

  const [confirmDeleteAll, setConfirmDeleteAll] = useState<{
    id: AnyTargetId;
    scope: "workspace" | "user";
  } | null>(null);

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  const handleSave = useCallback(
    (sourcePath: string, id: AnyTargetId, scope: "workspace" | "user") => {
      exportFile(sourcePath, id, activeType, false, scope);
    },
    [exportFile, activeType]
  );

  const handleDeleteRequest = useCallback(
    (name: string, id: AnyTargetId, scope: "workspace" | "user") => {
      setConfirmDelete({ name, id, scope });
    },
    []
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!confirmDelete) return;
    deleteFile(confirmDelete.name, confirmDelete.id, activeType, confirmDelete.scope);
    setConfirmDelete(null);
  }, [confirmDelete, deleteFile, activeType]);

  const handleSaveAll = useCallback(
    (id: AnyTargetId, scope: "workspace" | "user") => {
      const files = managedFiles.map((f) => {
        const primary =
          f.locations.find((l) => l.harnessId === SPECIAL_TARGET_IDS.FLIGHTPATH && l.scope === SETTING_SCOPES.WORKSPACE) ??
          f.locations.find((l) => l.harnessId === SPECIAL_TARGET_IDS.FLIGHTPATH && l.scope === SETTING_SCOPES.USER) ??
          f.locations[0];
        return { sourcePath: primary.path, name: f.name };
      });
      syncAll(files, id, activeType, scope);
    },
    [managedFiles, syncAll, activeType]
  );

  const handleDeleteAllRequest = useCallback(
    (id: AnyTargetId, scope: "workspace" | "user") => {
      setConfirmDeleteAll({ id, scope });
    },
    []
  );

  const handleDeleteAllConfirm = useCallback(() => {
    if (!confirmDeleteAll) return;
    deleteAll(confirmDeleteAll.id, activeType, confirmDeleteAll.scope);
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
        dirs live inside the project; user dirs apply globally.
      </p>

      {/* Type switcher + Open Folder */}
      <div className="flex items-center gap-2">
        <div className="fp-mode-switch" role="group" aria-label="Agent or skill type">
          <button
            type="button"
            onClick={() => setActiveType(HARNESS_FILE_TYPES.AGENT)}
            className={`fp-mode-switch-btn ${activeType === HARNESS_FILE_TYPES.AGENT ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
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
            onClick={() => setActiveType(HARNESS_FILE_TYPES.SKILL)}
            className={`fp-mode-switch-btn ${activeType === HARNESS_FILE_TYPES.SKILL ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            title="Manage skill files"
          >
            <i className="codicon codicon-tools codicon-sm" />
            Skills
          </button>
        </div>

        {!isStandalone && (
          <div className="ml-auto">
            <FlyoutActionDropdown
              label="Open Folder"
              groups={buildOpenFolderGroups(availableIds, targetDirectories)}
              onSelect={(encoded) => {
                const { id, scope } = decodeTarget(encoded);
                openHarnessDir(id, activeType, scope);
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
              availableIds={availableIds}
              targetDirectories={targetDirectories}
              onSave={handleSave}
              onDelete={handleDeleteRequest}
            />
          ))}
      </div>

      {/* Bulk actions */}
      <AllActionsBar
        files={managedFiles}
        availableIds={availableIds}
        targetDirectories={targetDirectories}
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
              <strong>{getTargetLabel(confirmDelete.id)}</strong>{" "}
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
              <strong>{getTargetLabel(confirmDeleteAll.id)}</strong>{" "}
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
