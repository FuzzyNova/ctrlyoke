import React, { useEffect, useState } from "react";
import { END_CONDITION_SCRIPT_TYPES } from "@root/types/DashboardConstants";
import type { EndConditionScriptType } from "@root/types/DashboardConstants";
import { ActionButton } from "./ActionButton";
import { CustomSelect } from "./CustomSelect";
import { Modal } from "./Modal";
import type { SelectOption } from "./CustomSelect";

const SCRIPT_TYPE_LABELS: Record<EndConditionScriptType, string> = {
  [END_CONDITION_SCRIPT_TYPES.PYTHON]: "Python",
  [END_CONDITION_SCRIPT_TYPES.JAVASCRIPT]: "JavaScript",
  [END_CONDITION_SCRIPT_TYPES.SHELL]: "Shell Script",
  [END_CONDITION_SCRIPT_TYPES.POWERSHELL]: "PowerShell",
};

const SCRIPT_TYPE_OPTIONS: SelectOption[] = (
  Object.values(END_CONDITION_SCRIPT_TYPES) as EndConditionScriptType[]
).map((value) => ({
  value,
  label: SCRIPT_TYPE_LABELS[value],
}));

const SCRIPT_TYPE_DEFAULT_NAMES: Record<EndConditionScriptType, string> = {
  [END_CONDITION_SCRIPT_TYPES.PYTHON]: "check_condition.py",
  [END_CONDITION_SCRIPT_TYPES.JAVASCRIPT]: "check_condition.js",
  [END_CONDITION_SCRIPT_TYPES.SHELL]: "check_condition.sh",
  [END_CONDITION_SCRIPT_TYPES.POWERSHELL]: "check_condition.ps1",
};

export function getDefaultScriptName(
  scriptType: EndConditionScriptType
): string {
  return SCRIPT_TYPE_DEFAULT_NAMES[scriptType];
}

interface CreateScriptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (scriptType: EndConditionScriptType, scriptName: string) => void;
  pending?: boolean;
  idPrefix?: string;
}

export const CreateScriptModal: React.FC<CreateScriptModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  pending = false,
  idPrefix = "create-script",
}) => {
  const [scriptType, setScriptType] = useState<EndConditionScriptType>(
    END_CONDITION_SCRIPT_TYPES.PYTHON
  );
  const [scriptName, setScriptName] = useState(
    getDefaultScriptName(END_CONDITION_SCRIPT_TYPES.PYTHON)
  );

  useEffect(() => {
    if (isOpen) {
      const defaultType = END_CONDITION_SCRIPT_TYPES.PYTHON;
      setScriptType(defaultType);
      setScriptName(getDefaultScriptName(defaultType));
    }
  }, [isOpen]);

  const handleScriptTypeChange = (value: string) => {
    const nextType = value as EndConditionScriptType;
    const previousDefaultName = getDefaultScriptName(scriptType);
    setScriptType(nextType);
    setScriptName((currentName) =>
      currentName === previousDefaultName
        ? getDefaultScriptName(nextType)
        : currentName
    );
  };

  const handleCreate = () => {
    const trimmedName = scriptName.trim();
    if (trimmedName) {
      onCreate(scriptType, trimmedName);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={pending ? () => undefined : onClose}
      title="Create New Script"
      size="sm"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <button
            type="button"
            className="fp-select-trigger w-auto shrink-0 px-3 text-xs hover:bg-list-hover-bg hover:text-foreground disabled:opacity-50"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <div className="shrink-0">
            <ActionButton
              label="Create Script"
              pendingLabel="Creating..."
              icon="new-file"
              onClick={handleCreate}
              disabled={pending || !scriptName.trim()}
              pending={pending}
              className="min-w-28 justify-center whitespace-nowrap"
            />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-script-type`}
            className="text-xs font-medium text-foreground"
          >
            Script type
          </label>
          <CustomSelect
            id={`${idPrefix}-script-type`}
            value={scriptType}
            onChange={handleScriptTypeChange}
            options={SCRIPT_TYPE_OPTIONS}
            triggerAriaLabel="Script type"
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${idPrefix}-script-name`}
            className="text-xs font-medium text-foreground"
          >
            Script name
          </label>
          <input
            type="text"
            id={`${idPrefix}-script-name`}
            value={scriptName}
            onChange={(event) => setScriptName(event.target.value)}
            disabled={pending}
            autoFocus
            className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
          />
          <span className="text-xxs text-description-fg">
            The script will be created in .ctrlyoke/scripts.
          </span>
        </div>
      </div>
    </Modal>
  );
};
