import { useEffect, useRef, useState } from "react";
import {
  SETTING_SCOPES,
  type AnyTargetId,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import { ActionDropdown, type ActionDropdownItem } from "./ActionDropdown";

const BULK_ACTIONS = {
  SAVE: "save",
  DELETE: "delete",
  SET_DEFAULT: "setDefault",
} as const;

export type BulkAction = (typeof BULK_ACTIONS)[keyof typeof BULK_ACTIONS];

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
    case BULK_ACTIONS.SAVE:
      return "Save";
    case BULK_ACTIONS.DELETE:
      return "Delete";
    case BULK_ACTIONS.SET_DEFAULT:
      return "Set Default";
  }
}

function getSubmitLabel(action: BulkAction): string {
  switch (action) {
    case BULK_ACTIONS.SAVE:
      return "Save";
    case BULK_ACTIONS.DELETE:
      return "Delete";
    case BULK_ACTIONS.SET_DEFAULT:
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
  const [action, setAction] = useState<BulkAction>(
    availableActions[0] ?? BULK_ACTIONS.SAVE
  );
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
  const scopeItems: ActionDropdownItem[] = [
    { label: "Workspace", value: SETTING_SCOPES.WORKSPACE },
    { label: "User", value: SETTING_SCOPES.USER },
  ];
  const targetItems: ActionDropdownItem[] = scopeTargets.map((id) => ({
    label: getTargetLabel(id),
    value: id,
    description: getTargetDescription(id, scope),
  }));
  const shouldShowLocationControls = action !== BULK_ACTIONS.SET_DEFAULT;
  const isSubmitDisabled =
    selectedCount === 0 ||
    (shouldShowLocationControls && scopeTargets.length === 0);

  return (
    <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
      <label className="mr-2 flex items-center gap-2 text-xs text-foreground shrink-0">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={selectAllState === "all"}
          onChange={onToggleSelectAll}
          aria-label="Select all rows"
          className="mt-0.5 h-4 w-4 shrink-0 accent-focus-border cursor-pointer"
        />
        <span className="truncate">
          Select all ({selectedCount}/{totalCount})
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
        <span className="text-xs text-description-fg">Bulk action:</span>
        <ActionDropdown
          label={getActionLabel(action)}
          items={actionItems}
          onSelect={(value) => setAction(value as BulkAction)}
          className="shrink-0 max-w-full"
        />

        {shouldShowLocationControls ? (
          <>
            <span className="shrink-0 text-xs text-description-fg">
              {action === BULK_ACTIONS.SAVE ? "to:" : "from:"}
            </span>

            <ActionDropdown
              label={scope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User"}
              items={scopeItems}
              onSelect={(value) =>
                handleScopeChange(value as SettingWriteScope)
              }
              className="shrink-0 max-w-full"
            />

            {scopeTargets.length > 0 ? (
              <ActionDropdown
                label={getTargetLabel(targetId)}
                items={targetItems}
                onSelect={(value) => setTargetId(value as AnyTargetId)}
                className="shrink-0 max-w-full"
              />
            ) : (
              <div className="shrink-0 max-w-full rounded border border-panel-border bg-list-hover-bg px-2 py-1 text-xs text-description-fg">
                No targets available for {scope}
              </div>
            )}
          </>
        ) : (
          <span className="text-xs text-description-fg">
            defaults (
            {activeScope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User"})
          </span>
        )}

        <button
          type="button"
          disabled={isSubmitDisabled}
          onClick={() => {
            if (action === BULK_ACTIONS.SAVE) {
              onSave(targetId, scope);
              return;
            }
            if (action === BULK_ACTIONS.DELETE) {
              onDelete(targetId, scope);
              return;
            }
            onSetDefault();
          }}
          className={`h-6 shrink-0 rounded px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
            action === BULK_ACTIONS.DELETE
              ? "border border-btn-border bg-btn-secondary-bg text-error-fg hover:bg-btn-secondary-hover"
              : "bg-btn-bg text-btn-fg hover:bg-btn-hover"
          }`}
        >
          {getSubmitLabel(action)}
        </button>
      </div>
    </div>
  );
}
