import { useEffect, useMemo, useState, useCallback } from "react";
import { useHarnessFileStore } from "@store/useHarnessFileStore";
import { useSettingsStore } from "@store/settingsStore";
import { sendMessage } from "@hooks/useMessageHandler";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
  HARNESS_FILE_TYPES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import type {
  HarnessId,
  AnyTargetId,
  SettingWriteScope,
} from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  ManagedFileLocation,
  ManagedTargetDirectory,
} from "@root/types/WebviewMessageTypes";
import { ActionDropdown } from "@components/shared/ActionDropdown";
import type { ActionDropdownItem } from "@components/shared/ActionDropdown";
import { FlyoutActionDropdown } from "@components/shared/FlyoutActionDropdown";
import type { FlyoutGroup } from "@components/shared/FlyoutActionDropdown";
import {
  BulkSelectionActionsBar,
  type BulkAction,
} from "@components/shared/BulkSelectionActionsBar";
import { isStandalone } from "@hooks/useVsCodeApi";

// ============================================================================
// Constants
// ============================================================================

const ALL_HARNESS_IDS = Object.values(HARNESS_IDS) as HarnessId[];

// All harnesses eligible for display
const ELIGIBLE_HARNESS_IDS: HarnessId[] = ALL_HARNESS_IDS;

function getTargetLabel(id: AnyTargetId): string {
  if (id === SPECIAL_TARGET_IDS.CTRLYOKE) return "ctrlyoke";
  if (id === SPECIAL_TARGET_IDS.AGENTS) return "Agents";
  if (id === SPECIAL_TARGET_IDS.VSCODE) return "VS Code";
  const info = HARNESS_INFO[id as keyof typeof HARNESS_INFO];
  return info?.shortName ?? id;
}

// Encode/decode targetId + scope into a single string value for dropdowns
function encodeTarget(id: AnyTargetId, scope: SettingWriteScope): string {
  return `${id}:${scope}`;
}

