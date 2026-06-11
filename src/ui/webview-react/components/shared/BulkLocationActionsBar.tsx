import { useState } from "react";
import {
  SETTING_SCOPES,
  type AnyTargetId,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import { ActionDropdown, type ActionDropdownItem } from "./ActionDropdown";

type BulkLocationAction = "save" | "delete";

export interface BulkLocationActionsBarProps {
  /** Number of items eligible for save/delete-all; the submit button is disabled at zero. */
  itemCount: number;
  /** Targets available for the given scope, in display order. */
  getTargetsForScope: (scope: SettingWriteScope) => AnyTargetId[];
  getTargetLabel: (id: AnyTargetId) => string;
  getTargetDescription: (id: AnyTargetId, scope: SettingWriteScope) => string;
  defaultTargetId: AnyTargetId;
  defaultScope?: SettingWriteScope;
  onSaveAll: (id: AnyTargetId, scope: SettingWriteScope) => void;
  onDeleteAll: (id: AnyTargetId, scope: SettingWriteScope) => void;
}

/**
 * Bottom-of-list bar shared by AgentSkillsManagerSection and McpManagerSection:
 * action select (Save All / Delete All) -> scope select -> target dropdown -> submit button.
 */
export function BulkLocationActionsBar({
  itemCount,
  getTargetsForScope,
  getTargetLabel,
  getTargetDescription,
  defaultTargetId,
  defaultScope = SETTING_SCOPES.WORKSPACE,
  onSaveAll,
  onDeleteAll,
}: BulkLocationActionsBarProps) {
  const [action, setAction] = useState<BulkLocationAction>("save");
  const [scope, setScope] = useState<SettingWriteScope>(defaultScope);
  const [targetId, setTargetId] = useState<AnyTargetId>(defaultTargetId);

  const scopeTargets = getTargetsForScope(scope);

  const handleScopeChange = (newScope: SettingWriteScope) => {
    setScope(newScope);
    const targets = getTargetsForScope(newScope);
    if (!targets.includes(targetId)) {
      setTargetId(targets[0] ?? defaultTargetId);
    }
  };

  const preposition = action === "save" ? "to:" : "from:";
  const targetItems: ActionDropdownItem[] = scopeTargets.map((id) => ({
    label: getTargetLabel(id),
    value: id,
    description: getTargetDescription(id, scope),
  }));

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-panel-border flex-wrap">
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as BulkLocationAction)}
        className="h-6 bg-input-bg border border-input-border rounded px-2 text-xs text-foreground focus:outline-none focus:border-focus-border shrink-0"
      >
        <option value="save">Save All</option>
        <option value="delete">Delete All</option>
      </select>

      <span className="text-xs text-description-fg shrink-0">
        {preposition}
      </span>

      <select
        value={scope}
        onChange={(e) => handleScopeChange(e.target.value as SettingWriteScope)}
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
        disabled={itemCount === 0}
        onClick={() => {
          if (action === "save") onSaveAll(targetId, scope);
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
