import { useEffect, useRef, useState } from "react";
import {
  SETTING_SCOPES,
  type AnyTargetId,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import { ActionDropdown, type ActionDropdownItem } from "./ActionDropdown";

export type BulkAction = "save" | "delete" | "setDefault";

export interface BulkSelectionActionsBarProps {
  totalCount: number;
  selectedCount: number;
  selectAllState: "all" | "none" | "some";
  onToggleSelectAll: () => void;
  availableActions: BulkAction[];
  getTargetsForScope: (scope: SettingWriteScope) => AnyTargetId[];
  getTargetLabel: (id: AnyTargetId) => string;
  getTargetDescription: (id: AnyTargetId, scope: SettingWriteScope) => string;
  defaultTargetId: AnyTargetId;
  defaultScope?: SettingWriteScope;
  activeScope?: SettingWriteScope;
  onSave: (id: AnyTargetId, scope: SettingWriteScope) => void;
  onDelete: (id: AnyTargetId, scope: SettingWriteScope) => void;
  onSetDefault: () => void;
}

function getActionLabel(action: BulkAction): string {
  switch (action) {
    case "save":
      return "Save";
    case "delete":
      return "Delete";
    case "setDefault":
      return "Set Default";
  }
}

function getSubmitLabel(action: BulkAction): string {
  switch (action) {
    case "save":
      return "Save";
    case "delete":
      return "Delete";
    case "setDefault":
      return "Set as Default";
  }
}

export function BulkSelectionActionsBar({
  totalCount,
  selectedCount,
  selectAllState,
  onToggleSelectAll,
  availableActions,
  getTargetsForScope,
  getTargetLabel,
  getTargetDescription,
  defaultTargetId,
  defaultScope = SETTING_SCOPES.WORKSPACE,
  activeScope = defaultScope,
  onSave,
  onDelete,
  onSetDefault,
}: BulkSelectionActionsBarProps) {
  const [action, setAction] = useState<BulkAction>(availableActions[0] ?? "save");
  const [scope, setScope] = useState<SettingWriteScope>(defaultScope);
  const [targetId, setTargetId] = useState<AnyTargetId>(defaultTargetId);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!availableActions.includes(action)) {
      setAction(availableActions[0] ?? "save");
    }
  }, [action, availableActions]);

  useEffect(() => {
    if (!selectAllRef.current) {
      return;
    }
    selectAllRef.current.indeterminate = selectAllState === "some";
  }, [selectAllState]);

  const scopeTargets = getTargetsForScope(scope);

  useEffect(() => {
    if (scopeTargets.length === 0) {
      return;
    }
    if (!scopeTargets.includes(targetId)) {
      setTargetId(scopeTargets[0]);
    }
  }, [scopeTargets, targetId]);

  const handleScopeChange = (newScope: SettingWriteScope) => {
    setScope(newScope);
    const nextTargets = getTargetsForScope(newScope);
    if (!nextTargets.includes(targetId)) {
      setTargetId(nextTargets[0] ?? defaultTargetId);
    }
  };

  const actionItems: ActionDropdownItem[] = availableActions.map((value) => ({
    label: getActionLabel(value),
    value,
  }));
  const targetItems: ActionDropdownItem[] = scopeTargets.map((id) => ({
    label: getTargetLabel(id),
    value: id,
    description: getTargetDescription(id, scope),
  }));
  const shouldShowLocationControls = action !== "setDefault";
  const isSubmitDisabled =
    selectedCount === 0 ||
    (shouldShowLocationControls && scopeTargets.length === 0);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-panel-border pt-3">
      <label className="mr-2 flex min-w-[170px] items-center gap-2 text-xs text-foreground">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={selectAllState === "all"}
          onChange={onToggleSelectAll}
          aria-label="Select all rows"
          className="h-3.5 w-3.5 rounded border-input-border bg-input-bg"
        />
        <span className="truncate">
          Select all ({selectedCount}/{totalCount} selected)
        </span>
      </label>

      <ActionDropdown
        label={getActionLabel(action)}
        items={actionItems}
        onSelect={(value) => setAction(value as BulkAction)}
        className="min-w-[120px]"
      />

      {shouldShowLocationControls ? (
        <>
          <span className="shrink-0 text-xs text-description-fg">
            {action === "save" ? "to:" : "from:"}
          </span>

          <select
            value={scope}
            onChange={(event) =>
              handleScopeChange(event.target.value as SettingWriteScope)
            }
            className="h-6 shrink-0 rounded border border-input-border bg-input-bg px-2 text-xs text-foreground focus:border-focus-border focus:outline-none"
          >
            <option value={SETTING_SCOPES.WORKSPACE}>Workspace</option>
            <option value={SETTING_SCOPES.USER}>User</option>
          </select>

          {scopeTargets.length > 0 ? (
            <ActionDropdown
              label={getTargetLabel(targetId)}
              items={targetItems}
              onSelect={(value) => setTargetId(value as AnyTargetId)}
              className="min-w-[220px] flex-1"
            />
          ) : (
            <div className="min-w-[220px] flex-1 rounded border border-panel-border bg-list-hover-bg px-2 py-1 text-xs text-description-fg">
              No targets available for {scope}
            </div>
          )}
        </>
      ) : (
        <span className="text-xs text-description-fg">
          defaults ({activeScope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User"})
        </span>
      )}

      <button
        type="button"
        disabled={isSubmitDisabled}
        onClick={() => {
          if (action === "save") {
            onSave(targetId, scope);
            return;
          }
          if (action === "delete") {
            onDelete(targetId, scope);
            return;
          }
          onSetDefault();
        }}
        className={`h-6 shrink-0 rounded px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
          action === "delete"
            ? "border border-btn-border bg-btn-secondary-bg text-error-fg hover:bg-btn-secondary-hover"
            : "bg-btn-bg text-btn-fg hover:bg-btn-hover"
        }`}
      >
        {getSubmitLabel(action)}
      </button>
    </div>
  );
}
