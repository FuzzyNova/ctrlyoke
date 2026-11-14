import type React from "react";
import { useSettingsStore } from "@store/settingsStore";
import {
  resolveWorkflowVariable,
  workflowVariableName,
  type WorkflowVariables,
} from "@utils/wholeValueVariables";

interface WorkflowVariableValueProps {
  /** The authored value; a whole-value `{{name}}` string renders the chip. */
  value: unknown;
  /** Clears the placeholder, returning the field to its picker. */
  onClear: () => void;
  /** The editor shown when the value is not a placeholder. */
  children: React.ReactNode;
  /** Variables to resolve against; defaults to the workflow's `vars`. */
  vars?: WorkflowVariables;
  /** Field name used in the chip's accessible label. */
  label?: string;
  disabled?: boolean;
}

const EMPTY_VARS: WorkflowVariables = {};

/**
 * Read-only `{{name}} → value` chip for a typed (`kind: value`) field authored
 * as a whole-value workflow variable. Clear hands the field back to its
 * editor; nothing here ever writes a placeholder on its own.
 */
export function WorkflowVariableValue({
  value,
  onClear,
  children,
  vars,
  label,
  disabled = false,
}: WorkflowVariableValueProps) {
  const storedVars = useSettingsStore((state) => state.workflowProperties.vars);
  const name = workflowVariableName(value);
  if (name === undefined) return <>{children}</>;
  const resolvedVars = vars ?? storedVars ?? EMPTY_VARS;
  const resolved = resolveWorkflowVariable(value, resolvedVars);
  const placeholder = String(value);
  return (
    <div
      role="group"
      aria-label={`${label ?? "Value"} uses variable ${placeholder}`}
      data-testid="workflow-variable-chip"
      className="flex items-center gap-2 rounded-sm border border-input-border px-2 py-1 text-xs"
    >
      <span className="font-mono">{placeholder}</span>
      <span aria-hidden="true">→</span>
      <span
        className={resolved === undefined ? "italic text-warning-fg" : ""}
        title={
          resolved === undefined
            ? `Variable "${name}" is not defined in this workflow's vars`
            : undefined
        }
      >
        {resolved ?? "undefined"}
      </span>
      <button
        type="button"
        className="ml-auto text-link-fg hover:underline disabled:opacity-50"
        aria-label={`Clear ${placeholder}${label ? ` from ${label}` : ""}`}
        onClick={onClear}
        disabled={disabled}
      >
        Clear
      </button>
    </div>
  );
}
