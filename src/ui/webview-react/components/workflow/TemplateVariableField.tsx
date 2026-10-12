import React from "react";
import {
  HARNESS_IDS,
  KEYBOARD_KEYS,
  TEMPLATE_VARIABLE_TYPES,
  WORKSPACE_ENTRY_KINDS,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { TemplateVariable } from "@store/uiStore";
import { modelWarning } from "@utils/dropdownValidation";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
} from "../../types/dropdownNamespaces";
import { CustomSelect, HarnessDropdown, Button } from "../shared";

export interface TemplateVariableFieldProps {
  variable: TemplateVariable;
  value: string;
  values?: Record<string, string>;
  onChange: (name: string, value: string) => void;
  pairedModels?: TemplateVariable[];
  modelOptions?: Record<string, Array<{ value: string; label: string }>>;
  harnessStatus?: React.ComponentProps<typeof HarnessDropdown>["harnessStatus"];
  hiddenDropdownOptions?: Record<string, string[]>;
  onHideOption?: (namespace: string, value: string) => void;
  onUnhideOption?: (namespace: string, value: string) => void;
  onBrowse?: (variable: TemplateVariable) => void;
  onCommit?: (name: string, value: string) => void;
  commitTextOnBlur?: boolean;
  multiline?: boolean;
  onKeyDown?: React.KeyboardEventHandler<
    HTMLInputElement | HTMLTextAreaElement
  >;
  idPrefix?: string;
  footer?: React.ReactNode;
}

/** Shared typed control for one template variable and any models paired to its harness. */
export const TemplateVariableField: React.FC<TemplateVariableFieldProps> = ({
  variable,
  value,
  values = {},
  onChange,
  pairedModels = [],
  modelOptions = {},
  harnessStatus = {},
  hiddenDropdownOptions = {},
  onHideOption,
  onUnhideOption,
  onBrowse,
  onCommit,
  commitTextOnBlur = false,
  multiline = false,
  onKeyDown,
  idPrefix = "var",
  footer,
}) => {
  const id = `${idPrefix}-${variable.name}`;
  // Leaving a text field commits only an edit made since it gained focus, so
  // tabbing through (or away from a freshly pre-filled row) never writes.
  const focusValueRef = React.useRef(value);
  const trackFocus = () => {
    focusValueRef.current = value;
  };
  const commitText = () => {
    focusValueRef.current = value;
    onCommit?.(variable.name, value);
  };
  const commitTextIfEdited = commitTextOnBlur
    ? () => {
        if (value !== focusValueRef.current) commitText();
      }
    : undefined;
  const isFile = variable.type === WORKSPACE_ENTRY_KINDS.FILE;
  const isDirectory = variable.type === WORKSPACE_ENTRY_KINDS.DIRECTORY;
  const isPicker = isFile || isDirectory;
  const isSelect = variable.type === TEMPLATE_VARIABLE_TYPES.SELECT;
  const isHarness = variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS;
  const paired = isHarness && pairedModels.length > 0;
  const inputClass =
    "w-full min-w-0 px-2 py-1.5 rounded-sm bg-input-bg text-input-fg border border-input-border focus:outline-hidden focus:border-focus-border font-mono text-xs";
  const selectClass =
    "w-full px-2 py-1.5 rounded-sm bg-dropdown-bg text-dropdown-fg border border-dropdown-border focus:outline-hidden focus:border-focus-border";

  const renderModel = (model: TemplateVariable) => {
    const harness = (value || HARNESS_IDS.CLAUDE_CLI) as HarnessId;
    const models = modelOptions[harness] ?? [];
    const namespace = modelNamespaceForHarness(harness);
    const modelValue = values[model.name] ?? "";
    return (
      <div key={model.name} className="form-group min-w-0">
        <label
          htmlFor={`${idPrefix}-${model.name}`}
          className="block text-sm text-foreground"
        >
          <span className="block mb-1">{model.name}</span>
          <CustomSelect
            id={`${idPrefix}-${model.name}`}
            triggerAriaLabel={model.name}
            value={modelValue}
            onChange={(next) => {
              onChange(model.name, next);
              onCommit?.(model.name, next);
            }}
            options={
              models.length === 0
                ? [{ value: "", label: "Loading models...", disabled: true }]
                : models.map((item) => ({
                    value: item.value,
                    label: item.label,
                  }))
            }
            namespace={namespace}
            hiddenValues={hiddenDropdownOptions[namespace] ?? []}
            onHideOption={(next) => onHideOption?.(namespace, next)}
            onUnhideOption={(next) => onUnhideOption?.(namespace, next)}
            warning={modelWarning(modelValue, harness, models) ?? undefined}
          />
        </label>
        {model.description && (
          <p className="mt-1 text-xs text-description-fg">
            {model.description}
          </p>
        )}
      </div>
    );
  };

  const control = isSelect ? (
    <select
      aria-label={variable.name}
      id={id}
      value={value}
      onChange={(event) => {
        onChange(variable.name, event.target.value);
        onCommit?.(variable.name, event.target.value);
      }}
      className={selectClass}
    >
      {(variable.options ?? []).map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  ) : isHarness ? (
    <HarnessDropdown
      id={id}
      schemaPath={`vars.${variable.name}`}
      value={value}
      onChange={(next) => {
        onChange(variable.name, next);
        onCommit?.(variable.name, next);
      }}
      harnessStatus={harnessStatus}
      hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []}
      onHideOption={(next) => onHideOption?.(DROPDOWN_NAMESPACES.HARNESS, next)}
      onUnhideOption={(next) =>
        onUnhideOption?.(DROPDOWN_NAMESPACES.HARNESS, next)
      }
    />
  ) : multiline ? (
    <textarea
      aria-label={variable.name}
      id={id}
      value={value}
      onChange={(event) => onChange(variable.name, event.target.value)}
      onFocus={trackFocus}
      onBlur={commitTextIfEdited}
      onKeyDown={onKeyDown}
      placeholder={`Enter ${variable.name}`}
      rows={3}
      className={`${inputClass} resize-y w-full`}
    />
  ) : (
    <input
      type="text"
      aria-label={variable.name}
      id={id}
      value={value}
      onChange={(event) => onChange(variable.name, event.target.value)}
      onFocus={trackFocus}
      onBlur={commitTextIfEdited}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === KEYBOARD_KEYS.ENTER && commitTextOnBlur) commitText();
      }}
      placeholder={
        isDirectory
          ? "path/to/dir"
          : isFile
            ? "path/to/spec.md"
            : `Enter ${variable.name}`
      }
      className={`${inputClass}${isPicker ? " flex-1" : ""}`}
    />
  );

  const body = (
    <div className={isPicker ? "flex gap-1.5" : undefined}>
      {control}
      {isPicker && (
        <Button
          variant="secondary"
          onClick={() => onBrowse?.(variable)}
          title={isDirectory ? "Browse for folder" : "Browse for file"}
        >
          Browse…
        </Button>
      )}
    </div>
  );
  const field = (
    <div className="form-group min-w-0">
      <label htmlFor={id} className="block text-sm text-foreground">
        <span className="block mb-1">
          {variable.name}
          {isPicker && (
            <span className="ml-1 text-xs text-description-fg">
              ({isDirectory ? "directory" : "file path"})
            </span>
          )}
        </span>
        {body}
      </label>
      {variable.description && (
        <p className="mt-1 text-xs text-description-fg">
          {variable.description}
        </p>
      )}
      {!paired && footer}
    </div>
  );

  if (!paired) return field;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 items-start">
        {field}
        {pairedModels.map(renderModel)}
      </div>
      {footer}
    </div>
  );
};