function decodeTarget(encoded: string): {
  id: AnyTargetId;
  scope: SettingWriteScope;
} {
  const colonIdx = encoded.lastIndexOf(":");
  return {
    id: encoded.slice(0, colonIdx) as AnyTargetId,
    scope: encoded.slice(colonIdx + 1) as SettingWriteScope,
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

function getLocationFolderPath(
  file: ManagedFile,
  locationIndex: number
): string {
  const location = file.locations[locationIndex];
  return file.type === HARNESS_FILE_TYPES.SKILL
    ? location.path
    : getParentFolderPath(location.path);
}

// Primary editable location: prefer ctrlyoke workspace, then ctrlyoke user, then first.
function getPrimaryLocation(
  file: ManagedFile
): ManagedFileLocation | undefined {
  return (
    file.locations.find(
      (l) =>
        l.harnessId === SPECIAL_TARGET_IDS.CTRLYOKE &&
        l.scope === SETTING_SCOPES.WORKSPACE
    ) ??
    file.locations.find(
      (l) =>
        l.harnessId === SPECIAL_TARGET_IDS.CTRLYOKE &&
        l.scope === SETTING_SCOPES.USER
    ) ??
    file.locations[0]
  );
}

function getSourcePath(file: ManagedFile): string {
  const editableLocation = getPrimaryLocation(file);
  if (editableLocation) return editableLocation.path;
  if (file.builtInSourcePath) return file.builtInSourcePath;
  throw new Error(`No source path is available for ${file.name}`);
}

// Path to open for "Edit": the .agent.md / .md file directly, or SKILL.md inside the skill folder
function getEditFilePath(file: ManagedFile): string {
  const primaryLoc = getPrimaryLocation(file);
  if (!primaryLoc) {
    throw new Error(`No editable copy is available for ${file.name}`);
  }
  return file.type === HARNESS_FILE_TYPES.SKILL
    ? `${primaryLoc.path}/SKILL.md`
    : primaryLoc.path;
}

function getTargetDirectoryPath(
  targetDirectories: ManagedTargetDirectory[],
  id: AnyTargetId,
  scope: SettingWriteScope
): string | undefined {
  return targetDirectories.find(
    (dir) => dir.harnessId === id && dir.scope === scope
  )?.path;
}

// ============================================================================
// Dropdown item builders — two-level (Workspace / User sections)
// ============================================================================

// Special targets that always appear regardless of harness availability
const SPECIAL_WORKSPACE_SUFFIXES: AnyTargetId[] = ["agents", "ctrlyoke"];
const SPECIAL_USER_SUFFIXES: AnyTargetId[] = ["agents", "vscode", "ctrlyoke"];

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
  const wsItems: ActionDropdownItem[] = getWorkspaceTargets(availableIds).map(
    (id) => {
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
    }
  );

  const userItems: ActionDropdownItem[] = getUserTargets(availableIds).map(
    (id) => {
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
    }
  );

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

function HarnessBadge({
  id,
  scope,
}: {
  id: AnyTargetId;
  scope: SettingWriteScope;
}) {
  const isFp = id === "ctrlyoke";
  return (
    <span
      className={`inline-flex items-center px-1 py-0.5 rounded text-xxs font-medium leading-none
        ${
          isFp
            ? "bg-badge-bg text-badge-fg"
            : "bg-list-hover-bg text-foreground border border-panel-border"
        }`}
    >
      {getTargetLabel(id)}
      {scope === SETTING_SCOPES.USER ? " ·user" : ""}
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
  isDefault: boolean;
  selected: boolean;
  onToggleSelected: (name: string) => void;
  onSave: (
    sourcePath: string,
    id: AnyTargetId,
    scope: SettingWriteScope
  ) => void;
  onDelete: (name: string, id: AnyTargetId, scope: SettingWriteScope) => void;
  onToggleDefault: (file: ManagedFile) => void;
  onEdit: (file: ManagedFile) => void;
}

function FileRow({
  file,
  availableIds,
  targetDirectories,
  isDefault,
  selected,
  onToggleSelected,
  onSave,
  onDelete,
  onToggleDefault,
  onEdit,
}: FileRowProps) {
  const presentKeys = new Set(
    file.locations.map((l) => encodeTarget(l.harnessId, l.scope))
  );

  const sourcePath = getSourcePath(file);

  const deleteItems: ActionDropdownItem[] = file.locations.map(
    (loc, index) => ({
      label: `${getTargetLabel(loc.harnessId)} (${loc.scope})`,
      value: encodeTarget(loc.harnessId, loc.scope),
      description: formatPathForDisplay(getLocationFolderPath(file, index)),
    })
  );

  const toggleTitle =
    file.type === HARNESS_FILE_TYPES.AGENT
      ? isDefault
        ? "Remove as default agent"
        : "Set as default agent"
      : isDefault
        ? "Remove from default skills"
        : "Add to default skills";

  return (
    <div className="py-2 px-3 border-b border-panel-border last:border-0">
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(file.name)}
          aria-label={`Select ${file.displayName}`}
          className="mt-0.5 h-4 w-4 shrink-0 accent-focus-border cursor-pointer"
        />

        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {file.displayName}
          </span>

          {!isStandalone && file.locations.length > 0 && (
            <button
              type="button"
              onClick={() => onEdit(file)}
              className="flex shrink-0 items-center gap-1 rounded border border-panel-border px-1.5 py-0.5 text-xxs text-description-fg transition-colors hover:border-focus-border hover:text-foreground"
              title={`Open ${file.type === HARNESS_FILE_TYPES.SKILL ? "SKILL.md" : file.displayName} in VS Code`}
            >
              <i className="codicon codicon-edit text-xxs" />
              <span className="hidden sm:inline">Edit</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onToggleDefault(file)}
            className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xxs transition-colors ${
              isDefault
                ? "border-btn-bg bg-btn-bg text-btn-fg hover:bg-btn-hover"
                : "border-panel-border text-description-fg hover:border-focus-border hover:text-foreground"
            }`}
            title={toggleTitle}
          >
            <i className="codicon codicon-globe text-xxs" />
            <span>{isDefault ? "Default" : "Set default"}</span>
          </button>
        </div>
      </div>

      {file.description && (
        <p
          className="mt-1 truncate text-xs text-description-fg"
          title={file.description}
        >
          {file.description}
        </p>
      )}

      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {file.locations.map((loc) => (
            <HarnessBadge
              key={`${loc.harnessId}-${loc.scope}-${loc.path}`}
              id={loc.harnessId}
              scope={loc.scope}
            />
          ))}
          {file.builtInSourcePath && (
            <span className="inline-flex items-center px-1 py-0.5 rounded text-xxs font-medium leading-none bg-badge-bg text-badge-fg">
              Built-in
            </span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <FlyoutActionDropdown
            label="Save"
            icon="save"
            groups={buildSaveFlyoutGroups(
              presentKeys,
              availableIds,
              targetDirectories
            )}
            onSelect={(encoded) => {
              const { id, scope } = decodeTarget(encoded);
              onSave(sourcePath, id, scope);
            }}
          />

          {file.locations.length > 0 && (
            <ActionDropdown
              label="Delete"
              icon="trash"
              items={deleteItems}
              onSelect={(encoded) => {
                const { id, scope } = decodeTarget(encoded);
                onDelete(file.name, id, scope);
              }}
              className="text-error-fg"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Section
// ============================================================================

type AgentSkillsManagerSectionProps = {
  activeScope: SettingWriteScope;
};

export function AgentSkillsManagerSection({
  activeScope,
}: AgentSkillsManagerSectionProps) {
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
  const openHarnessDir = useHarnessFileStore((s) => s.openHarnessDir);

  const harnessStatusMap = useSettingsStore((s) => s.harnessStatus);
  const availableIds = new Set(
    ELIGIBLE_HARNESS_IDS.filter((id) => harnessStatusMap[id]?.available)
  );

  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const fullGlobalSettings = useSettingsStore((s) => s.fullGlobalSettings);

  const defaultAgent = useMemo<string>(() => {
    const fullValue = fullGlobalSettings?.settings?.defaults?.agent;
    return typeof fullValue === "string"
      ? fullValue
      : (globalSettings.agent ?? "");
  }, [fullGlobalSettings, globalSettings.agent]);

  const defaultSkills = useMemo<string[]>(() => {
    const fullValue = fullGlobalSettings?.settings?.defaults?.skills;
    return Array.isArray(fullValue) ? fullValue : (globalSettings.skills ?? []);
  }, [fullGlobalSettings, globalSettings.skills]);

  const isFileDefault = useCallback(
    (file: ManagedFile): boolean =>
      file.type === HARNESS_FILE_TYPES.AGENT
        ? defaultAgent === file.name
        : defaultSkills.includes(file.name),
    [defaultAgent, defaultSkills]
  );

  const handleToggleDefault = useCallback(
    (file: ManagedFile) => {
      if (file.type === HARNESS_FILE_TYPES.AGENT) {
        sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
          path: "defaults.agent",
          value: defaultAgent === file.name ? "" : file.name,
          scope: activeScope,
        });
      } else {
        const nextSkills = defaultSkills.includes(file.name)
          ? defaultSkills.filter((name) => name !== file.name)
          : [...defaultSkills, file.name];
        sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
          path: "defaults.skills",
          value: nextSkills,
          scope: activeScope,
        });
      }
    },
    [activeScope, defaultAgent, defaultSkills]
  );

  const handleEditFile = useCallback((file: ManagedFile) => {
    sendMessage(MESSAGE_TYPES.OPEN_FILE, { path: getEditFilePath(file) });
  }, []);

  const [confirmDelete, setConfirmDelete] = useState<{
    name: string;
    id: AnyTargetId;
    scope: SettingWriteScope;
  } | null>(null);

  const [confirmDeleteAll, setConfirmDeleteAll] = useState<{
    names: string[];
    id: AnyTargetId;
    scope: SettingWriteScope;
  } | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    requestFiles();
  }, [requestFiles]);

  useEffect(() => {
    setSelectedIds(new Set(managedFiles.map((file) => file.name)));
    // managedFiles is intentionally excluded: this effect should only reset
    // the selection when switching tabs, not when the file list updates
    // (the effect below handles syncing selections as managedFiles changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType]);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        managedFiles
          .filter((file) => current.has(file.name))
          .map((file) => file.name)
      );
      for (const file of managedFiles) {
        next.add(file.name);
      }
      if (
        next.size === current.size &&
        [...next].every((name) => current.has(name))
      ) {
        return current;
      }
      return next;
    });
  }, [managedFiles]);

  const selectedFiles = useMemo(
    () => managedFiles.filter((file) => selectedIds.has(file.name)),
    [managedFiles, selectedIds]
  );

  const selectAllState =
    managedFiles.length === 0
      ? "none"
      : selectedIds.size === 0
        ? "none"
        : selectedIds.size === managedFiles.length
          ? "all"
          : "some";

  const availableBulkActions: BulkAction[] =
    activeType === HARNESS_FILE_TYPES.AGENT
      ? ["save", "delete"]
      : ["save", "delete", "setDefault"];

  const handleSave = useCallback(
    (sourcePath: string, id: AnyTargetId, scope: SettingWriteScope) => {
      exportFile(sourcePath, id, activeType, false, scope);
    },
    [exportFile, activeType]
  );

  const handleDeleteRequest = useCallback(
    (name: string, id: AnyTargetId, scope: SettingWriteScope) => {
      setConfirmDelete({ name, id, scope });
    },
    []
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!confirmDelete) return;
    deleteFile(
      confirmDelete.name,
      confirmDelete.id,
      activeType,
      confirmDelete.scope
    );
    setConfirmDelete(null);
  }, [confirmDelete, deleteFile, activeType]);

  const handleSaveAll = useCallback(
    (id: AnyTargetId, scope: SettingWriteScope) => {
      const files = selectedFiles.map((f) => ({
        sourcePath: getSourcePath(f),
        name: f.name,
      }));
      syncAll(files, id, activeType, scope);
    },
    [selectedFiles, syncAll, activeType]
  );

  const handleDeleteAllRequest = useCallback(
    (id: AnyTargetId, scope: SettingWriteScope) => {
      const names = selectedFiles
        .filter((file) =>
          file.locations.some(
            (location) => location.harnessId === id && location.scope === scope
          )
        )
        .map((file) => file.name);
      setConfirmDeleteAll({ names, id, scope });
    },
    [selectedFiles]
  );

  const handleDeleteAllConfirm = useCallback(() => {
    if (!confirmDeleteAll) return;
    for (const name of confirmDeleteAll.names) {
      deleteFile(name, confirmDeleteAll.id, activeType, confirmDeleteAll.scope);
    }
    setConfirmDeleteAll(null);
  }, [confirmDeleteAll, deleteFile, activeType]);

  const handleToggleSelected = useCallback((name: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((current) =>
      current.size === managedFiles.length
        ? new Set()
        : new Set(managedFiles.map((file) => file.name))
    );
  }, [managedFiles]);

  const handleSetDefault = useCallback(() => {
    if (activeType !== HARNESS_FILE_TYPES.SKILL) {
      return;
    }
    const visibleNames = new Set(managedFiles.map((file) => file.name));
    const preservedDefaults = defaultSkills.filter(
      (name) => !visibleNames.has(name)
    );
    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path: "defaults.skills",
      value: [...preservedDefaults, ...selectedFiles.map((file) => file.name)],
      scope: activeScope,
    });
  }, [activeScope, activeType, defaultSkills, managedFiles, selectedFiles]);

  const getContextDescription = (): string => {
    if (activeType === HARNESS_FILE_TYPES.AGENT) {
      return "Built-in ctrlyoke agents are always available to workflows. Save a copy to ctrlyoke to customize one, or to a harness directory to enable native subagent spawning.";
    }
    return "Save skills to a harness directory to make that skill always available for that harness, regardless of what ctrlyoke attaches.";
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase text-description-fg tracking-wide">
        Agent & Skills Manager
      </h3>

      {/* Type switcher + Open Folder */}
      <div className="flex items-center gap-2">
        <div
          className="fp-mode-switch"
          role="group"
          aria-label="Agent or skill type"
        >
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

      <div className="space-y-2">
        <p className="text-xs text-description-fg">{getContextDescription()}</p>
        <p className="text-xs text-description-fg">
          Save to ctrlyoke for fine-grained control via properties. Workspace
          directories are project-scoped; user directories apply globally.
        </p>
      </div>

      {/* Bulk actions */}
      <div className="rounded border border-panel-border bg-editor-bg px-3 py-2">
        <BulkSelectionActionsBar
          totalCount={managedFiles.length}
          selectedCount={selectedFiles.length}
          selectAllState={selectAllState}
          onToggleSelectAll={handleToggleSelectAll}
          availableActions={availableBulkActions}
          getTargetsForScope={(scope) =>
            scope === SETTING_SCOPES.WORKSPACE
              ? getWorkspaceTargets(availableIds)
              : getUserTargets(availableIds)
          }
          getTargetLabel={getTargetLabel}
          getTargetDescription={(id, scope) =>
            formatPathForDisplay(
              getTargetDirectoryPath(targetDirectories, id, scope) ?? ""
            )
          }
          defaultTargetId={HARNESS_IDS.CLAUDE_CLI as HarnessId}
          defaultScope={activeScope}
          activeScope={activeScope}
          onSave={handleSaveAll}
          onDelete={handleDeleteAllRequest}
          onSetDefault={handleSetDefault}
        />
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
              isDefault={isFileDefault(file)}
              selected={selectedIds.has(file.name)}
              onToggleSelected={handleToggleSelected}
              onSave={handleSave}
              onDelete={handleDeleteRequest}
              onToggleDefault={handleToggleDefault}
              onEdit={handleEditFile}
            />
          ))}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
          role="button"
          tabIndex={0}
          aria-label={`Close delete ${activeType} dialog`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmDelete(null);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === "Enter" ||
                event.key === " " ||
                event.key === "Escape")
            ) {
              event.preventDefault();
              setConfirmDelete(null);
            }
          }}
        >
          <div
            className="bg-editor-bg border border-panel-border rounded p-4 max-w-sm w-full mx-4 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <p className="text-sm text-foreground mb-1 font-semibold">
              Delete {activeType}?
            </p>
            <p className="text-xs text-description-fg mb-4">
              Remove <strong>{confirmDelete.name}</strong> from{" "}
              <strong>{getTargetLabel(confirmDelete.id)}</strong> (
              {confirmDelete.scope})? This only deletes the file from that
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

      {/* Bulk delete confirmation modal */}
      {confirmDeleteAll && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
          role="button"
          tabIndex={0}
          aria-label={`Close delete selected ${activeType} dialog`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmDeleteAll(null);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === "Enter" ||
                event.key === " " ||
                event.key === "Escape")
            ) {
              event.preventDefault();
              setConfirmDeleteAll(null);
            }
          }}
        >
          <div
            className="bg-editor-bg border border-panel-border rounded p-4 max-w-sm w-full mx-4 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <p className="text-sm text-foreground mb-1 font-semibold">
              Delete selected {activeType}s?
            </p>
            <p className="text-xs text-description-fg mb-4">
              Remove {confirmDeleteAll.names.length} selected {activeType}
              {confirmDeleteAll.names.length === 1 ? "" : "s"} from{" "}
              <strong>{getTargetLabel(confirmDeleteAll.id)}</strong> (
              {confirmDeleteAll.scope}). Copies in other directories are not
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
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
